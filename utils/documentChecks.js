/**
 * utils/documentChecks.js — free, no-AI checks on the 5 Step-5 documents + the tables behind the admin badges
 *
 * WHY THIS EXISTS
 *   Some applicants upload ONE photo/file for all five document slots. These checks run on the server at
 *   upload time (before anything is sent to Cloudinary), cost nothing, and tell the applicant exactly which
 *   document failed and why:
 *     1. the same file / same picture used in two different slots          → REJECT   (DOC_DUPLICATE)
 *     2. image too small to read                                           → REJECT   (DOC_TOO_SMALL)
 *     3. image blank / almost entirely one colour                          → REJECT   (DOC_BLANK)
 *     4. image the server cannot open at all                               → REJECT   (DOC_UNREADABLE)
 *     5. photo too blurry to read, or too dark to read                     → REJECT   (DOC_BLURRY / DOC_TOO_DARK)
 *        so an unreadable document is refused at submit and never reaches the admin's queue.
 *        Blur = variance of the Laplacian (edge strength) on a <=640px greyscale copy. Calibrated on real phone
 *        photos of certificates/IDs: legible ones scored 119-1950; the same photos with a light blur (sigma 1.5,
 *        text already hard to read) scored 5-37. Default limit 20 sits in that gap (kept low on purpose: a wrongly refused applicant costs more than a blurry one the admin can return); a small ID card on a big plain
 *        background is the lowest legitimate case seen (119). Darkness = mean brightness below 40 of 255.
 *     6. file already used by a DIFFERENT applicant (other e-mail)         → FLAG only (shown to the admin)
 *   Flag, not reject, for #5: siblings legitimately share a Certificate of Low Income, and a returning resident
 *   can reuse an old certificate. The admin decides.
 *
 * HOW "SAME PICTURE" IS DETECTED
 *   - sha256 of the bytes: catches the identical file.
 *   - a 32x32 greyscale thumbnail of each image, compared by Pearson correlation (contrast-normalised, so it does
 *     not care about brightness, JPEG quality or resizing): catches the same photo re-compressed / resized (the
 *     browser already shrinks photos before upload, so byte hashes alone are not enough). Two images are "the same
 *     picture" when the correlation is at least DOC_DUP_SIMILARITY (default 0.985; the same photo re-saved scores
 *     0.985+ even when shrunk and re-compressed hard, two different pages of the same template scored ~0.96 and unrelated documents ~0.6 in testing).
 *     (A bit-hash such as dHash was tried first: on mostly-white documents most of its bits compare white against
 *     white, so JPEG noise flips them and re-compressed copies slipped through.)
 *   Not caught on purpose: the same photo rotated or cropped (the AI badge in the admin view helps there).
 *
 * TABLE (created lazily, so it also comes back after an admin restores an older .db backup)
 *   document_checks   one row per applicant + slot: fingerprint, duplicate flag, AI verdict, AI "same document as",
 *                     auto-rotation applied. Rows are NOT deleted when an application is returned for correction
 *                     (the user row is), so a resubmission can be compared with the documents it kept.
 *
 * ENV
 *   DOC_CHECK=off          switch the upload-time checks off completely
 *   DOC_MIN_SIDE=300       shortest allowed image side in pixels
 *   DOC_MIN_SHARPNESS=20   Laplacian-variance limit below which a photo counts as blurry (0 = switch the blur check off)
 *   DOC_MIN_BRIGHTNESS=40  mean brightness (0-255) below which a photo counts as too dark (0 = off)
 *   DOC_DUP_SIMILARITY=0.985  thumbnail correlation (0-1) at or above which two images count as "the same picture"
 */

const crypto = require('crypto');
const log    = require('./logger');
// liveDb on purpose (not the `db` proxy): this data belongs to the live applicants, and the proxy can point at a
// READ-ONLY archive snapshot while an admin has one set Active (see the note at the top of utils/db.js).
const { liveDb: db, genId } = require('./db');

// slot (= multer field name) → label shown to people + the id_verification_requests column that stores the URL
const SLOTS = {
  id_front:        { label: 'School ID / Government ID',                 column: 'id_front_url' },
  cert_residency:  { label: 'Certificate of Residency',                  column: 'cert_residency_url' },
  cert_low_income: { label: 'Certificate of Low Income',                 column: 'cert_low_income_url' },
  cert_enrollment: { label: 'Certificate of Registration/Enrollment',    column: 'cert_enrollment_url' },
  cert_grades:     { label: 'Report Card / Certificate of Grades',       column: 'cert_grades_url' },
};
const SLOT_KEYS = Object.keys(SLOTS);
// slot → key of the matching item in utils/applicationRevision.js REVISION_ITEMS (the admin's "return for correction" checklist)
const FLAG_BY_SLOT = { id_front: 'doc_school_id', cert_residency: 'doc_residency', cert_low_income: 'doc_low_income', cert_enrollment: 'doc_enrollment', cert_grades: 'doc_grades' };

const MIN_SIDE    = Math.max(100, parseInt(process.env.DOC_MIN_SIDE, 10) || 300);
const DUP_SIMILARITY = Math.min(0.9999, Math.max(0.8, parseFloat(process.env.DOC_DUP_SIMILARITY) || 0.985));
const MIN_SHARPNESS  = Math.max(0, Number.isFinite(parseFloat(process.env.DOC_MIN_SHARPNESS)) ? parseFloat(process.env.DOC_MIN_SHARPNESS) : 20);
const MIN_BRIGHTNESS = Math.max(0, Number.isFinite(parseFloat(process.env.DOC_MIN_BRIGHTNESS)) ? parseFloat(process.env.DOC_MIN_BRIGHTNESS) : 40);
const BLANK_STDEV = 5;           // grayscale standard deviation (0-255) below which an image counts as blank
const MIN_FILE_BYTES = 1024;     // anything smaller than 1 KB cannot be a real document

// ───────────────────────── schema ─────────────────────────
function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_checks (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      slot            TEXT NOT NULL,
      sha256          TEXT DEFAULT '',
      thumb           TEXT DEFAULT '',          -- 32x32 greyscale thumbnail (base64) used to spot "same picture"
      applicant_email TEXT DEFAULT '',
      applicant_name  TEXT DEFAULT '',
      dup_note        TEXT DEFAULT '',
      ai_status       TEXT DEFAULT 'pending',   -- pending | running | done | skipped
      ai_verdict      TEXT DEFAULT '',          -- match | mismatch | unsure | unreadable
      ai_detected     TEXT DEFAULT '',          -- what the AI thinks the document is (human label)
      ai_confidence   REAL DEFAULT NULL,
      ai_note         TEXT DEFAULT '',
      ai_same_as      TEXT DEFAULT '',          -- slot of ANOTHER document the AI thinks is the same physical page
      ai_rotation     INTEGER DEFAULT 0,        -- degrees (clockwise) the image was auto-rotated to make it upright
      ai_checked_at   TEXT DEFAULT NULL,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, slot)
    );
    CREATE INDEX IF NOT EXISTS idx_doccheck_sha  ON document_checks(sha256);
    CREATE INDEX IF NOT EXISTS idx_doccheck_user ON document_checks(user_id);
    CREATE INDEX IF NOT EXISTS idx_doccheck_email ON document_checks(applicant_email);

  `);
}

// ───────────────────────── image inspection ─────────────────────────
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/**
 * How alike two stored thumbnails are, 0..1 (Pearson correlation of the pixel values, so brightness / contrast /
 * JPEG quality / resizing do not matter). 0 when either is missing or flat (a blank image has no pattern to match).
 */
function similarity(a, b) {
  if (!a || !b) return 0;
  const x = Buffer.from(a, 'base64'), y = Buffer.from(b, 'base64');
  if (x.length !== y.length || !x.length) return 0;
  let sx = 0, sy = 0;
  for (let i = 0; i < x.length; i++) { sx += x[i]; sy += y[i]; }
  const mx = sx / x.length, my = sy / y.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx < 1e-6 || syy < 1e-6) return 0;
  return sxy / Math.sqrt(sxx * syy);
}
const sameThumb = (a, b) => similarity(a, b) >= DUP_SIMILARITY;

/**
 * Look inside one image. Returns { width, height, stdev, thumb } or throws if sharp cannot decode it.
 * Works on one tiny 32x32 greyscale copy, so it takes a few milliseconds even for a 12-megapixel phone photo.
 */
async function inspectImage(buffer) {
  const sharp = require('sharp');
  const meta = await sharp(buffer, { failOn: 'none' }).rotate().metadata();   // rotate() = honour EXIF, like the viewer does
  const width = meta.width || 0, height = meta.height || 0;

  const small = await sharp(buffer, { failOn: 'none' }).rotate().greyscale()
    .resize(32, 32, { fit: 'fill' }).raw().toBuffer();

  // Blank test: standard deviation of the same thumbnail
  let sum = 0; for (let i = 0; i < small.length; i++) sum += small[i];
  const mean = sum / small.length;
  let sq = 0; for (let i = 0; i < small.length; i++) sq += (small[i] - mean) * (small[i] - mean);
  const stdev = Math.sqrt(sq / small.length);

  // Readability: edge strength (blur) + brightness, on a copy no bigger than 640px so a 12 MP photo and a 1 MP photo are judged alike
  const g = sharp(buffer, { failOn: 'none' }).rotate().greyscale().resize(640, 640, { fit: 'inside', withoutEnlargement: true });
  const lap = await g.clone().convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] }).raw().toBuffer();
  let ls = 0, lq = 0; for (let i = 0; i < lap.length; i++) { ls += lap[i]; lq += lap[i] * lap[i]; }
  const sharpness = lq / lap.length - (ls / lap.length) * (ls / lap.length);
  const px = await g.clone().raw().toBuffer();
  let ps = 0; for (let i = 0; i < px.length; i++) ps += px[i];
  const brightness = ps / px.length;

  return { width, height, stdev, sharpness, brightness, thumb: small.toString('base64') };
}

const isImageMime = (m) => /^image\//.test(m || '');

/**
 * Check a set of uploaded files. `files` = { slot: multerFile } (only the slots that were sent).
 * @returns {{ problems: Array<{slot,code,message}>, prints: Object, info: Object }}
 *   prints[slot] = { sha256, dhash }   (stored later with persistFingerprints)
 */
async function inspectFiles(files) {
  const problems = [];
  const prints = {};
  const info = {};

  await Promise.all(Object.keys(files).map(async (slot) => {
    const f = files[slot];
    const label = SLOTS[slot].label;
    const buf = f.buffer;
    prints[slot] = { sha256: sha256(buf), thumb: '' };

    if (buf.length < MIN_FILE_BYTES) {
      problems.push({ slot, code: 'DOC_TOO_SMALL', message: `The file for "${label}" is almost empty (${buf.length} bytes). Please upload the real document.` });
      return;
    }
    if (!isImageMime(f.mimetype)) return;       // PDF / DOCX: only the byte hash is available

    try {
      const r = await inspectImage(buf);
      info[slot] = { width: r.width, height: r.height, stdev: Math.round(r.stdev * 10) / 10, sharp: Math.round(r.sharpness), bright: Math.round(r.brightness) };
      prints[slot].thumb = r.thumb;
      if (Math.min(r.width, r.height) < MIN_SIDE) {
        problems.push({ slot, code: 'DOC_TOO_SMALL', message: `The photo for "${label}" is too small to read (${r.width}×${r.height} px). Take it again closer to the paper, or use a scan/PDF.` });
      } else if (r.stdev < BLANK_STDEV) {
        problems.push({ slot, code: 'DOC_BLANK', message: `The photo for "${label}" looks blank or almost one colour. Make sure the whole document is visible, well lit and in focus.` });
      } else if (MIN_BRIGHTNESS && r.brightness < MIN_BRIGHTNESS) {
        problems.push({ slot, code: 'DOC_TOO_DARK', message: `The photo for "${label}" is too dark to read. Retake it in good light (near a window or with a lamp) without covering the paper with your shadow.` });
      } else if (MIN_SHARPNESS && r.sharpness < MIN_SHARPNESS) {
        problems.push({ slot, code: 'DOC_BLURRY', message: `The photo for "${label}" is blurry and the text cannot be read. Hold the phone steady, tap the document on the screen to focus, and retake it (or upload a scan / PDF).` });
      }
    } catch (e) {
      log.warn(`[DOC-CHECK] could not decode image for ${slot} (${f.originalname}, ${f.mimetype}): ${e.message}`);
      problems.push({ slot, code: 'DOC_UNREADABLE', message: `We could not open the image for "${label}". Please choose it again or take a new photo.` });
    }
  }));

  return { problems, prints, info };
}

/**
 * Same file / same picture in two or more slots of ONE submission. One problem per group of identical documents
 * (so "one photo in all five slots" produces ONE clear message, not ten). We cannot know which of the group is the
 * right one, so every member is named and listed in `slots` for highlighting.
 */
function findInternalDuplicates(prints) {
  const slots = SLOT_KEYS.filter((s) => prints[s]);
  const group = {};                                     // slot → group id (smallest slot index in the group)
  slots.forEach((s, i) => { group[s] = i; });
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = prints[slots[i]], b = prints[slots[j]];
      if (a.sha256 === b.sha256 || sameThumb(a.thumb, b.thumb)) {
        const from = group[slots[j]], to = group[slots[i]];
        if (from !== to) slots.forEach((s) => { if (group[s] === from) group[s] = to; });   // merge groups
      }
    }
  }
  const byGroup = {};
  slots.forEach((s) => { (byGroup[group[s]] = byGroup[group[s]] || []).push(s); });
  const problems = [];
  Object.values(byGroup).filter((g) => g.length > 1).forEach((g) => {
    const names = g.map((s) => `"${SLOTS[s].label}"`);
    const list = names.length === 2 ? `${names[0]} and ${names[1]} are` : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are all`;
    problems.push({
      slot: g[1], slots: g, code: 'DOC_DUPLICATE',
      message: `${list} the same file or photo. Each requirement needs its own, different document — please replace the one${g.length > 2 ? 's' : ''} that ${g.length > 2 ? 'are' : 'is'} not the right document.`,
    });
  });
  return problems;
}

/**
 * Files already stored for OTHER applicants (different e-mail). Returns { slot: "note" } for the admin badge.
 * Scans all fingerprints in JS for the thumbnail comparison — fine for thousands of rows; move to an index if this
 * ever reaches hundreds of thousands.
 */
function findReuseByOthers(prints, email, excludeUserId = '') {
  const flags = {};
  let rows = [];
  try {
    ensureSchema();
    rows = db.prepare(`SELECT user_id, slot, sha256, thumb, applicant_email, applicant_name
                       FROM document_checks WHERE user_id != ? AND LOWER(applicant_email) != LOWER(?)`).all(excludeUserId || '', email || '');
  } catch (e) {
    log.error(`[DOC-CHECK] reuse lookup failed (continuing without it): ${e.message}`);
    return flags;
  }
  for (const slot of Object.keys(prints)) {
    const p = prints[slot];
    const hit = rows.find((r) => r.sha256 === p.sha256 || sameThumb(r.thumb, p.thumb));
    if (hit) {
      const where = SLOTS[hit.slot] ? SLOTS[hit.slot].label : hit.slot;
      flags[slot] = `Same file already used by ${hit.applicant_name || 'another applicant'} (${where})`;
    }
  }
  return flags;
}

function refusal(req, res, problems) {
  const ref = req._id;
  const first = problems[0];
  const message = problems.map((p) => p.message).join(' ');
  log.warn(`[REG-FAIL] ${first.code} (HTTP 422) — ${problems.map((p) => `${p.slot}:${p.code}`).join(', ')} | ref=${ref} email=${((req.session && req.session.pendingRegistration) || {}).email || '—'}`);
  return res.status(422).json({ error: message, code: first.code, field: first.slot, fields: [...new Set(problems.flatMap((p) => p.slots || [p.slot]))], ref });
}

/**
 * Express middleware for POST /api/auth/complete-registration.
 * Runs AFTER multer (files are in memory) and BEFORE processIdDocument (nothing is stored yet), so a rejected
 * applicant costs no Cloudinary uploads. Sets req.docPrints / req.docFlags for persistDocumentFingerprints().
 * Fail-open if the checker itself crashes: a bug here must never block a real applicant.
 */
async function requireDistinctDocuments(req, res, next) {
  if (String(process.env.DOC_CHECK || '').toLowerCase() === 'off') return next();
  try {
    const files = {};
    for (const slot of SLOT_KEYS) {
      const f = req.files && req.files[slot] && req.files[slot][0];
      if (f) files[slot] = f;
    }
    if (!Object.keys(files).length) return next();   // the existing "no documents received" path handles this

    const { problems, prints, info } = await inspectFiles(files);

    // Returned application: documents the applicant did NOT replace are carried over from the saved record, so they are
    // not in req.files. Compare the new uploads with their stored fingerprints too (same e-mail, most recent per slot),
    // otherwise "replace the Residency certificate with a copy of my ID" would slip through.
    const email = ((req.session && req.session.pendingRegistration) || {}).email || '';
    const all = Object.assign({}, prints);
    if (req.revision && email) {
      try {
        ensureSchema();
        const kept = db.prepare(`SELECT slot, sha256, thumb FROM document_checks WHERE LOWER(applicant_email)=LOWER(?) ORDER BY updated_at ASC`).all(email);
        const before = {};
        for (const k of kept) if (SLOTS[k.slot]) before[k.slot] = k;                                                     // later rows overwrite earlier ones
        for (const k of Object.values(before)) if (!prints[k.slot]) all[k.slot] = { sha256: k.sha256, thumb: k.thumb };
        // The admin flagged this document and the applicant sent the very same file again.
        for (const slot of Object.keys(prints)) {
          const b = before[slot];
          if (b && req.revision.flagged && req.revision.flagged.has(FLAG_BY_SLOT[slot]) && (b.sha256 === prints[slot].sha256 || sameThumb(b.thumb, prints[slot].thumb)))
            problems.push({ slot, code: 'DOC_UNCHANGED', message: `The admin asked you to replace "${SLOTS[slot].label}", but this is the same file you sent before. Please upload a new, correct document.` });
        }
        req.docKeptPrints = Object.fromEntries(Object.keys(all).filter((sl) => !prints[sl]).map((sl) => [sl, all[sl]]));
      } catch (e) { log.error(`[DOC-CHECK] could not load kept documents' fingerprints (continuing): ${e.message}`); }
    }
    problems.push(...findInternalDuplicates(all));
    log.info(`[DOC-CHECK] ref=${req._id} ${Object.keys(files).map((s) => `${s}:${info[s] ? `${info[s].width}x${info[s].height} sd=${info[s].stdev} sharp=${info[s].sharp} bright=${info[s].bright}` : 'non-image'}`).join(' ')} → ${problems.length ? `${problems.length} problem(s)` : 'ok'}`);
    if (problems.length) return refusal(req, res, problems);

    req.docPrints = Object.assign({}, prints, req.docKeptPrints || {});
    req.docFlags  = findReuseByOthers(prints, email);
    if (Object.keys(req.docFlags).length) log.warn(`[DOC-CHECK] ref=${req._id} reused files: ${JSON.stringify(req.docFlags)}`);
    return next();
  } catch (e) {
    log.error(`[DOC-CHECK] crashed (letting the request through): ${e.stack || e.message} ref=${req._id}`);
    return next();
  }
}

// ───────────────────────── persistence ─────────────────────────
/** Store fingerprints + duplicate flags for a freshly created applicant. Never throws. */
function persistDocumentFingerprints({ userId, email, name, prints, flags = {} }) {
  if (!userId || !prints) return;
  try {
    ensureSchema();
    const up = db.prepare(`
      INSERT INTO document_checks (id, user_id, slot, sha256, thumb, applicant_email, applicant_name, dup_note)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id, slot) DO UPDATE SET
        sha256=excluded.sha256, thumb=excluded.thumb, dup_note=excluded.dup_note,
        ai_status='pending', ai_verdict='', ai_detected='', ai_confidence=NULL, ai_note='', ai_same_as='', ai_rotation=0, ai_checked_at=NULL,
        updated_at=datetime('now')`);
    db.transaction(() => {
      for (const slot of Object.keys(prints)) {
        up.run(genId(), userId, slot, prints[slot].sha256, prints[slot].thumb || '', email || '', name || '', flags[slot] || '');
      }
    })();
  } catch (e) {
    log.error(`[DOC-CHECK] could not save fingerprints for ${userId}: ${e.message}`);
  }
}

/** { userId: { slot: {...badge data, url} } } for every pending applicant. `url` = the document's current stored URL. */
function getChecksForPendingApplicants() {
  ensureSchema();
  const rows = db.prepare(`
    SELECT c.user_id, c.slot, c.dup_note, c.ai_status, c.ai_verdict, c.ai_detected, c.ai_confidence, c.ai_note, c.ai_same_as, c.ai_rotation
    FROM document_checks c JOIN users u ON u.id = c.user_id WHERE u.account_status = 'pending'`).all();
  const out = {};
  for (const r of rows) {
    (out[r.user_id] = out[r.user_id] || {})[r.slot] = {
      dupNote: r.dup_note || '', aiStatus: r.ai_status, verdict: r.ai_verdict,
      detected: r.ai_detected, confidence: r.ai_confidence, note: r.ai_note || '',
      sameAs: r.ai_same_as || '', rotation: r.ai_rotation || 0,
    };
  }
  // current URLs (rotation changes them), so the admin page can refresh a thumbnail in place
  const vr = db.prepare(`
    SELECT v.user_id, v.id_front_url, v.cert_residency_url, v.cert_low_income_url, v.cert_enrollment_url, v.cert_grades_url
    FROM id_verification_requests v JOIN users u ON u.id = v.user_id
    WHERE u.account_status = 'pending'
      AND v.id = (SELECT id FROM id_verification_requests WHERE user_id = v.user_id ORDER BY created_at DESC LIMIT 1)`).all();
  for (const v of vr) {
    const u = (out[v.user_id] = out[v.user_id] || {});
    for (const slot of SLOT_KEYS) u[slot] = Object.assign(u[slot] || {}, { url: v[SLOTS[slot].column] || '' });
  }
  return out;
}

module.exports = {
  SLOTS, SLOT_KEYS, ensureSchema, sha256, similarity, sameThumb,
  inspectFiles, inspectImage, findInternalDuplicates, findReuseByOthers,
  requireDistinctDocuments, persistDocumentFingerprints, getChecksForPendingApplicants,
  refusal,
};
