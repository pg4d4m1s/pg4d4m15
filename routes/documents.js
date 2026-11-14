/**
 * routes/documents.js — admin side of the document checker (badges, re-run, rotate)
 *
 *   GET  /api/admin/accounts/pending/document-checks   badges + current file URLs for every pending applicant
 *                                                      (database read only — no AI call)
 *   POST /api/admin/accounts/:id/recheck-documents     run the AI check again (1 Gemini request for all 5 documents)
 *   POST /api/admin/accounts/:id/rotate-document       { slot, degrees: 90|180|270 }  manual fix when the AI could not
 *                                                      (or was not available to) turn a sideways photo upright
 *   GET  /api/admin/ai-usage?days=7&feature=&status=&limit=100
 *                                                      the admin "AI Usage" page: every Gemini request of the document
 *                                                      checker + selfie check (utils/aiUsage.js) with totals, a per-feature
 *                                                      breakdown, the key pool state and the newest requests
 *
 * "Request a new copy" has no route of its own on purpose: in the admin panel it ticks that document in the existing
 * "Return application for correction" form (PUT /api/admin/accounts/:id/reject, utils/applicationRevision.js), so the
 * applicant's wizard, the e-mail and the resubmission checks are the ones you already have.
 *
 * All paths are under /api/admin/*, so server.js's admin guard applies on top of requireAdmin.
 */

const express = require('express');
const router  = express.Router();

const log = require('../utils/logger');
const { findUserById, logAdminAction } = require('../utils/db');
const geminiPool = require('../utils/geminiPool');
const aiUsage = require('../utils/aiUsage');
const { requireAdmin } = require('../middleware/auth');
const dc = require('../utils/documentChecks');
const { enqueueDocumentAudit, rotateStoredDocument } = require('../utils/docClassifier');
const { liveDb: db } = require('../utils/db');

router.get('/api/admin/accounts/pending/document-checks', requireAdmin, (req, res) => {
  try {
    res.json({ checks: dc.getChecksForPendingApplicants(), aiAvailable: !!geminiPool.getKey() });
  } catch (e) {
    log.error(`[DOC-CHECK] could not load badges: ${e.stack || e.message}`);
    res.status(500).json({ error: 'Could not load document badges.' });
  }
});

// ── AI usage of the document checker + selfie check (read-only, database only — no AI call) ──
router.get('/api/admin/ai-usage', requireAdmin, (req, res) => {
  try {
    const summary = aiUsage.getSummary(req.query.days);
    const recent = aiUsage.getRecent({ limit: req.query.limit, feature: String(req.query.feature || ''), status: String(req.query.status || '') });
    res.json({
      summary, recent,
      features: aiUsage.FEATURES,
      pool: geminiPool.getStatus(),                 // in-memory per-key counters (all features, reset on restart)
      docCheckEnabled: String(process.env.DOC_AI_CHECK || '').toLowerCase() !== 'off',
      gateEnabled: String(process.env.DOC_AI_GATE || '').toLowerCase() !== 'off' && String(process.env.DOC_AI_CHECK || '').toLowerCase() !== 'off',
      selfieEnabled: String(process.env.SELFIE_AI_CHECK || '').toLowerCase() !== 'off',
    });
  } catch (e) {
    log.error(`[AI-USAGE] could not load the usage page: ${e.stack || e.message}`);
    res.status(500).json({ error: 'Could not load AI usage.' });
  }
});

function pendingApplicant(req, res) {
  const user = findUserById(req.params.id);
  if (!user) { res.status(404).json({ error: 'Applicant not found.' }); return null; }
  if (user.accountStatus !== 'pending') { res.status(400).json({ error: 'This application is no longer pending.' }); return null; }
  return user;
}

router.post('/api/admin/accounts/:id/recheck-documents', requireAdmin, (req, res) => {
  try {
    const user = pendingApplicant(req, res); if (!user) return;
    if (String(process.env.DOC_AI_CHECK || '').toLowerCase() === 'off')
      return res.status(503).json({ error: 'The AI document check is switched off (DOC_AI_CHECK=off).', code: 'AI_OFF' });
    if (!geminiPool.getKey())
      return res.status(503).json({ error: 'No Gemini key is available right now (not configured or today\'s quota is used up).', code: 'NO_KEY' });
    dc.ensureSchema();
    db.prepare(`UPDATE document_checks SET ai_status='pending', ai_verdict='', ai_note='' WHERE user_id=?`).run(user.id);
    enqueueDocumentAudit(user.id, { io: req.app.get('io'), trigger: 'admin_recheck' });
    log.admin(`🔁 AI document re-check queued for @${user.username} by @${req.user.username}`);
    logAdminAction(req.user.id, 'document_recheck', 'user', user.id, 'AI document re-check requested');
    res.json({ success: true, queued: true });
  } catch (e) {
    log.error(`[DOC-AI] recheck failed: ${e.stack || e.message}`);
    res.status(500).json({ error: 'Could not queue the check.' });
  }
});

router.post('/api/admin/accounts/:id/rotate-document', requireAdmin, async (req, res) => {
  try {
    const slot = String((req.body || {}).slot || '');
    const degrees = Number((req.body || {}).degrees) || 90;
    if (!dc.SLOTS[slot]) return res.status(400).json({ error: 'Unknown document.', code: 'BAD_SLOT' });
    if (![90, 180, 270].includes(degrees)) return res.status(400).json({ error: 'Rotation must be 90, 180 or 270 degrees.', code: 'BAD_DEGREES' });
    const user = pendingApplicant(req, res); if (!user) return;
    dc.ensureSchema();
    const r = await rotateStoredDocument(user.id, slot, degrees);
    if (!r.ok) return res.status(422).json({ error: `Could not rotate: ${r.reason}.`, code: 'ROTATE_FAILED' });
    logAdminAction(req.user.id, 'document_rotated', 'user', user.id, `${slot} +${degrees}°`);
    res.json({ success: true, url: r.url });
  } catch (e) {
    log.error(`[DOC-ROTATE] failed: ${e.stack || e.message}`);
    res.status(500).json({ error: 'Could not rotate the document.' });
  }
});

module.exports = router;
