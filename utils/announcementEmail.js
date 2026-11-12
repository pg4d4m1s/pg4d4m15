/**
 * utils/announcementEmail.js — E-mail an announcement to a chosen audience
 *
 * Used by routes/announcements.js (Admin → Community → Announcements → "Email").
 *
 * AUDIENCE MODEL (union — a person is only e-mailed once, however many boxes match them)
 *   assigned    approved residents who have a bed
 *   unassigned  approved residents who have NO bed yet
 *   pending     applicants whose account is still waiting for approval
 *   rooms       approved residents sleeping in the ticked rooms (by dorm_rooms.id)
 *   "Everyone" in the UI is simply assigned + unassigned + pending ticked together.
 *   Never included: admins, banned/deactivated accounts (is_active = 0), blank/invalid e-mails.
 *
 * Notes for future-me
 *   • Sending runs as a BACKGROUND JOB. 300 recipients × ~0.5 s would outlive a normal HTTP
 *     request on Railway, so the route answers 202 right away and the admin page polls the job.
 *   • Only ONE job runs at a time (stops double-clicks and protects the daily mail quota —
 *     the Gmail API limit is shared with OTP / password-reset mail).
 *   • The job aborts after ABORT_AFTER_FAILURES failures in a row (every driver down) instead of
 *     hammering a broken mailer; the admin sees how many went out and why it stopped.
 *   • Jobs live in memory (lost on restart), but every send is also written to
 *     announcement_emails, so there is a permanent record. A row still 'running' at boot means
 *     the server restarted mid-send and is marked 'interrupted'.
 *   • Statements are prepared inside functions (db is a proxy — see utils/announcements.js).
 */

const { randomUUID } = require('crypto');
const log = require('./logger');
const { db } = require('./db');
const { sendAnnouncementEmail } = require('./emailService');

// ── Schema ─────────────────────────────────────────────────────────────────
// schemaReconcile.js re-creates this table after a DB restore from an older backup.
db.exec(`
  CREATE TABLE IF NOT EXISTS announcement_emails (
    id              TEXT PRIMARY KEY,
    announcement_id TEXT NOT NULL,
    subject         TEXT NOT NULL,
    audience        TEXT NOT NULL DEFAULT '',     -- JSON: { groups: [...], rooms: [ids] }
    total           INTEGER NOT NULL DEFAULT 0,
    sent            INTEGER NOT NULL DEFAULT 0,
    failed          INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'running',  -- running | done | aborted | interrupted
    sent_by         TEXT DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_announcement_emails_ann ON announcement_emails(announcement_id, created_at DESC);
`);
try {
  const n = db.prepare(`UPDATE announcement_emails SET status = 'interrupted', finished_at = datetime('now') WHERE status = 'running'`).run().changes;
  if (n) log.warn(`[announcement-email] ${n} send(s) were interrupted by a restart — marked 'interrupted'`);
} catch (e) { log.warn(`[announcement-email] boot cleanup skipped: ${e.message}`); }

// ── Settings ───────────────────────────────────────────────────────────────
const GROUP_KEYS = ['assigned', 'unassigned', 'pending'];
const MAX_RECIPIENTS = Math.max(1, parseInt(process.env.ANNOUNCEMENT_EMAIL_MAX, 10) || 400);
const SEND_DELAY_MS = 150;           // gentle pacing between messages
const ABORT_AFTER_FAILURES = 5;      // consecutive failures → stop
const MAX_ROOMS = 200;
const FAILURES_KEPT = 20;            // failed addresses remembered per job (for the admin to see)
const JOBS_KEPT = 20;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Audience ───────────────────────────────────────────────────────────────

/** Whitelist + normalise whatever the browser sent. */
function normaliseAudience(input = {}) {
  const groups = [...new Set((Array.isArray(input.groups) ? input.groups : []).filter(g => GROUP_KEYS.includes(g)))];
  const rooms = [...new Set((Array.isArray(input.rooms) ? input.rooms : []).map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, MAX_ROOMS);
  return { groups, rooms };
}

/**
 * Everything the checklist needs: head-counts per group and the room list.
 * Counts only include people who would actually be e-mailed (active, non-admin, has an e-mail).
 */
function getAudienceOptions() {
  const c = db.prepare(`
    SELECT
      SUM(CASE WHEN u.account_status = 'approved' AND ba.id IS NOT NULL THEN 1 ELSE 0 END) AS assigned,
      SUM(CASE WHEN u.account_status = 'approved' AND ba.id IS NULL     THEN 1 ELSE 0 END) AS unassigned,
      SUM(CASE WHEN u.account_status = 'pending'                        THEN 1 ELSE 0 END) AS pending
    FROM users u
    LEFT JOIN bed_assignments ba ON ba.user_id = u.id
    WHERE u.role = 'user' AND u.is_active = 1 AND TRIM(COALESCE(u.email, '')) <> ''
  `).get();

  const rooms = db.prepare(`
    SELECT dr.id, dr.room_number AS roomNumber, dr.gender, dr.capacity, COUNT(u.id) AS residents
      FROM dorm_rooms dr
      LEFT JOIN bed_assignments ba ON ba.room_id = dr.id
      LEFT JOIN users u ON u.id = ba.user_id AND u.account_status = 'approved' AND u.is_active = 1
                       AND u.role = 'user' AND TRIM(COALESCE(u.email, '')) <> ''
     GROUP BY dr.id
     ORDER BY dr.room_number
  `).all();

  return {
    counts: { assigned: c?.assigned || 0, unassigned: c?.unassigned || 0, pending: c?.pending || 0 },
    rooms,
    maxRecipients: MAX_RECIPIENTS,
  };
}

/**
 * Turn an audience into a de-duplicated recipient list.
 * @returns {{ recipients: {id,firstName,lastName,email,status,roomNumber}[], skipped: {noEmail:number, duplicate:number} }}
 */
function resolveRecipients(audienceInput) {
  const { groups, rooms } = normaliseAudience(audienceInput);
  const clauses = [];
  const params = [];
  if (groups.includes('assigned'))   clauses.push(`(u.account_status = 'approved' AND ba.id IS NOT NULL)`);
  if (groups.includes('unassigned')) clauses.push(`(u.account_status = 'approved' AND ba.id IS NULL)`);
  if (groups.includes('pending'))    clauses.push(`(u.account_status = 'pending')`);
  if (rooms.length) {
    clauses.push(`(u.account_status = 'approved' AND ba.room_id IN (${rooms.map(() => '?').join(',')}))`);
    params.push(...rooms);
  }
  const skipped = { noEmail: 0, duplicate: 0 };
  if (!clauses.length) return { recipients: [], skipped };

  const rows = db.prepare(`
    SELECT u.id, u.first_name, u.last_name, u.email, u.account_status, dr.room_number
      FROM users u
      LEFT JOIN bed_assignments ba ON ba.user_id = u.id
      LEFT JOIN dorm_rooms dr ON dr.id = ba.room_id
     WHERE u.role = 'user' AND u.is_active = 1 AND (${clauses.join(' OR ')})
     ORDER BY u.first_name COLLATE NOCASE, u.last_name COLLATE NOCASE
  `).all(...params);

  const seen = new Set();
  const recipients = [];
  for (const r of rows) {
    const email = String(r.email || '').trim();
    if (!EMAIL_RE.test(email)) { skipped.noEmail++; continue; }
    const key = email.toLowerCase();
    if (seen.has(key)) { skipped.duplicate++; continue; }
    seen.add(key);
    recipients.push({
      id: r.id, firstName: r.first_name || '', lastName: r.last_name || '', email,
      status: r.account_status, roomNumber: r.room_number ?? null,
    });
  }
  return { recipients, skipped };
}

// ── History ────────────────────────────────────────────────────────────────

/** Recent sends of one announcement — lets the UI warn "already e-mailed on …". */
function listPreviousSends(announcementId, limit = 3) {
  return db.prepare(`
    SELECT id, subject, total, sent, failed, status, created_at AS createdAt
      FROM announcement_emails WHERE announcement_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
  `).all(announcementId, limit);
}

// ── Background send job ────────────────────────────────────────────────────

const jobs = new Map();   // id → job (insertion order = oldest first)
let activeJobId = null;

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id, announcementId: job.announcementId, status: job.status,
    total: job.total, sent: job.sent, failed: job.failed,
    abortReason: job.abortReason || '', failures: job.failures,
    startedAt: job.startedAt, finishedAt: job.finishedAt || null,
  };
}

function getJob(id) { return publicJob(jobs.get(id)); }
function getActiveJob() { return activeJobId ? publicJob(jobs.get(activeJobId)) : null; }

function pruneJobs() {
  while (jobs.size > JOBS_KEPT) {
    const oldest = jobs.keys().next().value;
    if (oldest === activeJobId) break;
    jobs.delete(oldest);
  }
}

function persistFinish(job) {
  try {
    db.prepare(`UPDATE announcement_emails SET sent = ?, failed = ?, status = ?, finished_at = datetime('now') WHERE id = ?`)
      .run(job.sent, job.failed, job.status, job.id);
  } catch (e) { log.error(`[announcement-email] could not save result of ${job.id}: ${e.message}`); }
}

/**
 * Start sending. Returns immediately with the job snapshot; the loop continues in the background.
 * @throws {Error & {code:'BUSY'}} when another send is still running
 */
function startSendJob({ announcementId, subject, title, message, type, recipients, audience, adminId = '', adminName = '' }) {
  if (activeJobId && jobs.get(activeJobId)?.status === 'running') {
    const err = new Error('Another announcement e-mail is still being sent. Wait for it to finish.');
    err.code = 'BUSY';
    throw err;
  }

  const job = {
    id: randomUUID(), announcementId, status: 'running',
    total: recipients.length, sent: 0, failed: 0, failures: [], abortReason: '',
    startedAt: new Date().toISOString(), finishedAt: null,
  };
  jobs.set(job.id, job);
  activeJobId = job.id;
  pruneJobs();

  db.prepare(`
    INSERT INTO announcement_emails (id, announcement_id, subject, audience, total, status, sent_by)
    VALUES (?, ?, ?, ?, ?, 'running', ?)
  `).run(job.id, announcementId, subject, JSON.stringify(audience), job.total, adminId || '');

  log.admin(`📢 Announcement e-mail started: "${subject}" → ${job.total} recipient(s) by @${adminName || adminId}`);

  // Fire and forget — every path inside is caught so it can never crash the process.
  (async () => {
    let consecutiveFailures = 0;
    try {
      for (const r of recipients) {
        let ok = false, reason = '';
        try {
          const res = await sendAnnouncementEmail(r.email, r.firstName, { title, message, type, subject });
          ok = !!(res && res.success);
          if (!ok) reason = (res && res.error) || 'not delivered';
        } catch (e) { reason = e.message || String(e); }

        if (ok) { job.sent++; consecutiveFailures = 0; }
        else {
          job.failed++; consecutiveFailures++;
          if (job.failures.length < FAILURES_KEPT) job.failures.push({ email: r.email, reason: String(reason).slice(0, 200) });
          log.warn(`[announcement-email] failed → ${r.email}: ${reason}`);
          if (consecutiveFailures >= ABORT_AFTER_FAILURES) {
            job.status = 'aborted';
            job.abortReason = `Stopped after ${ABORT_AFTER_FAILURES} failures in a row — the e-mail service is not delivering. ${job.total - job.sent - job.failed} recipient(s) were not attempted.`;
            break;
          }
        }
        await new Promise(res => setTimeout(res, SEND_DELAY_MS));
      }
      if (job.status === 'running') job.status = 'done';
    } catch (e) {
      job.status = 'aborted';
      job.abortReason = `Unexpected error: ${e.message}`;
      log.error(`[announcement-email] job ${job.id} crashed: ${e.stack || e.message}`);
    } finally {
      job.finishedAt = new Date().toISOString();
      if (activeJobId === job.id) activeJobId = null;
      persistFinish(job);
      const line = `📢 Announcement e-mail ${job.status}: "${subject}" — ✔ ${job.sent} sent | ✖ ${job.failed} failed of ${job.total}`;
      if (job.status === 'done' && !job.failed) log.admin(line); else log.warn(line);
    }
  })();

  return publicJob(job);
}

module.exports = {
  GROUP_KEYS, MAX_RECIPIENTS,
  normaliseAudience, getAudienceOptions, resolveRecipients,
  listPreviousSends, startSendJob, getJob, getActiveJob,
};
