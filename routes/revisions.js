/**
 * routes/revisions.js — approved residents correcting their own application (request -> admin approval -> edit)
 *
 * RESIDENT (login required; only approved residents can create requests)
 *   GET    /api/users/me/application-summary          sections + documents + current/last request + form options
 *   POST   /api/users/me/revisions                    { items:[{key,note}], reason }      send a request
 *   DELETE /api/users/me/revisions/:id                withdraw a request that is still pending
 *   PUT    /api/users/me/revisions/current/info       { group, values }                   save ONE approved info group
 *   POST   /api/users/me/revisions/current/documents  multipart (id_front, cert_*)        replace approved documents
 *   POST   /api/users/me/revisions/current/finish     "I'm done" -> admins are told to review the change log
 *
 * ADMIN (all under /api/admin/*, so server.js's admin guard applies on top of requireAdmin)
 *   GET  /api/admin/revisions/stats                   counts per status (sidebar badge)
 *   GET  /api/admin/revisions?status=pending|approved|completed|rejected|cancelled|expired|all
 *   GET  /api/admin/revisions/:id                     request + the resident's current application + change log
 *   POST /api/admin/revisions/:id/approve             { items:[key], days:1|3|7|14, note }
 *   POST /api/admin/revisions/:id/reject              { note }   (required)
 *   POST /api/admin/revisions/:id/revoke              { note }   close an approved window early
 *
 * All rules live in utils/residentRevisions.js; this file only does HTTP, notifications and audit logging.
 */
'use strict';

const express = require('express');
const router  = express.Router();

const log = require('../utils/logger');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { uploadRevisionDocs } = require('../middleware/upload');
const { trackUpload } = require('../middleware/uploadDiagnostics');
const { findUserById, createNotification, logAdminAction } = require('../utils/db');
const rr = require('../utils/residentRevisions');
const { REVISION_ITEMS } = require('../utils/applicationRevision');
const emailService = require('../utils/emailService');

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────
function send(res, r, okBody) {
  if (r.ok) return res.json({ success: true, ...okBody });
  return res.status(r.status || 400).json({ error: r.error, code: r.code, ...(r.field ? { field: r.field } : {}) });
}
function fail500(res, tag, e, msg) {
  log.error(`[revision] ${tag} failed: ${e.stack || e.message}`);
  return res.status(500).json({ error: msg });
}
const phDate = (iso) => new Date(iso).toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'Asia/Manila' });

/** In-app notification + live nudge to the resident's open tabs. Never throws (a failed nudge must not undo a decision). */
function tellResident(req, userId, type, message) {
  try {
    createNotification({ userId, type, actorId: null, targetId: null, message });
    const io = req.app.get('io');
    if (io) { io.to(`user:${userId}`).emit('new-notification', { userId }); io.to(`user:${userId}`).emit('revision-updated', { type }); }
  } catch (e) { log.warn(`[revision] could not notify resident ${userId}: ${e.message}`); }
}
function tellAdmins(req, event, payload) {
  try { const io = req.app.get('io'); if (io) io.to('admins').emit(event, payload); }
  catch (e) { log.warn(`[revision] could not notify admins: ${e.message}`); }
}
function mailResident(userId, args) {
  try {
    const u = findUserById(userId);
    if (u && u.email && typeof emailService.sendRevisionDecisionEmail === 'function') {
      emailService.sendRevisionDecisionEmail(u.email, u.firstName, args).catch((e) => log.warn(`[revision] e-mail to ${u.email} failed: ${e.message}`));
    }
  } catch (e) { log.warn(`[revision] e-mail skipped: ${e.message}`); }
}

// ── RESIDENT ────────────────────────────────────────────────────────────────────────────────────
router.get('/api/users/me/application-summary', requireAuth, (req, res) => {
  try {
    const uid = req.user.id;
    const summary = rr.buildSummary(uid);
    if (!summary) return res.status(404).json({ error: 'Account not found.' });
    const open = rr.getOpenRequest(uid);
    const hist = rr.history(uid, 5);
    const el = rr.eligibility(uid);
    let blockedReason = '';
    if (!el.ok) blockedReason = el.error;
    else if (open) blockedReason = open.status === 'pending' ? 'Your request is waiting for the admin.' : 'Your edits are unlocked.';
    res.set('Cache-Control', 'private, no-store');
    res.json({
      summary, revision: open, history: hist,
      canRequest: el.ok && !open, blockedReason,
      // the MOST RECENT request is shown as a banner while it is still news (declined / revoked / expired in the last 14 days)
      lastDecision: (!open && hist[0] && ['rejected', 'cancelled', 'expired'].includes(hist[0].status) && hist[0].updatedAt && Date.now() - new Date(hist[0].updatedAt).getTime() < 14 * 864e5) ? hist[0] : null,
      requestable: rr.REQUESTABLE.map((k) => ({ key: k, label: REVISION_ITEMS[k].label, group: REVISION_ITEMS[k].group })),
      options: { civilStatus: rr.CIVIL_STATUSES, yearLevels: rr.YEAR_LEVELS, income: rr.INCOME_OPTIONS, sexes: rr.SEXES },
      limits: { reasonMin: rr.REASON_MIN, reasonMax: rr.REASON_MAX, noteMax: rr.NOTE_MAX },
    });
  } catch (e) { fail500(res, 'application-summary', e, 'Could not load your application. Please try again.'); }
});

router.post('/api/users/me/revisions', requireAuth, (req, res) => {
  try {
    const r = rr.createRequest(req.user.id, (req.body || {}).items, (req.body || {}).reason);
    if (r.ok) {
      log.info(`[revision] @${req.user.username} requested a correction: [${r.request.items.map((i) => i.key).join(', ')}]`);
      tellAdmins(req, 'revision-request', { id: r.request.id, username: req.user.username, count: r.request.items.length });
    }
    send(res, r, { request: r.request });
  } catch (e) { fail500(res, 'create', e, 'Could not send your request. Please try again.'); }
});

router.delete('/api/users/me/revisions/:id', requireAuth, (req, res) => {
  try {
    const r = rr.cancelRequest(req.params.id, req.user.id);
    if (r.ok) tellAdmins(req, 'revision-request', { id: r.request.id, withdrawn: true });
    send(res, r, { request: r.request });
  } catch (e) { fail500(res, 'cancel', e, 'Could not withdraw your request.'); }
});

router.put('/api/users/me/revisions/current/info', requireAuth, (req, res) => {
  try {
    const open = rr.getOpenRequest(req.user.id);
    const group = String((req.body || {}).group || '');
    const r = rr.applyInfo(req.user.id, open, group, (req.body || {}).values);
    if (r.ok && r.changed) log.info(`[revision] @${req.user.username} saved ${group}: ${r.fields.join(', ')}`);
    send(res, r, { changed: r.changed, fields: r.fields });
  } catch (e) { fail500(res, 'save-info', e, 'Could not save your changes. Please try again.'); }
});

// Window check BEFORE the upload pipeline, so a resident without an approved request never makes us store files.
function requireEditWindow(req, res, next) {
  try {
    const open = rr.getOpenRequest(req.user.id);
    if (!open || open.status !== 'approved')
      return res.status(403).json({ error: 'You do not have an approved correction request. Send a request first.', code: 'NO_WINDOW' });
    req.revisionRequest = open;
    next();
  } catch (e) { fail500(res, 'edit-window', e, 'Could not check your request.'); }
}
router.post('/api/users/me/revisions/current/documents', requireAuth, requireEditWindow,
  trackUpload('revision-documents'), ...uploadRevisionDocs,
  (req, res) => {
    try {
      const r = rr.applyDocuments(req.user.id, req.revisionRequest, req.idDocUrls);
      if (r.ok) log.upload(`[revision] @${req.user.username} replaced: ${r.replaced.join(', ')}`);
      send(res, r, { replaced: r.ok ? r.replaced : [] });
    } catch (e) { fail500(res, 'save-documents', e, 'Could not save your document. Please try again.'); }
  });

router.post('/api/users/me/revisions/current/finish', requireAuth, (req, res) => {
  try {
    const open = rr.getOpenRequest(req.user.id);
    if (!open) return res.status(409).json({ error: 'You have no open correction request.', code: 'NO_OPEN' });
    const r = rr.finish(open.id, req.user.id);
    if (r.ok) {
      log.info(`[revision] @${req.user.username} finished ${open.id} (${r.changeCount} change(s))`);
      tellAdmins(req, 'revision-completed', { id: open.id, username: req.user.username, changeCount: r.changeCount });
    }
    send(res, r, { request: r.request, changeCount: r.changeCount });
  } catch (e) { fail500(res, 'finish', e, 'Could not finish. Please try again.'); }
});

// ── ADMIN ───────────────────────────────────────────────────────────────────────────────────────
router.get('/api/admin/revisions/stats', requireAdmin, (req, res) => {
  try { res.json(rr.statsForAdmin()); }
  catch (e) { fail500(res, 'admin-stats', e, 'Could not load revision stats.'); }
});

router.get('/api/admin/revisions', requireAdmin, (req, res) => {
  try { res.json(rr.listForAdmin({ status: String(req.query.status || 'all'), limit: req.query.limit })); }
  catch (e) { fail500(res, 'admin-list', e, 'Could not load revision requests.'); }
});

router.get('/api/admin/revisions/:id', requireAdmin, (req, res) => {
  try {
    const d = rr.detailForAdmin(req.params.id);
    if (!d) return res.status(404).json({ error: 'Request not found.' });
    res.json(d);
  } catch (e) { fail500(res, 'admin-detail', e, 'Could not load the request.'); }
});

router.post('/api/admin/revisions/:id/approve', requireAdmin, (req, res) => {
  try {
    const b = req.body || {};
    const r = rr.approve({ id: req.params.id, adminId: req.user.id, items: b.items, days: b.days, note: b.note });
    if (r.ok) {
      const q = r.request;
      const labels = q.approvedLabels;
      log.admin(`Revision ${q.id} APPROVED by @${req.user.username} for ${q.userId}: [${q.approvedItems.join(', ')}] ${r.days}d`);
      logAdminAction(req.user.id, 'revision_approved', 'user', q.userId, `${q.approvedItems.join(',')} for ${r.days} day(s)`);
      tellResident(req, q.userId, 'revision_approved',
        `Your correction request was approved. You can now edit: ${labels.join('; ')}. Open My Dormitory \u2192 My Application before ${phDate(q.expiresAt)}.`);
      mailResident(q.userId, { approved: true, items: labels, note: q.adminNote, expiresAt: q.expiresAt });
      tellAdmins(req, 'revision-request', { id: q.id, decided: true });
    }
    send(res, r, { request: r.request });
  } catch (e) { fail500(res, 'approve', e, 'Could not approve the request.'); }
});

router.post('/api/admin/revisions/:id/reject', requireAdmin, (req, res) => {
  try {
    const r = rr.reject({ id: req.params.id, adminId: req.user.id, note: (req.body || {}).note });
    if (r.ok) {
      const q = r.request;
      log.admin(`Revision ${q.id} DECLINED by @${req.user.username} for ${q.userId}`);
      logAdminAction(req.user.id, 'revision_rejected', 'user', q.userId, q.adminNote);
      tellResident(req, q.userId, 'revision_rejected', `Your correction request was not approved: ${q.adminNote}`);
      mailResident(q.userId, { approved: false, items: q.items.map((i) => i.label), note: q.adminNote });
      tellAdmins(req, 'revision-request', { id: q.id, decided: true });
    }
    send(res, r, { request: r.request });
  } catch (e) { fail500(res, 'reject', e, 'Could not decline the request.'); }
});

router.post('/api/admin/revisions/:id/revoke', requireAdmin, (req, res) => {
  try {
    const r = rr.revoke({ id: req.params.id, adminId: req.user.id, note: (req.body || {}).note });
    if (r.ok) {
      const q = r.request;
      log.admin(`Revision ${q.id} REVOKED by @${req.user.username} for ${q.userId}`);
      logAdminAction(req.user.id, 'revision_revoked', 'user', q.userId, q.adminNote);
      tellResident(req, q.userId, 'revision_rejected', `Your edit access was closed by the admin.${q.adminNote ? ' ' + q.adminNote : ''}`);
      tellAdmins(req, 'revision-request', { id: q.id, decided: true });
    }
    send(res, r, { request: r.request });
  } catch (e) { fail500(res, 'revoke', e, 'Could not revoke the request.'); }
});

module.exports = router;
