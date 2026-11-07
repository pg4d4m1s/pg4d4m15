/**
 * middleware/uploadDiagnostics.js
 *
 * Why this file exists
 * ────────────────────
 * "Some residents can't submit, but it works for me" is only debuggable if the
 * server can tell us WHICH of these happened:
 *
 *   1. the upload was too slow / the phone's connection dropped mid-upload,
 *   2. the resident left (refreshed / switched apps) while files were uploading,
 *   3. a file was too large / the wrong type / unreadable,
 *   4. our file storage (Cloudinary) failed,
 *   5. the sign-up session was gone (expired, cookies cleared, DB wiped).
 *
 * Before this file, cases 1-2 left NO trace at all (an aborted upload never
 * reaches a route handler or the request logger) and 3-4 were collapsed into a
 * generic "Server error". This module gives every case its own log line and its
 * own resident-facing message.
 *
 * Exports
 *   trackUpload(label)        – Express middleware: logs upload start, body-received
 *                               timing/throughput, and ABORTED uploads.
 *   uploadSummary(req)        – one-line summary for the request logger.
 *   describeUploadError(err)  – maps multer / sharp / Cloudinary errors → {status, body, level, why}
 *   handleUploadError(err, req, res) – log + send the mapped JSON error.
 *   isUploadError(err)        – true if describeUploadError() should handle this error.
 *   clientReportHandler       – POST /api/auth/client-report (browser-side failure reports).
 *   clientIp(req), fmtBytes(n)
 *
 * No dependencies other than the project logger.
 */

const log = require('../utils/logger');

// Keep in sync with multerUpload limits in middleware/upload.js
const MAX_FILE_MB = 15;

const FIELD_LABELS = {
  id_front:        'School ID / Government ID',
  id_back:         'ID (back)',
  selfie:          'selfie photo',
  avatar:          'profile photo',
  cert_residency:  'Certificate of Residency',
  cert_low_income: 'Certificate of Low Income',
  cert_enrollment: 'Certificate of Registration/Enrollment',
  cert_grades:     'Report Card / Certificate of Grades',
};
const fieldLabel = (f) => FIELD_LABELS[f] || null;

// ── small formatters ─────────────────────────────────────────────────────────
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
  if (n >= 1024)        return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}
const fmtSecs = (ms) => (ms / 1000).toFixed(1) + 's';

// First X-Forwarded-For hop = the real client behind Railway's proxy.
// LOG-ONLY: this header is client-spoofable, never use it for security decisions.
function clientIp(req) {
  const raw = req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '?';
  return String(raw).split(',')[0].trim().replace(/^::ffff:/, '').replace('::1', 'localhost');
}

// "Android · Chrome 154" is far more useful in a log line than a 150-char UA.
function shortUa(ua) {
  ua = String(ua || '');
  const os =
    /iPhone|iPad|iPod/.test(ua) ? 'iOS' :
    /Android/.test(ua)          ? 'Android' :
    /Windows/.test(ua)          ? 'Windows' :
    /Mac OS X/.test(ua)         ? 'macOS' :
    /Linux/.test(ua)            ? 'Linux' : 'unknown-OS';
  const m =
    ua.match(/(SamsungBrowser|VivoBrowser|OPR|Edg|CriOS|FxiOS|Firefox|Chrome|Version)\/(\d+)/);
  const names = { OPR: 'Opera', Edg: 'Edge', CriOS: 'Chrome-iOS', FxiOS: 'Firefox-iOS', Version: 'Safari/WebView' };
  const browser = m ? `${names[m[1]] || m[1]} ${m[2]}` : 'unknown-browser';
  return `${os} · ${browser}`;
}

// ── 1. Upload tracking ───────────────────────────────────────────────────────
/**
 * Mount BEFORE multer:
 *   router.post('/x', trackUpload('complete-registration'), ...uploadIdDocs, handler)
 */
function trackUpload(label = 'upload') {
  return function uploadTracker(req, res, next) {
    const startedAt  = Date.now();
    const declared   = parseInt(req.headers['content-length'], 10) || 0;
    const startBytes = req.socket ? req.socket.bytesRead : 0;
    const rid        = req._id ? `[${req._id}] ` : '';
    const diag = (req._uploadDiag = {
      label, startedAt, declared,
      bodyDone: false, bodyMs: null,
      ip: clientIp(req), ua: shortUa(req.headers['user-agent']),
    });

    // expressIp vs real ip: if these differ, rate limiters are keying on Railway's
    // proxy address, not the resident (see TRUST_PROXY_HOPS in server.js).
    log.upload(
      `▶ ${rid}${label} incoming — body ${fmtBytes(declared)} | ip=${diag.ip} ` +
      `(express-ip=${req.ip}) | ${diag.ua}`
    );

    req.on('end', () => {
      diag.bodyDone = true;
      diag.bodyMs   = Date.now() - startedAt;
      const kbps = diag.bodyMs > 0 ? Math.round(declared / 1024 / (diag.bodyMs / 1000)) : 0;
      log.upload(
        `✔ ${rid}${label} body fully received in ${fmtSecs(diag.bodyMs)} ` +
        `(${fmtBytes(declared)} ≈ ${kbps} KB/s ≈ ${(kbps * 8 / 1000).toFixed(1)} Mbps)` +
        (diag.bodyMs > 15000 ? '  ⚠ slow link on the resident side' : '')
      );
    });

    // 'close' without a finished response == the client went away first.
    res.on('close', () => {
      if (res.writableFinished) return;
      const elapsed  = Date.now() - startedAt;
      const received = Math.max(0, (req.socket ? req.socket.bytesRead : 0) - startBytes);
      const pct      = declared ? Math.min(100, Math.round((received / declared) * 100)) : null;
      const kbps     = elapsed > 0 ? Math.round(received / 1024 / (elapsed / 1000)) : 0;

      if (!diag.bodyDone) {
        log.error(
          `✖ ${rid}${label} ABORTED DURING UPLOAD after ${fmtSecs(elapsed)} — ` +
          `received ≈${fmtBytes(received)} of ${fmtBytes(declared)}` +
          `${pct !== null ? ` (${pct}%)` : ''} at ≈${kbps} KB/s | ip=${diag.ip} | ${diag.ua}\n` +
          `   ↳ meaning: the resident's connection dropped / was too slow, or they refreshed/left the page mid-upload.`
        );
      } else {
        log.error(
          `✖ ${rid}${label} CLIENT LEFT WHILE SERVER WAS PROCESSING — upload finished in ` +
          `${fmtSecs(diag.bodyMs)}, gave up after ${fmtSecs(elapsed)} | ip=${diag.ip} | ${diag.ua}\n` +
          `   ↳ meaning: resident refreshed/closed the page (or lost signal) while we were saving their files.`
        );
      }
    });

    next();
  };
}

/** One-line addendum for the request logger (server.js). */
function uploadSummary(req) {
  const d = req && req._uploadDiag;
  if (!d || d.bodyMs == null) return '';
  const kbps = d.bodyMs > 0 ? Math.round(d.declared / 1024 / (d.bodyMs / 1000)) : 0;
  return ` | body ${fmtBytes(d.declared)} received in ${fmtSecs(d.bodyMs)} (≈${kbps} KB/s)`;
}

// ── 2. Specific upload errors ────────────────────────────────────────────────
const ABORT_RE   = /unexpected end of form|request aborted|premature close|aborted|ECONNRESET/i;
const UNREAD_RE  = /unsupported image format|input buffer|corrupt|vipsjpeg|bad seek|pngload|webp|heif/i;

function isUploadError(err) {
  if (!err) return false;
  return (
    err.name === 'MulterError' ||
    err.code === 'BAD_FILE_TYPE' ||
    /^LIMIT_/.test(err.code || '') ||
    (ABORT_RE.test(err.message || '') && /form|multipart|aborted/i.test(err.message || '')) ||
    !!err.uploadField
  );
}

/**
 * Translate an error into { status, body, level, why }.
 * `body.error` is what the resident reads — keep it specific and actionable.
 */
function describeUploadError(err, req) {
  const field = err.field || err.uploadField || null;
  const label = field ? fieldLabel(field) : null;
  const ref   = req && req._id;
  const msg   = String((err && err.message) || err || '');
  const withRef = (b) => (ref ? { ...b, ref } : b);

  if (err.code === 'LIMIT_FILE_SIZE') {
    return {
      status: 413, level: 'warn', why: `file too large${field ? ` (${field})` : ''}`,
      body: withRef({
        error: `${label ? `Your ${label}` : 'One of your files'} is larger than ${MAX_FILE_MB} MB. ` +
               `Please choose a smaller file or take a lower-resolution photo.`,
        code: 'FILE_TOO_LARGE', field,
      }),
    };
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return {
      status: 400, level: 'warn', why: `unexpected file field ${field}`,
      body: withRef({ error: 'An unexpected file was attached. Please refresh the page and try again.', code: 'UNEXPECTED_FILE', field }),
    };
  }
  if (err.code === 'BAD_FILE_TYPE') {
    return {
      status: 415, level: 'warn', why: `bad file type ${err.mimetype || '?'} for ${field}`,
      body: withRef({
        error: `${label ? `Your ${label}` : 'A file'} is not an accepted type` +
               `${err.mimetype ? ` (${err.mimetype})` : ''}. ` +
               (['id_front', 'cert_residency', 'cert_low_income', 'cert_enrollment', 'cert_grades'].includes(field)
                 ? 'Please upload a JPG, PNG, WebP, PDF or DOCX file.'
                 : 'Please upload a JPG, PNG, GIF or WebP image.'),
        code: 'BAD_FILE_TYPE', field,
      }),
    };
  }
  if (ABORT_RE.test(msg) && /form|multipart|aborted|reset/i.test(msg)) {
    return {
      status: 400, level: 'warn', why: 'upload interrupted before it finished',
      body: withRef({
        error: 'Your upload was interrupted before it finished (the connection dropped). Please try again on a steadier connection.',
        code: 'UPLOAD_INCOMPLETE',
      }),
    };
  }
  if (UNREAD_RE.test(msg) && err.uploadStage !== 'storage') {
    return {
      status: 422, level: 'warn', why: `unreadable image (${field || '?'}): ${msg}`,
      body: withRef({
        error: `We couldn't read your ${label || 'photo'} — the file may be corrupted or in an unsupported format. ` +
               `Please re-take the photo or choose a different file.`,
        code: 'IMAGE_UNREADABLE', field,
      }),
    };
  }
  if (err.uploadStage === 'storage' || err.http_code) {
    return {
      status: 502, level: 'error',
      why: `file storage (Cloudinary) failed for ${field || '?'}: http_code=${err.http_code || '—'} ${msg}`,
      body: withRef({
        error: `We couldn't save your ${label || 'file'} because our file storage didn't respond. ` +
               `This is on our side, not yours — nothing was lost. Please wait a minute and tap Submit again.`,
        code: 'STORAGE_FAILED', field,
      }),
    };
  }
  return {
    status: 500, level: 'error', why: `unclassified: ${msg}`,
    body: withRef({
      error: 'Something went wrong on our server while processing your files. Please try again in a minute. ' +
             'If it keeps happening, contact the dorm office and quote the reference code shown.',
      code: 'SERVER_ERROR',
    }),
  };
}

function handleUploadError(err, req, res) {
  const d = describeUploadError(err, req);
  const rid = req && req._id ? `[${req._id}] ` : '';
  const line = `${rid}${req.method} ${req.originalUrl.split('?')[0]} → ${d.status} UPLOAD ${d.body.code}: ${d.why} | ip=${clientIp(req)} | ${shortUa(req.headers['user-agent'])}`;
  (d.level === 'error' ? log.error : log.warn)(line);
  if (d.level === 'error' && err && err.stack && process.env.NODE_ENV !== 'production') console.error(err.stack);
  if (res.headersSent) return;
  res.status(d.status).json(d.body);
}

// ── 3. Browser-side failure reports ──────────────────────────────────────────
// The browser knows things the server can't: bytes actually sent, the phone's
// reported network type, whether the tab was backgrounded, and failures that
// never produced a request at all (timeouts, offline, page refresh mid-upload).
const ORANGE = '\x1b[48;5;208m\x1b[37m';
const cleanStr = (v, max = 120) =>
  String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, max);
const cleanNum = (v, min = 0, max = 1e12) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : null;
};

function clientReportHandler(req, res) {
  try {
    const b   = req.body || {};
    const net = b.net && typeof b.net === 'object' ? b.net : {};
    const ev  = cleanStr(b.event, 40).replace(/[^a-z0-9_]/gi, '');
    if (!ev) return res.status(400).end();

    const parts = [];
    const add = (k, v) => { if (v !== null && v !== undefined && v !== '') parts.push(`${k}=${v}`); };

    add('step',     cleanNum(b.step, 0, 9));
    add('kind',     cleanStr(b.kind, 30));
    add('phase',    cleanStr(b.phase, 30));
    add('code',     cleanStr(b.code, 30));
    add('http',     cleanNum(b.httpStatus, 0, 999));
    const pct = cleanNum(b.percent, 0, 100);
    if (pct !== null) add('at', `${pct}%`);
    if (b.loaded != null && b.total != null) add('sent', `${fmtBytes(cleanNum(b.loaded))}/${fmtBytes(cleanNum(b.total))}`);
    else if (b.total != null)                add('size', fmtBytes(cleanNum(b.total)));
    if (b.elapsedMs != null) add('after', fmtSecs(cleanNum(b.elapsedMs, 0, 36e5)));
    if (b.uploadMs  != null) add('upload', fmtSecs(cleanNum(b.uploadMs, 0, 36e5)));
    const kbps = cleanNum(b.avgKBps, 0, 1e6);
    if (kbps !== null) add('speed', `${kbps}KB/s(${(kbps * 8 / 1000).toFixed(2)}Mbps)`);
    if (Array.isArray(b.files)) add('files', '[' + b.files.slice(0, 8).map((n) => fmtBytes(cleanNum(n))).join(', ') + ']');
    if (b.compressedFrom != null) add('compressed', `${fmtBytes(cleanNum(b.compressedFrom))}→${fmtBytes(cleanNum(b.compressedTo))}`);
    add('net',      cleanStr(net.type, 10));
    if (net.downlink != null) add('downlink', `${Number(net.downlink) || 0}Mbps`);
    if (net.rtt != null)      add('rtt', `${cleanNum(net.rtt, 0, 99999)}ms`);
    if (net.online === false) add('ONLINE', 'false');
    if (net.saveData)         add('saveData', 'on');
    if (b.backgrounded)       add('BACKGROUNDED', 'true');
    if (b.visible && b.visible !== 'visible') add('visible', cleanStr(b.visible, 10));
    add('msg',      cleanStr(b.message, 160));

    const pending = req.session && req.session.pendingRegistration;
    const who = pending ? pending.email : 'no-session';
    const rid = req._id ? `[${req._id}] ` : '';
    const line = `${rid}${ev} ${parts.join(' ')} | ${who} | ip=${clientIp(req)} | ${shortUa(req.headers['user-agent'])}`;

    const bad = /fail|abort|interrupt|timeout|error|backgrounded/i.test(ev);
    if (bad) log.tag('CLIENT', ORANGE, `\x1b[33m${line}\x1b[0m`);
    else     log.tag('CLIENT', ORANGE, line);
  } catch (e) {
    // never let diagnostics break anything
  }
  return res.status(204).end();
}

module.exports = {
  trackUpload,
  uploadSummary,
  describeUploadError,
  handleUploadError,
  isUploadError,
  clientReportHandler,
  clientIp,
  fmtBytes,
  fieldLabel,
};
