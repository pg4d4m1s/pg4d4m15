/**
 * public/js/reg-resilience.js — PGA-DAMIS registration resilience layer
 *
 * Loaded BEFORE auth.js. auth.js calls into window.RegResilience; this file in turn
 * uses auth.js globals lazily (at call time): currentStep, otpVerified, isGoogleSignup,
 * avatarFileRef, capturedPhotoData, showTab, updateProgress, $ …
 *
 * What it does
 *   1. Photo compression  – phone photos (3-8 MB) are resized to ≤1600 px JPEG (a few hundred KB)
 *                           before upload. The server already downsizes to 1200 px, so nothing is lost.
 *   2. Upload with progress – XMLHttpRequest (fetch cannot report upload progress): real progress bar,
 *                           speed + ETA, stall detection (45 s without data), hard time cap, cancel
 *                           button, screen wake-lock, "don't leave this page" guard.
 *   3. Specific errors     – every failure kind maps to a plain-language message + what to do next.
 *   4. Draft + resume      – form answers (localStorage) and photos/documents (IndexedDB) are saved as the
 *                           resident goes, and the verified e-mail is looked up from the server session, so a
 *                           refresh / reloaded tab resumes at the right step WITHOUT a new OTP.
 *   5. Diagnostics         – failures, interruptions and real upload speeds are reported to the server
 *                           (POST /api/auth/client-report) so the logs show the actual root cause.
 *   6. Returned application – when an admin rejects an application it is sent BACK for correction. After login /
 *                           Google / e-mail OTP the wizard reopens (openRevision) with every saved answer, the admin's
 *                           comment, the checklist of flagged items, and un-flagged documents/selfie kept as they were.
 *
 * Privacy: the draft holds the resident's own answers/photos on THEIR device only, expires after 24 h
 * (same as the server session), never contains passwords/OTPs, and is wiped on successful submission
 * or "Start over".
 */
(function (global) {
  'use strict';

  var API = {
    STATUS: '/api/auth/registration-status',
    RESET:  '/api/auth/registration-reset',
    REPORT: '/api/auth/client-report',
    REVISION: '/api/auth/revision',
  };
  var DRAFT_KEY    = 'damis_reg_draft_v1';
  var INFLIGHT_KEY = 'damis_reg_inflight_v1';
  var DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
  var DB_NAME = 'damis_reg_files_v1', DB_STORE = 'files';

  var UPLOAD = {
    STALL_MS:      45 * 1000,      // no bytes sent for this long → give up (signal dropped)
    MAX_UPLOAD_MS: 4 * 60 * 1000,  // absolute cap for the sending phase
    PROCESSING_MS: 90 * 1000,      // waiting for the server's reply after the last byte
  };
  var IMG = { EDGE_DOC: 1600, EDGE_AVATAR: 1280, QUALITY: 0.82, SKIP_BELOW: 200 * 1024 };

  var DOC_LABELS = {
    'school-id': 'School ID or Government ID', 'residency': 'Certificate of Residency',
    'low-income': 'Certificate of Low Income', 'enrollment': 'Certificate of Registration/Enrollment',
    'grades': 'Report Card / Certificate of Grades',
    'avatar': 'live selfie',
  };
  var DOC_KEYS = ['school-id', 'residency', 'low-income', 'enrollment', 'grades'];

  var state = {
    uploading: false, backgrounded: false, restoring: false, submitted: false,
    lastSig: '', avatarSig: null, abortFn: null, uploadCtx: null, timer: null,
    revision: null,   // the returned application being corrected (set by openRevision)
  };

  // ── tiny helpers ───────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function norm(e) { return String(e || '').trim().toLowerCase(); }
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }
  function fmtSpeed(kbps) { return kbps >= 1024 ? (kbps / 1024).toFixed(1) + ' MB/s' : Math.round(kbps) + ' KB/s'; }
  function fmtDur(ms) {
    var s = Math.round(ms / 1000);
    return s >= 60 ? Math.floor(s / 60) + ' min ' + (s % 60) + ' s' : s + ' s';
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function g(name) { try { return global[name]; } catch (e) { return undefined; } }

  function netInfo() {
    var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection || {};
    return { online: navigator.onLine !== false, type: c.effectiveType || null, downlink: c.downlink || null,
             rtt: c.rtt || null, saveData: !!c.saveData };
  }
  function curStep() { try { return currentStep; } catch (e) { return null; } }

  // ── 5. diagnostics ─────────────────────────────────────────────────────────
  function report(event, data) {
    try {
      var payload = Object.assign({ event: event, step: curStep(), net: netInfo(), visible: document.visibilityState }, data || {});
      var json = JSON.stringify(payload);
      if (navigator.sendBeacon && navigator.sendBeacon(API.REPORT, new Blob([json], { type: 'application/json' }))) return;
      fetch(API.REPORT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json, keepalive: true }).catch(function () {});
    } catch (e) { /* diagnostics must never break registration */ }
  }

  // ── 1. image compression ───────────────────────────────────────────────────
  function loadViaImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
      img.src = url;
    });
  }
  async function decodeImage(file) {
    if (global.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* fall through */ }
    }
    return loadViaImg(file);
  }

  /** → { blob, name, changed, note } — never throws for "can't compress", only for "can't read". */
  async function compressImage(file, maxEdge) {
    var isImg = /^image\/(jpeg|png|webp)$/i.test(file.type);
    if (!isImg) {
      // PDF/DOCX/other: copy into memory now. Android can revoke picker files (ERR_UPLOAD_FILE_CHANGED)
      // between selecting and submitting; an in-memory Blob can't change underneath the upload.
      try {
        var buf = await file.arrayBuffer();
        return { blob: new Blob([buf], { type: file.type || 'application/octet-stream' }), name: file.name, changed: false, note: 'copied' };
      } catch (e) { var er = new Error('unreadable'); er.unreadable = true; throw er; }
    }
    if (file.size <= IMG.SKIP_BELOW) return { blob: file, name: file.name, changed: false, note: 'small' };
    var bmp;
    try { bmp = await decodeImage(file); }
    catch (e) { return { blob: file, name: file.name, changed: false, note: 'decode-failed' }; }
    try {
      var w = bmp.width, h = bmp.height, scale = Math.min(1, maxEdge / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
      var canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);          // PNG transparency → white
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, cw, ch);
      var blob = await new Promise(function (res) { canvas.toBlob(res, 'image/jpeg', IMG.QUALITY); });
      if (!blob || (blob.size >= file.size && scale === 1)) return { blob: file, name: file.name, changed: false, note: 'no-gain' };
      var base = (file.name || 'photo').replace(/\.[^.]+$/, '');
      return { blob: blob, name: base + '.jpg', changed: true, note: w + 'x' + h + '→' + cw + 'x' + ch };
    } catch (e) {
      return { blob: file, name: file.name, changed: false, note: 'compress-error' };
    } finally { if (bmp && bmp.close) try { bmp.close(); } catch (e) {} }
  }

  var prepared = {};   // 'doc:<key>' | 'avatar' → { src, promise }
  function prepareFile(key, file, maxEdge) {
    var e = prepared[key];
    if (e && e.src === file) return e.promise;
    var p = compressImage(file, maxEdge || IMG.EDGE_DOC).then(function (r) {
      r.origSize = file.size; r.size = r.blob.size; r.key = key; return r;
    });
    prepared[key] = { src: file, promise: p };
    p.catch(function () { delete prepared[key]; });
    return p;
  }

  function dataUrlToBlob(dataUrl) {
    var parts = String(dataUrl).split(','), mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/jpeg';
    var bin = atob(parts[1]), arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }
  function avatarSource() {
    var f = null, d = null;
    try { f = avatarFileRef; } catch (e) {}
    try { d = capturedPhotoData; } catch (e) {}
    if (f) return { file: f, sig: 'f:' + f.name + ':' + f.size + ':' + f.lastModified };
    if (d) return { file: null, data: d, sig: 'd:' + d.length + ':' + d.slice(-24) };
    return { file: null, sig: '' };
  }
  var avatarBlobCache = { sig: '', blob: null };
  function avatarInput() {
    var s = avatarSource();
    if (!s.sig) return null;
    if (s.file) return s.file;
    if (avatarBlobCache.sig !== s.sig) avatarBlobCache = { sig: s.sig, blob: dataUrlToBlob(s.data) };
    return avatarBlobCache.blob;
  }

  /**
   * Compress everything that will be uploaded. Returns
   * { docs:{key:{blob,name}}, avatar:{blob,name}|null, sizes:[...], origTotal, total }
   */
  async function prepareFiles(input) {
    var jobs = [];
    DOC_KEYS.forEach(function (k) { if (input.docs && input.docs[k]) jobs.push({ key: k, file: input.docs[k], edge: IMG.EDGE_DOC }); });
    var av = avatarInput();
    if (av) jobs.push({ key: 'avatar', file: av, edge: IMG.EDGE_AVATAR });

    var out = { docs: {}, avatar: null, sizes: [], origTotal: 0, total: 0 };
    ui.show();
    for (var i = 0; i < jobs.length; i++) {
      var j = jobs[i];
      ui.set('Optimizing photos (' + (i + 1) + '/' + jobs.length + ')…', Math.round((i / jobs.length) * 100), 'Making files smaller so they upload faster');
      var r;
      try { r = await prepareFile(j.key === 'avatar' ? 'avatar' : 'doc:' + j.key, j.file, j.edge); }
      catch (e) {
        ui.hide();
        var err = new Error('Could not read your ' + (DOC_LABELS[j.key] || 'file') + '.');
        err.kind = 'file_unreadable'; err.fileKey = j.key; throw err;
      }
      if (r.changed) report('photo_compressed', { compressedFrom: r.origSize, compressedTo: r.size, phase: j.key });
      var rec = { blob: r.blob, name: r.name };
      if (j.key === 'avatar') out.avatar = rec; else out.docs[j.key] = rec;
      out.sizes.push(r.size); out.origTotal += r.origSize; out.total += r.size;
    }
    return out;
  }

  // ── 2. progress UI ─────────────────────────────────────────────────────────
  var ui = {
    el: null,
    ensure: function () {
      if (this.el && document.body.contains(this.el)) return this.el;
      var el = document.createElement('div');
      el.id = 'reg-upload-progress';
      el.className = 'hidden mb-4 p-3 rounded-xl border border-blue-200 bg-blue-50 text-blue-800 text-xs';
      el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
      el.innerHTML =
        '<div class="flex items-center justify-between mb-1.5"><span id="rup-phase" class="font-bold">Preparing…</span><span id="rup-pct" class="font-bold">0%</span></div>' +
        '<div class="w-full h-2 bg-blue-100 rounded-full overflow-hidden"><div id="rup-bar" class="h-2 bg-blue-600 rounded-full" style="width:0%;transition:width .25s"></div></div>' +
        '<div class="flex items-center justify-between mt-1.5 text-[11px] text-blue-700"><span id="rup-detail"></span><button type="button" id="rup-cancel" class="font-semibold underline hidden">Cancel</button></div>' +
        '<p id="rup-hint" class="mt-1.5 text-[11px] text-blue-600">Keep this screen open until it finishes.</p>';
      var anchor = $('err-5');
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(el, anchor); else document.body.appendChild(el);
      el.querySelector('#rup-cancel').onclick = function () { if (state.abortFn) state.abortFn('cancelled'); };
      this.el = el; return el;
    },
    show: function () { this.ensure().classList.remove('hidden'); },
    hide: function () { if (this.el) this.el.classList.add('hidden'); var c = $('rup-cancel'); if (c) c.classList.add('hidden'); },
    set: function (phase, pct, detail, hint, cancellable) {
      var el = this.ensure(); el.classList.remove('hidden');
      var p = $('rup-phase'), n = $('rup-pct'), b = $('rup-bar'), d = $('rup-detail'), h = $('rup-hint'), c = $('rup-cancel');
      if (p) p.textContent = phase;
      if (n) n.textContent = (pct == null ? '' : Math.round(pct) + '%');
      if (b) b.style.width = (pct == null ? 100 : Math.max(2, Math.min(100, pct))) + '%';
      if (d) d.textContent = detail || '';
      if (h && hint) h.textContent = hint;
      if (c) c.classList.toggle('hidden', !cancellable);
    },
  };

  var wakeLock = null;
  function acquireWakeLock() { try { if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(function () {}); } catch (e) {} }
  function releaseWakeLock() { try { if (wakeLock) wakeLock.release().catch(function () {}); } catch (e) {} wakeLock = null; }
  function beforeUnload(e) { e.preventDefault(); e.returnValue = 'Your application is still uploading. Leaving now will cancel it.'; return e.returnValue; }

  /**
   * XHR upload. Resolves { status, data, text, uploadMs, totalMs } for ANY http reply.
   * Rejects with { kind, percent, loaded, total, elapsedMs, uploadDone, avgKBps } for transport failures:
   * stalled | timeout | processing_timeout | network | cancelled
   */
  function uploadWithProgress(url, fd, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest(), t0 = Date.now();
      var lastGrow = t0, loaded = 0, total = 0, uploadDoneAt = 0, settled = false, reason = null, ema = 0, lastT = t0, lastL = 0;
      xhr.open('POST', url);
      xhr.responseType = 'text';

      function stats() {
        var el = Date.now() - t0, upMs = (uploadDoneAt || Date.now()) - t0;
        return { loaded: loaded, total: total, percent: total ? loaded / total * 100 : 0, elapsedMs: el,
                 uploadDone: !!uploadDoneAt, uploadMs: upMs, avgKBps: upMs > 500 ? Math.round(loaded / 1024 / (upMs / 1000)) : 0 };
      }
      function finish(fn, v) { if (settled) return; settled = true; clearInterval(watch); state.abortFn = null; fn(v); }
      function fail(kind) { var s = stats(); s.kind = kind; finish(reject, s); }

      xhr.upload.onprogress = function (e) {
        if (!e.lengthComputable) return;
        if (e.loaded > loaded) lastGrow = Date.now();
        loaded = e.loaded; total = e.total;
        var now = Date.now();
        if (now - lastT >= 700) {                       // smoothed speed (bytes/s)
          var inst = (loaded - lastL) / ((now - lastT) / 1000);
          ema = ema ? ema * 0.6 + inst * 0.4 : inst; lastT = now; lastL = loaded;
        }
        var left = ema > 0 ? (total - loaded) / ema * 1000 : null;
        onProgress({ phase: 'uploading', percent: loaded / total * 100, loaded: loaded, total: total, speedKBps: ema / 1024,
                     etaMs: (now - t0 > 3000) ? left : null });
      };
      xhr.upload.onload = function () {
        uploadDoneAt = Date.now(); lastGrow = uploadDoneAt;
        onProgress({ phase: 'processing', percent: 100, loaded: total, total: total });
      };
      xhr.onload = function () {
        var text = xhr.responseText || '', data = null;
        try { data = JSON.parse(text); } catch (e) {}
        var s = stats();
        finish(resolve, { status: xhr.status, data: data, text: text, uploadMs: s.uploadMs, totalMs: s.elapsedMs, avgKBps: s.avgKBps, loaded: loaded, total: total });
      };
      xhr.onerror = function () { fail(reason || 'network'); };
      xhr.onabort = function () { fail(reason || 'cancelled'); };

      var watch = setInterval(function () {
        var now = Date.now();
        if (!uploadDoneAt) {
          if (now - lastGrow > UPLOAD.STALL_MS)  { reason = 'stalled';  xhr.abort(); }
          else if (now - t0 > UPLOAD.MAX_UPLOAD_MS) { reason = 'timeout'; xhr.abort(); }
        } else if (now - uploadDoneAt > UPLOAD.PROCESSING_MS) { reason = 'processing_timeout'; xhr.abort(); }
      }, 1000);

      state.abortFn = function (why) { reason = why || 'cancelled'; xhr.abort(); };
      try { xhr.send(fd); } catch (e) { fail('network'); }
    });
  }

  // ── 3. specific messages ───────────────────────────────────────────────────
  function withRef(msg, data) { return data && data.ref ? msg + ' (Ref: ' + data.ref + ')' : msg; }

  function explain(f) {
    var pct = f.percent != null ? Math.round(f.percent) : null;
    var speed = f.avgKBps ? ' at about ' + fmtSpeed(f.avgKBps) : '';
    var sent = f.total ? fmtBytes(f.loaded) + ' of ' + fmtBytes(f.total) : '';
    var bg = state.backgrounded ? ' The browser was in the background (e.g. you switched apps) — stay on this screen while uploading.' : '';
    var saved = ' Your answers and documents are saved on this device.';
    switch (f.kind) {
      case 'offline':
        return { message: "You're offline — this device has no internet connection right now." ,
                 hint: 'Reconnect to Wi-Fi or mobile data, then tap Submit Application again.' + saved };
      case 'stalled':
        return { message: 'The upload stalled at ' + pct + '% — no data was sent for ' + Math.round(UPLOAD.STALL_MS / 1000) + ' seconds.' + bg,
                 hint: 'Your signal probably dropped. Move to a spot with better reception, or switch between Wi-Fi and mobile data, then tap Submit Application again.' + saved };
      case 'timeout':
        return { message: 'The upload took longer than ' + fmtDur(UPLOAD.MAX_UPLOAD_MS) + ' and was stopped at ' + pct + '% (' + sent + speed + ').' + bg,
                 hint: 'Your connection is too slow for this upload right now. Try Wi-Fi or a stronger signal, then tap Submit Application again.' + saved };
      case 'network':
        if (f.uploadDone) return { message: 'Your files finished uploading, but the connection dropped before the server replied.',
                 hint: 'We checked and your application was not recorded yet — tap Submit Application again.' + saved };
        return { message: 'Connection lost while uploading (' + (pct || 0) + '% sent' + (sent ? ': ' + sent : '') + ').' + bg,
                 hint: 'Check your internet connection and tap Submit Application again.' + saved };
      case 'processing_timeout':
        return { message: 'Your files were uploaded, but the server took too long to reply (over ' + Math.round(UPLOAD.PROCESSING_MS / 1000) + ' seconds).',
                 hint: 'The server may be busy. Wait a minute and tap Submit Application again.' + saved };
      case 'cancelled':
        return { message: 'Upload cancelled.', hint: 'Tap Submit Application whenever you are ready.' + saved };
      case 'file_unreadable':
        return { message: 'Could not read your ' + (DOC_LABELS[f.fileKey] || 'file') + ' — the file may have been moved or deleted after you selected it.',
                 hint: 'Remove it and select the file again.' };
      case 'http': return explainHttp(f);
    }
    return { message: 'Something unexpected happened while submitting.', hint: 'Please try again.' + saved };
  }

  function explainHttp(f) {
    var d = f.data || {}, st = f.status, code = d.code;
    var saved = ' Your answers and documents are saved on this device.';
    if (code === 'SESSION_EXPIRED' || code === 'EMAIL_NOT_VERIFIED')
      return { message: withRef(d.error, d), hint: 'Reload this page and verify your email again — your answers will be restored automatically.', code: code };
    if (code === 'REVISION_ACK_REQUIRED')
      return { message: withRef(d.error, d), hint: 'We took you back to confirm your corrections.', code: code, goStep: 3 };
    if (code === 'REVISION_DOC_REQUIRED')
      return { message: withRef(d.error, d), hint: 'Upload a new file for each document the admin asked you to replace.', code: code, field: d.field };
    if (code === 'REVISION_GONE')
      return { message: withRef(d.error, d), hint: 'Reload this page to continue.', code: code };
    if (code === 'VALIDATION')
      return { message: withRef(d.error, d), hint: 'We took you back to fix it.', code: code, field: d.field, goStep: 3 };
    if (/^SELFIE_/.test(code || ''))   // server-side face check rejected / missed the live selfie → back to Step 4
      return { message: withRef(d.error, d), hint: 'Please retake your live selfie.', code: code, field: d.field, goStep: 4 };
    if (code === 'FILE_TOO_LARGE' || code === 'BAD_FILE_TYPE' || code === 'IMAGE_UNREADABLE')
      return { message: withRef(d.error, d), hint: 'Remove that file and choose another.', code: code, field: d.field };
    if (code === 'STORAGE_FAILED' || code === 'SERVER_ERROR' || code === 'UPLOAD_INCOMPLETE')
      return { message: withRef(d.error, d), hint: saved.trim(), code: code };
    if (d.error) return { message: withRef(d.error, d), hint: st === 429 ? '' : saved.trim(), code: code, field: d.field };
    if (st === 413) return { message: 'The server refused the upload because it is too large (' + fmtBytes(f.total) + ').', hint: 'Use smaller or lower-resolution photos.' };
    if (st === 502 || st === 503 || st === 504)
      return { message: 'The server is temporarily unavailable (HTTP ' + st + '). This often lasts a minute after an update.', hint: 'Wait a minute and tap Submit Application again.' + saved };
    return { message: 'The server sent an unexpected reply (HTTP ' + st + ').', hint: 'Please try again in a minute.' + saved };
  }

  async function fetchStatus() {
    try {
      var ctrl = global.AbortController ? new AbortController() : null;
      var t = ctrl ? setTimeout(function () { ctrl.abort(); }, 8000) : null;
      var r = await fetch(API.STATUS, { cache: 'no-store', credentials: 'same-origin', signal: ctrl ? ctrl.signal : undefined });
      if (t) clearTimeout(t);
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  }

  function markInflight(on) { if (on) lsSet(INFLIGHT_KEY, String(Date.now())); else lsDel(INFLIGHT_KEY); }

  /**
   * Send the registration. → { ok:true, data, recovered? } | { ok:false, failure:{ message, hint, kind, code, field, goStep, ... } }
   */
  async function submit(url, fd, ctx) {
    ctx = ctx || {};
    state.uploading = true; state.backgrounded = false; markInflight(true);
    acquireWakeLock(); global.addEventListener('beforeunload', beforeUnload);
    state.uploadCtx = { files: ctx.sizes || [], t0: Date.now() };
    ui.set('Uploading your application…', 0, 'Starting…', 'Keep this screen open until it finishes.', true);
    var result;
    try {
      if (navigator.onLine === false) { var o = { kind: 'offline', percent: 0, loaded: 0, total: 0, elapsedMs: 0 }; throw o; }
      result = await uploadWithProgress(url, fd, function (p) {
        if (p.phase === 'processing') {
          ui.set('Saving your application…', 100, 'Files uploaded — the server is storing them (usually a few seconds)', 'Almost done — please wait.', true);
          return;
        }
        var detail = fmtBytes(p.loaded) + ' of ' + fmtBytes(p.total) +
          (p.speedKBps ? ' · ' + fmtSpeed(p.speedKBps) : '') + (p.etaMs != null && p.etaMs > 1500 ? ' · ~' + fmtDur(p.etaMs) + ' left' : '');
        ui.set('Uploading your application…', p.percent, detail, null, true);
      });
    } catch (f) {
      ui.hide();
      f = f || { kind: 'network' };
      var base = { kind: f.kind, percent: f.percent, loaded: f.loaded, total: f.total, elapsedMs: f.elapsedMs, avgKBps: f.avgKBps,
                   files: state.uploadCtx.files, backgrounded: state.backgrounded };
      // The server may have finished even though we never saw the reply — ask before telling them it failed.
      if (f.uploadDone || f.kind === 'processing_timeout') {
        var st = await fetchStatus();
        if (st && st.submitted) {
          report('upload_recovered', Object.assign({ message: 'reply lost but application was saved' }, base));
          cleanup(); return { ok: true, recovered: true, data: { success: true, pending: true } };
        }
      }
      report(f.kind === 'cancelled' ? 'upload_cancelled' : 'upload_failed', base);
      markInflight(false); cleanup();
      var ex = explain(f);
      return { ok: false, failure: { kind: f.kind, message: ex.message, hint: ex.hint, percent: f.percent, uploadDone: f.uploadDone } };
    }

    ui.hide(); cleanup();
    var base2 = { httpStatus: result.status, uploadMs: result.uploadMs, elapsedMs: result.totalMs, avgKBps: result.avgKBps,
                  loaded: result.loaded, total: result.total, files: state.uploadCtx.files, backgrounded: state.backgrounded };
    var d = result.data;
    if (result.status >= 200 && result.status < 300 && d && d.success) {
      report('upload_ok', base2);
      return { ok: true, data: d };
    }
    markInflight(false);
    var failure = { kind: 'http', status: result.status, data: d, total: result.total };
    var ex2 = explainHttp(failure);
    report('upload_failed', Object.assign({ kind: 'http', code: d && d.code, message: d && d.error }, base2));
    return { ok: false, failure: { kind: 'http', message: ex2.message, hint: ex2.hint, code: ex2.code, field: ex2.field, goStep: ex2.goStep, status: result.status } };
  }
  function cleanup() {
    state.uploading = false; releaseWakeLock(); global.removeEventListener('beforeunload', beforeUnload);
  }

  // ── 4a. IndexedDB for photos/documents ─────────────────────────────────────
  var FileStore = (function () {
    var dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve) {
        try {
          var req = indexedDB.open(DB_NAME, 1);
          req.onupgradeneeded = function () { req.result.createObjectStore(DB_STORE, { keyPath: 'key' }); };
          req.onsuccess = function () { resolve(req.result); };
          req.onerror = req.onblocked = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
      return dbp;
    }
    function tx(mode, fn) {
      return open().then(function (db) {
        if (!db) return null;
        return new Promise(function (resolve) {
          try {
            var t = db.transaction(DB_STORE, mode), r = fn(t.objectStore(DB_STORE));
            t.oncomplete = function () { resolve(r && 'result' in r ? r.result : true); };
            t.onerror = t.onabort = function () { resolve(null); };
          } catch (e) { resolve(null); }
        });
      });
    }
    return {
      put: function (key, blob, name) { return tx('readwrite', function (s) { return s.put({ key: key, blob: blob, name: name, type: blob.type, savedAt: Date.now() }); }); },
      get: function (key) { return tx('readonly', function (s) { return s.get(key); }); },
      del: function (key) { return tx('readwrite', function (s) { return s.delete(key); }); },
      clear: function () { return tx('readwrite', function (s) { return s.clear(); }); },
    };
  })();

  // ── 4b. draft (answers) ────────────────────────────────────────────────────
  var ADDR_PREFIXES = ['perm', 'pres', 'father', 'mother', 'guardian'];
  var ADDR_SEL_RE = /^(perm|pres|father|mother|guardian)-(region|province|city|brgy)$/;
  var SPECIAL = {};
  ['school-name-manual-toggle', 'school-addr-manual-toggle', 'reg-school', 'reg-schooladdr',
   'yearlevel-manual-toggle', 'reg-yearlevel', 'reg-yearlevel-manual', 'course-manual-toggle', 'reg-course', 'reg-course-manual',
   'specialization-manual-toggle', 'reg-specialization', 'reg-specialization-manual',
   'father-deceased', 'mother-deceased', 'same-as-permanent', 'father-same-as-perm', 'mother-same-as-perm', 'guardian-same-as-perm']
    .forEach(function (k) { SPECIAL[k] = 1; });

  function verifiedEmail() { var e = $('reg-email'); return e ? norm(e.value) : ''; }
  function canSave() {
    var ov = false; try { ov = otpVerified; } catch (e) {}
    return ov && !state.submitted && !state.restoring && !state.uploading && !!verifiedEmail();
  }

  function captureDraft() {
    var fields = {};
    ['step-3', 'step-4'].forEach(function (sid) {
      var root = $(sid); if (!root) return;
      root.querySelectorAll('input, select, textarea').forEach(function (el) {
        if (el.type === 'file' || el.type === 'password') return;
        if (el.type === 'radio') { if (el.checked && el.name) fields['radio:' + el.name] = el.value; return; }
        var id = el.id; if (!id || /-addr-hidden$/.test(id) || ADDR_SEL_RE.test(id) || id === 'reg-email-display') return;
        fields[id] = el.type === 'checkbox' ? (el.checked ? 1 : 0) : el.value;
      });
    });
    var addr = {};
    ADDR_PREFIXES.forEach(function (p) {
      var o = {};
      ['region', 'province', 'city', 'brgy'].forEach(function (k) { var el = $(p + '-' + k); o[k] = el ? el.value : ''; });
      if (o.region) addr[p] = o;
    });
    var news = $('chk-news'); if (news) fields['chk-news'] = news.checked ? 1 : 0;
    // Step 5 is not scanned wholesale (it holds the T&C checkbox, which must never be auto-restored),
    // so the two optional Step 5 inputs are saved explicitly. Restore is generic by element id.
    var roomPref = $('reg-room-pref');       if (roomPref && roomPref.value) fields['reg-room-pref'] = roomPref.value;
    var roomNote = $('reg-roommate-note');   if (roomNote && roomNote.value) fields['reg-roommate-note'] = roomNote.value;
    var idTypeSel = $('reg-id-type');        if (idTypeSel && idTypeSel.value) fields['reg-id-type'] = idTypeSel.value;   // which ID the applicant is uploading
    return { v: 1, email: verifiedEmail(), step: curStep(), fields: fields, addr: addr, rev: state.revision ? state.revision.id : null };
  }

  function saveDraft() {
    if (!canSave()) return;
    try {
      var d = captureDraft(), sig = JSON.stringify(d);
      if (sig === state.lastSig) return;
      state.lastSig = sig; d.savedAt = Date.now();
      lsSet(DRAFT_KEY, JSON.stringify(d));
    } catch (e) {}
  }
  function loadDraft() {
    var raw = lsGet(DRAFT_KEY); if (!raw) return null;
    try {
      var d = JSON.parse(raw);
      if (!d || d.v !== 1 || !d.savedAt || Date.now() - d.savedAt > DRAFT_TTL_MS) { clearDraft(); return null; }
      return d;
    } catch (e) { clearDraft(); return null; }
  }
  function clearDraft() { lsDel(DRAFT_KEY); state.lastSig = ''; FileStore.clear(); }

  function persistAvatar() {
    if (!canSave()) return Promise.resolve();
    var s = avatarSource();
    if (s.sig === state.avatarSig) return Promise.resolve();
    state.avatarSig = s.sig;
    if (!s.sig) return FileStore.del('avatar');
    return prepareFile('avatar', avatarInput(), IMG.EDGE_AVATAR).then(function (r) { return FileStore.put('avatar', r.blob, r.name); }).catch(function () {});
  }

  // restore helpers
  function setVal(id, v) { var el = $(id); if (el && v != null) el.value = v; }
  function setChecked(id, on) { var el = $(id); if (el) el.checked = !!on; }
  function hasOption(sel, v) { return !!sel && Array.prototype.some.call(sel.options, function (o) { return o.value === v; }); }
  function call(fn) { try { var f = global[fn]; if (typeof f === 'function') return f.apply(null, Array.prototype.slice.call(arguments, 1)); } catch (e) { console.warn('[RegResilience] ' + fn + ' failed', e); } }

  async function restoreAddr(prefix, a) {
    if (!a || !a.region) return;
    var r = $(prefix + '-region'); if (!r || !hasOption(r, a.region)) return;
    r.value = a.region;
    await call('loadAddrCascade', prefix, 'province');
    var p = $(prefix + '-province');
    if (a.province && hasOption(p, a.province)) p.value = a.province;
    if (a.province && a.province !== '__ncr__' && a.province !== '__none__') await call('loadAddrCascade', prefix, 'city');
    var c = $(prefix + '-city');
    if (a.city && hasOption(c, a.city)) c.value = a.city; else { call('buildAddrString', prefix); return; }
    await call('loadAddrCascade', prefix, 'brgy');
    var b = $(prefix + '-brgy');
    if (a.brgy && hasOption(b, a.brgy)) b.value = a.brgy;
    call('buildAddrString', prefix);
  }

  async function waitFor(fn, ms) {
    var t0 = Date.now();
    while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch (e) {} await sleep(100); }
    return false;
  }

  async function restoreAvatar(f) {
    var rec = await FileStore.get('avatar'); if (!rec || !rec.blob) return false;
    // Gallery uploads no longer exist. A saved photo is only trusted if the draft says it passed the live face scan
    // (the hidden #selfie-verified flag is restored with the other fields before this runs). Older drafts → retake.
    if (!call('selfieIsVerified')) { call('clearSelfiePhoto'); return false; }
    var file = new File([rec.blob], rec.name || 'avatar.jpg', { type: rec.type || 'image/jpeg' });
    call('previewAvatarViewfinder', { target: { files: [file] } });
    call('setStep4Mode', 'captured');
    var ok = await waitFor(function () { var fr = $('av-vf-frame'); return typeof _vfNatImg !== 'undefined' && _vfNatImg && fr && !fr.classList.contains('hidden'); }, 6000);
    if (!ok) return true;   // file is restored even if the crop box could not be re-applied
    try {
      var cx = parseFloat(f['avatar-crop-x']), cy = parseFloat(f['avatar-crop-y']), cs = parseFloat(f['avatar-crop-size']);
      if (!isNaN(cx) && !isNaN(cy) && !isNaN(cs)) {
        var b = _getRenderedImageBounds();
        if (b) {
          _cropSize = (cs / 100 * _vfNatImg.naturalWidth) * b.scale;
          _cropX = b.x + (cx / 100 * _vfNatImg.naturalWidth) * b.scale;
          _cropY = b.y + (cy / 100 * _vfNatImg.naturalHeight) * b.scale;
          _clampCrop(b); _applyCropFrame();
        }
      }
    } catch (e) { console.warn('[RegResilience] crop restore skipped', e); }
    return true;
  }

  function showStep(n) {
    for (var i = 1; i <= 5; i++) { var el = $('step-' + i); if (el) el.classList.toggle('hidden', i !== n); }
    var ok = $('step-ok'); if (ok) ok.classList.add('hidden');
    try { currentStep = n; } catch (e) {}
    call('updateProgress', n);
    var sc = document.querySelector('.overflow-y-auto'); if (sc) sc.scrollTop = 0;
    if (n === 5) call('loadRoomPreferences', false);   // resumed straight onto Step 5 → populate the live room list
  }

  async function restoreDraft(d) {
    state.restoring = true;
    var restored = { fields: 0, docs: 0, avatar: false };
    try {
      var f = d.fields || {};
      // 1) plain fields
      Object.keys(f).forEach(function (k) {
        if (SPECIAL[k]) return;
        if (k.indexOf('radio:') === 0) {
          var rr = document.querySelector('input[type="radio"][name="' + k.slice(6) + '"][value="' + f[k] + '"]'); if (rr) rr.checked = true; return;
        }
        var el = $(k); if (!el) return;
        if (el.type === 'checkbox') el.checked = !!f[k]; else if (el.tagName !== 'SELECT' || hasOption(el, f[k])) el.value = f[k];
        restored.fields++;
      });
      // 2) school (manual toggles wipe their text, so re-apply it afterwards)
      [['name', 'school-name-manual-toggle', 'reg-school'], ['addr', 'school-addr-manual-toggle', 'reg-schooladdr']].forEach(function (s) {
        if (f[s[1]]) { setChecked(s[1], true); call('toggleSchoolManual', s[0]); setVal(s[2], f[s[2]]); }
      });
      // 3) year level → course → specialization (each rebuilds the next)
      if (f['yearlevel-manual-toggle']) { setChecked('yearlevel-manual-toggle', true); call('toggleYearLevelManualMode'); setVal('reg-yearlevel-manual', f['reg-yearlevel-manual']); }
      else if (f['reg-yearlevel']) { setVal('reg-yearlevel', f['reg-yearlevel']); call('onYearLevelChange'); }
      if (f['course-manual-toggle']) {
        setChecked('course-manual-toggle', true); call('toggleCourseManualMode');
        setVal('reg-course-manual', f['reg-course-manual']); setVal('reg-specialization-manual', f['reg-specialization-manual']);
      } else {
        if (f['reg-course'] && hasOption($('reg-course'), f['reg-course'])) { setVal('reg-course', f['reg-course']); call('onCourseChange'); }
        if (f['specialization-manual-toggle']) {
          setChecked('specialization-manual-toggle', true); call('toggleSpecializationManualMode'); setVal('reg-specialization-manual', f['reg-specialization-manual']);
        } else if (f['reg-specialization'] && hasOption($('reg-specialization'), f['reg-specialization'])) setVal('reg-specialization', f['reg-specialization']);
      }
      // 4) parents "deceased" (hides + clears their fields), then addresses in dependency order
      ['father', 'mother'].forEach(function (p) { if (f[p + '-deceased']) { setChecked(p + '-deceased', true); call('toggleParentDeceased', p); } });
      var addr = d.addr || {};
      await restoreAddr('perm', addr.perm);
      if (f['same-as-permanent']) { setChecked('same-as-permanent', true); call('toggleSameAsPermanent'); }
      else await restoreAddr('pres', addr.pres);
      for (var i = 0; i < ['father', 'mother', 'guardian'].length; i++) {
        var p = ['father', 'mother', 'guardian'][i];
        if ((p === 'father' || p === 'mother') && f[p + '-deceased']) continue;
        if (p === 'guardian') { var gs = $('guardian-section'); if (!gs || gs.classList.contains('hidden')) continue; }
        if (f[p + '-same-as-perm']) { setChecked(p + '-same-as-perm', true); call('toggleParentSameAsPerm', p); }
        else await restoreAddr(p, addr[p]);
      }
      // 5) refresh phone counters / formatting (input handlers)
      ['father-phone', 'mother-phone', 'guardian-phone'].forEach(function (id) { var el = $(id); if (el && el.value) el.dispatchEvent(new Event('input', { bubbles: true })); });
      var rp = $('reg-phone'); if (rp && rp.value) call('validatePhoneInline');
      var rn = $('reg-roommate-note'); if (rn && rn.value) rn.dispatchEvent(new Event('input', { bubbles: true }));   // refresh the 0/300 counter

      // 6) photo + documents
      if (d.step >= 4 || (await FileStore.get('avatar'))) restored.avatar = await restoreAvatar(f);
      for (var k = 0; k < DOC_KEYS.length; k++) {
        var rec = await FileStore.get('doc:' + DOC_KEYS[k]);
        if (rec && rec.blob) {
          var file = new File([rec.blob], rec.name || 'document', { type: rec.type || rec.blob.type });
          call('handleDocFile', { target: { files: [file] } }, DOC_KEYS[k]); restored.docs++;
        }
      }
    } finally { state.restoring = false; }

    // 7) choose the step — never past what the restored data supports
    var target = Math.min(Math.max(d.step || 3, 3), 5);
    if (target >= 4 && !state.revision) {
      var v3 = await call('validateStep', 3);
      if (!v3) target = 3;
    }
    if (target >= 5 && !restored.avatar && !state.revision) target = 4;
    showStep(target);
    state.lastSig = '';
    return restored;
  }

  // ── resume / start-over UI ─────────────────────────────────────────────────
  function banner(html) {
    var old = $('reg-resume-banner'); if (old) old.remove();
    var el = document.createElement('div');
    el.id = 'reg-resume-banner';
    el.className = 'mx-8 mb-3 p-3 rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-800 text-xs flex items-start justify-between gap-3';
    el.innerHTML = '<span>' + html + '</span><button type="button" id="reg-startover" class="font-bold underline whitespace-nowrap">Start over</button>';
    var s1 = $('step-1'); if (s1 && s1.parentNode) s1.parentNode.insertBefore(el, s1);
    el.querySelector('#reg-startover').onclick = startOver;
    setTimeout(function () { if (el.parentNode) el.style.opacity = '0.85'; }, 15000);
  }
  async function startOver() {
    if (!await damisConfirm('Your saved answers will be discarded and the registration starts from the beginning.', { title: 'Start over?', confirmText: 'Start over', tone: 'warning' })) return;
    clearDraft(); markInflight(false);
    try { await fetch(API.RESET, { method: 'POST', credentials: 'same-origin' }); } catch (e) {}
    location.href = '/';
  }

  function showSuccess(email) {
    for (var i = 1; i <= 5; i++) { var el = $('step-' + i); if (el) el.classList.add('hidden'); }
    call('showTab', 'signup');
    var ok = $('step-ok'); if (ok) ok.classList.remove('hidden');
    var pb = $('prog-bar'); if (pb) { pb.style.width = '100%'; pb.style.background = '#f59e0b'; }
    var ce = $('reg-confirm-email'); if (ce) ce.textContent = email || '';
    onSubmitted();
  }

  /**
   * Called on page load, after returning from Google, and when the server says the e-mail is already verified.
   * Returns true if it took over the UI.
   */
  async function maybeResume(opts) {
    opts = opts || {};
    var st = await fetchStatus();
    if (!st) return false;

    if (st.submitted && !st.active) {            // reply to the submit was lost, but it was saved
      if (lsGet(INFLIGHT_KEY)) { showSuccess(st.email); return true; }
      return false;
    }
    if (!st.active) return false;
    if (opts.googleEmail && norm(opts.googleEmail) !== norm(st.email)) return false;
    if (st.revision && st.emailVerified) {          // an admin returned this applicant's application for correction
      if (await openRevision()) { report('revision_resumed', {}); return true; }
    }

    // show the sign-up panel with the right e-mail
    call('showTab', 'signup');
    var em = $('reg-email');
    if (st.isGoogleSignup) { try { isGoogleSignup = true; } catch (e) {} call('applyGoogleSignupUi', st.email); }
    else if (em) { em.value = st.email; em.readOnly = true; }

    if (!st.emailVerified) {                     // OTP sent, not entered yet
      var oe = $('otp-email'); if (oe) oe.textContent = st.email;
      showStep(2);
      var rt = $('resend-timer'), rb = $('resend-btn'); if (rt) rt.classList.add('hidden'); if (rb) rb.classList.remove('hidden');
      banner('Welcome back — enter the 6-digit code we emailed to <b>' + st.email + '</b>, or tap Resend Code.');
      report('resume_unverified', {});
      return true;
    }

    try { otpVerified = true; } catch (e) {}
    call('lockOtpStepUi');
    await call('initAddrDropdowns');
    var d = loadDraft();
    if (d && norm(d.email) === norm(st.email)) {
      var r = await restoreDraft(d);
      var when = new Date(d.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      banner('Welcome back — your email is already verified and we restored your progress (saved ' + when + ').');
      report('draft_restored', { phase: 'step' + curStep(), code: r.fields + 'f/' + r.docs + 'd/' + (r.avatar ? 'a' : '-') });
    } else {
      showStep(3);
      banner('Welcome back — your email <b>' + st.email + '</b> is already verified, so no new code is needed.');
      report('resume_verified_nodraft', {});
    }
    return true;
  }

  /** After a fresh OTP verification: restore a saved draft for the same e-mail (e.g. the session expired). */
  async function restoreAfterVerify() {
    var d = loadDraft();
    if (!d || norm(d.email) !== verifiedEmail()) return;
    var r = await restoreDraft(d);
    call('showToast', 'Restored your saved answers.', 'info');
    report('draft_restored_after_verify', { code: r.fields + 'f/' + r.docs + 'd/' + (r.avatar ? 'a' : '-') });
  }


  // ── 6. returned application (admin "Reject" = send back for correction) ────────────────────────────────
  // Server: GET /api/auth/revision (session-gated) → { id, email, isGoogle, reason, flags:[{key,label,note,group,step,docKey}],
  // snapshot, docs:{docKey:url}, avatarUrl, idType, fields }. Anything NOT flagged is kept server-side, so the applicant only
  // re-uploads what the admin ticked. Documents the server will keep are shown as "kept"; flagged ones must be replaced.
  function escH(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function safeUrl(u) { return /^https?:\/\//i.test(u || '') ? u : ''; }
  function revFlags() { var rev = global._revision; return rev && rev.flags ? rev.flags : []; }
  function revFlagged(key) { return revFlags().some(function (f) { return f.key === key; }); }
  function keepsSelfie() {
    var rev = global._revision; if (!rev || !rev.avatarUrl || revFlagged('selfie')) return false;
    var f = null, d = null;
    try { f = avatarFileRef; } catch (e) {}
    try { d = capturedPhotoData; } catch (e) {}
    return !(f || d);
  }

  function clearRevisionUI() {
    Array.prototype.slice.call(document.querySelectorAll('.rev-ui')).forEach(function (el) { el.remove(); });
    DOC_KEYS.forEach(function (k) { var z = $('doc-zone-' + k); if (z) z.classList.remove('hidden'); });
  }

  /** Keeps the per-document boxes (and the kept-selfie box) in sync with what the applicant did. `mode` = Step 4 mode, when called from setStep4Mode(). */
  function revRefresh(mode) {
    var rev = global._revision; if (!rev) return;
    DOC_KEYS.forEach(function (k) {
      var box = $('rev-doc-' + k), zone = $('doc-zone-' + k); if (!box || !zone) return;
      var flag = revFlags().filter(function (x) { return x.docKey === k; })[0];
      var hasNew = !!(global._damis_docs && global._damis_docs[k]);
      var keptUrl = safeUrl(global._damis_kept && global._damis_kept[k]);
      var cls = 'mb-2 p-3 rounded-xl border text-sm ', html = '', hideZone = false;
      if (hasNew) {
        cls += 'border-green-300 bg-green-50 text-green-800 dark:bg-green-950/30 dark:text-green-200 dark:border-green-700';
        html = '<span class="font-semibold">&#10003; New file selected &mdash; it replaces ' + (flag ? 'the file the admin rejected' : 'the saved one') + '.</span>';
      } else if (flag) {
        cls += 'border-red-300 bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-200 dark:border-red-700';
        html = '<span class="font-bold"><i class="fa-solid fa-triangle-exclamation mr-1"></i>The admin asked you to replace this document.</span>' +
               (flag.note ? '<br><span class="text-xs">Admin: ' + escH(flag.note) + '</span>' : '') + '<br><span class="text-xs">Upload a new file below.</span>';
      } else if (keptUrl) {
        cls += 'border-green-300 bg-green-50 text-green-800 dark:bg-green-950/30 dark:text-green-200 dark:border-green-700 flex flex-wrap items-center gap-2';
        html = '<span class="font-semibold flex-1" style="min-width:10rem">&#10003; Saved from your earlier application &mdash; kept as is.</span>' +
               '<a href="' + escH(keptUrl) + '" target="_blank" rel="noopener" class="inline-flex items-center min-h-[44px] px-3 text-xs font-bold underline">View</a>' +
               '<button type="button" data-rev-replace class="min-h-[44px] px-3 rounded-xl border border-green-400 text-xs font-bold">Replace</button>';
        hideZone = true;
      } else { box.className = 'hidden'; box.innerHTML = ''; zone.classList.remove('hidden'); return; }
      box.className = 'rev-ui ' + cls; box.innerHTML = html;
      zone.classList.toggle('hidden', hideZone);
      var rb = box.querySelector('[data-rev-replace]');
      if (rb) rb.onclick = function () { zone.classList.remove('hidden'); var fi = $('doc-file-' + k); if (fi) fi.click(); };
    });
    if (mode) {   // Step 4: show the accepted photo instead of the empty camera placeholder while the applicant has not retaken it
      var keep = keepsSelfie() && mode === 'idle', kb = $('rev-kept-avatar');
      if (kb) kb.classList.toggle('hidden', !keep);
      if (keep) ['av-placeholder-wrap', 'btn-selfie-start', 'selfie-hint'].forEach(function (id) { var el = $(id); if (el) el.classList.add('hidden'); });
    }
  }

  /** '' when fine, otherwise a message. scope 'info' = flagged information was confirmed; 'docs' = flagged documents were replaced. */
  function revisionCheck(scope) {
    if (!global._revision) return '';
    if (scope === 'info') {
      var unacked = revFlags().filter(function (f) {
        if (f.group !== 'info') return false;
        var cb = document.querySelector('[data-rev-ack="' + f.key + '"]');
        return !(cb && cb.checked);
      });
      if (unacked.length) {
        var box = $('rev-ack-box'); if (box && box.scrollIntoView) { try { box.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {} }
        return 'The admin flagged: ' + unacked.map(function (f) { return f.label; }).join('; ') + '. Fix it, then tick \u201cI have corrected / checked this\u201d just above the Continue button.';
      }
    } else if (scope === 'docs') {
      var miss = revFlags().filter(function (f) { return f.docKey && !(global._damis_docs && global._damis_docs[f.docKey]); });
      if (miss.length) return 'The admin asked you to replace: ' + miss.map(function (f) { return f.label; }).join('; ') + '. Please upload a new file for each.';
    }
    return '';
  }
  function revisionAck() {
    return Array.prototype.slice.call(document.querySelectorAll('[data-rev-ack]')).filter(function (cb) { return cb.checked; })
      .map(function (cb) { return cb.getAttribute('data-rev-ack'); });
  }

  function buildRevisionUI(rev) {
    clearRevisionUI();
    var flags = rev.flags || [];
    // 1) banner: the admin's comment + the checklist
    var s1 = $('step-1');
    if (s1 && s1.parentNode) {
      var b = document.createElement('div');
      b.id = 'rev-banner';
      b.className = 'rev-ui mx-4 sm:mx-8 mb-3 p-4 rounded-xl border-2 border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200 dark:border-amber-700 text-sm';
      var h = '<p class="font-bold text-base flex items-start gap-2"><i class="fa-solid fa-triangle-exclamation mt-1 flex-shrink-0"></i><span>Your application needs corrections</span></p>';
      if (rev.reason) h += '<p class="mt-2 break-words" style="white-space:pre-wrap"><strong>Admin comment:</strong> ' + escH(rev.reason) + '</p>';
      if (flags.length) h += '<p class="mt-3 font-semibold">Please correct or replace:</p><ul class="list-disc pl-5 mt-1 space-y-1">' +
        flags.map(function (f) { return '<li><strong>' + escH(f.label) + '</strong>' + (f.note ? ' &mdash; ' + escH(f.note) : '') + '</li>'; }).join('') + '</ul>';
      h += '<p class="mt-3 text-xs leading-snug">Nothing you entered was lost. Fix only the items above, then submit again on the last step.' +
           (rev.snapshot ? '' : ' This application was saved by an older version of the form &mdash; please double-check your address, school and course below.') + '</p>';
      b.innerHTML = h;
      s1.parentNode.insertBefore(b, s1);
    }
    // 2) Step 3: confirm each flagged piece of information
    var infoFlags = flags.filter(function (f) { return f.group === 'info'; }), err3 = $('err-3');
    if (infoFlags.length && err3 && err3.parentNode) {
      var ab = document.createElement('div');
      ab.id = 'rev-ack-box';
      ab.className = 'rev-ui mb-4 p-3 rounded-xl border-2 border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200 dark:border-amber-700';
      ab.innerHTML = '<p class="text-sm font-bold">Confirm your corrections</p><p class="text-xs mb-1">The admin flagged the information below. Review it above, fix anything wrong, then tick each box.</p>' +
        infoFlags.map(function (f) {
          return '<label class="flex items-start gap-3 min-h-[44px] py-2 cursor-pointer text-sm"><input type="checkbox" data-rev-ack="' + escH(f.key) + '" class="mt-0.5 w-5 h-5 flex-shrink-0 accent-blue-600"/>' +
                 '<span><strong>' + escH(f.label) + '</strong>' + (f.note ? '<br><span class="text-xs">Admin: ' + escH(f.note) + '</span>' : '') +
                 '<br><span class="text-xs">I have corrected / checked this.</span></span></label>';
        }).join('');
      err3.parentNode.insertBefore(ab, err3);
    }
    // 3) Step 4: selfie flagged → say so; otherwise show the accepted photo (kept unless retaken)
    var s4 = $('step-4');
    if (s4) {
      var sf = flags.filter(function (f) { return f.key === 'selfie'; })[0];
      if (sf) {
        var n4 = document.createElement('div');
        n4.className = 'rev-ui mb-3 p-3 rounded-xl border border-red-300 bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-200 dark:border-red-700 text-sm';
        n4.innerHTML = '<span class="font-bold"><i class="fa-solid fa-triangle-exclamation mr-1"></i>The admin asked you to retake your selfie.</span>' + (sf.note ? '<br><span class="text-xs">Admin: ' + escH(sf.note) + '</span>' : '');
        s4.insertBefore(n4, s4.firstChild);
      } else if (safeUrl(rev.avatarUrl)) {
        var kb = document.createElement('div');
        kb.id = 'rev-kept-avatar';
        kb.className = 'rev-ui hidden flex items-center gap-4 mb-4 p-3 rounded-xl border border-green-300 bg-green-50 text-green-800 dark:bg-green-950/30 dark:text-green-200 dark:border-green-700';
        kb.innerHTML = '<img src="' + escH(safeUrl(rev.avatarUrl)) + '" alt="Your saved profile photo" class="w-20 h-20 rounded-xl object-cover flex-shrink-0"/>' +
          '<div class="min-w-0"><p class="text-sm font-bold">&#10003; Your profile photo was accepted</p><p class="text-xs">You can keep it. Retake it only if you want to change it.</p>' +
          '<button type="button" data-rev-retake class="mt-2 min-h-[44px] px-4 rounded-xl border border-green-400 text-xs font-bold">Retake selfie</button></div>';
        var sp = $('selfie-panel'); if (sp && sp.parentNode) sp.parentNode.insertBefore(kb, sp); else s4.insertBefore(kb, s4.firstChild);
        var rt = kb.querySelector('[data-rev-retake]'); if (rt) rt.onclick = function () { call('doModeSelfie'); };
      }
    }
    // 4) Step 5: one status box above each document slot
    DOC_KEYS.forEach(function (k) {
      var zone = $('doc-zone-' + k); if (!zone || !zone.parentNode) return;
      var box = document.createElement('div'); box.id = 'rev-doc-' + k; box.className = 'hidden';
      zone.parentNode.insertBefore(box, zone);
    });
  }

  // ── Records rejected BEFORE wizard snapshots existed: rebuild the form from the saved database columns ─────────────
  // The columns hold the TEXT the wizard produced (address string, "3rd Year", course code …), so every dropdown is matched
  // back by its visible text. Anything that cannot be matched is left empty and Step 3 validation makes the applicant pick it.
  function nrmTxt(s) { return String(s == null ? '' : s).replace(/\s+\(\d{4}\)$/, '').replace(/\s+/g, ' ').trim().toLowerCase(); }
  function optByText(sel, text) {
    var t = nrmTxt(text); if (!sel || !t) return null;
    for (var i = 0; i < sel.options.length; i++) { var o = sel.options[i]; if (o.value && nrmTxt(o.text) === t) return o; }
    return null;
  }
  function isPlaceholderText(s) { return !s || /^[\u2014\u2013-]|^select\b/i.test(String(s).trim()); }   // "— Select Year Level —" etc. is not an answer
  function catalogEntry(code) {
    var c = String(code || '').trim().toLowerCase(), list = global.ASCOT_COURSES;
    if (!c || !Array.isArray(list)) return null;
    for (var i = 0; i < list.length; i++) if (String(list[i].value).toLowerCase() === c) return list[i];
    return null;
  }

  /**
   * "[Purok - ]Barangay, City/Municipality, [Province,] Region, Philippines" → Region → Province → City → Barangay dropdowns + purok.
   * Works right-to-left, one level at a time, because each level's list depends on the one above. Returns true when the barangay was matched.
   */
  async function restoreAddrFromString(prefix, str) {
    var parts = String(str || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    if (parts.length && /^philippines$/i.test(parts[parts.length - 1])) parts.pop();
    var r = $(prefix + '-region'); if (!parts.length || !r) return false;
    var ro = optByText(r, parts[parts.length - 1]);
    if (!ro) { console.warn('[RegResilience] ' + prefix + ' address: region not recognised — "' + str + '"'); return false; }
    parts.pop(); r.value = ro.value;
    await call('loadAddrCascade', prefix, 'province');
    var p = $(prefix + '-province');
    if (p && p.value !== '__ncr__' && p.value !== '__none__') {            // NCR / regions without provinces go straight to cities
      var po = parts.length ? optByText(p, parts[parts.length - 1]) : null;
      if (!po) { call('buildAddrString', prefix); return false; }
      p.value = po.value; parts.pop();
      await call('loadAddrCascade', prefix, 'city');
    }
    var c = $(prefix + '-city'), co = parts.length ? optByText(c, parts[parts.length - 1]) : null;
    if (!co) { call('buildAddrString', prefix); return false; }
    c.value = co.value; parts.pop();
    await call('loadAddrCascade', prefix, 'brgy');
    var b = $(prefix + '-brgy'), seg = parts.length ? parts[parts.length - 1] : '';
    if (seg && b) {
      var bo = optByText(b, seg), purok = '', idx = seg.indexOf(' - ');
      while (!bo && idx > -1) {                                           // "Purok 3 - Barangay": barangay names may contain " - " too, so try every split
        bo = optByText(b, seg.slice(idx + 3));
        if (bo) purok = seg.slice(0, idx); else idx = seg.indexOf(' - ', idx + 3);
      }
      if (bo) { b.value = bo.value; var pk = $(prefix + '-purok'); if (pk && purok && !pk.value) pk.value = purok; }
    }
    call('buildAddrString', prefix);
    return !!(b && b.value);
  }

  function restoreSchoolFromColumns(f) {
    var nm = String(f.schoolName || '').trim(), ad = String(f.schoolAddress || '').trim();
    if (nm && nrmTxt(nm).indexOf('aurora state college of technology') !== 0) { setChecked('school-name-manual-toggle', true); call('toggleSchoolManual', 'name'); setVal('reg-school', nm); }
    if (ad && nrmTxt(ad) !== 'zabali, baler, aurora')                          { setChecked('school-addr-manual-toggle', true); call('toggleSchoolManual', 'addr'); setVal('reg-schooladdr', ad); }
  }

  /** Year level first (it filters the course list), then course, then major — the same order the wizard itself uses. */
  function restoreYearCourseFromColumns(f) {
    var yl = String(f.yearLevel || '').trim(), yearOk = false;
    if (!isPlaceholderText(yl)) {
      var ys = $('reg-yearlevel'), m = /^\s*([1-5])(?:st|nd|rd|th)?\b/i.exec(yl), yo = optByText(ys, yl);
      if (!yo && m && hasOption(ys, m[1])) yo = { value: m[1] };
      if (yo) { ys.value = yo.value; call('onYearLevelChange'); }
      else { setChecked('yearlevel-manual-toggle', true); call('toggleYearLevelManualMode'); setVal('reg-yearlevel-manual', yl); }   // typed via "Not listed"
      yearOk = true;
    }
    var code = String(f.course || '').trim(), spec = String(f.specialization || '').trim();
    if (!code && !spec) return;
    var entry = catalogEntry(code) || catalogEntry(spec), cs = $('reg-course');
    if (entry && yearOk && cs && hasOption(cs, entry.family)) {
      cs.value = entry.family; call('onCourseChange');
      var ss = $('reg-specialization');
      if (entry.major && ss && hasOption(ss, entry.value)) ss.value = entry.value;
      return;
    }
    if (entry && !yearOk) return;   // the course list is locked until a year level is chosen — the applicant picks both again
    // not a catalog code (typed via "Not listed"), or not offered for that year level → keep exactly what was saved, as text
    setChecked('course-manual-toggle', true); call('toggleCourseManualMode');
    setVal('reg-course-manual', code || spec); setVal('reg-specialization-manual', spec && spec !== code ? spec : '');
  }

  async function restoreLegacy(rev) {
    var f = rev.fields || {};
    function tenDigits(p) { var d = String(p || '').replace(/\D/g, ''); return d.slice(-10); }
    setVal('reg-fname', f.firstName); setVal('reg-mname', f.middleName); setVal('reg-lname', f.lastName); setVal('reg-suffix', f.suffix);
    setVal('reg-bday', f.birthday); setVal('reg-bio', f.bio);
    if (f.civilStatus && hasOption($('reg-civil'), f.civilStatus)) setVal('reg-civil', f.civilStatus);
    if (f.monthlyIncome && hasOption($('reg-income'), f.monthlyIncome)) setVal('reg-income', f.monthlyIncome);
    Array.prototype.forEach.call(document.querySelectorAll('input[name="sex"]'), function (rd) { if (String(rd.value).toLowerCase() === String(f.sex || '').toLowerCase()) rd.checked = true; });
    var ph = $('reg-phone'); if (ph && f.phone) { ph.value = tenDigits(f.phone); call('formatPhone', ph); call('validatePhoneInline'); }

    restoreSchoolFromColumns(f);
    restoreYearCourseFromColumns(f);

    var fam = [['father', f.fatherInfo], ['mother', f.motherInfo], ['guardian', f.guardianInfo]].map(function (pair) {
      var o = null; try { o = pair[1] ? JSON.parse(pair[1]) : null; } catch (e) {}
      return { p: pair[0], o: o };
    });
    fam.forEach(function (x) {
      var p = x.p, o = x.o; if (!o) return;
      setVal(p + '-fname', o.firstName); setVal(p + '-mname', o.middleName); setVal(p + '-lname', o.lastName); setVal(p + '-suffix', o.suffix);
      if (p === 'guardian') setVal('guardian-relationship', o.relationship);
      if (o.deceased) { setChecked(p + '-deceased', true); call('toggleParentDeceased', p); }
      else { var pp = $(p + '-phone'); if (pp && o.phone) { pp.value = tenDigits(o.phone); pp.dispatchEvent(new Event('input', { bubbles: true })); } setVal(p + '-employer', o.employer); }
    });
    if (f.roomPreference != null) setVal('reg-room-pref', f.roomPreference);
    setVal('reg-roommate-note', f.roommateNote);

    // Addresses last (they need the network / bundled PSGC lists). Identical to the permanent address → the "Same as Permanent" box.
    var perm = String(f.permanentAddress || '').trim(), pres = String(f.presentAddress || '').trim();
    await restoreAddrFromString('perm', perm);
    if (pres && pres === perm) { setChecked('same-as-permanent', true); call('toggleSameAsPermanent'); }
    else await restoreAddrFromString('pres', pres);
    for (var i = 0; i < fam.length; i++) {
      var p = fam[i].p, o = fam[i].o, addr = o && !o.deceased ? String(o.address || '').trim() : '';
      if (!addr) continue;
      if (p === 'guardian') { var gs = $('guardian-section'); if (!gs || gs.classList.contains('hidden')) continue; }
      if (perm && addr === perm) { setChecked(p + '-same-as-perm', true); call('toggleParentSameAsPerm', p); }
      else await restoreAddrFromString(p, addr);
    }
  }

  /**
   * Reopen the wizard for an application an admin sent back. Called after login ("applicationReturned"), after Google
   * sign-in, after a fresh e-mail OTP (verify-otp says revision:true) and on page reload (registration-status says revision:true).
   * Returns true when it took over the UI.
   */
  async function openRevision() {
    var rev = null;
    try {
      var resp = await fetch(API.REVISION, { cache: 'no-store', credentials: 'same-origin' });
      if (!resp.ok) return false;
      rev = (await resp.json()).revision;
    } catch (e) { return false; }
    if (!rev) return false;

    global._revision = rev; state.revision = rev;
    global._damis_kept = {};
    DOC_KEYS.forEach(function (k) {
      var flagged = revFlags().some(function (f) { return f.docKey === k; });
      if (rev.docs && rev.docs[k] && !flagged) global._damis_kept[k] = rev.docs[k];
    });

    call('showTab', 'signup');
    var em = $('reg-email');
    if (rev.isGoogle) { var already = false; try { already = isGoogleSignup; } catch (e) {} if (!already) call('applyGoogleSignupUi', rev.email); }
    else if (em) { em.value = rev.email; em.readOnly = true; }
    try { otpVerified = true; } catch (e) {}
    call('lockOtpStepUi');
    await call('initAddrDropdowns');
    buildRevisionUI(rev);

    var flagSteps = revFlags().map(function (f) { return f.step; });
    var startStep = flagSteps.length ? Math.min(5, Math.max(3, Math.min.apply(null, flagSteps))) : 3;
    var d = loadDraft();
    if (d && norm(d.email) === norm(rev.email) && d.rev === rev.id) {
      await restoreDraft(d);                                   // the applicant already started correcting on this device → continue there
    } else {
      await FileStore.clear();                                 // never mix leftovers of another attempt into this application
      if (rev.snapshot) await restoreDraft({ v: 1, email: rev.email, step: startStep, fields: rev.snapshot.fields || {}, addr: rev.snapshot.addr || {} });
      else { state.restoring = true; try { await restoreLegacy(rev); } finally { state.restoring = false; } showStep(startStep); }
      if (rev.idType && hasOption($('reg-id-type'), rev.idType)) setVal('reg-id-type', rev.idType);
    }
    // The wizard opens on the first FLAGGED step, which may be 4 or 5. If anything in Step 3 is still missing after the restore
    // (an old record, an address that could not be matched …), open on Step 3 instead so nothing incomplete can be submitted.
    if (curStep() > 3) {
      var step3Ok = await call('validateStep', 3);
      if (!step3Ok) { showStep(3); report('revision_step3_incomplete', { phase: rev.snapshot ? 'snapshot' : 'legacy' }); }
    }
    state.lastSig = '';
    revRefresh(keepsSelfie() ? 'idle' : 'other');
    report('revision_opened', { code: (rev.flags || []).map(function (f) { return f.key; }).join(',') || 'comment-only', phase: rev.snapshot ? 'snapshot' : 'legacy' });
    return true;
  }

  // ── hooks called from auth.js ──────────────────────────────────────────────
  function onStepChange(step) { saveDraft(); if (step >= 5) persistAvatar(); }
  function onDocSelected(key, file) {
    revRefresh();
    if (state.restoring) return;
    prepareFile('doc:' + key, file, IMG.EDGE_DOC)
      .then(function (r) { return canSave() ? FileStore.put('doc:' + key, r.blob, r.name) : null; })
      .catch(function () {});
  }
  function onDocCleared(key) { delete prepared['doc:' + key]; FileStore.del('doc:' + key); revRefresh(); }
  function onSubmitted() { state.submitted = true; markInflight(false); lsDel(DRAFT_KEY); FileStore.clear(); clearRevisionUI(); global._revision = null; global._damis_kept = {}; state.revision = null; }

  var debounceT = null;
  function init() {
    if (state.inited) return; state.inited = true;
    ['input', 'change'].forEach(function (ev) {
      document.addEventListener(ev, function () { clearTimeout(debounceT); debounceT = setTimeout(saveDraft, 600); }, true);
    });
    // periodic: crop box / avatar changes fire no input events
    state.timer = setInterval(function () { if (document.visibilityState === 'visible') { saveDraft(); persistAvatar(); } }, 2000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        saveDraft();
        if (state.uploading) { state.backgrounded = true; report('upload_backgrounded', { elapsedMs: Date.now() - (state.uploadCtx && state.uploadCtx.t0 || Date.now()) }); }
      }
    });
    global.addEventListener('pagehide', function () {
      saveDraft();
      if (state.uploading) report('upload_interrupted_page_left', { elapsedMs: Date.now() - (state.uploadCtx && state.uploadCtx.t0 || Date.now()), files: state.uploadCtx && state.uploadCtx.files, backgrounded: state.backgrounded });
    });
  }

  global.RegResilience = {
    init: init, maybeResume: maybeResume, restoreAfterVerify: restoreAfterVerify,
    prepareFiles: prepareFiles, submit: submit, report: report, explain: explain,
    onStepChange: onStepChange, onDocSelected: onDocSelected, onDocCleared: onDocCleared, onSubmitted: onSubmitted,
    isUploading: function () { return state.uploading; },
    openRevision: openRevision, revRefresh: revRefresh, revisionCheck: revisionCheck, revisionAck: revisionAck,
    snapshot: function () { return captureDraft(); },
    progressUI: ui, fmtBytes: fmtBytes,
    _test: { compressImage: compressImage, captureDraft: captureDraft, restoreDraft: restoreDraft, loadDraft: loadDraft, saveDraft: saveDraft, FileStore: FileStore, uploadWithProgress: uploadWithProgress, state: state },
  };
})(window);
