// utils/archiveView.js
/**
 * Archive viewing — "Set Active" on an Archive DB snapshot.
 *
 * What it does
 *   While an admin has a snapshot Active, every /api/admin/* request from THAT
 *   admin session is answered from the snapshot (opened READ-ONLY) instead of the
 *   live database. The real admin tabs — Residents, Room Management, Billing,
 *   Incident Reports, Utility Bills, … — therefore show the old records in their
 *   usual places, exactly as if the snapshot had been loaded, but static.
 *
 * What it never does
 *   • never writes to, replaces, or closes the live database (connecthub.db);
 *   • never affects residents, other admins, sockets, schedulers or the session
 *     store — the switch is scoped to a single request via AsyncLocalStorage
 *     (see runWithDb in utils/db.js), and the session store holds `liveDb`;
 *   • never allows changes while viewing: any non-read request is refused with 403
 *     (code ARCHIVE_READ_ONLY). This matters because a snapshot is a copy of the
 *     live data, so the SAME ids exist in both — a "delete post X" aimed at an
 *     archived post would otherwise hit the live post X.
 *
 * Always live (never switched, never blocked by view mode)
 *   /api/admin/db-archives/*      the Active / Inactive controls themselves
 *   /api/admin/backup/*           a backup must be of the live data, never a snapshot
 *   /api/admin/announcements/*    login-page notices describe the live site, not a snapshot
 *   /api/admin/research/manager/* the admin's own survey answers (tied to their
 *                                 live account, not to the dormitory's archived data)
 *   /api/admin/research/survey-switch  the global survey on/off flag (app_settings of the
 *                                 LIVE db — reading or flipping it must never hit a snapshot)
 *
 * Wiring (server.js) — after session + passport, BEFORE the routers:
 *     app.use('/api/admin', archiveViewMiddleware);
 *     app.use('/api/posts', archiveWriteGuard);   // admin page calls DELETE /api/posts/:id
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const log  = require('./logger');
const { getDbArchiveById, runWithDb } = require('./db');

// Paths (relative to the /api/admin mount) that always use the live DB.
const ALWAYS_LIVE = [
  /^\/db-archives(\/|$)/,
  /^\/backup(\/|$)/,
  /^\/research\/manager(\/|$)/,
  /^\/research\/survey-switch(\/|$)/,
  // Login-page announcements describe the LIVE site, so editing them must never hit (or be
  // blocked by) an archived snapshot — older snapshots may not even have the table.
  /^\/announcements(\/|$)/,
];

// GET routes that look harmless but WRITE (admission-slip assigns an admission number).
const WRITING_GETS = [/^\/users\/[^/]+\/admission-slip\/?$/];

const READ_METHODS  = new Set(['GET', 'HEAD', 'OPTIONS']);
const IDLE_CLOSE_MS = 10 * 60 * 1000;

/** id → { handle, file, lastUsed } — open read-only connections, closed when idle. */
const openHandles = new Map();
/** id → Promise<handle> — de-dupes concurrent first opens (two requests, one download). */
const opening = new Map();

const idleSweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of openHandles) {
    if (now - entry.lastUsed > IDLE_CLOSE_MS) closeArchiveHandle(id);
  }
}, 60 * 1000);
idleSweeper.unref(); // never keep the process alive just for this

// ── Snapshot file access ─────────────────────────────────────────────────────

/** Where a cloud snapshot is cached locally while it is being viewed. */
function archiveCachePath(archiveId) {
  return path.join(os.tmpdir(), 'damis-archive-view', `${String(archiveId).replace(/[^a-zA-Z0-9_-]/g, '')}.db`);
}

/** Best-effort removal of SQLite's -wal / -shm side files next to a snapshot. */
function removeSidecars(file) {
  for (const suffix of ['-wal', '-shm']) fs.unlink(file + suffix, () => {});
}

/** Local file path for a snapshot (downloads + caches it first if it lives in Cloudinary). */
async function resolveArchiveFile(rec) {
  if (rec.storage !== 'cloudinary') {
    if (!rec.file_url || !fs.existsSync(rec.file_url)) {
      const err = new Error('Archive file is missing from local disk.');
      err.status = 404;
      throw err;
    }
    return rec.file_url;
  }

  const cached = archiveCachePath(rec.id);
  if (fs.existsSync(cached) && fs.statSync(cached).size > 0) return cached;

  fs.mkdirSync(path.dirname(cached), { recursive: true });
  const part = `${cached}.${process.pid}.${Date.now()}.part`;
  try {
    const upstream = await fetch(rec.file_url);
    if (!upstream.ok) throw new Error(`Cloudinary fetch failed (${upstream.status})`);
    fs.writeFileSync(part, Buffer.from(await upstream.arrayBuffer()));
    fs.renameSync(part, cached); // atomic: a half-written file is never used
  } catch (e) {
    fs.unlink(part, () => {});   // don't leave a stray .part behind
    throw e;
  }
  log.info(`[archive-view] cached cloud snapshot "${rec.label}" locally (${(fs.statSync(cached).size / 1024 / 1024).toFixed(2)} MB)`);
  return cached;
}

/** Open a snapshot strictly read-only and sanity-check it. Caller must close() on failure. */
function openReadonly(file) {
  const handle = new Database(file, { readonly: true, fileMustExist: true });
  try {
    handle.prepare('SELECT COUNT(*) FROM users').get();
  } catch (e) {
    handle.close();
    const err = new Error(`Archived file appears corrupt: ${e.message}`);
    err.status = 400;
    throw err;
  }
  return handle;
}

/** Open (or reuse) the read-only connection for a snapshot. Validates it on first open. */
async function getArchiveHandle(rec) {
  const hit = openHandles.get(rec.id);
  if (hit && hit.handle.open) { hit.lastUsed = Date.now(); return hit.handle; }

  if (opening.has(rec.id)) return opening.get(rec.id);
  const p = (async () => {
    const file   = await resolveArchiveFile(rec);
    const handle = openReadonly(file);
    openHandles.set(rec.id, { handle, file, lastUsed: Date.now() });
    log.info(`[archive-view] opened snapshot "${rec.label}" read-only`);
    return handle;
  })().finally(() => opening.delete(rec.id));
  opening.set(rec.id, p);
  return p;
}

/** Close + forget a snapshot connection (and its cached cloud copy when `dropCache`). */
function closeArchiveHandle(id, { dropCache = false } = {}) {
  const entry = openHandles.get(id);
  if (entry) {
    try { entry.handle.close(); } catch (_) {}
    openHandles.delete(id);
    removeSidecars(entry.file);
  }
  if (dropCache) {
    const cached = archiveCachePath(id);
    fs.unlink(cached, () => {});
    removeSidecars(cached);
  }
}

// ── Request helpers ──────────────────────────────────────────────────────────

const isAdmin = (req) => req.user && (req.user.role === 'admin' || req.user.role === 'superadmin');

/** Which snapshot (if any) is this admin session viewing? Clears a stale id (purged snapshot). */
function getViewingArchive(req) {
  const id = req.session?.viewingArchiveId;
  if (!id) return null;
  const rec = getDbArchiveById(id);
  if (!rec) { delete req.session.viewingArchiveId; return null; }
  return rec;
}

function refuseWrite(req, res, rec) {
  log.warn(`[archive-view] blocked ${req.method} ${req.originalUrl} — @${req.user.username} is viewing "${rec.label}" (read-only)`);
  return res.status(403).json({
    error: `Read-only: you are viewing the archived snapshot "${rec.label}". Switch back to the Live Database (Archive DB tab) to make changes.`,
    code: 'ARCHIVE_READ_ONLY',
  });
}

// ── Middleware ───────────────────────────────────────────────────────────────

/**
 * Mount ONCE on '/api/admin', after session + passport, before the routers.
 * Live admins / residents / everyone else fall straight through (one cheap check).
 */
async function archiveViewMiddleware(req, res, next) {
  try {
    if (!req.session?.viewingArchiveId) return next();                // normal case: live DB
    if (!isAdmin(req)) return next();                                 // requireAdmin will reject them
    if (ALWAYS_LIVE.some(re => re.test(req.path))) return next();     // switch controls, backups, own survey

    const rec = getViewingArchive(req);
    if (!rec) return next();                                          // snapshot was purged → live

    if (!READ_METHODS.has(req.method) || WRITING_GETS.some(re => re.test(req.path))) {
      return refuseWrite(req, res, rec);
    }

    const handle = await getArchiveHandle(rec);
    res.setHeader('Cache-Control', 'no-store');        // never let the browser mix live and archived JSON
    res.setHeader('X-Viewing-Archive', rec.id);
    req.viewingArchive = rec;
    return runWithDb(handle, next);                    // everything downstream reads the snapshot
  } catch (err) {
    log.error(`[archive-view] could not open snapshot — ${err.message}`);
    if (err.status) return res.status(err.status).json({ error: err.message });
    return res.status(500).json({ error: `Could not open the archived snapshot: ${err.message}` });
  }
}

/**
 * Write-guard for routes OUTSIDE /api/admin that the admin page still calls with
 * archived ids (e.g. DELETE /api/posts/:id). Does not switch databases — it only
 * refuses non-read requests from an admin who is viewing a snapshot.
 */
function archiveWriteGuard(req, res, next) {
  try {
    if (READ_METHODS.has(req.method)) return next();
    if (!req.session?.viewingArchiveId || !isAdmin(req)) return next();
    const rec = getViewingArchive(req);
    if (!rec) return next();
    return refuseWrite(req, res, rec);
  } catch (err) {
    log.error(`[archive-view] write-guard failed — ${err.message}`);
    return res.status(500).json({ error: 'Could not verify archive view state.' });
  }
}

module.exports = {
  archiveViewMiddleware, archiveWriteGuard,
  getViewingArchive, getArchiveHandle, closeArchiveHandle,
  resolveArchiveFile, archiveCachePath,
};
