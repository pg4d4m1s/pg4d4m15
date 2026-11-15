/**
 * utils/faceCheck.js — server-side selfie sanity check (second layer behind the in-browser face scanner)
 *
 * WHY THIS EXISTS
 *   The browser scanner (public/js/auth.js → "LIVE SELFIE") only lets a live camera frame through when exactly one
 *   face is centred, the applicant has completed random head-turn / mouth challenges and the final photo shows a calm
 *   face. But anything that runs in the browser can be bypassed by someone POSTing straight to
 *   /api/auth/complete-registration, and the browser's landmark model cannot recognise a tongue at all, so the server
 *   re-checks the image that actually arrives.
 *
 * WHAT IT CHECKS (via the Gemini key pool you already use for the chatbot / moderation)
 *   - exactly one clearly visible, real human face
 *   - NOT a photo of a screen / printed photo / ID card / cartoon / object / animal
 *   - face clear (not covered, not blurry)
 *   - NOT a tongue sticking out past the lips. Smiling or laughing — mouth open, teeth showing, even a tongue merely
 *     visible INSIDE the open mouth — is fine; only a tongue clearly poking out is refused (SELFIE_TONGUE_OUT).
 *   Any refusal (code SELFIE_*) sends the applicant back to Step 4 to retake the selfie (public/js/auth.js handles it).
 *
 * FAIL-OPEN BY DESIGN for infrastructure problems (no key, quota exhausted, timeout, unparsable answer):
 *   the applicant is let through and the log shows a loud [SELFIE-CHECK] WARN so an admin can review the photo by
 *   hand. Only a CLEAR negative from the model rejects the upload. Never block a real applicant because an API is down.
 *
 * LOGGING
 *   Each request is stored in ai_usage_log (utils/aiUsage.js) with what the AI saw, and printed as [SELFIE-CHECK] and
 *   [AI-USAGE] lines. Admin page: System → AI Usage.
 *
 * Turn it off completely with SELFIE_AI_CHECK=off in .env.
 * Free-tier Gemini keys only allow ~20 requests/day each (see geminiPool.js) — if registrations outgrow that, the
 * check simply skips itself (fail-open) instead of failing.
 */

const geminiPool = require('./geminiPool');
const aiUsage    = require('./aiUsage');
const log        = require('./logger');

const TIMEOUT_MS = 12000;

const PROMPT =
  'You are a strict-but-fair photo screener for a dormitory application. The image is meant to be a LIVE selfie of ' +
  'the applicant (an official profile photo). Answer ONLY with JSON in exactly this shape: ' +
  '{"faceCount": <integer number of human faces clearly visible>, ' +
  '"realPerson": <true if it looks like a real person photographed directly by a camera, false if it is a drawing, ' +
  'cartoon, mascot, object, animal, screenshot, a photo of a computer/phone screen, a printed photo, or a photo of an ID card>, ' +
  '"faceClear": <true if the face is large enough, unobstructed (no mask, sunglasses, hand or object covering it) and in focus>, ' +
  '"tongueOut": <true ONLY if the tongue is clearly sticking out past the lips (poking out over or beyond the lower lip); ' +
  'false for a closed mouth, a smile, a laugh or an open mouth with teeth showing, even if the tongue can be seen inside the mouth>, ' +
  '"reason": "<max 12 words>"}. Do not add any other text.';

/**
 * One Gemini vision call with key rotation on daily-quota exhaustion.
 * → { data, usageId } on success, { data: null, usageId } when it could not be checked (= fail-open).
 */
async function askGemini(buffer, mimeType, ctx = {}) {
  let key = geminiPool.getKey();
  const track = (status, extra = {}) => aiUsage.record(Object.assign(
    { feature: 'selfie_check', trigger: 'applicant_submit', applicant: ctx.applicant, ref: ctx.ref, docCount: 1, key, status }, extra));
  if (!key) {
    log.warn('[SELFIE-CHECK] skipped — no Gemini key available (not configured or all exhausted).');
    return { data: null, usageId: track('no_key', { error: 'no key available (not configured or all exhausted)' }) };
  }

  const body = {
    contents: [{ role: 'user', parts: [
      { text: PROMPT },
      { inline_data: { mime_type: mimeType || 'image/jpeg', data: buffer.toString('base64') } },
    ] }],
    generationConfig: { temperature: 0, maxOutputTokens: 250, responseMimeType: 'application/json' },
  };

  while (key) {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(geminiPool.buildUrl(key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      const timedOut = e.name === 'AbortError';
      log.warn(`[SELFIE-CHECK] skipped — Gemini request failed (${timedOut ? 'timeout' : e.message}).`);
      return { data: null, usageId: track(timedOut ? 'timeout' : 'error', { latencyMs: Date.now() - t0, error: timedOut ? 'timeout' : e.message }) };
    } finally { clearTimeout(timer); }

    if (resp.ok) {
      geminiPool.trackRequest(key);
      const data = await resp.json().catch(() => null);
      const um = (data && data.usageMetadata) || {};
      const meta = { latencyMs: Date.now() - t0, httpStatus: resp.status, promptTokens: um.promptTokenCount, outputTokens: um.candidatesTokenCount, totalTokens: um.totalTokenCount };
      const text = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
                   data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
                   data.candidates[0].content.parts[0].text;
      if (!text) {
        log.warn('[SELFIE-CHECK] skipped — empty Gemini reply.');
        return { data: null, usageId: track('error', Object.assign({ error: 'empty reply' }, meta)) };
      }
      try { return { data: JSON.parse(text.replace(/```json|```/g, '').trim()), usageId: track('ok', meta) }; }
      catch (e) {
        log.warn(`[SELFIE-CHECK] skipped — unparsable Gemini reply: ${String(text).slice(0, 80)}`);
        return { data: null, usageId: track('error', Object.assign({ error: `unparsable reply: ${String(text).slice(0, 80)}` }, meta)) };
      }
    }

    if (resp.status === 429) {
      const errBody = await resp.text().catch(() => '');
      const isRPD = geminiPool.markExhausted(key, errBody);
      const usageId = track('rate_limited', { latencyMs: Date.now() - t0, httpStatus: 429, error: isRPD ? 'daily quota (RPD) used up on this key' : 'per-minute limit (RPM)' });
      const next = isRPD ? geminiPool.getKey() : null;
      if (next) { key = next; continue; }
      log.warn('[SELFIE-CHECK] skipped — Gemini rate/quota limit hit.');
      return { data: null, usageId };
    }
    log.warn(`[SELFIE-CHECK] skipped — Gemini HTTP ${resp.status}.`);
    return { data: null, usageId: track('error', { latencyMs: Date.now() - t0, httpStatus: resp.status, error: `HTTP ${resp.status}` }) };
  }
  return { data: null, usageId: track('no_key', { error: 'no key available' }) };
}

/**
 * @param {Buffer} buffer    raw uploaded image bytes
 * @param {string} mimeType
 * @param {{ref?:string, applicant?:string}} [ctx]  labels for the AI usage log only (request ref, applicant e-mail)
 * @returns {Promise<{ok:boolean, skipped?:boolean, code?:string, message?:string, detail?:object}>}
 */
async function checkSelfie(buffer, mimeType, ctx = {}) {
  if (String(process.env.SELFIE_AI_CHECK || '').toLowerCase() === 'off') return { ok: true, skipped: true };
  const t0 = Date.now();
  const { data: r, usageId } = await askGemini(buffer, mimeType, ctx);
  if (!r) {
    aiUsage.setOutcome(usageId, 'AI unavailable — selfie let through, review the photo manually');
    return { ok: true, skipped: true };
  }

  const faces = Number(r.faceCount);
  const seen = `faces=${faces} realPerson=${r.realPerson} faceClear=${r.faceClear} tongueOut=${r.tongueOut} reason="${String(r.reason || '').slice(0, 60)}"`;
  log.info(`[SELFIE-CHECK] ${seen} (${Date.now() - t0}ms)${ctx.ref ? ` ref=${ctx.ref}` : ''}`);
  const done = (result, label) => { aiUsage.setOutcome(usageId, `${seen} → ${label}`); return result; };

  if (faces === 0 || r.realPerson === false)
    return done({ ok: false, code: 'SELFIE_NO_FACE', detail: r,
      message: 'We could not see a real face in your selfie. Please retake it facing the camera — photos of screens, printed photos, IDs or objects are not accepted.' }, 'REFUSED (SELFIE_NO_FACE)');
  if (faces > 1)
    return done({ ok: false, code: 'SELFIE_MULTIPLE_FACES', detail: r,
      message: 'More than one face was found in your selfie. Please retake it so only you are in the frame.' }, 'REFUSED (SELFIE_MULTIPLE_FACES)');
  if (r.faceClear === false)
    return done({ ok: false, code: 'SELFIE_FACE_UNCLEAR', detail: r,
      message: 'Your face is not clearly visible (too small, blurry or covered). Please retake the selfie in good light with your face uncovered.' }, 'REFUSED (SELFIE_FACE_UNCLEAR)');
  if (r.tongueOut === true)
    return done({ ok: false, code: 'SELFIE_TONGUE_OUT', detail: r,
      message: 'Your tongue is sticking out in the selfie. This is your official profile photo — please retake it without sticking your tongue out (smiling is fine).' }, 'REFUSED (SELFIE_TONGUE_OUT)');
  return done({ ok: true }, 'ok');
}

module.exports = { checkSelfie };
