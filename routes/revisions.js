/**
 * routes/revisions.js — approved residents correcting their own application (request -> admin approval -> edit)
 *
 * Two approvals: (1) the admin allows the resident to edit, (2) after the resident submits, the admin reviews the
 * changes and approves them again. Until then the edits are DRAFTS; the resident's real record is not touched.
 *
 * RESIDENT (login required; only approved residents can create requests)
 *   GET    /api/users/me/application-summary          sections + documents (drafts laid over them) + current/last request + form options
 *   POST   /api/users/me/revisions                    { items:[{key,note}], reason }      send a request
 *   DELETE /api/users/me/revisions/:id                withdraw a request (or submitted changes) that is still waiting for the admin
 *   PUT    /api/users/me/revisions/current/info       { group, values }                   save ONE approved info group as a draft
 *   POST   /api/users/me/revisions/current/documents  multipart (id_front, cert_*)        save approved documents as drafts
 *   POST   /api/users/me/revisions/current/submit     "Submit for review" -> admins are told to review the drafts
 *
 * ADMIN (all under /api/admin/*, so server.js's admin guard applies on top of requireAdmin)
 *   GET  /api/admin/revisions/stats                   counts per status (sidebar badge)
 *   GET  /api/admin/revisions/items                   what an admin may ask a resident to correct
 *   POST /api/admin/residents/:userId/revisions       { items:[{key,note}], days, note (required) }   admin asks a resident to correct something (edit window opens at once)
 *   GET  /api/admin/revisions?status=pending|approved|submitted|completed|rejected|cancelled|expired|all
 *   GET  /api/admin/revisions/:id                     request + the resident's current application + (proposed or applied) changes
 *   POST /api/admin/revisions/:id/approve             { items:[key], days:1|3|7|14, note }   1st approval: allow the resident to edit
 *   POST /api/admin/revisions/:id/reject              { note }   (required)                  decline the request
 *   POST /api/admin/revisions/:id/revoke              { note }   close an approved window early (drafts are discarded)
 *   POST /api/admin/revisions/:id/apply               { note }                               2nd approval: write the submitted changes
 *   POST /api/admin/revisions/:id/return              { note (required), days }              send the changes back for correction
 *   POST /api/admin/revisions/:id/discard             { note (required) }                    decline the submitted changes
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

function mailReview(userId, args) {
  try {
    const u = findUserById(userId);
    if (u && u.email && typeof emailService.sendRevisionReviewEmail === 'function') {
      emailService.sendRevisionReviewEmail(u.email, u.firstName, args).catch((e) => log.warn(`[revision] review e-mail to ${u.email} failed: ${e.message}`));
    }
  } catch (e) { log.warn(`[revision] review e-mail skipped: ${e.message}`); }
}

// ── RESIDENT ────────────────────────────────────────────────────────────────────────────────────
router.get('/api/users/me/application-summary', requireAuth, (req, res) => {
  try {
    const uid = req.user.id;
    const open = rr.getOpenRequest(uid);
    const summary = rr.buildSummary(uid, { draftsOf: open ? open.id : null });      // the resident sees their own drafts on top of the real record
    if (!summary) return res.status(404).json({ error: 'Account not found.' });
    const hist = rr.history(uid, 5);
    const el = rr.eligibility(uid);
    let blockedReason = '';
    if (!el.ok) blockedReason = el.error;
    else if (open) blockedReason = open.status === 'pending' ? 'Your request is waiting for the admin.' : open.status === 'submitted' ? 'Your changes are waiting for the admin to review.' : 'Your edits are unlocked.';
    res.set('Cache-Control', 'private, no-store');
    res.json({
      summary, revision: open, history: hist,
      canRequest: el.ok && !open, blockedReason,
      // the MOST RECENT request is shown as a banner while it is still news (declined / revoked / expired in the last 14 days)
      lastDecision: (!open && hist[0] && (['rejected', 'cancelled', 'expired'].includes(hist[0].status) || (hist[0].status === 'completed' && hist[0].reviewedAt)) && hist[0].updatedAt && Date.now() - new Date(hist[0].updatedAt).getTime() < 14 * 864e5) ? hist[0] : null,
      requestable: rr.REQUESTABLE.map((k) => ({ key: k, label: rr.ITEMS[k].label, group: rr.ITEMS[k].group })),
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
    send(res, r, { request: r.request, wasSubmitted: r.wasSubmitted });
  } catch (e) { fail500(res, 'cancel', e, 'Could not withdraw your request.'); }
});

router.put('/api/users/me/revisions/current/info', requireAuth, (req, res) => {
  try {
    const open = rr.getOpenRequest(req.user.id);
    const group = String((req.body || {}).group || '');
    const r = rr.saveInfoDraft(req.user.id, open, group, (req.body || {}).values);
    if (r.ok && r.changed) log.info(`[revision] @${req.user.username} saved a draft of ${group}: ${r.fields.join(', ')}`);
    send(res, r, { changed: r.changed, cleared: r.cleared, fields: r.fields });
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
      const r = rr.saveDocumentDrafts(req.user.id, req.revisionRequest, req.idDocUrls);
      if (r.ok) log.upload(`[revision] @${req.user.username} saved draft documents: ${r.replaced.join(', ')}`);
      send(res, r, { replaced: r.ok ? r.replaced : [] });
    } catch (e) { fail500(res, 'save-documents', e, 'Could not save your document. Please try again.'); }
  });

router.post('/api/users/me/revisions/current/submit', requireAuth, (req, res) => {
  try {
    const open = rr.getOpenRequest(req.user.id);
    if (!open) return res.status(409).json({ error: 'You have no open correction request.', code: 'NO_OPEN' });
    const r = rr.submitForReview(open.id, req.user.id);
    if (r.ok) {
      log.info(`[revision] @${req.user.username} submitted ${open.id} for review (${r.changeCount} change(s))`);
      if (r.submitted) tellAdmins(req, 'revision-submitted', { id: open.id, username: req.user.username, changeCount: r.changeCount });
      else tellAdmins(req, 'revision-request', { id: open.id, decided: true });
    }
    send(res, r, { request: r.request, submitted: r.submitted, changeCount: r.changeCount });
  } catch (e) { fail500(res, 'submit', e, 'Could not submit. Please try again.'); }
});

// ── ADMIN ───────────────────────────────────────────────────────────────────────────────────────
router.get('/api/admin/revisions/stats', requireAdmin, (req, res) => {
  try { res.json(rr.statsForAdmin()); }
  catch (e) { fail500(res, 'admin-stats', e, 'Could not load revision stats.'); }
});

// What an admin may ask a resident to correct (labels come from the same list the resident sees).
router.get('/api/admin/revisions/items', requireAdmin, (req, res) => {
  res.json({
    items: rr.REQUESTABLE.map((k) => ({ key: k, label: rr.ITEMS[k].label, group: rr.ITEMS[k].group })),
    windows: rr.ALLOWED_WINDOWS, defaultDays: rr.DEFAULT_WINDOW_DAYS, noteMin: rr.ADMIN_NOTE_MIN, noteMax: rr.ADMIN_NOTE_MAX,
  });
});

// Admin asks ONE resident to correct something -> the edit window opens immediately (see rr.adminRequest).
router.post('/api/admin/residents/:userId/revisions', requireAdmin, (req, res) => {
  try {
    const b = req.body || {};
    const r = rr.adminRequest({ userId: req.params.userId, adminId: req.user.id, items: b.items, days: b.days, note: b.note });
    if (r.ok) {
      const q = r.request;
      const labels = q.approvedLabels;
      log.admin(`Revision ${q.id} REQUESTED by @${req.user.username} from ${q.userId}: [${q.approvedItems.join(', ')}] ${r.days}d`);
      logAdminAction(req.user.id, 'revision_requested_by_admin', 'user', q.userId, `${q.approvedItems.join(',')} for ${r.days} day(s)`);
      tellResident(req, q.userId, 'revision_approved',
        `The dormitory admin asked you to correct: ${labels.join('; ')}. ${q.adminNote} Open My Dormitory \u2192 My Application before ${phDate(q.expiresAt)}.`);
      mailResident(q.userId, { approved: true, items: labels, note: q.adminNote, expiresAt: q.expiresAt });
      tellAdmins(req, 'revision-request', { id: q.id, decided: true });
    }
    send(res, r, { request: r.request });
  } catch (e) { fail500(res, 'admin-request', e, 'Could not send the revision request.'); }
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

// Second approval — the resident submitted drafts; nothing is written to their record until /apply.
router.post('/api/admin/revisions/:id/apply', requireAdmin, (req, res) => {
  try {
    const r = rr.applyChanges({ id: req.params.id, adminId: req.user.id, note: (req.body || {}).note });
    if (r.ok) {
      const q = r.request;
      log.admin(`Revision ${q.id} CHANGES APPROVED by @${req.user.username} for ${q.userId}: ${r.applied} change(s) applied`);
      logAdminAction(req.user.id, 'revision_changes_applied', 'user', q.userId, `${r.applied} change(s) applied`);
      tellResident(req, q.userId, 'revision_approved', `Your changes were approved and saved to your application.${q.reviewNote ? ' ' + q.reviewNote : ''}`);
      mailReview(q.userId, { outcome: 'applied', items: q.items.map((i) => i.label), note: q.reviewNote });
      tellAdmins(req, 'revision-request', { id: q.id, decided: true });
    }
    send(res, r, { request: r.request, applied: r.applied });
  } catch (e) { fail500(res, 'apply', e, 'Could not apply the changes.'); }
});

router.post('/api/admin/revisions/:id/return', requireAdmin, (req, res) => {
  try {
    const b = req.body || {};
    const r = rr.returnChanges({ id: req.params.id, adminId: req.user.id, note: b.note, days: b.days });
    if (r.ok) {
      const q = r.request;
      log.admin(`Revision ${q.id} CHANGES RETURNED by @${req.user.username} to ${q.userId} (${r.days}d)`);
      logAdminAction(req.user.id, 'revision_changes_returned', 'user', q.userId, q.reviewNote);
      tellResident(req, q.userId, 'revision_approved',
        `The admin sent your changes back for correction: ${q.reviewNote} Open My Dormitory \u2192 My Application before ${phDate(q.expiresAt)} and submit again.`);
      mailReview(q.userId, { outcome: 'returned', items: q.approvedLabels, note: q.reviewNote, expiresAt: q.expiresAt });
      tellAdmins(req, 'revision-request', { id: q.id, decided: true });
    }
    send(res, r, { request: r.request });
  } catch (e) { fail500(res, 'return', e, 'Could not return the changes.'); }
});

router.post('/api/admin/revisions/:id/discard', requireAdmin, (req, res) => {
  try {
    const r = rr.discardChanges({ id: req.params.id, adminId: req.user.id, note: (req.body || {}).note });
    if (r.ok) {
      const q = r.request;
      log.admin(`Revision ${q.id} CHANGES DECLINED by @${req.user.username} for ${q.userId}`);
      logAdminAction(req.user.id, 'revision_changes_declined', 'user', q.userId, q.reviewNote);
      tellResident(req, q.userId, 'revision_rejected', `Your changes were not approved and nothing was changed: ${q.reviewNote}`);
      mailReview(q.userId, { outcome: 'declined', items: q.items.map((i) => i.label), note: q.reviewNote });
      tellAdmins(req, 'revision-request', { id: q.id, decided: true });
    }
    send(res, r, { request: r.request });
  } catch (e) { fail500(res, 'discard', e, 'Could not decline the changes.'); }
});

module.exports = router;
