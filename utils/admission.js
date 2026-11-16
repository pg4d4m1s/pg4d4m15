// utils/admission.js
/**
 * Admissions control — "close applications" switch + automatic close when a gender's beds are full.
 *
 * Rules (set by the admin, see the Registrations tab):
 *   • Master switch (app_settings.admission_closed = '1')  → registration is closed for EVERYONE (male + female).
 *   • Auto-close per gender: when the number of APPROVED residents of that sex reaches the number of beds in the
 *     rooms of that gender (SUM of dorm_rooms.capacity), that gender is closed. Approved residents count even when
 *     they have no bed assigned yet — they will be assigned later.
 *   • When a gender becomes full:
 *       – every still-pending application of that sex is auto-returned to the archive ("Rejected" tab) and the
 *         applicant gets a "slots are full" e-mail;
 *       – an automatic login-page announcement is posted (male / female / both).
 *   • Nothing is stored for "full": it is computed live from the data, so it reopens by itself when beds are
 *     added or a resident leaves. Only the announcement flags live in app_settings (admission_ann_male|female|all).
 *
 * Missing keys = open, so deploying this does not change current behaviour. A gender with 0 beds is NOT treated
 * as full (nothing to compare against) — it never auto-rejects or auto-announces.
 */

'use strict';

const log = require('./logger');
const { db, getSetting, setSetting, findUserById, archiveRejectedRegistration } = require('./db');
const ann = require('./announcements');
const { sendSlotsFullEmail } = require('./emailService');

const KEY_CLOSED     = 'admission_closed';
const KEY_UPDATED_AT = 'admission_updated_at';
const KEY_UPDATED_BY = 'admission_updated_by';
const SEXES = ['male', 'female'];
const ANN_SOURCE = 'admission_full';

function isManuallyClosed() { return getSetting(KEY_CLOSED, '0') === '1'; }

function countFor(sex) {
  const approved = db.prepare(
    `SELECT COUNT(*) AS c FROM users WHERE account_status='approved' AND role='user' AND is_active=1 AND LOWER(sex)=?`
  ).get(sex).c;
  const max = db.prepare(`SELECT COALESCE(SUM(capacity),0) AS c FROM dorm_rooms WHERE gender=?`).get(sex).c;
  const pending = db.prepare(
    `SELECT COUNT(*) AS c FROM users WHERE account_status='pending' AND role='user' AND LOWER(sex)=?`
  ).get(sex).c;
  const full = max > 0 && approved >= max;
  return { approved, max, remaining: Math.max(0, max - approved), pending, full };
}

/** Live numbers. `open` = accepting new applications right now. */
function getStatus() {
  const manual = isManuallyClosed();
  const out = {
    manualClosed: manual,
    updatedAt: getSetting(KEY_UPDATED_AT, '') || null,
    updatedBy: getSetting(KEY_UPDATED_BY, '') || null,
  };
  for (const sex of SEXES) {
    const c = countFor(sex);
    out[sex] = { ...c, open: !manual && !c.full, reason: manual ? 'manual' : (c.full ? 'full' : null) };
  }
  out.allClosed = !out.male.open && !out.female.open;
  return out;
}

function setManualClosed(closed, byUsername = '') {
  setSetting(KEY_CLOSED, closed ? '1' : '0');
  setSetting(KEY_UPDATED_AT, new Date().toISOString());
  setSetting(KEY_UPDATED_BY, byUsername);
  log.admin(`🚪 Applications ${closed ? 'CLOSED' : 'REOPENED'} for everyone by @${byUsername || '?'}`);
  return getStatus();
}

// ── Automatic announcements ────────────────────────────────────────────────
const ANN_TEXT = {
  male: {
    title: 'Male dormitory slots are full',
    body:  'All male slots in the dormitory have been filled, so applications from male applicants are now closed. ' +
           'Please check this page again for updates.',
  },
  female: {
    title: 'Female dormitory slots are full',
    body:  'All female slots in the dormitory have been filled, so applications from female applicants are now closed. ' +
           'Please check this page again for updates.',
  },
  all: {
    title: 'Dormitory slots are full — applications closed',
    body:  'All male and female dormitory slots have been filled, so applications are now closed. ' +
           'Please check this page again for updates.',
  },
};

/** Posts / hides the automatic announcements so they match the live state. Safe to call any time (idempotent). */
function syncAnnouncements(status = getStatus()) {
  const wanted = new Set();
  if (status.male.full && status.female.full) wanted.add('all');
  else if (status.male.full) wanted.add('male');
  else if (status.female.full) wanted.add('female');

  for (const tag of ['male', 'female', 'all']) {
    const key = `admission_ann_${tag}`;
    const existingId = getSetting(key, '');
    if (wanted.has(tag)) {
      if (!existingId) {
        const t = ANN_TEXT[tag];
        const created = ann.createAnnouncement(
          { title: t.title, body: t.body, type: 'warning', ctaSignup: false, isActive: true, showFrom: null, showUntil: null },
          '', { source: ANN_SOURCE, semesterTag: `auto-${tag}` }
        );
        setSetting(key, created.id);
        log.admin(`📢 Auto-announcement posted: ${t.title}`);
      }
    } else if (existingId) {
      try { ann.setAnnouncementActive(existingId, false); } catch (e) { log.warn(`[admission] could not hide announcement ${existingId}: ${e.message}`); }
      setSetting(key, '');
      log.admin(`📢 Auto-announcement hidden (slots no longer full): ${tag}`);
    }
  }
}

// ── Auto-reject pending applicants of a full gender ────────────────────────
/**
 * Archives + removes every pending applicant of `sex` (same safe path as a manual "Reject": nothing is lost, the
 * record shows in Registrations → Rejected and can be restored) and e-mails them that the slots are full.
 * @returns {string[]} ids of the applicants that were removed
 */
function rejectPendingFor(sex, adminId = null) {
  const rows = db.prepare(
    `SELECT id FROM users WHERE account_status='pending' AND role='user' AND LOWER(sex)=? ORDER BY created_at ASC`
  ).all(sex);
  const reason = `Sorry — all ${sex} dormitory slots are already full, so your application could not be accepted.`;
  const removed = [];
  const toEmail = [];
  for (const { id } of rows) {
    const user = findUserById(id);
    if (!user || user.accountStatus !== 'pending') continue;
    try {
      const idDocs = db.prepare('SELECT * FROM id_verification_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(id);
      db.transaction(() => {
        archiveRejectedRegistration({ user, idDocs, reason, flags: [], rejectedBy: adminId || 'system' });
        db.prepare('DELETE FROM users WHERE id = ?').run(id);
      })();
      removed.push(id);
      toEmail.push({ email: user.email, firstName: user.firstName });
      log.admin(`✖ AUTO-REJECTED (${sex} slots full) @${user.username} (${user.email})`);
    } catch (e) {
      log.error(`[admission] auto-reject failed for ${id} — left pending: ${e.message}`);
    }
  }
  // E-mails go out after the archive is safe, one at a time (never blocks the admin's request).
  (async () => {
    for (const t of toEmail) {
      try { await sendSlotsFullEmail(t.email, t.firstName, sex); }
      catch (e) { log.error(`[admission] slots-full email failed → ${t.email}: ${e.message}`); }
    }
  })();
  return removed;
}

/**
 * Call after anything that can fill a gender (an approval). Auto-rejects pending applicants of every full gender and
 * refreshes the announcements. Returns { status, rejected: { male: n, female: n } }.
 */
function enforce(adminId = null, io = null) {
  const rejected = { male: 0, female: 0 };
  let status = getStatus();
  for (const sex of SEXES) {
    if (status[sex].full && status[sex].pending > 0) {
      const ids = rejectPendingFor(sex, adminId);
      rejected[sex] = ids.length;
      if (io) ids.forEach(id => io.to('admins').emit('account-rejected', { userId: id }));
    }
  }
  status = getStatus();
  syncAnnouncements(status);
  return { status, rejected };
}

module.exports = { getStatus, setManualClosed, enforce, syncAnnouncements, isManuallyClosed };
