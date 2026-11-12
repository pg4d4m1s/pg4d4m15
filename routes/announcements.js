/**
 * routes/announcements.js — Login-page announcements API
 *
 *   PUBLIC  GET    /api/announcements/public          what the login page shows
 *   ADMIN   GET    /api/admin/announcements           all announcements (admin tab)
 *   ADMIN   GET    /api/admin/announcements/template  "applications open" wording for the current semester
 *   ADMIN   POST   /api/admin/announcements           create
 *   ADMIN   PUT    /api/admin/announcements/:id       edit
 *   ADMIN   PATCH  /api/admin/announcements/:id/active  show / hide
 *   ADMIN   DELETE /api/admin/announcements/:id       delete
 *
 *   E-mail broadcast (audience checklist — logic in utils/announcementEmail.js)
 *   ADMIN   GET    /api/admin/announcements/email/options          group head-counts, rooms, previous sends
 *   ADMIN   POST   /api/admin/announcements/email/preview          how many people a given audience reaches
 *   ADMIN   POST   /api/admin/announcements/:id/email/test         send ONE copy to the admin's own address
 *   ADMIN   POST   /api/admin/announcements/:id/email              start the real send (202 + job id)
 *   ADMIN   GET    /api/admin/announcements/email/jobs/:jobId      progress of a send
 *
 * Data layer + wording live in utils/announcements.js.
 * Admin routes reuse requireAdmin from routes/admin.js so they behave exactly
 * like every other admin route (including the dev-only admin injection).
 */
const express = require('express');
const router  = express.Router();
const log     = require('../utils/logger');
const { requireAdmin } = require('./admin');
const { logAdminAction, getSetting } = require('../utils/db');
const ann = require('../utils/announcements');
const annMail = require('../utils/announcementEmail');
const { sendAnnouncementEmail } = require('../utils/emailService');
const { db } = require('../utils/db');

const SUBJECT_MAX = 150;
const MESSAGE_MAX = 5000; // e-mail has room the login card does not

// Same pattern as routes/admin.js: stash the message so the request logger prints it inline.
function send500(res, err, label = '') {
  const msg = err?.message || String(err);
  res._errMsg = label ? `${label}: ${msg}` : msg;
  res.status(500).json({ error: msg });
}

// ── PUBLIC ─────────────────────────────────────────────────────────────────
// No login on purpose: visitors who cannot log in are the audience. Returns only
// title/body/style of announcements that are active and inside their date window.
router.get('/api/announcements/public', (req, res) => {
  try {
    res.set('Cache-Control', 'no-cache'); // admin edits must show up on the next page load
    res.json({ announcements: ann.listPublicAnnouncements() });
  } catch (err) {
    log.error(`[announcements] public list failed: ${err.message}`);
    // The login page ignores this failure and simply shows no banner.
    res.status(500).json({ announcements: [], error: 'Could not load announcements.' });
  }
});

// ── ADMIN ──────────────────────────────────────────────────────────────────
router.get('/api/admin/announcements', requireAdmin, (req, res) => {
  try {
    res.json({ announcements: ann.listAnnouncements() });
  } catch (err) { send500(res, err, 'announcements list'); }
});

// Wording for the current semester settings (Residents → semester bar).
router.get('/api/admin/announcements/template', requireAdmin, (req, res) => {
  try {
    const semester   = getSetting('current_semester', '1st Semester');
    const schoolYear = getSetting('school_year', String(new Date().getFullYear()));
    res.json({ template: ann.buildSemesterTemplate(semester, schoolYear) });
  } catch (err) { send500(res, err, 'announcement template'); }
});

router.post('/api/admin/announcements', requireAdmin, (req, res) => {
  try {
    const { value, error } = ann.validateInput(req.body);
    if (error) return res.status(400).json({ error });
    const created = ann.createAnnouncement(value, req.user.id);
    logAdminAction(req.user.id, 'announcement_created', 'announcement', created.id, created.title);
    log.admin(`📢 Announcement created: "${created.title}" by @${req.user.username}`);
    res.status(201).json({ announcement: created });
  } catch (err) { send500(res, err, 'announcement create'); }
});

router.put('/api/admin/announcements/:id', requireAdmin, (req, res) => {
  try {
    const { value, error } = ann.validateInput(req.body);
    if (error) return res.status(400).json({ error });
    const updated = ann.updateAnnouncement(req.params.id, value);
    if (!updated) return res.status(404).json({ error: 'Announcement not found.' });
    logAdminAction(req.user.id, 'announcement_updated', 'announcement', updated.id, updated.title);
    log.admin(`📢 Announcement updated: "${updated.title}" by @${req.user.username}`);
    res.json({ announcement: updated });
  } catch (err) { send500(res, err, 'announcement update'); }
});

router.patch('/api/admin/announcements/:id/active', requireAdmin, (req, res) => {
  try {
    if (typeof req.body?.isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive (true/false) is required.' });
    }
    const updated = ann.setAnnouncementActive(req.params.id, req.body.isActive);
    if (!updated) return res.status(404).json({ error: 'Announcement not found.' });
    logAdminAction(req.user.id, req.body.isActive ? 'announcement_shown' : 'announcement_hidden',
      'announcement', updated.id, updated.title);
    log.admin(`📢 Announcement ${req.body.isActive ? 'shown' : 'hidden'}: "${updated.title}" by @${req.user.username}`);
    res.json({ announcement: updated });
  } catch (err) { send500(res, err, 'announcement toggle'); }
});

router.delete('/api/admin/announcements/:id', requireAdmin, (req, res) => {
  try {
    if (!ann.deleteAnnouncement(req.params.id)) {
      return res.status(404).json({ error: 'Announcement not found.' });
    }
    logAdminAction(req.user.id, 'announcement_deleted', 'announcement', req.params.id, '');
    log.admin(`📢 Announcement deleted (${req.params.id}) by @${req.user.username}`);
    res.json({ success: true });
  } catch (err) { send500(res, err, 'announcement delete'); }
});

// ── E-MAIL BROADCAST ───────────────────────────────────────────────────────
// All of these live under /api/admin/announcements, which archiveView.js lists in ALWAYS_LIVE:
// recipients always come from the LIVE database, even while an admin is viewing an archive snapshot.

/** Validate the compose form (subject + message) shared by test and real sends. */
function readMailContent(body = {}, announcement) {
  const subject = String(body.subject ?? announcement.title ?? '').replace(/[\r\n]+/g, ' ').trim();
  const message = String(body.message ?? announcement.body ?? '').trim();
  if (!subject) return { error: 'Subject is required.' };
  if (subject.length > SUBJECT_MAX) return { error: `Subject must be ${SUBJECT_MAX} characters or fewer.` };
  if (!message) return { error: 'Message is required.' };
  if (message.length > MESSAGE_MAX) return { error: `Message must be ${MESSAGE_MAX} characters or fewer.` };
  return { subject, message };
}

router.get('/api/admin/announcements/email/options', requireAdmin, (req, res) => {
  try {
    const options = annMail.getAudienceOptions();
    const announcementId = String(req.query.announcementId || '');
    res.json({
      ...options,
      previousSends: announcementId ? annMail.listPreviousSends(announcementId) : [],
      activeJob: annMail.getActiveJob(),
    });
  } catch (err) { send500(res, err, 'announcement email options'); }
});

router.post('/api/admin/announcements/email/preview', requireAdmin, (req, res) => {
  try {
    const { recipients, skipped } = annMail.resolveRecipients(req.body);
    res.json({
      count: recipients.length,
      skipped,
      overLimit: recipients.length > annMail.MAX_RECIPIENTS,
      maxRecipients: annMail.MAX_RECIPIENTS,
      sample: recipients.slice(0, 5).map(r => ({
        name: `${r.firstName} ${r.lastName}`.trim() || r.email,
        status: r.status,
        roomNumber: r.roomNumber,
      })),
    });
  } catch (err) { send500(res, err, 'announcement email preview'); }
});

router.get('/api/admin/announcements/email/jobs/:jobId', requireAdmin, (req, res) => {
  const job = annMail.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'That send is no longer tracked (the server may have restarted). Check the Admin log.' });
  res.json({ job });
});

// One copy to the admin's own address, so the layout and wording can be checked before the real send.
router.post('/api/admin/announcements/:id/email/test', requireAdmin, async (req, res) => {
  try {
    const announcement = ann.findAnnouncement(req.params.id);
    if (!announcement) return res.status(404).json({ error: 'Announcement not found.' });
    const { subject, message, error } = readMailContent(req.body, announcement);
    if (error) return res.status(400).json({ error });

    const me = db.prepare('SELECT email, first_name FROM users WHERE id = ?').get(req.user.id);
    if (!me?.email) return res.status(400).json({ error: 'Your admin account has no e-mail address to send the test to.' });

    const result = await sendAnnouncementEmail(me.email, me.first_name, {
      title: announcement.title, message, type: announcement.type, subject: `[TEST] ${subject}`.slice(0, SUBJECT_MAX),
    });
    if (!result?.success) {
      return res.status(502).json({ error: `The test e-mail could not be sent: ${result?.error || 'no e-mail driver accepted it'}` });
    }
    log.admin(`📢 Announcement test e-mail → ${me.email} ("${subject}") by @${req.user.username}`);
    res.json({ success: true, to: me.email });
  } catch (err) { send500(res, err, 'announcement email test'); }
});

router.post('/api/admin/announcements/:id/email', requireAdmin, (req, res) => {
  try {
    const announcement = ann.findAnnouncement(req.params.id);
    if (!announcement) return res.status(404).json({ error: 'Announcement not found.' });
    const { subject, message, error } = readMailContent(req.body, announcement);
    if (error) return res.status(400).json({ error });

    const audience = annMail.normaliseAudience(req.body);
    const { recipients } = annMail.resolveRecipients(audience);
    if (!recipients.length) return res.status(400).json({ error: 'No one matches the selected recipients.' });
    if (recipients.length > annMail.MAX_RECIPIENTS) {
      return res.status(400).json({
        error: `That is ${recipients.length} people — the limit per send is ${annMail.MAX_RECIPIENTS} (daily mail quota). Narrow the recipients, or raise ANNOUNCEMENT_EMAIL_MAX.`,
      });
    }
    // The admin confirmed a specific head-count. If people were approved/removed in between, ask again.
    if (Number(req.body?.confirmCount) !== recipients.length) {
      return res.status(409).json({
        error: `The recipient list changed (now ${recipients.length} people). Please review and confirm again.`,
        count: recipients.length,
      });
    }

    const job = annMail.startSendJob({
      announcementId: announcement.id, subject, title: announcement.title, message, type: announcement.type,
      recipients, audience, adminId: req.user.id, adminName: req.user.username,
    });
    logAdminAction(req.user.id, 'announcement_emailed', 'announcement', announcement.id,
      `${subject} → ${recipients.length} recipient(s) ${JSON.stringify(audience)}`);
    res.status(202).json({ job });
  } catch (err) {
    if (err.code === 'BUSY') return res.status(409).json({ error: err.message });
    send500(res, err, 'announcement email send');
  }
});

module.exports = router;
