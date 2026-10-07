// utils/gmailApi.js
/**
 * Minimal Gmail API client (HTTPS, OAuth2 refresh-token flow).
 *
 * Why this exists: Railway Free/Trial/Hobby plans block outbound SMTP
 * (ports 465/587). The Gmail API talks to the same Gmail account over
 * HTTPS (port 443), which is allowed.
 *
 * Pure factory — it does NOT read process.env. utils/emailService.js reads the
 * env vars and passes them in, so this file stays easy to test.
 *
 *   const client = createGmailClient({ clientId, clientSecret, refreshToken, user });
 *   const messageId = await client.send({ fromName, to, subject, html, text });
 *
 * Errors thrown by send() always start with "Gmail API ..." and include the
 * HTTP status and Google's own message, e.g.
 *   "Gmail API token refresh 400: invalid_grant — Token has been expired or revoked."
 *   "Gmail API 403: Request had insufficient authentication scopes. [insufficientPermissions]"
 *
 * MIME building is delegated to nodemailer's MailComposer (already a project
 * dependency) so emoji subjects, UTF-8 bodies and header escaping are handled
 * correctly instead of hand-rolling RFC 2822.
 */

'use strict';

const MailComposer = require('nodemailer/lib/mail-composer');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL  = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

// Refresh the access token a little before Google says it expires.
const TOKEN_SAFETY_MARGIN_MS = 60_000;

function createGmailClient({ clientId, clientSecret, refreshToken, user, timeoutMs = 10_000 }) {
  if (!clientId || !clientSecret || !refreshToken || !user) {
    throw new Error('createGmailClient: clientId, clientSecret, refreshToken and user are all required');
  }

  let accessToken          = null;
  let accessTokenExpiresAt = 0;
  let refreshInFlight      = null; // dedupes concurrent refreshes

  /** fetch() with a timeout and readable network errors. */
  async function _fetch(url, init, label) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new Error(`${label} timeout after ${timeoutMs}ms`);
      }
      throw new Error(`${label} network error: ${err.cause?.code || err.message}`);
    }
  }

  /** Turn a failed Google response into a short, loggable detail string. */
  async function _errorDetail(res) {
    const raw = await res.text().catch(() => '');
    try {
      const data = JSON.parse(raw);
      // Token endpoint: { error: 'invalid_grant', error_description: '...' }
      if (typeof data.error === 'string') {
        return data.error_description ? `${data.error} — ${data.error_description}` : data.error;
      }
      // API endpoint: { error: { code, message, errors: [{ reason }] } }
      if (data.error?.message) {
        const reason = data.error.errors?.[0]?.reason;
        return reason ? `${data.error.message} [${reason}]` : data.error.message;
      }
    } catch { /* not JSON — fall through */ }
    return String(raw || res.statusText).slice(0, 300);
  }

  async function _refreshAccessToken() {
    const label = 'Gmail API token refresh';
    const res = await _fetch(TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type:    'refresh_token',
      }),
    }, label);

    if (!res.ok) throw new Error(`${label} ${res.status}: ${String(await _errorDetail(res)).slice(0, 300)}`);

    const data = await res.json().catch(() => ({}));
    if (!data.access_token) throw new Error(`${label} ${res.status}: response had no access_token`);

    accessToken          = data.access_token;
    accessTokenExpiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
    return accessToken;
  }

  async function _getAccessToken({ force = false } = {}) {
    if (!force && accessToken && Date.now() < accessTokenExpiresAt - TOKEN_SAFETY_MARGIN_MS) {
      return accessToken;
    }
    if (!refreshInFlight) {
      refreshInFlight = _refreshAccessToken().finally(() => { refreshInFlight = null; });
    }
    return refreshInFlight;
  }

  /** Build the RFC 2822 message and return it base64url-encoded (Gmail's "raw"). */
  function _buildRaw({ fromName, to, subject, html, text }) {
    const composer = new MailComposer({
      from: { name: fromName || '', address: user },
      to,
      subject,
      html,
      text,
    });
    return new Promise((resolve, reject) => {
      composer.compile().build((err, message) => {
        if (err) return reject(err);
        resolve(message.toString('base64url'));
      });
    });
  }

  async function _postMessage(raw, token) {
    return _fetch(SEND_URL, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ raw }),
    }, 'Gmail API');
  }

  /** Send one email. Returns the Gmail message id. */
  async function send({ fromName, to, subject, html, text }) {
    if (!to || !subject || (!html && !text)) {
      throw new Error('Gmail API send() requires to, subject, and html or text');
    }

    const raw = await _buildRaw({ fromName, to, subject, html, text });

    let res = await _postMessage(raw, await _getAccessToken());

    // A cached access token can be revoked early; refresh once and retry.
    if (res.status === 401) {
      res = await _postMessage(raw, await _getAccessToken({ force: true }));
    }

    if (!res.ok) throw new Error(`Gmail API ${res.status}: ${String(await _errorDetail(res)).slice(0, 300)}`);

    const data = await res.json().catch(() => ({}));
    return data.id || undefined;
  }

  return { send };
}

module.exports = { createGmailClient };
