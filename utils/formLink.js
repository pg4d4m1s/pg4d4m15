/**
 * utils/formLink.js
 *
 * Short-lived, signed link for a resident's OWN Application Form PDF.
 *
 * Why it exists: the form used to be a plain <a href="/api/users/me/application-form">. When the page is open
 * inside an in-app browser (Facebook/Messenger/Instagram) the PDF is handed off to the phone's external browser
 * or download manager, which does NOT share the session cookie -> "You must be logged in to do that.".
 * A signed link carries its own proof of identity, so it works wherever it ends up being opened.
 *
 * Safety: HMAC-SHA256 with SESSION_SECRET, bound to one user id + an expiry (3 minutes), valid for that user's
 * Application Form only. Not single-use on purpose: the in-app browser fetches the URL first and the external
 * downloader fetches it again a few seconds later.
 */
const crypto = require('crypto');

const FORM_LINK_TTL_MS = 3 * 60 * 1000;

function secret() {
  return process.env.SESSION_SECRET || 'dev-only-insecure-secret-do-not-use-in-production';
}

function sign(userId, exp) {
  return crypto.createHmac('sha256', secret()).update(`appform:v1:${userId}:${exp}`).digest('base64url');
}

/** Relative URL (starts with /api/...) that downloads the user's Application Form for the next 3 minutes. */
function createFormLink(userId, now = Date.now()) {
  const exp = now + FORM_LINK_TTL_MS;
  const qs = new URLSearchParams({ u: String(userId), e: String(exp), s: sign(userId, exp), download: '1' });
  return `/api/application-form/download?${qs.toString()}`;
}

/** @param {{u?:any,e?:any,s?:any}} q  req.query  @returns {{ok:true,userId:string}|{ok:false,reason:'invalid'|'expired'}} */
function verifyFormLink(q, now = Date.now()) {
  const { u, e, s } = q || {};
  const exp = Number(e);
  if (typeof u !== 'string' || typeof s !== 'string' || !u || !s || !Number.isFinite(exp)) return { ok: false, reason: 'invalid' };
  const expected = Buffer.from(sign(u, exp));
  const got = Buffer.from(s);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return { ok: false, reason: 'invalid' };
  if (now > exp) return { ok: false, reason: 'expired' };   // only authentic links get the friendlier "expired" message
  return { ok: true, userId: u };
}

module.exports = { createFormLink, verifyFormLink, FORM_LINK_TTL_MS };
