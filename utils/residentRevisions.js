/**
 * utils/residentRevisions.js — approved residents asking to correct their own application
 *
 * Flow (every step is server-enforced; the browser only mirrors it):
 *
 *   1. RESIDENT  sends a request:  which parts are wrong (info groups / documents) + a reason      -> status 'pending'
 *   2. ADMIN     approves (can grant fewer items, picks a 1-14 day window) or declines with a note -> 'approved' | 'rejected'
 *   3. RESIDENT  edits ONLY the approved items inside the window (info is validated like registration;
 *                documents go through the same upload pipeline). Edits are saved as DRAFTS (table revision_drafts):
 *                the resident's real record is NOT touched.
 *   4. RESIDENT  taps "Submit for review" (or the window runs out with drafts saved)                -> 'submitted'
 *   5. ADMIN     sees old -> new for every draft and decides (second approval):
 *                  approve & apply  -> drafts are written to the real record + change log           -> 'completed'
 *                  return           -> back to the resident with a note, drafts kept, new window    -> 'approved'
 *                  decline          -> drafts are thrown away, the real record stays as it was      -> 'rejected'
 *
 * Statuses: pending | approved | submitted | completed | rejected | cancelled (resident withdrew / admin revoked) | expired
 * Only ONE open (pending, approved or submitted) request per resident at a time, max MAX_REQUESTS_30D per rolling 30 days.
 *
 * Data layout it relies on (nothing in those tables changes shape):
 *   users                      personal / address / school / family answers      (registration columns)
 *   id_verification_requests   latest row = the 5 supporting documents            (id_front_url, cert_*_url)
 *
 * Why it uses `liveDb`: residents and sockets always work on the live database, never on an Archive DB snapshot.
 *
 * Pure validation helpers are exported for tests; everything that touches the database lives below them.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const { liveDb: db, genId } = require('./db');
const log = require('./logger');
const { REVISION_ITEMS } = require('./applicationRevision');

// ── What a resident may ask to change ───────────────────────────────────────────────────────────
// Re-uses the labels of the "return application for correction" checklist (REVISION_ITEMS) so admins see the
// same wording everywhere. The selfie is NOT here: a resident can already change their profile photo freely.
const REQUESTABLE = Object.freeze([
  'info_personal', 'info_address', 'info_school', 'info_family',
  'doc_school_id', 'doc_residency', 'doc_low_income', 'doc_enrollment', 'doc_grades',
]);
const DOC_ITEMS  = REQUESTABLE.filter((k) => REVISION_ITEMS[k].group === 'doc');
const INFO_ITEMS = REQUESTABLE.filter((k) => REVISION_ITEMS[k].group === 'info');
// multipart field name -> item key  (id_front -> doc_school_id ...)
const FIELD_TO_ITEM = Object.freeze(Object.fromEntries(DOC_ITEMS.map((k) => [REVISION_ITEMS[k].field, k])));

const ALLOWED_WINDOWS     = Object.freeze([1, 3, 7, 14]);   // days an approved request stays editable
const DEFAULT_WINDOW_DAYS = 7;
const MAX_REQUESTS_30D    = 5;
const REASON_MIN = 10, REASON_MAX = 500, NOTE_MAX = 200, ADMIN_NOTE_MIN = 5, ADMIN_NOTE_MAX = 500;

// Same lists as the registration wizard (public/index.html)
const CIVIL_STATUSES = Object.freeze(['Single', 'Married', 'Widowed', 'Separated', 'Annulled']);
const SEXES          = Object.freeze(['male', 'female']);
const YEAR_LEVELS    = Object.freeze(['1', '2', '3', '4', '5']);
const INCOME_OPTIONS = Object.freeze([
  'Below \u20B15,000',
  '\u20B15,000 \u2013 \u20B19,999',
  '\u20B110,000 \u2013 \u20B114,999',
  '\u20B115,000 \u2013 \u20B119,999',
  '\u20B120,000 \u2013 \u20B129,999',
  '\u20B130,000 \u2013 \u20B149,999',
  '\u20B150,000 and above',
]);

// Columns a draft may target. Draft rows are written by this module only, but the whitelist is re-checked before
// any column name goes into SQL when a draft is applied.
const INFO_COLUMNS = new Set(['first_name', 'middle_name', 'last_name', 'suffix', 'birthday', 'sex', 'civil_status', 'phone',
  'permanent_address', 'present_address', 'location', 'school_name', 'school_address', 'year_level', 'course', 'specialization',
  'father_info', 'mother_info', 'guardian_info', 'monthly_income']);
const DOC_COLUMNS  = new Set(DOC_ITEMS.map((k) => REVISION_ITEMS[k].urlCol));

// ── Schema ──────────────────────────────────────────────────────────────────────────────────────
function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS revision_requests (
      id             TEXT PRIMARY KEY,
      user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status         TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | submitted | completed | rejected | cancelled | expired
      items          TEXT NOT NULL DEFAULT '[]',        -- JSON [{key, note}]  what the resident asked to change
      approved_items TEXT NOT NULL DEFAULT '[]',        -- JSON [key]          what the admin allowed
      done_items     TEXT NOT NULL DEFAULT '[]',        -- JSON [key]          approved items the resident already saved
      reason         TEXT NOT NULL DEFAULT '',          -- resident: why
      admin_note     TEXT NOT NULL DEFAULT '',          -- admin: comment shown to the resident
      decided_by     TEXT,                              -- admin user id (no FK on purpose: deleting an admin must not fail)
      decided_at     TEXT,
      expires_at     TEXT,                              -- end of the edit window (set on approval)
      completed_at   TEXT,
      created_at     TEXT DEFAULT (datetime('now')),
      updated_at     TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_revreq_user   ON revision_requests(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_revreq_status ON revision_requests(status, created_at);

    CREATE TABLE IF NOT EXISTS revision_changes (
      id         TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES revision_requests(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL,
      item_key   TEXT NOT NULL,                         -- info_personal | doc_residency ...
      field      TEXT NOT NULL,                         -- users column, or the document column (cert_residency_url ...)
      old_value  TEXT DEFAULT '',
      new_value  TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_revchg_req ON revision_changes(request_id);

    -- Resident edits waiting for the admin's second approval. One row per changed column / document slot.
    -- Nothing in here is visible on the resident's real record until the admin approves (applyChanges).
    CREATE TABLE IF NOT EXISTS revision_drafts (
      id         TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES revision_requests(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL,
      item_key   TEXT NOT NULL,                         -- info_personal | doc_residency ...
      field      TEXT NOT NULL,                         -- users column, or the document column (cert_residency_url ...)
      new_value  TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_revdraft_field ON revision_drafts(request_id, field);
  `);
  // Columns added for the second review step (older databases get them on boot; harmless when already there).
  const have = db.prepare('PRAGMA table_info(revision_requests)').all().map((c) => c.name);
  for (const [name, ddl] of [['submitted_at', 'TEXT'], ['reviewed_by', 'TEXT'], ['reviewed_at', 'TEXT'], ['review_note', "TEXT NOT NULL DEFAULT ''"]]) {
    if (!have.includes(name)) db.exec(`ALTER TABLE revision_requests ADD COLUMN ${name} ${ddl}`);
  }
}
try { ensureSchema(); }
catch (e) { log.error(`[revision] could not create tables: ${e.stack || e.message}`); throw e; }   // fail loudly at boot, not on the first resident tap

// ── Small helpers ───────────────────────────────────────────────────────────────────────────────
const fail = (status, code, error, extra = {}) => ({ ok: false, status, code, error, ...extra });

function cleanText(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, max);
}
const sqlNow = (d = new Date()) => d.toISOString().slice(0, 19).replace('T', ' ');           // matches datetime('now')
const toIso  = (ts) => (!ts ? null : (/[zZ+]/.test(String(ts)) ? String(ts) : String(ts).replace(' ', 'T') + 'Z'));
function parseJson(s, fallback) {
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch (_) { return fallback; }
}
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'\-]*$/u;

/** Admin / resident input -> [{key, note}] (unknown keys dropped, duplicates merged, notes trimmed). */
function sanitizeItems(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set(), out = [];
  for (const raw of input) {
    const key  = typeof raw === 'string' ? raw : raw && raw.key;
    const note = raw && typeof raw === 'object' ? raw.note : '';
    if (typeof key !== 'string' || !REQUESTABLE.includes(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, note: cleanText(note, NOTE_MAX) });
  }
  return out;
}
const decorate = (items) => items.map((i) => ({ key: i.key, note: i.note || '', label: REVISION_ITEMS[i.key].label, group: REVISION_ITEMS[i.key].group }));

function shape(row) {
  if (!row) return null;
  const items    = sanitizeItems(parseJson(row.items, []));
  const approved = parseJson(row.approved_items, []).filter((k) => REQUESTABLE.includes(k));
  const done     = parseJson(row.done_items, []).filter((k) => REQUESTABLE.includes(k));
  return {
    id: row.id, userId: row.user_id, status: row.status,
    items: decorate(items), approvedItems: approved, doneItems: done,
    approvedLabels: approved.map((k) => REVISION_ITEMS[k].label),
    reason: row.reason || '', adminNote: row.admin_note || '',
    decidedAt: toIso(row.decided_at), expiresAt: toIso(row.expires_at), completedAt: toIso(row.completed_at),
    submittedAt: toIso(row.submitted_at), reviewedAt: toIso(row.reviewed_at), reviewNote: row.review_note || '',
    createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at),
  };
}

// ── Course catalog (shared with the browser, same trick as utils/applicationForm.js) ────────────
let _catalog = null;
function catalog() {
  if (_catalog) return _catalog;
  _catalog = { courseFullName: () => null, courseMajorName: () => null };
  try {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'course-catalog.js'), 'utf8');
    const ctx = {}; vm.createContext(ctx); vm.runInContext(src, ctx, { timeout: 1000 });
    if (typeof ctx.courseFullName === 'function')  _catalog.courseFullName  = ctx.courseFullName;
    if (typeof ctx.courseMajorName === 'function') _catalog.courseMajorName = ctx.courseMajorName;
  } catch (e) { log.warn(`[revision] course catalog not loaded (${e.message}) - showing stored course codes`); }
  return _catalog;
}

// ── Validation of the editable information groups ───────────────────────────────────────────────
const addrSegments = (a) => String(a || '').split(',').map((s) => s.trim()).filter(Boolean).length;

/** Any phone format -> 10 digits starting with 9, or '' when it is not a valid PH mobile number. */
function tenDigits(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (/^9\d{9}$/.test(d)) return d;
  if (/^09\d{9}$/.test(d)) return d.slice(1);
  if (/^639\d{9}$/.test(d)) return d.slice(2);
  return '';
}
function ageOn(iso) {
  const d = new Date(iso + 'T00:00:00Z'); if (isNaN(d)) return -1;
  const n = new Date(); let a = n.getUTCFullYear() - d.getUTCFullYear();
  if (n.getUTCMonth() < d.getUTCMonth() || (n.getUTCMonth() === d.getUTCMonth() && n.getUTCDate() < d.getUTCDate())) a--;
  return a;
}

function sanitizePerson(raw, label, { guardian = false } = {}) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const p = {
    firstName: cleanText(o.firstName, 60), middleName: cleanText(o.middleName, 60),
    lastName:  cleanText(o.lastName, 60),  suffix:     cleanText(o.suffix, 10),
  };
  const deceased = !guardian && (o.deceased === true || o.deceased === 'true');
  if (!p.firstName) return fail(400, 'VALIDATION', `${label}'s first name is required.`, { field: `${label}.firstName` });
  if (!p.lastName)  return fail(400, 'VALIDATION', `${label}'s last name is required.`,  { field: `${label}.lastName` });
  for (const k of ['firstName', 'middleName', 'lastName']) {
    if (p[k] && !NAME_RE.test(p[k])) return fail(400, 'VALIDATION', `${label}'s name has characters that are not allowed.`, { field: `${label}.${k}` });
  }
  const out = { ...p, phone: '', employer: '', address: '' };
  if (guardian) out.relationship = cleanText(o.relationship, 40);
  if (!deceased) {
    out.phone = tenDigits(o.phone);
    if (!out.phone) return fail(400, 'VALIDATION', `${label}'s contact number must be 10 digits starting with 9.`, { field: `${label}.phone` });
    out.employer = cleanText(o.employer, 120);
    if (!guardian && !out.employer) return fail(400, 'VALIDATION', `${label}'s employer / company is required.`, { field: `${label}.employer` });
    out.address = cleanText(o.address, 300);
    if (out.address.length < 5) return fail(400, 'VALIDATION', `${label}'s address is required.`, { field: `${label}.address` });
  }
  if (guardian && !out.relationship) return fail(400, 'VALIDATION', `${label}'s relationship to the resident is required.`, { field: `${label}.relationship` });
  if (!guardian) out.deceased = deceased;
  return { ok: true, person: out };
}

/**
 * values (from the browser) -> { ok, updates: { column: newValue } } | { ok:false, status, code, error, field }
 * Column names are OUR constants (never the browser's), so they are safe to put into SQL.
 */
function buildInfoUpdate(group, v, row) {
  v = v && typeof v === 'object' ? v : {};
  switch (group) {
    case 'info_personal': {
      const firstName = cleanText(v.firstName, 60), lastName = cleanText(v.lastName, 60);
      const middleName = cleanText(v.middleName, 60), suffix = cleanText(v.suffix, 10);
      if (!firstName) return fail(400, 'VALIDATION', 'First name is required.', { field: 'firstName' });
      if (!lastName)  return fail(400, 'VALIDATION', 'Last name is required.',  { field: 'lastName' });
      for (const [k, val] of [['firstName', firstName], ['middleName', middleName], ['lastName', lastName]]) {
        if (val && !NAME_RE.test(val)) return fail(400, 'VALIDATION', 'Names can only contain letters, spaces, hyphens, apostrophes and periods.', { field: k });
      }
      const birthday = String(v.birthday || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday)) return fail(400, 'VALIDATION', 'Date of birth is required.', { field: 'birthday' });
      const age = ageOn(birthday);
      if (age < 13)  return fail(400, 'VALIDATION', 'You must be at least 13 years old.', { field: 'birthday' });
      if (age > 100) return fail(400, 'VALIDATION', 'Please check your date of birth.', { field: 'birthday' });
      const sex = String(v.sex || '').toLowerCase();
      if (!SEXES.includes(sex)) return fail(400, 'VALIDATION', 'Please choose your sex.', { field: 'sex' });
      const civil = String(v.civilStatus || '').trim();
      if (!CIVIL_STATUSES.includes(civil)) return fail(400, 'VALIDATION', 'Please choose your civil status.', { field: 'civilStatus' });
      const ten = tenDigits(v.phone);
      if (!ten) return fail(400, 'VALIDATION', 'Invalid phone number. Enter 10 digits after +63 (it starts with 9).', { field: 'phone' });
      const phone = '+63' + ten;
      if (phone !== row.phone) {
        const taken = db.prepare('SELECT id FROM users WHERE phone = ? AND id <> ?').get(phone, row.id);
        if (taken) return fail(409, 'PHONE_TAKEN', 'That phone number is already registered to another account.', { field: 'phone' });
      }
      return { ok: true, updates: { first_name: firstName, middle_name: middleName, last_name: lastName, suffix, birthday, sex, civil_status: civil, phone } };
    }
    case 'info_address': {
      const perm = cleanText(v.permanentAddress, 300), pres = cleanText(v.presentAddress, 300);
      // "[Purok - ]Barangay, City, [Province,] Region, Philippines" has >= 4 comma segments (same rule as registration)
      if (addrSegments(perm) < 4) return fail(400, 'VALIDATION', 'Your permanent address looks incomplete. Use: Purok / Street, Barangay, City / Municipality, Province, Region, Philippines.', { field: 'permanentAddress' });
      if (addrSegments(pres) < 4) return fail(400, 'VALIDATION', 'Your present address looks incomplete. Use: Purok / Street, Barangay, City / Municipality, Province, Region, Philippines.', { field: 'presentAddress' });
      return { ok: true, updates: { permanent_address: perm, present_address: pres, location: pres } };   // registration also stores location = present address
    }
    case 'info_school': {
      const schoolName = cleanText(v.schoolName, 120), schoolAddress = cleanText(v.schoolAddress, 200);
      const yearLevel = String(v.yearLevel || '').trim(), course = cleanText(v.course, 80), specialization = cleanText(v.specialization, 80);
      if (!schoolName) return fail(400, 'VALIDATION', 'School name is required.', { field: 'schoolName' });
      if (!YEAR_LEVELS.includes(yearLevel)) return fail(400, 'VALIDATION', 'Please select your year level.', { field: 'yearLevel' });
      if (!course) return fail(400, 'VALIDATION', 'Please select your program / course.', { field: 'course' });
      return { ok: true, updates: { school_name: schoolName, school_address: schoolAddress, year_level: yearLevel, course, specialization } };
    }
    case 'info_family': {
      const f = sanitizePerson(v.father, "Father"); if (!f.ok) return f;
      const m = sanitizePerson(v.mother, "Mother"); if (!m.ok) return m;
      const income = String(v.monthlyIncome || '').trim();
      if (!INCOME_OPTIONS.includes(income) && income !== String(row.monthly_income || ''))   // a legacy value that is already stored stays valid
        return fail(400, 'VALIDATION', 'Please choose your family income bracket.', { field: 'monthlyIncome' });
      const updates = { father_info: JSON.stringify(f.person), mother_info: JSON.stringify(m.person), monthly_income: income };
      if (f.person.deceased && m.person.deceased) {       // guardian is only required (and only stored) when both parents are deceased
        const g = sanitizePerson(v.guardian, "Guardian", { guardian: true }); if (!g.ok) return g;
        updates.guardian_info = JSON.stringify(g.person);
      }
      return { ok: true, updates };
    }
    default: return fail(400, 'BAD_GROUP', 'Unknown part of the application.');
  }
}

// ── Request lifecycle ───────────────────────────────────────────────────────────────────────────
/**
 * An approved window that ran out: drafts the resident saved go to the admin for review (nothing is lost, nothing is applied
 * on its own); a window with no drafts simply expires.
 */
function expireStale() {
  const now = sqlNow();
  const toReview = db.prepare(`UPDATE revision_requests SET status = 'submitted', submitted_at = datetime('now'), updated_at = datetime('now')
                               WHERE status = 'approved' AND expires_at IS NOT NULL AND expires_at < ?
                                 AND EXISTS (SELECT 1 FROM revision_drafts d WHERE d.request_id = revision_requests.id)`).run(now);
  const expired = db.prepare(`UPDATE revision_requests SET status = 'expired', updated_at = datetime('now')
                              WHERE status = 'approved' AND expires_at IS NOT NULL AND expires_at < ?`).run(now);
  if (toReview.changes) log.info(`[revision] ${toReview.changes} request(s) passed their edit window with saved drafts and now wait for admin review`);
  if (expired.changes)  log.info(`[revision] ${expired.changes} approved request(s) passed their edit window and expired`);
  return toReview.changes + expired.changes;
}
function getRow(id) { return db.prepare('SELECT * FROM revision_requests WHERE id = ?').get(id); }
function getOpenRequest(userId) {
  expireStale();
  return shape(db.prepare(`SELECT * FROM revision_requests WHERE user_id = ? AND status IN ('pending','approved','submitted') ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(userId));
}
function history(userId, limit = 5) {
  return db.prepare('SELECT * FROM revision_requests WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(userId, limit).map(shape);
}

function eligibility(userId) {
  const u = db.prepare('SELECT account_status, role FROM users WHERE id = ?').get(userId);
  if (!u) return fail(404, 'NO_USER', 'Account not found.');
  if ((u.account_status || 'approved') !== 'approved' || (u.role && u.role !== 'user'))
    return fail(403, 'NOT_RESIDENT', 'Only approved residents can request a correction.');
  return { ok: true };
}

function createRequest(userId, rawItems, rawReason) {
  const el = eligibility(userId); if (!el.ok) return el;
  const items = sanitizeItems(rawItems);
  if (!items.length) return fail(400, 'NO_ITEMS', 'Choose at least one thing you want to correct.');
  const reason = cleanText(rawReason, REASON_MAX);
  if (reason.length < REASON_MIN) return fail(400, 'REASON_REQUIRED', 'Please tell the admin what is wrong (at least a short sentence) so they can decide.', { field: 'reason' });
  if (getOpenRequest(userId)) return fail(409, 'ALREADY_OPEN', 'You already have a correction request in progress.');
  const recent = db.prepare(`SELECT COUNT(*) AS n FROM revision_requests WHERE user_id = ? AND created_at >= datetime('now','-30 days')`).get(userId).n;
  if (recent >= MAX_REQUESTS_30D) return fail(429, 'TOO_MANY', `You can send up to ${MAX_REQUESTS_30D} correction requests every 30 days. Please contact the dormitory admin.`);
  const id = genId();
  db.prepare('INSERT INTO revision_requests (id, user_id, items, reason) VALUES (?,?,?,?)').run(id, userId, JSON.stringify(items), reason);
  log.info(`[revision] request ${id} created by ${userId}: [${items.map((i) => i.key).join(', ')}]`);
  return { ok: true, request: shape(getRow(id)) };
}

function cancelRequest(id, userId) {
  const row = getRow(id);
  if (!row || row.user_id !== userId) return fail(404, 'NOT_FOUND', 'Request not found.');
  if (row.status !== 'pending' && row.status !== 'submitted') return fail(409, 'NOT_PENDING', 'Only a request (or changes) still waiting for the admin can be withdrawn.');
  db.transaction(() => {
    db.prepare('DELETE FROM revision_drafts WHERE request_id = ?').run(id);           // withdrawn changes never reach the real record
    db.prepare(`UPDATE revision_requests SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`).run(id);
  })();
  return { ok: true, request: shape(getRow(id)), wasSubmitted: row.status === 'submitted' };
}

function approve({ id, adminId, items, days, note }) {
  expireStale();
  const row = getRow(id);
  if (!row) return fail(404, 'NOT_FOUND', 'Request not found.');
  if (row.status !== 'pending') return fail(409, 'NOT_PENDING', `This request was already ${row.status}.`);
  const requested = sanitizeItems(parseJson(row.items, [])).map((i) => i.key);
  const wanted = Array.isArray(items) ? items : requested;
  const granted = [...new Set(wanted.filter((k) => requested.includes(k)))];
  if (!granted.length) return fail(400, 'NO_ITEMS', 'Select at least one item to allow, or decline the request instead.');
  const d = ALLOWED_WINDOWS.includes(Number(days)) ? Number(days) : DEFAULT_WINDOW_DAYS;
  const expires = sqlNow(new Date(Date.now() + d * 86400000));
  db.prepare(`UPDATE revision_requests SET status = 'approved', approved_items = ?, admin_note = ?, decided_by = ?, decided_at = datetime('now'),
              expires_at = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(granted), cleanText(note, ADMIN_NOTE_MAX), adminId, expires, id);
  return { ok: true, request: shape(getRow(id)), days: d };
}

function reject({ id, adminId, note }) {
  const row = getRow(id);
  if (!row) return fail(404, 'NOT_FOUND', 'Request not found.');
  if (row.status !== 'pending') return fail(409, 'NOT_PENDING', `This request was already ${row.status}.`);
  const n = cleanText(note, ADMIN_NOTE_MAX);
  if (n.length < ADMIN_NOTE_MIN) return fail(400, 'NOTE_REQUIRED', 'Please tell the resident why the request was declined.', { field: 'note' });
  db.prepare(`UPDATE revision_requests SET status = 'rejected', admin_note = ?, decided_by = ?, decided_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(n, adminId, id);
  return { ok: true, request: shape(getRow(id)) };
}

/** Admin closes an approved window early (typo in the approval, resident misuse ...). Unsubmitted drafts are discarded. */
function revoke({ id, adminId, note }) {
  const row = getRow(id);
  if (!row) return fail(404, 'NOT_FOUND', 'Request not found.');
  if (row.status !== 'approved') return fail(409, 'NOT_APPROVED', 'Only an approved request can be revoked.');
  const n = cleanText(note, ADMIN_NOTE_MAX) || row.admin_note;
  db.transaction(() => {
    db.prepare('DELETE FROM revision_drafts WHERE request_id = ?').run(id);
    db.prepare(`UPDATE revision_requests SET status = 'cancelled', admin_note = ?, decided_by = ?, updated_at = datetime('now') WHERE id = ?`).run(n, adminId, id);
  })();
  return { ok: true, request: shape(getRow(id)) };
}

/**
 * Resident hands the drafts over. With drafts -> 'submitted' (admin must approve again). Without any -> the request is simply
 * closed ('completed', nothing to review).
 */
function submitForReview(id, userId) {
  const row = getRow(id);
  if (!row || row.user_id !== userId) return fail(404, 'NOT_FOUND', 'Request not found.');
  if (row.status !== 'approved') return fail(409, 'NOT_APPROVED', 'This request is not open for editing.');
  const changeCount = db.prepare('SELECT COUNT(*) AS n FROM revision_drafts WHERE request_id = ?').get(id).n;
  if (!changeCount) {
    db.prepare(`UPDATE revision_requests SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
    return { ok: true, submitted: false, request: shape(getRow(id)), changeCount: 0 };
  }
  db.prepare(`UPDATE revision_requests SET status = 'submitted', submitted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
  return { ok: true, submitted: true, request: shape(getRow(id)), changeCount };
}

// ── Saving the resident's edits as DRAFTS (only inside an approved window, only approved items) ─
/**
 * Re-reads the request from the database on EVERY edit (never trusts the object a caller holds) and checks owner,
 * status, expiry and that `key` was approved. Returns { error } or { request } (the fresh, shaped request).
 */
function guardEdit(request, userId, key) {
  expireStale();
  const row = request && request.id ? getRow(request.id) : null;
  if (row && row.user_id === userId && row.status === 'expired') return { error: fail(410, 'EXPIRED', 'Your edit window has ended. Please send a new request.') };
  if (row && row.user_id === userId && row.status === 'submitted') return { error: fail(409, 'IN_REVIEW', 'Your changes were already sent to the admin for review.') };
  if (!row || row.user_id !== userId || row.status !== 'approved') {
    return { error: fail(403, 'NO_WINDOW', 'You do not have an approved correction request. Send a request first.') };
  }
  const fresh = shape(row);
  if (fresh.expiresAt && new Date(fresh.expiresAt) < new Date()) return { error: fail(410, 'EXPIRED', 'Your edit window has ended. Please send a new request.') };
  if (key && !fresh.approvedItems.includes(key)) return { error: fail(403, 'NOT_APPROVED', 'The admin did not approve changes to that part of your application.') };
  return { request: fresh };
}
/** done_items = approved items that currently hold at least one draft. */
function setDone(requestId, key, on) {
  const row = getRow(requestId);
  const set = new Set(parseJson(row.done_items, []));
  if (on) set.add(key); else set.delete(key);
  db.prepare(`UPDATE revision_requests SET done_items = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify([...set]), requestId);
}
function listDrafts(requestId) {
  return db.prepare('SELECT item_key, field, new_value FROM revision_drafts WHERE request_id = ? ORDER BY created_at, rowid').all(requestId);
}
function latestDocsRow(userId) {
  return db.prepare('SELECT * FROM id_verification_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(userId);
}

/**
 * One information group -> draft rows (only the columns that really differ from the REAL record).
 * Saving the group again replaces its earlier draft; saving values equal to the real record clears the draft.
 * The real record (users table) is never written here.
 */
function saveInfoDraft(userId, request, group, values) {
  if (!INFO_ITEMS.includes(group)) return fail(400, 'BAD_GROUP', 'Unknown part of the application.');
  const g = guardEdit(request, userId, group); if (g.error) return g.error;
  request = g.request;
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!row) return fail(404, 'NO_USER', 'Account not found.');
  const built = buildInfoUpdate(group, values, row);
  if (!built.ok) return built;

  const changes = [];
  for (const [col, nv] of Object.entries(built.updates)) {
    const ov = row[col] == null ? '' : String(row[col]);
    if (ov !== String(nv)) changes.push({ field: col, newValue: String(nv) });
  }
  const had = db.prepare('SELECT COUNT(*) AS n FROM revision_drafts WHERE request_id = ? AND item_key = ?').get(request.id, group).n;
  db.transaction(() => {
    db.prepare('DELETE FROM revision_drafts WHERE request_id = ? AND item_key = ?').run(request.id, group);
    const ins = db.prepare('INSERT INTO revision_drafts (id, request_id, user_id, item_key, field, new_value) VALUES (?,?,?,?,?,?)');
    for (const c of changes) ins.run(genId(), request.id, userId, group, c.field, c.newValue);
    setDone(request.id, group, changes.length > 0);
  })();
  log.info(`[revision] ${request.id}: ${userId} saved a draft of ${group} -> [${changes.map((c) => c.field).join(', ')}]`);
  return { ok: true, changed: changes.length, cleared: !changes.length && had > 0, fields: changes.map((c) => c.field) };
}

/** urls = req.idDocUrls from middleware/upload.js (field name -> stored URL). The new file is stored as a draft only. */
function saveDocumentDrafts(userId, request, urls) {
  const g = guardEdit(request, userId, null); if (g.error) return g.error;
  request = g.request;
  const incoming = Object.entries(urls || {}).filter(([field, url]) => FIELD_TO_ITEM[field] && url);
  if (!incoming.length) return fail(400, 'NO_FILE', 'Please choose the file you want to upload (JPG, PNG, WebP, PDF or DOCX).');
  const notAllowed = incoming.filter(([field]) => !request.approvedItems.includes(FIELD_TO_ITEM[field]));
  if (notAllowed.length) {
    log.warn(`[revision] ${request.id}: ${userId} uploaded documents that were not approved: ${notAllowed.map(([f]) => f).join(', ')}`);
    return fail(403, 'NOT_APPROVED', `The admin did not approve changes to: ${notAllowed.map(([f]) => REVISION_ITEMS[FIELD_TO_ITEM[f]].label).join(', ')}.`);
  }
  const replaced = [];
  db.transaction(() => {
    const up = db.prepare(`INSERT INTO revision_drafts (id, request_id, user_id, item_key, field, new_value) VALUES (?,?,?,?,?,?)
                           ON CONFLICT(request_id, field) DO UPDATE SET new_value = excluded.new_value, updated_at = datetime('now')`);
    for (const [field, url] of incoming) {
      const key = FIELD_TO_ITEM[field], col = REVISION_ITEMS[key].urlCol;       // our constant, not the browser's
      up.run(genId(), request.id, userId, key, col, url);                        // a replaced draft file stays in storage, only the pointer changes
      replaced.push(key);
    }
    replaced.forEach((k) => setDone(request.id, k, true));
  })();
  log.info(`[revision] ${request.id}: ${userId} saved draft documents [${replaced.join(', ')}]`);
  return { ok: true, replaced };
}

/** Drafts as old -> new, where "old" is the resident's REAL value right now (what approving would overwrite). */
function draftChanges(requestId, userId) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) || {};
  const docs = latestDocsRow(userId) || {};
  return listDrafts(requestId).map((d) => {
    const isDoc = DOC_COLUMNS.has(d.field);
    const old = isDoc ? docs[d.field] : u[d.field];
    return { itemKey: d.item_key, field: d.field, isDocument: isDoc, oldValue: old == null ? '' : String(old), newValue: d.new_value || '' };
  });
}

// ── Summary of the resident's application (also used by the admin review) ───────────────────────
function fmtDate(v) {
  if (!v) return '';
  const d = new Date(String(v).slice(0, 10) + 'T00:00:00Z');
  return isNaN(d) ? String(v) : d.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}
const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');
function fmtPhone(p) {
  const t = tenDigits(p);
  return t ? `+63 ${t.slice(0, 3)} ${t.slice(3, 6)} ${t.slice(6)}` : String(p || '');
}
function personName(o) { return [o.firstName, o.middleName, o.lastName, o.suffix].filter(Boolean).join(' '); }
function docKind(url) {
  const u = String(url || '').toLowerCase().split('?')[0];
  if (u.startsWith('data:application/pdf') || u.endsWith('.pdf')) return 'pdf';
  if (u.endsWith('.docx') || u.endsWith('.doc')) return 'docx';
  return url ? 'image' : '';
}
function personRows(o, { guardian = false } = {}) {
  const rows = [{ label: 'Name', value: personName(o) || '\u2014' }];
  if (guardian) rows.push({ label: 'Relationship', value: o.relationship || '\u2014' });
  if (o.deceased) { rows.push({ label: 'Status', value: 'Deceased' }); return rows; }
  rows.push({ label: 'Contact number', value: fmtPhone(o.phone) || '\u2014' }, { label: 'Employer / company', value: o.employer || '\u2014' }, { label: 'Address', value: o.address || '\u2014', wide: true });
  return rows;
}

/**
 * opts.draftsOf = request id -> the resident's saved DRAFTS are laid over their real record (their own view while editing / waiting).
 * Without it the summary shows the real record only (admin side, PDF ...). Sections / documents that hold a draft carry staged: true.
 */
function buildSummary(userId, opts = {}) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u) return null;
  const docs = { ...(latestDocsRow(userId) || {}) };
  const staged = new Set();
  if (opts.draftsOf) {
    for (const d of listDrafts(opts.draftsOf)) {
      if (DOC_COLUMNS.has(d.field)) docs[d.field] = d.new_value;
      else if (INFO_COLUMNS.has(d.field)) u[d.field] = d.new_value;
      else continue;
      staged.add(d.item_key);
    }
  }
  const bed  = db.prepare('SELECT dr.room_number AS room, ba.bed_number AS bed, dr.gender AS gender FROM bed_assignments ba JOIN dorm_rooms dr ON dr.id = ba.room_id WHERE ba.user_id = ? LIMIT 1').get(userId);
  const father = parseJson(u.father_info, {}), mother = parseJson(u.mother_info, {}), guardian = parseJson(u.guardian_info, {});
  const cat = catalog();
  const courseName = cat.courseFullName(u.course) || u.course || '';
  const major = cat.courseMajorName(u.course) || cat.courseMajorName(u.specialization) || '';
  const bothGone = !!(father.deceased && mother.deceased);
  const dash = '\u2014';

  const sections0 = [
    { key: 'info_personal', title: 'Personal information', icon: 'fa-user', rows: [
      { label: 'Full name', value: personName({ firstName: u.first_name, middleName: u.middle_name, lastName: u.last_name, suffix: u.suffix }), wide: true },
      { label: 'Date of birth', value: fmtDate(u.birthday) || dash }, { label: 'Sex', value: cap(u.sex) || dash },
      { label: 'Civil status', value: u.civil_status || dash }, { label: 'Phone', value: fmtPhone(u.phone) || dash },
      { label: 'Email', value: u.email || dash, wide: true },
    ] },
    { key: 'info_address', title: 'Home address', icon: 'fa-location-dot', rows: [
      { label: 'Permanent address', value: u.permanent_address || dash, wide: true },
      { label: 'Present address', value: u.present_address || dash, wide: true },
    ] },
    { key: 'info_school', title: 'School', icon: 'fa-graduation-cap', rows: [
      { label: 'School', value: u.school_name || dash }, { label: 'School address', value: u.school_address || dash },
      { label: 'Year level', value: u.year_level ? `Year ${u.year_level}` : dash }, { label: 'Program / course', value: courseName || dash, wide: true },
      ...(major ? [{ label: 'Major / specialization', value: major, wide: true }] : []),
    ] },
    { key: 'info_family', title: 'Family', icon: 'fa-people-roof', groups: [
      { title: "Father", rows: personRows(father) }, { title: "Mother", rows: personRows(mother) },
      ...(bothGone || personName(guardian) ? [{ title: 'Guardian', rows: personRows(guardian, { guardian: true }) }] : []),
    ], rows: [{ label: 'Combined monthly family income', value: u.monthly_income || dash, wide: true }] },
  ];

  const sections = sections0.map((sec) => ({ ...sec, staged: staged.has(sec.key) }));

  const docRow = (key, label, url, extra = {}) => ({ key, label, url: url || '', kind: docKind(url), onFile: !!url, staged: staged.has(key), ...extra });
  const documents = [
    ...DOC_ITEMS.map((k) => docRow(k, REVISION_ITEMS[k].label, docs[REVISION_ITEMS[k].urlCol])),
    docRow('doc_medical', 'Medical Certificate', u.cert_medical_url, { note: 'Upload or replace it from the Medical Certificate card.' }),
  ];

  const tenOfPhone = tenDigits(u.phone);
  return {
    applicant: { name: personName({ firstName: u.first_name, middleName: u.middle_name, lastName: u.last_name, suffix: u.suffix }), username: u.username, avatar: u.avatar || '', email: u.email },
    status: { admissionNo: u.admission_no || '', room: bed ? bed.room : null, bed: bed ? bed.bed : null, roomGender: bed ? bed.gender : null, sex: u.sex || '' },
    sections, documents,
    // raw values the resident's edit form starts from
    values: {
      info_personal: { firstName: u.first_name || '', middleName: u.middle_name || '', lastName: u.last_name || '', suffix: u.suffix || '', birthday: u.birthday || '', sex: String(u.sex || '').toLowerCase(), civilStatus: u.civil_status || '', phone: tenOfPhone },
      info_address:  { permanentAddress: u.permanent_address || '', presentAddress: u.present_address || '' },
      info_school:   { schoolName: u.school_name || '', schoolAddress: u.school_address || '', yearLevel: String(u.year_level || ''), course: u.course || '', specialization: u.specialization || '' },
      info_family:   { father: { ...father, phone: tenDigits(father.phone) || '' }, mother: { ...mother, phone: tenDigits(mother.phone) || '' },
                       guardian: { ...guardian, phone: tenDigits(guardian.phone) || '' }, monthlyIncome: u.monthly_income || '' },
    },
  };
}
// ── Admin side ──────────────────────────────────────────────────────────────────────────────────
const ADMIN_SELECT = `
  SELECT r.*, u.first_name, u.middle_name, u.last_name, u.username, u.email, u.avatar, u.sex AS user_sex,
         dr.room_number, ba.bed_number, dr.gender AS room_gender,
         (SELECT COUNT(*) FROM revision_changes c WHERE c.request_id = r.id) AS change_count,
         (SELECT COUNT(*) FROM revision_drafts d WHERE d.request_id = r.id) AS draft_count
  FROM revision_requests r
  JOIN users u ON u.id = r.user_id
  LEFT JOIN bed_assignments ba ON ba.user_id = r.user_id
  LEFT JOIN dorm_rooms dr ON dr.id = ba.room_id`;

function adminRow(row) {
  const base = shape(row);
  const inReview = row.status === 'submitted';
  // sex that the resident has (completed) or WOULD have (submitted) after the change, to flag a room / gender clash
  let sexAfter = null;
  if (inReview) { const d = db.prepare(`SELECT new_value FROM revision_drafts WHERE request_id = ? AND field = 'sex'`).get(row.id); sexAfter = d ? d.new_value : null; }
  else if (row.change_count > 0) sexAfter = row.user_sex;
  const mismatch = sexAfter && row.room_gender && String(sexAfter).toLowerCase() !== row.room_gender;
  return {
    ...base,
    resident: {
      id: row.user_id, username: row.username, email: row.email, avatar: row.avatar || '',
      name: personName({ firstName: row.first_name, middleName: row.middle_name, lastName: row.last_name }),
      room: row.room_number || null, bed: row.bed_number || null,
    },
    changeCount: inReview ? (row.draft_count || 0) : (row.change_count || 0),
    warnings: mismatch ? [`Sex ${inReview ? 'would become' : 'is now'} "${sexAfter}" but the resident is assigned to Room ${row.room_number} (${row.room_gender}). Review the bed assignment.`] : [],
  };
}

const STATUSES = ['pending', 'approved', 'submitted', 'completed', 'rejected', 'cancelled', 'expired'];
function listForAdmin({ status = 'all', limit = 100 } = {}) {
  expireStale();
  const params = [];
  let q = ADMIN_SELECT;
  if (STATUSES.includes(status)) { q += ' WHERE r.status = ?'; params.push(status); }
  q += ` ORDER BY CASE r.status WHEN 'submitted' THEN 0 WHEN 'pending' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END, r.created_at DESC, r.rowid DESC LIMIT ?`;
  params.push(Math.min(Math.max(parseInt(limit, 10) || 100, 1), 300));
  return db.prepare(q).all(...params).map(adminRow);
}
function statsForAdmin() {
  expireStale();
  const out = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM revision_requests GROUP BY status').all()) out[r.status] = r.n;
  return out;
}
function detailForAdmin(id) {
  expireStale();
  const row = db.prepare(`${ADMIN_SELECT} WHERE r.id = ?`).get(id);
  if (!row) return null;
  const labelOf = (k) => (REVISION_ITEMS[k] ? REVISION_ITEMS[k].label : k);
  // submitted -> the PROPOSED changes (drafts vs. the real record, nothing applied yet); otherwise the log of what was applied
  const changes = row.status === 'submitted'
    ? draftChanges(id, row.user_id).map((c) => ({ ...c, label: labelOf(c.itemKey), at: null }))
    : db.prepare('SELECT item_key, field, old_value, new_value, created_at FROM revision_changes WHERE request_id = ? ORDER BY created_at, rowid').all(id)
        .map((c) => ({ itemKey: c.item_key, label: labelOf(c.item_key), field: c.field,
                       isDocument: c.field.endsWith('_url'), oldValue: c.old_value || '', newValue: c.new_value || '', at: toIso(c.created_at) }));
  const summary = buildSummary(row.user_id);
  if (summary) delete summary.values;                  // the admin does not need the edit-form values
  return { ...adminRow(row), changes, summary };
}

// ── Admin: the second approval (resident submitted drafts) ──────────────────────────────────────
function submittedRow(id) {
  expireStale();
  const row = getRow(id);
  if (!row) return { error: fail(404, 'NOT_FOUND', 'Request not found.') };
  if (row.status !== 'submitted') return { error: fail(409, 'NOT_SUBMITTED', `These changes are not waiting for review (status: ${row.status}).`) };
  return { row };
}

/** Approve: write every draft to the real record, log old -> new, close the request. All or nothing. */
function applyChanges({ id, adminId, note }) {
  const s = submittedRow(id); if (s.error) return s.error;
  const row = s.row, userId = row.user_id;
  const drafts = listDrafts(id);
  const live = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!live) return fail(404, 'NO_USER', 'The resident account no longer exists.');
  const infoDrafts = drafts.filter((d) => INFO_COLUMNS.has(d.field));
  const docDrafts  = drafts.filter((d) => DOC_COLUMNS.has(d.field));

  const ph = infoDrafts.find((d) => d.field === 'phone');                     // someone else may have taken the number since the draft was saved
  if (ph && ph.new_value !== live.phone && db.prepare('SELECT id FROM users WHERE phone = ? AND id <> ?').get(ph.new_value, userId))
    return fail(409, 'PHONE_TAKEN', 'The new phone number is now registered to another account. Return the changes so the resident can fix it.');

  const n = cleanText(note, ADMIN_NOTE_MAX);
  let applied = 0;
  db.transaction(() => {
    const logIns = db.prepare('INSERT INTO revision_changes (id, request_id, user_id, item_key, field, old_value, new_value) VALUES (?,?,?,?,?,?,?)');
    const userChanges = infoDrafts.filter((d) => String(live[d.field] == null ? '' : live[d.field]) !== d.new_value);
    if (userChanges.length) {
      db.prepare(`UPDATE users SET ${userChanges.map((d) => `${d.field} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)   // columns are whitelisted above
        .run(...userChanges.map((d) => d.new_value), userId);
      for (const d of userChanges) logIns.run(genId(), id, userId, d.item_key, d.field, live[d.field] == null ? '' : String(live[d.field]), d.new_value);
      applied += userChanges.length;
    }
    if (docDrafts.length) {
      let latest = latestDocsRow(userId);
      if (!latest) {          // very old accounts may have no verification row; 'approved' keeps it out of the pending queue
        const nid = genId();
        db.prepare(`INSERT INTO id_verification_requests (id, user_id, id_front_url, status) VALUES (?, ?, '', 'approved')`).run(nid, userId);
        latest = db.prepare('SELECT * FROM id_verification_requests WHERE id = ?').get(nid);
      }
      for (const d of docDrafts) {
        if ((latest[d.field] || '') === d.new_value) continue;
        db.prepare(`UPDATE id_verification_requests SET ${d.field} = ? WHERE id = ?`).run(d.new_value, latest.id);                // columns are whitelisted above
        logIns.run(genId(), id, userId, d.item_key, d.field, latest[d.field] || '', d.new_value);                                 // the old file stays in storage as evidence
        applied++;
      }
    }
    db.prepare('DELETE FROM revision_drafts WHERE request_id = ?').run(id);
    db.prepare(`UPDATE revision_requests SET status = 'completed', completed_at = datetime('now'), reviewed_by = ?, reviewed_at = datetime('now'),
                review_note = ?, updated_at = datetime('now') WHERE id = ?`).run(adminId, n, id);
  })();
  log.info(`[revision] ${id}: applied ${applied} change(s) for ${userId}`);
  return { ok: true, request: shape(getRow(id)), applied };
}

/** Decline the changes: drafts are thrown away, the real record stays exactly as it was. A reason is required. */
function discardChanges({ id, adminId, note }) {
  const s = submittedRow(id); if (s.error) return s.error;
  const n = cleanText(note, ADMIN_NOTE_MAX);
  if (n.length < ADMIN_NOTE_MIN) return fail(400, 'NOTE_REQUIRED', 'Please tell the resident why the changes were not approved.', { field: 'note' });
  db.transaction(() => {
    db.prepare('DELETE FROM revision_drafts WHERE request_id = ?').run(id);
    db.prepare(`UPDATE revision_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now'), review_note = ?, updated_at = datetime('now') WHERE id = ?`).run(adminId, n, id);
  })();
  return { ok: true, request: shape(getRow(id)) };
}

/** Return for correction: drafts are kept, the resident gets a fresh edit window and the admin's note. A reason is required. */
function returnChanges({ id, adminId, note, days }) {
  const s = submittedRow(id); if (s.error) return s.error;
  const n = cleanText(note, ADMIN_NOTE_MAX);
  if (n.length < ADMIN_NOTE_MIN) return fail(400, 'NOTE_REQUIRED', 'Please tell the resident what to fix.', { field: 'note' });
  const d = ALLOWED_WINDOWS.includes(Number(days)) ? Number(days) : DEFAULT_WINDOW_DAYS;
  const expires = sqlNow(new Date(Date.now() + d * 86400000));
  db.prepare(`UPDATE revision_requests SET status = 'approved', expires_at = ?, reviewed_by = ?, reviewed_at = datetime('now'), review_note = ?,
              updated_at = datetime('now') WHERE id = ?`).run(expires, adminId, n, id);
  return { ok: true, request: shape(getRow(id)), days: d };
}

module.exports = {
  // constants (used by routes + UI)
  REQUESTABLE, INFO_ITEMS, DOC_ITEMS, FIELD_TO_ITEM, ALLOWED_WINDOWS, DEFAULT_WINDOW_DAYS, MAX_REQUESTS_30D,
  REASON_MIN, REASON_MAX, NOTE_MAX, ADMIN_NOTE_MIN, CIVIL_STATUSES, SEXES, YEAR_LEVELS, INCOME_OPTIONS,
  // pure helpers (unit-testable)
  sanitizeItems, buildInfoUpdate, tenDigits, cleanText,
  // resident side
  getOpenRequest, history, eligibility, createRequest, cancelRequest, saveInfoDraft, saveDocumentDrafts, submitForReview, buildSummary,
  // admin side
  approve, reject, revoke, applyChanges, discardChanges, returnChanges, listForAdmin, statsForAdmin, detailForAdmin, expireStale,
};
