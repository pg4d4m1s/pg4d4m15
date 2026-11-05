/**
 * utils/announcements.js — Login-page announcements
 *
 * Notices shown to visitors on the login page (public/index.html). Two ways in:
 *   • manual — an admin writes one in Admin → Community → Announcements
 *   • auto   — createSemesterAnnouncement() is called by the "Start New Semester"
 *              rollover (routes/admin.js) so returning residents learn that their
 *              old account was archived and that they should register again.
 *
 * Why a separate module (and not utils/db.js)?
 *   db.js is already very large. This module only needs the shared `db` proxy,
 *   creates its own table at boot, and is easy to find and change later.
 *
 * Notes for future-me
 *   • Statements are prepared inside functions, never at module load — `db` is a
 *     proxy that can point at a read-only archive snapshot for one request
 *     (see utils/db.js / utils/archiveView.js), and a statement prepared at load
 *     would stay bound to whichever handle was active at that moment.
 *   • The admin API for these rows is listed in archiveView.js ALWAYS_LIVE, so it
 *     always hits the live DB even while an archive snapshot is "Set Active".
 *   • Dates (show_from / show_until) are plain 'YYYY-MM-DD' in Philippine time
 *     (UTC+8, no DST), inclusive on both ends. Timestamps are UTC like the rest
 *     of the DB (datetime('now')).
 *   • Text is stored as plain text. The login page renders it with textContent,
 *     so nothing here is ever interpreted as HTML.
 */

const { randomUUID } = require('crypto');
const log = require('./logger');
const { db, toUTC } = require('./db');

// ── Schema ─────────────────────────────────────────────────────────────────
// Created at boot. schemaReconcile.js re-adds this table after a DB restore
// from a backup that predates it, so no extra restore handling is needed.
db.exec(`
  CREATE TABLE IF NOT EXISTS announcements (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    body          TEXT NOT NULL DEFAULT '',
    type          TEXT NOT NULL DEFAULT 'info',     -- info | success | warning | urgent
    source        TEXT NOT NULL DEFAULT 'manual',   -- manual | semester_rollover
    semester_tag  TEXT NOT NULL DEFAULT '',         -- e.g. "2nd Semester 2026" (auto posts)
    cta_signup    INTEGER NOT NULL DEFAULT 0,       -- 1 = show a "Create Account" button
    is_active     INTEGER NOT NULL DEFAULT 1,       -- 0 = hidden by an admin
    show_from     TEXT,                             -- 'YYYY-MM-DD' PH time, NULL = immediately
    show_until    TEXT,                             -- 'YYYY-MM-DD' PH time, NULL = until hidden
    created_by    TEXT DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_announcements_created ON announcements(created_at DESC);
`);

const TYPES        = ['info', 'success', 'warning', 'urgent'];
const TITLE_MAX    = 120;
const BODY_MAX     = 1000;
const PUBLIC_LIMIT = 3; // the login card is small — never show more than this

// ── Helpers ────────────────────────────────────────────────────────────────

/** Today's date in the Philippines ('YYYY-MM-DD'). PH has no DST, so +8h is exact. */
function phToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** live | scheduled | expired | hidden — what an admin sees as the row's state. */
function statusOf(row, today = phToday()) {
  if (!row.is_active) return 'hidden';
  if (row.show_from && today < row.show_from) return 'scheduled';
  if (row.show_until && today > row.show_until) return 'expired';
  return 'live';
}

function toAdminShape(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    type: row.type,
    source: row.source,
    semesterTag: row.semester_tag,
    ctaSignup: !!row.cta_signup,
    isActive: !!row.is_active,
    showFrom: row.show_from || '',
    showUntil: row.show_until || '',
    status: statusOf(row),
    createdBy: row.created_by,
    createdAt: toUTC(row.created_at),
    updatedAt: toUTC(row.updated_at),
  };
}

/** Only what the login page needs — nothing about who wrote it or when it expires. */
function toPublicShape(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    type: row.type,
    ctaSignup: !!row.cta_signup,
    createdAt: toUTC(row.created_at),
    updatedAt: toUTC(row.updated_at), // lets the page re-show an announcement an admin has edited
  };
}

/**
 * Validate + normalise admin input (used for both create and update).
 * @returns {{ value: object } | { error: string }}
 */
function validateInput(input = {}) {
  const title = String(input.title ?? '').trim();
  const body  = String(input.body ?? '').trim();
  if (!title) return { error: 'Title is required.' };
  if (title.length > TITLE_MAX) return { error: `Title must be ${TITLE_MAX} characters or fewer.` };
  if (body.length > BODY_MAX)   return { error: `Message must be ${BODY_MAX} characters or fewer.` };

  const type = String(input.type || 'info');
  if (!TYPES.includes(type)) return { error: `Style must be one of: ${TYPES.join(', ')}.` };

  const showFrom  = input.showFrom  ? String(input.showFrom)  : null;
  const showUntil = input.showUntil ? String(input.showUntil) : null;
  if (showFrom  && !isRealDate(showFrom))  return { error: '"Show from" is not a valid date.' };
  if (showUntil && !isRealDate(showUntil)) return { error: '"Show until" is not a valid date.' };
  if (showFrom && showUntil && showUntil < showFrom) {
    return { error: '"Show until" cannot be earlier than "Show from".' };
  }

  return {
    value: {
      title, body, type,
      ctaSignup: !!input.ctaSignup,
      isActive: input.isActive === undefined ? true : !!input.isActive,
      showFrom, showUntil,
    },
  };
}

// ── Queries ────────────────────────────────────────────────────────────────

function getAnnouncement(id) {
  return db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
}

/** Everything, newest first — for the admin tab. */
function listAnnouncements() {
  return db.prepare('SELECT * FROM announcements ORDER BY created_at DESC, rowid DESC').all().map(toAdminShape);
}

/** What visitors see: active, inside its date window, newest first, capped. */
function listPublicAnnouncements() {
  const today = phToday();
  return db.prepare(`
    SELECT * FROM announcements
     WHERE is_active = 1
       AND (show_from  IS NULL OR show_from  <= ?)
       AND (show_until IS NULL OR show_until >= ?)
     ORDER BY created_at DESC, rowid DESC
     LIMIT ?
  `).all(today, today, PUBLIC_LIMIT).map(toPublicShape);
}

// ── Writes ─────────────────────────────────────────────────────────────────

function createAnnouncement(value, adminId = '', extra = {}) {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO announcements
      (id, title, body, type, source, semester_tag, cta_signup, is_active, show_from, show_until, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, value.title, value.body, value.type,
    extra.source || 'manual', extra.semesterTag || '',
    value.ctaSignup ? 1 : 0, value.isActive ? 1 : 0,
    value.showFrom, value.showUntil, adminId || ''
  );
  return toAdminShape(getAnnouncement(id));
}

/** @returns the updated announcement, or null when the id does not exist. */
function updateAnnouncement(id, value) {
  const info = db.prepare(`
    UPDATE announcements
       SET title = ?, body = ?, type = ?, cta_signup = ?, is_active = ?,
           show_from = ?, show_until = ?, updated_at = datetime('now')
     WHERE id = ?
  `).run(
    value.title, value.body, value.type, value.ctaSignup ? 1 : 0, value.isActive ? 1 : 0,
    value.showFrom, value.showUntil, id
  );
  return info.changes ? toAdminShape(getAnnouncement(id)) : null;
}

function setAnnouncementActive(id, isActive) {
  const info = db.prepare(
    `UPDATE announcements SET is_active = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(isActive ? 1 : 0, id);
  return info.changes ? toAdminShape(getAnnouncement(id)) : null;
}

function deleteAnnouncement(id) {
  return db.prepare('DELETE FROM announcements WHERE id = ?').run(id).changes > 0;
}

// ── "Applications open" notice ─────────────────────────────────────────────

/**
 * Wording of the "new semester is open" notice. Single source of truth: used by
 * the automatic post below AND by the "Use template" button in the admin editor.
 * @param {string} semester    e.g. "2nd Semester"
 * @param {string|number} schoolYear  e.g. "2026"
 */
function buildSemesterTemplate(semester, schoolYear) {
  const tag = `${semester} ${schoolYear}`.trim();
  return {
    title: `${tag} — Applications Now Open`,
    body:
      `Applications for ${tag} are now open.\n\n` +
      `Returning residents: your previous account was archived at the end of last semester, ` +
      `so you can no longer log in with it. Tap "Create Account" to register again and upload ` +
      `your new documents. You may reuse your old email or Gmail address.`,
    type: 'success',
    ctaSignup: true,
    isActive: true,
    showFrom: null,
    showUntil: null,
  };
}

/**
 * Called after a successful semester rollover. Hides the previous automatic
 * notice (so old semesters never stack up on the login page) and posts the new one.
 * Manual announcements are never touched.
 */
function createSemesterAnnouncement({ semester, schoolYear, adminId = '' }) {
  const tag = `${semester} ${schoolYear}`.trim();
  const value = buildSemesterTemplate(semester, schoolYear);
  return db.transaction(() => {
    const hidden = db.prepare(
      `UPDATE announcements SET is_active = 0, updated_at = datetime('now')
        WHERE source = 'semester_rollover' AND is_active = 1`
    ).run().changes;
    const created = createAnnouncement(value, adminId, { source: 'semester_rollover', semesterTag: tag });
    log.admin(`📢 Auto-announcement posted for ${tag} (hid ${hidden} older automatic notice${hidden === 1 ? '' : 's'})`);
    return created;
  })();
}

module.exports = {
  TYPES, TITLE_MAX, BODY_MAX,
  validateInput, buildSemesterTemplate,
  listAnnouncements, listPublicAnnouncements,
  createAnnouncement, updateAnnouncement, setAnnouncementActive, deleteAnnouncement,
  createSemesterAnnouncement,
};
