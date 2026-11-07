/**
 * utils/faceCheck.js — server-side selfie sanity check (second layer behind the in-browser face scanner)
 *
 * WHY THIS EXISTS
 *   The browser scanner (public/js/auth.js → "LIVE SELFIE") only lets a live camera frame through when exactly one
 *   face is centred and the applicant has completed random head-turn / mouth challenges. But anything that runs in
 *   the browser can be bypassed by someone POSTing straight to /api/auth/complete-registration, so the server
 *   re-checks the image that actually arrives.
 *
 * WHAT IT CHECKS (via the Gemini key pool you already use for the chatbot / moderation)
 *   - exactly one clearly visible, real human face
 *   - NOT a photo of a screen / printed photo / ID card / cartoon / object / animal
 *
 * FAIL-OPEN BY DESIGN for infrastructure problems (no key, quota exhausted, timeout, unparsable answer):
 *   the applicant is let through and the log shows a loud [SELFIE-CHECK] WARN so an admin can review the photo by
 *   hand. Only a CLEAR negative from the model rejects the upload. Never block a real applicant because an API is down.
 *
 * Turn it off completely with SELFIE_AI_CHECK=off in .env.
 * Free-tier Gemini keys only allow ~20 requests/day each (see geminiPool.js) — if registrations outgrow that, the
 * check simply skips itself (fail-open) instead of failing.
 */

const geminiPool = require('./geminiPool');
const log        = require('./logger');

const TIMEOUT_MS = 12000;

const PROMPT =
  'You are a strict-but-fair photo screener for a dormitory application. The image is meant to be a LIVE selfie of ' +
  'the applicant (a profile photo). Answer ONLY with JSON in exactly this shape: ' +
  '{"faceCount": <integer number of human faces clearly visible>, ' +
  '"realPerson": <true if it looks like a real person photographed directly by a camera, false if it is a drawing, ' +
  'cartoon, mascot, object, animal, screenshot, a photo of a computer/phone screen, a printed photo, or a photo of an ID card>, ' +
  '"faceClear": <true if the face is large enough, unobstructed (no mask, sunglasses, hand or object covering it) and in focus>, ' +
  '"reason": "<max 12 words>"}. Do not add any other text.';

/** One Gemini vision call with key rotation on daily-quota exhaustion. Returns parsed JSON or null (= could not check). */
async function askGemini(buffer, mimeType) {
  let key = geminiPool.getKey();
  if (!key) { log.warn('[SELFIE-CHECK] skipped — no Gemini key available (not configured or all exhausted).'); return null; }

  const body = {
    contents: [{ role: 'user', parts: [
      { text: PROMPT },
      { inline_data: { mime_type: mimeType || 'image/jpeg', data: buffer.toString('base64') } },
    ] }],
    generationConfig: { temperature: 0, maxOutputTokens: 200, responseMimeType: 'application/json' },
  };

  while (key) {
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
      log.warn(`[SELFIE-CHECK] skipped — Gemini request failed (${e.name === 'AbortError' ? 'timeout' : e.message}).`);
      return null;
    } finally { clearTimeout(timer); }

    if (resp.ok) {
      geminiPool.trackRequest(key);
      const data = await resp.json().catch(() => null);
      const text = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
                   data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
                   data.candidates[0].content.parts[0].text;
      if (!text) { log.warn('[SELFIE-CHECK] skipped — empty Gemini reply.'); return null; }
      try { return JSON.parse(text.replace(/```json|```/g, '').trim()); }
      catch (e) { log.warn(`[SELFIE-CHECK] skipped — unparsable Gemini reply: ${String(text).slice(0, 80)}`); return null; }
    }

    if (resp.status === 429) {
      const errBody = await resp.text().catch(() => '');
      const isRPD = geminiPool.markExhausted(key, errBody);
      const next = isRPD ? geminiPool.getKey() : null;
      if (next) { key = next; continue; }
      log.warn('[SELFIE-CHECK] skipped — Gemini rate/quota limit hit.');
      return null;
    }
    log.warn(`[SELFIE-CHECK] skipped — Gemini HTTP ${resp.status}.`);
    return null;
  }
  return null;
}

/**
 * @param {Buffer} buffer    raw uploaded image bytes
 * @param {string} mimeType
 * @returns {Promise<{ok:boolean, skipped?:boolean, code?:string, message?:string, detail?:object}>}
 */
async function checkSelfie(buffer, mimeType) {
  if (String(process.env.SELFIE_AI_CHECK || '').toLowerCase() === 'off') return { ok: true, skipped: true };
  const t0 = Date.now();
  const r = await askGemini(buffer, mimeType);
  if (!r) return { ok: true, skipped: true };

  const faces = Number(r.faceCount);
  log.info(`[SELFIE-CHECK] faces=${faces} realPerson=${r.realPerson} faceClear=${r.faceClear} reason="${String(r.reason || '').slice(0, 60)}" (${Date.now() - t0}ms)`);

  if (faces === 0 || r.realPerson === false)
    return { ok: false, code: 'SELFIE_NO_FACE', detail: r,
      message: 'We could not see a real face in your selfie. Please retake it facing the camera — photos of screens, printed photos, IDs or objects are not accepted.' };
  if (faces > 1)
    return { ok: false, code: 'SELFIE_MULTIPLE_FACES', detail: r,
      message: 'More than one face was found in your selfie. Please retake it so only you are in the frame.' };
  if (r.faceClear === false)
    return { ok: false, code: 'SELFIE_FACE_UNCLEAR', detail: r,
      message: 'Your face is not clearly visible (too small, blurry or covered). Please retake the selfie in good light with your face uncovered.' };
  return { ok: true };
}

module.exports = { checkSelfie };
