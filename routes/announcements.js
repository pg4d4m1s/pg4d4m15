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

module.exports = router;
