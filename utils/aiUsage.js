/**
 * utils/aiUsage.js — one row per Gemini request made by the document checker and the selfie face check
 *
 * WHY THIS EXISTS
 *   geminiPool.js only keeps in-memory counters (they reset on every Railway deploy/restart) and says nothing about
 *   WHAT each request was for. This table is the permanent record behind the admin "AI Usage" page:
 *     - which feature asked (submit-time document gate, admin badge job, selfie check)
 *     - who it was about (applicant e-mail / name) and the request ref that also appears in the server log
 *     - did it work (ok / rate_limited / timeout / error / no_key), how long it took, which key, how many tokens
 *     - what the AI decided (the `outcome` text, e.g. "id_front=match rotate270 cert_grades=mismatch(...) → REFUSED")
 *   Only metadata is stored — never the document images or the model's raw text.
 *
 * Every call is also printed to the server log as  [AI-USAGE] …  so Railway logs and the admin page tell one story.
 *
 * NEVER THROWS: a logging problem must never break an applicant's registration. Failures are logged and swallowed.
 * Uses liveDb on purpose (see the note at the top of utils/db.js): the usage belongs to the live system, not to an
 * archived snapshot an admin may have set Active.
 *
 * ENV   AI_USAGE_KEEP_DAYS=90   rows older than this are deleted (once per server start)
 */

const log = require('./logger');
const geminiPool = require('./geminiPool');
const { liveDb: db, genId } = require('./db');

// feature id → label shown to the admin
const FEATURES = {
  doc_gate:     'Document check at submit',
  doc_audit:    'Document badges (admin)',
  selfie_check: 'Selfie face check',
  id_orient:    'Document orientation',
};
const STATUSES = ['ok', 'rate_limited', 'timeout', 'error', 'no_key'];
const KEEP_DAYS = Math.max(7, parseInt(process.env.AI_USAGE_KEEP_DAYS, 10) || 90);

let pruned = false;
function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_usage_log (
      id            TEXT PRIMARY KEY,
      feature       TEXT NOT NULL,
      trigger_by    TEXT DEFAULT '',          -- applicant_submit | admin_recheck | ''
      status        TEXT NOT NULL,            -- ok | rate_limited | timeout | error | no_key
      http_status   INTEGER DEFAULT NULL,
      model         TEXT DEFAULT '',
      key_suffix    TEXT DEFAULT '',          -- last 6 characters of the key only
      latency_ms    INTEGER DEFAULT NULL,
      prompt_tokens INTEGER DEFAULT NULL,
      output_tokens INTEGER DEFAULT NULL,
      total_tokens  INTEGER DEFAULT NULL,
      doc_count     INTEGER DEFAULT 0,
      user_id       TEXT DEFAULT '',
      applicant     TEXT DEFAULT '',
      ref           TEXT DEFAULT '',
      outcome       TEXT DEFAULT '',          -- what the AI decided (filled in after the request)
      error         TEXT DEFAULT '',
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_usage_feature ON ai_usage_log(feature, created_at DESC);
  `);
  if (!pruned) {
    pruned = true;
    try {
      const r = db.prepare(`DELETE FROM ai_usage_log WHERE created_at < datetime('now', ?)`).run(`-${KEEP_DAYS} days`);
      if (r.changes) log.info(`[AI-USAGE] pruned ${r.changes} row(s) older than ${KEEP_DAYS} days`);
    } catch (e) { log.warn(`[AI-USAGE] prune failed: ${e.message}`); }
  }
}

const int = (v) => (Number.isFinite(Number(v)) && v !== null && v !== undefined && v !== '' ? Math.round(Number(v)) : null);
const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);

/**
 * Record one Gemini request. Returns the row id (pass it to setOutcome later) or '' if it could not be stored.
 * @param {object} e { feature, status, trigger, httpStatus, key, latencyMs, promptTokens, outputTokens, totalTokens,
 *                     docCount, userId, applicant, ref, outcome, error }
 */
function record(e) {
  try {
    ensureSchema();
    const id = genId();
    const keySuffix = e.key ? String(e.key).slice(-6) : '';
    db.prepare(`
      INSERT INTO ai_usage_log (id, feature, trigger_by, status, http_status, model, key_suffix, latency_ms,
                                prompt_tokens, output_tokens, total_tokens, doc_count, user_id, applicant, ref, outcome, error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, clip(e.feature, 40), clip(e.trigger, 30), STATUSES.includes(e.status) ? e.status : 'error',
           int(e.httpStatus), geminiPool.model, keySuffix, int(e.latencyMs),
           int(e.promptTokens), int(e.outputTokens), int(e.totalTokens), int(e.docCount) || 0,
           clip(e.userId, 64), clip(e.applicant, 120), clip(e.ref, 40), clip(e.outcome, 600), clip(e.error, 300));
    log.ai(`[AI-USAGE] ${e.feature} ${e.status}${e.httpStatus ? ` (HTTP ${e.httpStatus})` : ''} ${e.latencyMs != null ? `${e.latencyMs}ms ` : ''}` +
           `tokens=${e.totalTokens != null ? e.totalTokens : '?'} docs=${e.docCount || 0} key=${keySuffix ? `…${keySuffix}` : 'none'}` +
           `${e.applicant ? ` applicant=${clip(e.applicant, 60)}` : ''}${e.ref ? ` ref=${e.ref}` : ''}${e.error ? ` error="${clip(e.error, 80)}"` : ''}`);
    return id;
  } catch (err) {
    log.warn(`[AI-USAGE] could not record the request (continuing): ${err.message}`);
    return '';
  }
}

/** Attach "what the AI decided" to a row recorded earlier. Safe to call with an empty id. */
function setOutcome(id, outcome) {
  if (!id) return;
  try { db.prepare(`UPDATE ai_usage_log SET outcome = ? WHERE id = ?`).run(clip(outcome, 600), id); }
  catch (err) { log.warn(`[AI-USAGE] could not save the outcome (continuing): ${err.message}`); }
}

/** Totals, per-feature breakdown, per-day counts and last-24h per-key counts for the admin page. */
function getSummary(days = 7) {
  ensureSchema();
  const d = Math.min(90, Math.max(1, parseInt(days, 10) || 7));
  const since = `-${d} days`;
  const agg = `COUNT(*) AS calls,
    SUM(status = 'ok') AS ok, SUM(status = 'rate_limited') AS rateLimited,
    SUM(status IN ('timeout','error','no_key')) AS failed,
    ROUND(AVG(CASE WHEN status = 'ok' THEN latency_ms END)) AS avgLatencyMs,
    COALESCE(SUM(prompt_tokens),0) AS promptTokens, COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(total_tokens),0) AS totalTokens`;
  const totals = db.prepare(`SELECT ${agg} FROM ai_usage_log WHERE created_at >= datetime('now', ?)`).get(since);
  const byFeature = db.prepare(`SELECT feature, ${agg} FROM ai_usage_log WHERE created_at >= datetime('now', ?) GROUP BY feature ORDER BY calls DESC`).all(since)
    .map((r) => ({ ...r, label: FEATURES[r.feature] || r.feature }));
  // days are Philippine days (UTC+8) so the bars line up with the office's working day, not with the UTC midnight at 8 AM
  const daily = db.prepare(`SELECT date(created_at, '+8 hours') AS day, COUNT(*) AS calls, SUM(status <> 'ok') AS problems
                            FROM ai_usage_log WHERE created_at >= datetime('now', ?) GROUP BY date(created_at, '+8 hours') ORDER BY day ASC`).all(since);
  const keys24h = db.prepare(`SELECT key_suffix AS keySuffix, COUNT(*) AS calls FROM ai_usage_log
                              WHERE created_at >= datetime('now','-1 day') AND key_suffix <> '' GROUP BY key_suffix`).all();
  return { days: d, totals, byFeature, daily, keys24h };
}

/** Newest requests first. Filters are whitelisted (feature / status), never interpolated. */
function getRecent({ limit = 100, feature = '', status = '' } = {}) {
  ensureSchema();
  const where = [], args = [];
  if (feature && FEATURES[feature]) { where.push('feature = ?'); args.push(feature); }
  if (status && STATUSES.includes(status)) { where.push('status = ?'); args.push(status); }
  const lim = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
  return db.prepare(`SELECT id, feature, trigger_by AS triggerBy, status, http_status AS httpStatus, model, key_suffix AS keySuffix,
                            latency_ms AS latencyMs, prompt_tokens AS promptTokens, output_tokens AS outputTokens, total_tokens AS totalTokens,
                            doc_count AS docCount, user_id AS userId, applicant, ref, outcome, error, created_at AS createdAt
                     FROM ai_usage_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...args, lim)
    .map((r) => ({ ...r, featureLabel: FEATURES[r.feature] || r.feature }));
}

module.exports = { FEATURES, STATUSES, ensureSchema, record, setOutcome, getSummary, getRecent };
