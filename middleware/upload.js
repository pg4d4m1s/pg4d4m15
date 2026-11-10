const log = require('../utils/logger');
const { handleUploadError } = require('./uploadDiagnostics');
/**
 * middleware/upload.js
 *
 * Pipeline: Multer (memory) → Sharp (resize/compress) → Cloudinary (store)
 *
 * Falls back gracefully if Cloudinary credentials are missing (dev mode):
 *   converts to base64 data URL so the app still works without Cloudinary.
 */

const multer        = require('multer');
const cloudinary    = require('cloudinary').v2;
const { Readable }  = require('stream');
const os            = require('os');
const fs            = require('fs');
const path          = require('path');
const { execFile }  = require('child_process');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const hasCloudinary = !!(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY    &&
  process.env.CLOUDINARY_API_SECRET
);

if (!hasCloudinary) {
  console.warn('⚠️  Cloudinary not configured — images stored as base64 (dev mode only).');
}

const storage = multer.memoryStorage();
// id_front (school ID / government ID) and certificate fields allow PDFs and Word docs in addition to images
const CERT_FIELDS = new Set(['cert_residency', 'cert_low_income', 'cert_enrollment', 'cert_grades', 'cert_medical', 'id_front']);
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const DOCX_TYPES  = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/msword',  // legacy .doc (rare but accepted)
];
const ALL_DOC_TYPES = [...IMAGE_TYPES, 'application/pdf', ...DOCX_TYPES];

const fileFilter = (req, file, cb) => {
  const allowed = CERT_FIELDS.has(file.fieldname) ? ALL_DOC_TYPES : IMAGE_TYPES;
  if (allowed.includes(file.mimetype)) return cb(null, true);
  // Extra guard: some browsers send wrong MIME for docx — check extension as fallback
  const ext = (file.originalname || '').toLowerCase();
  if (CERT_FIELDS.has(file.fieldname) && (ext.endsWith('.docx') || ext.endsWith('.doc'))) return cb(null, true);
  // Tag the error so the resident gets a specific message (see uploadDiagnostics.describeUploadError)
  const typeErr = new Error(CERT_FIELDS.has(file.fieldname)
    ? 'Only JPG, PNG, WebP, PDF, or DOCX allowed for certificates.'
    : 'Only JPG, PNG, GIF, WebP allowed.');
  typeErr.code = 'BAD_FILE_TYPE';
  typeErr.field = file.fieldname;
  typeErr.mimetype = file.mimetype;
  cb(typeErr, false);
};
const multerUpload = multer({ storage, fileFilter, limits: { fileSize: 15 * 1024 * 1024 } });

/**
 * Verify a file's actual bytes match the type it claims to be, instead of trusting the
 * client-supplied Content-Type / filename extension alone.
 *
 * fileFilter() above only looks at `file.mimetype`, which is whatever the browser (or an
 * attacker's HTTP client) put in the multipart Content-Type header for that field — it is
 * NOT derived from the file's actual bytes, so it is trivial to spoof (e.g. upload an
 * .html/.svg/.php payload with `Content-Type: image/jpeg`). Previously, if that spoofed
 * file then failed to parse as an image, resizeImage()'s catch block silently fell back to
 * storing the ORIGINAL, unprocessed bytes — so a disguised file could still end up stored
 * and served back from Cloudinary (or as a base64 data: URL) under an "image" label.
 *
 * This checks the first few bytes (the file's "magic number") against what each accepted
 * MIME type actually looks like on disk, and rejects anything that doesn't match before it
 * ever reaches Sharp or Cloudinary. Defense in depth alongside fileFilter(), not a
 * replacement for it.
 */
function magicBytesMatch(buffer, mimetype) {
  if (!buffer || buffer.length < 4) return false;
  const b = buffer;
  switch (mimetype) {
    case 'image/jpeg': return b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
    case 'image/png':  return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;
    case 'image/gif':  return b.slice(0, 3).toString('ascii') === 'GIF';
    case 'image/webp': return b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP';
    case 'application/pdf': return b.slice(0, 4).toString('ascii') === '%PDF';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/zip':
      // .docx is a ZIP container (local file header signature PK\x03\x04)
      return b[0] === 0x50 && b[1] === 0x4B && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07);
    case 'application/msword':
      // legacy .doc — OLE Compound File signature
      return b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0;
    default:
      return true; // unknown/unlisted type — let fileFilter's allowlist be the only gate
  }
}

/**
 * Throws the same tagged error shape fileFilter() uses (code: 'BAD_FILE_TYPE') if a
 * file's bytes don't match its claimed type, so it's handled by the app's existing
 * uploadDiagnostics error path (proper 415 status + a resident-facing message) rather
 * than falling through to a generic 500.
 */
function assertFileSignature(file) {
  if (!file) return;
  if (magicBytesMatch(file.buffer, file.mimetype)) return;
  const err = new Error('File content does not match its claimed type.');
  err.code = 'BAD_FILE_TYPE';
  err.field = file.fieldname;
  err.mimetype = file.mimetype;
  log.warn(`[upload] Rejected "${file.originalname}" on field "${file.fieldname}" — bytes don't match claimed type ${file.mimetype}`);
  throw err;
}

async function resizeImage(buffer, options = {}) {
  try {
    const sharp = require('sharp');
    const { width = 1200, height, fit = 'inside', quality = 80 } = options;
    let p = sharp(buffer).rotate();
    p = height ? p.resize(width, height, { fit, withoutEnlargement: true })
               : p.resize(width, null, { fit: 'inside', withoutEnlargement: true });
    return await p.jpeg({ quality, progressive: true }).toBuffer();
  } catch { return buffer; }
}

/**
 * Convert a DOCX buffer to a PDF buffer using LibreOffice.
 *
 * LibreOffice is spawned headlessly in a unique temp directory per call so
 * concurrent conversions don't collide on the ~/.config/libreoffice lock.
 * Temp files are always cleaned up in a finally block.
 *
 * @param  {Buffer} docxBuffer  - Raw DOCX file bytes
 * @param  {string} filename    - Original filename (used only for logging)
 * @returns {Promise<Buffer>}   - PDF bytes
 */
async function convertDocxToPdf(docxBuffer, filename = 'document.docx') {
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'damis-docx-'));
  const inPath  = path.join(tmpDir, 'input.docx');
  const outPath = path.join(tmpDir, 'input.pdf');
  try {
    fs.writeFileSync(inPath, docxBuffer);
    await new Promise((resolve, reject) => {
      execFile(
        'libreoffice',
        ['--headless', '--convert-to', 'pdf', '--outdir', tmpDir, inPath],
        { timeout: 30_000 },
        (err, _stdout, stderr) => {
          if (err) return reject(new Error(`LibreOffice: ${stderr || err.message}`));
          resolve();
        }
      );
    });
    if (!fs.existsSync(outPath)) throw new Error('LibreOffice produced no output PDF');
    const pdfBuf = fs.readFileSync(outPath);
    log.upload(`convertDocxToPdf: "${filename}" → PDF (${(pdfBuf.length / 1024).toFixed(0)} KB)`);
    return pdfBuf;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

function toCloudinary(buffer, folder, opts = {}) {
  return new Promise((res, rej) => {
    const s = cloudinary.uploader.upload_stream({ folder, ...opts }, (e, r) => e ? rej(e) : res(r));
    Readable.from(buffer).pipe(s);
  });
}

function toDataUrl(buf, mime = 'image/jpeg') {
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function processPostImage(req, res, next) {
  if (!req.file) return next();
  try {
    assertFileSignature(req.file);
    const buf = await resizeImage(req.file.buffer, { width: 1200, quality: 80 });
    req.cloudinaryUrl = hasCloudinary ? (await toCloudinary(buf, 'pga-damis/posts')).secure_url : toDataUrl(buf, req.file.mimetype);
    next();
  } catch (err) {
    console.error('Post image error:', err.message);
    res.status(err.code === 'BAD_FILE_TYPE' ? 415 : 500).json({ error: err.code === 'BAD_FILE_TYPE' ? err.message : 'Image upload failed.' });
  }
}

async function processAvatar(req, res, next) {
  if (!req.file) return next();
  try {
    assertFileSignature(req.file);
    const buf = await resizeImage(req.file.buffer, { width: 400, height: 400, fit: 'cover', quality: 85 });
    req.cloudinaryUrl = hasCloudinary ? (await toCloudinary(buf, 'pga-damis/avatars')).secure_url : toDataUrl(buf, req.file.mimetype);
    next();
  } catch (err) {
    console.error('Avatar error:', err.message);
    res.status(err.code === 'BAD_FILE_TYPE' ? 415 : 500).json({ error: err.code === 'BAD_FILE_TYPE' ? err.message : 'Avatar upload failed.' });
  }
}

async function processCover(req, res, next) {
  if (!req.file) return next();
  try {
    assertFileSignature(req.file);
    const buf = await resizeImage(req.file.buffer, { width: 1500, height: 500, fit: 'cover', quality: 80 });
    req.cloudinaryUrl = hasCloudinary ? (await toCloudinary(buf, 'pga-damis/covers')).secure_url : toDataUrl(buf, req.file.mimetype);
    next();
  } catch (err) {
    console.error('Cover error:', err.message);
    res.status(err.code === 'BAD_FILE_TYPE' ? 415 : 500).json({ error: err.code === 'BAD_FILE_TYPE' ? err.message : 'Cover upload failed.' });
  }
}

async function processIdDocument(req, res, next) {
  const t0 = Date.now();
  // Log exactly what multer received so we can diagnose missing files
  const receivedFields = req.files
    ? Object.entries(req.files).map(([k,v]) => `${k}[${v.length}] ${(v[0].size/1024).toFixed(1)}KB (${v[0].mimetype})`).join(', ')
    : req.file ? `${req.file.fieldname} ${(req.file.size/1024).toFixed(1)}KB (${req.file.mimetype})` : 'none';
  log.upload(`── processIdDocument ─────────────────────────`);
  log.upload(`Multer received: ${receivedFields || 'NO FILES'}`);

  // Log crop params from form body for debugging
  const cropParams = {
    faceX:    req.body?.avatarFaceX,
    faceY:    req.body?.avatarFaceY,
    cropX:    req.body?.avatarCropX,
    cropY:    req.body?.avatarCropY,
    cropSize: req.body?.avatarCropSize,
  };
  const hasCropInput = [cropParams.cropX, cropParams.cropY, cropParams.cropSize].every(v => v !== undefined && v !== '');
  log.upload(`Face crop params: faceCenter=(${cropParams.faceX}%,${cropParams.faceY}%) cropTopLeft=(${cropParams.cropX}%,${cropParams.cropY}%) size=${cropParams.cropSize}% → ${hasCropInput ? '✔ will use face-crop' : '✘ missing — will fall back to center-crop'}`);

  if (!req.files && !req.file) return next();
  let currentField = null;   // which file we were working on if something throws
  try {
    const urls = {};

    // ── Avatar: face-aware crop using user's crop selection ──────────────
    const avatarFile = req.files?.['avatar']?.[0];
    if (avatarFile) {
      currentField = 'avatar';
      assertFileSignature(avatarFile);
      const sharp = require('sharp');
      const faceX    = parseFloat(req.body?.avatarFaceX)    || 50;
      const faceY    = parseFloat(req.body?.avatarFaceY)    || 50;
      const cropXPct = parseFloat(req.body?.avatarCropX);
      const cropYPct = parseFloat(req.body?.avatarCropY);
      const cropSzPct= parseFloat(req.body?.avatarCropSize);

      const hasCropData = !isNaN(cropXPct) && !isNaN(cropYPct) && !isNaN(cropSzPct) && cropSzPct > 1;

      let buf;
      if (hasCropData) {
        // Get post-rotation dimensions so crop coords match what the user saw in the browser
        const meta = await sharp(avatarFile.buffer).rotate().metadata();
        const natW = meta.width, natH = meta.height;

        // cropSzPct is relative to natural width — convert to pixels
        const cropPx = Math.round(natW * cropSzPct / 100);
        const left = Math.max(0, Math.min(natW - cropPx, Math.round(natW * cropXPct / 100)));
        const top  = Math.max(0, Math.min(natH - cropPx, Math.round(natH * cropYPct / 100)));
        // Clamp so crop doesn't exceed image bounds
        const safeW = Math.min(cropPx, natW - left);
        const safeH = Math.min(cropPx, natH - top);

        log.upload(`Avatar face-crop: image=${natW}x${natH} | crop @ (${left},${top}) size=${safeW}x${safeH}px | faceCenter=(${faceX}%,${faceY}%) → 400x400`);

        buf = await sharp(avatarFile.buffer)
          .rotate()
          .extract({ left, top, width: safeW, height: safeH })
          .resize(400, 400, { fit: 'cover', position: 'center' })
          .jpeg({ quality: 85, progressive: true })
          .toBuffer();
        log.upload(`Avatar face-crop SUCCESS → 400x400 JPEG`);
      } else {
        log.upload(`Avatar: no crop data received, falling back to center-crop 400x400`);
        buf = await resizeImage(avatarFile.buffer, { width: 400, height: 400, fit: 'cover', quality: 85 });
      }

      urls['avatar'] = hasCloudinary
        ? (await toCloudinary(buf, 'pga-damis/avatars')).secure_url
        : toDataUrl(buf, avatarFile.mimetype);
      log.upload(`Avatar stored: ${hasCloudinary ? urls['avatar'].slice(0,70)+'…' : '[base64]'}`);
    }

    // ── ID docs and certs ────────────────────────────────────────────────
    const fields = ['id_front', 'id_back', 'selfie', 'cert_residency', 'cert_low_income', 'cert_enrollment', 'cert_grades', 'cert_medical'];
    const DOCX_MIMES = new Set([
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
    ]);
    for (const field of fields) {
      const file = req.files?.[field]?.[0] || (req.file?.fieldname === field ? req.file : null);
      if (!file) continue;
      currentField = field;
      assertFileSignature(file);
      const isPdf  = file.mimetype === 'application/pdf';
      const isDocx = DOCX_MIMES.has(file.mimetype) || (file.originalname || '').toLowerCase().endsWith('.docx');
      const folder = field.startsWith('cert_') ? 'damis/cert-docs' : 'damis/id-docs';

      if (isPdf) {
        // Upload PDFs as resource_type:'image' so Cloudinary generates accessible URLs
        // and allows thumbnail transformations (pg_1, etc.).
        // resource_type:'raw' caused 401 Unauthorized on direct access.
        urls[field] = hasCloudinary
          ? (await toCloudinary(file.buffer, folder, { resource_type: 'image', format: 'pdf' })).secure_url
          : toDataUrl(file.buffer, 'application/pdf');
        log.upload(`PDF upload [${field}] → resource_type:image | url: ${hasCloudinary ? (urls[field]||'').slice(0,70)+'…' : '[base64]'}`);

      } else if (isDocx) {
        // Convert DOCX → PDF at upload time via LibreOffice so the admin panel
        // can preview documents inline (PDFs render in-browser; raw DOCX cannot).
        // The original DOCX bytes are not stored — the PDF is the canonical record.
        let pdfBuf;
        try {
          pdfBuf = await convertDocxToPdf(file.buffer, file.originalname);
        } catch (convErr) {
          // If LibreOffice fails, fall back to storing raw DOCX so the upload still
          // succeeds; admin will see a Download button instead of an inline preview.
          log.warn(`[upload] DOCX→PDF conversion failed for ${field} (${file.originalname}): ${convErr.message} — falling back to raw DOCX`);
          urls[field] = hasCloudinary
            ? (await toCloudinary(file.buffer, folder, {
                resource_type: 'raw',
                format: 'docx',
                public_id: `${field}_${Date.now()}`,
              })).secure_url
            : toDataUrl(file.buffer, file.mimetype);
          log.upload(`DOCX fallback [${field}] → resource_type:raw | url: ${hasCloudinary ? (urls[field]||'').slice(0,70)+'…' : '[base64]'}`);
          continue;
        }
        // Upload the converted PDF as resource_type:'image' (same as native PDF uploads)
        // so Cloudinary can generate thumbnail transformations for the admin preview.
        urls[field] = hasCloudinary
          ? (await toCloudinary(pdfBuf, folder, { resource_type: 'image', format: 'pdf' })).secure_url
          : toDataUrl(pdfBuf, 'application/pdf');
        log.upload(`DOCX→PDF upload [${field}] → resource_type:image | url: ${hasCloudinary ? (urls[field]||'').slice(0,70)+'…' : '[base64]'}`);

      } else {
        const buf = await resizeImage(file.buffer, { width: 1200, quality: 85 });
        urls[field] = hasCloudinary
          ? (await toCloudinary(buf, folder, { resource_type: 'image' })).secure_url
          : toDataUrl(buf, file.mimetype);
        log.upload(`Image upload [${field}] → ${hasCloudinary ? (urls[field]||'').slice(0,70)+'…' : '[base64]'}`);
      }
    }

    req.idDocUrls = urls;
    const elapsed = Date.now() - t0;
    log.upload(`processIdDocument done in ${elapsed}ms. Stored: ${Object.keys(urls).map(k => `${k}(${urls[k] ? '✔' : '✘'})`).join(' ')}`);
    next();
  } catch (err) {
    // Cloudinary rejects with a plain object ({ message, http_code }); normalise so we can annotate it.
    if (typeof err !== 'object' || err === null) err = new Error(String(err));
    err.uploadField = err.uploadField || currentField;
    if (!err.uploadStage && (err.http_code || /cloudinary|ETIMEDOUT|ECONNRESET|ENOTFOUND|socket hang up/i.test(String(err.message)))) {
      err.uploadStage = 'storage';
    }
    log.error(
      `ID doc upload error on field "${currentField || '?'}" after ${Date.now() - t0}ms: ${err.message}` +
      `${err.http_code ? ` (Cloudinary HTTP ${err.http_code})` : ''}`
    );
    console.error(err);
    return handleUploadError(err, req, res);   // specific JSON error + log line (was a generic "ID upload failed.")
  }
}

module.exports = {
  multerSingle:    (field) => multerUpload.single(field),
  uploadPostImage: [multerUpload.single('image'),  processPostImage],
  uploadAvatar:    [multerUpload.single('avatar'), processAvatar],
  uploadCover:     [multerUpload.single('cover'),  processCover],
  uploadIdDocs:    [multerUpload.fields([
    { name: 'id_front',        maxCount: 1 },
    { name: 'id_back',         maxCount: 1 },
    { name: 'selfie',          maxCount: 1 },
    { name: 'avatar',          maxCount: 1 },
    { name: 'cert_residency',  maxCount: 1 },
    { name: 'cert_low_income', maxCount: 1 },
    { name: 'cert_enrollment', maxCount: 1 },
    { name: 'cert_grades',     maxCount: 1 },
  ]), processIdDocument],
  // Medical Certificate: ONE file from an approved resident (not part of registration). Same validation/PDF/DOCX pipeline.
  uploadMedicalCert: [multerUpload.single('cert_medical'), processIdDocument],
  // Low-level helpers exposed to route files for custom upload flows
  multerUpload,
  toCloudinary,
  resizeImage,
  hasCloudinary,
};
