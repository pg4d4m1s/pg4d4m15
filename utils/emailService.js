/**
 * utils/emailService.js
 *
 * WATERFALL DRIVER SYSTEM — drivers are tried in priority order until one
 * accepts the message. Chain (only configured drivers are included):
 *
 *   GMAIL API → SENDGRID #1 → #2 → #3 → #4 → #5 → SMTP (Gmail) → CONSOLE
 *
 *   Gmail API is the PRIMARY mailer. SendGrid only sends when the Gmail API fails
 *   (token revoked, daily limit hit, Google outage, timeout, ...). Set
 *   EMAIL_GMAIL_FIRST=false to restore the old order (SendGrid first, Gmail API after) without a code change.
 *
 * SendGrid accounts (up to 5, each needs a KEY *and* its own verified FROM):
 *
 *   SENDGRID_API_KEY   + SENDGRID_FROM     ← account 1 (primary)
 *   SENDGRID_API_KEY2  + SENDGRID_FROM2    ← account 2
 *   SENDGRID_API_KEY3  + SENDGRID_FROM3    ← account 3
 *   SENDGRID_API_KEY4  + SENDGRID_FROM4    ← account 4
 *   SENDGRID_API_KEY5  + SENDGRID_FROM5    ← account 5
 *
 *   Each account verifies its own sender, so FROM is NOT shared between
 *   accounts. A slot with a key but no FROM (or the reverse) is ignored and a
 *   warning is logged at boot. Only account 1 falls back to EMAIL_USER when
 *   SENDGRID_FROM is empty (legacy behaviour).
 *
 * Gmail API (HTTPS — works on Railway Free/Hobby where SMTP is blocked):
 *   GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET + GMAIL_REFRESH_TOKEN + GMAIL_USER
 *   OAuth2 refresh-token flow with the gmail.send scope (see utils/gmailApi.js).
 *   Free, ~500 emails/day for a personal Gmail account. All four variables are
 *   required; if only some are set the driver is disabled and a warning is
 *   logged at boot. It is tried FIRST (see EMAIL_GMAIL_FIRST); a quota / auth failure marks it
 *   "degraded" so mail goes straight to SendGrid for EMAIL_DRIVER_COOLDOWN_MS, then Gmail is retried.
 *   ⚠ If the Google Cloud OAuth consent screen is in "Testing" status, Google expires the refresh
 *   token after 7 days (→ "invalid_grant"). Publish the app ("In production") to avoid weekly breakage.
 *
 * Gmail SMTP (unchanged):
 *   USE_REAL_EMAIL=true + EMAIL_USER + EMAIL_PASS  (Gmail App Password, 16 chars)
 *   ⚠ Railway blocks SMTP ports 465/587 — works locally / on a VPS. If it is
 *   enabled on Railway it is tried after SendGrid and fails fast (8 s timeout).
 *
 * Failure handling
 *   • Permanent account-level errors (401/403, bad key, unverified sender,
 *     suspended / trial-expired / over-quota account, SMTP unreachable) mark
 *     that driver "degraded". It is skipped for EMAIL_DRIVER_COOLDOWN_MS
 *     (default 10 min) and then retried automatically — no redeploy needed.
 *   • Transient errors (5xx, timeouts, network) fall through to the next driver.
 *   • Every failure is logged with the driver name and the provider's message.
 *     When nothing delivers, ONE line lists every driver's reason.
 *
 * CONSOLE driver (last resort)
 *   • Development: prints the email (incl. OTP) to the log and reports success.
 *   • Railway/production: reports FAILURE (so users see an error instead of a
 *     false "code sent") and does NOT print the OTP.
 *     Set ALLOW_CONSOLE_OTP=true to restore the old behaviour for testing.
 *
 * Optional: EMAIL_HTTP_TIMEOUT_MS (default 10000), EMAIL_DRIVER_COOLDOWN_MS (default 600000)
 *
 * Delivery tracking (optional, recommended) — SendGrid answers "202 Accepted" as soon as it QUEUES a
 * message, long before the recipient's mail server takes it, so a slow OTP looks perfect in our own log.
 * The SendGrid Event Webhook (routes/sendgridWebhook.js) reports what happens next (delivered / deferred
 * / bounce / dropped / blocked + the receiving server's reply). Enable it with:
 *   SENDGRID_WEBHOOK_PUBLIC_KEY[2..5]  — the "Verification Key" of each SendGrid account's Signed Event Webhook
 *   MAIL_SLOW_WARN_MS                  — warn when an e-mail is still unconfirmed after this long (default 30000)
 *   EMAIL_GMAIL_FIRST                  — default ON: Gmail API is the FIRST mailer for ALL e-mail; SendGrid is only the
 *                                        fallback (takes over automatically if Gmail fails or hits its daily limit).
 *                                        Set to "false" to put SendGrid first again. (Replaces OTP_PREFER_GMAIL_API,
 *                                        which is no longer read.)
 *   OTP_FAILOVER_AFTER_MS              — re-send the SAME OTP via the next driver if SendGrid has not confirmed
 *                                        delivery after this long, or reports bounce/dropped/blocked (default 0 = off;
 *                                        needs the webhook; try 20000). Only applies to mail that SendGrid accepted
 *                                        (i.e. when Gmail failed first) — the Gmail API gives no delivery events.
 *
 * Env values are trimmed and stripped of accidental wrapping quotes, because
 * pasting KEY="abc" into the Railway variables UI keeps the quotes.
 */

'use strict';

const nodemailer = require('nodemailer');
const crypto = require('crypto');
const { createGmailClient } = require('./gmailApi');
const log = require('./logger');

// ─────────────────────────────────────────────────────────────────────────────
// Environment helpers
// ─────────────────────────────────────────────────────────────────────────────
/** Read an env var, trimmed, with accidental wrapping quotes removed. */
function env(name) {
  return (process.env[name] || '').trim().replace(/^["']+|["']+$/g, '').trim();
}

// Railway does not set NODE_ENV for you, so also detect Railway itself.
const IS_PRODUCTION =
  env('NODE_ENV') === 'production' ||
  !!(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);

const ALLOW_CONSOLE_OTP      = env('ALLOW_CONSOLE_OTP') === 'true';
const CONSOLE_COUNTS_AS_SENT = !IS_PRODUCTION || ALLOW_CONSOLE_OTP;

const HTTP_TIMEOUT_MS = Number(env('EMAIL_HTTP_TIMEOUT_MS'))     || 10_000;
const COOLDOWN_MS     = Number(env('EMAIL_DRIVER_COOLDOWN_MS'))  || 10 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// SendGrid accounts — slots 1..5
// ─────────────────────────────────────────────────────────────────────────────
const MAX_SENDGRID_ACCOUNTS = 5;

/** Slot 1 = SENDGRID_API_KEY / SENDGRID_FROM, slot N = SENDGRID_API_KEY<N> / SENDGRID_FROM<N>. */
const { accounts: SENDGRID_ACCOUNTS, warnings: SENDGRID_WARNINGS } = (() => {
  const accounts = [];
  const warnings = [];
  const seenKeys = new Map(); // key → slot, to catch the same key pasted twice

  for (let n = 1; n <= MAX_SENDGRID_ACCOUNTS; n++) {
    const sfx  = n === 1 ? '' : String(n);
    const key  = env(`SENDGRID_API_KEY${sfx}`);
    let   from = env(`SENDGRID_FROM${sfx}`);

    if (!key) {
      if (from) warnings.push(`SENDGRID_FROM${sfx} is set but SENDGRID_API_KEY${sfx} is missing — slot ${n} ignored`);
      continue;
    }
    if (!from && n === 1) from = env('EMAIL_USER') || 'noreply@pgadamis.gov.ph'; // legacy fallback
    if (!from) {
      warnings.push(`SENDGRID_API_KEY${sfx} is set but SENDGRID_FROM${sfx} is missing — slot ${n} ignored`);
      continue;
    }
    if (seenKeys.has(key)) {
      warnings.push(`SENDGRID_API_KEY${sfx} is identical to slot ${seenKeys.get(key)} — slot ${n} ignored (a duplicate key is not a fallback)`);
      continue;
    }
    seenKeys.set(key, n);
    accounts.push({ driver: n === 1 ? 'sendgrid' : `sendgrid${n}`, slot: n, key, from });
  }
  return { accounts, warnings };
})();

// ─────────────────────────────────────────────────────────────────────────────
// Gmail API (HTTPS, OAuth2) — works on Railway Free/Hobby where SMTP is blocked
// ─────────────────────────────────────────────────────────────────────────────
const GMAIL_API = (() => {
  const cfg = {
    clientId:     env('GMAIL_CLIENT_ID'),
    clientSecret: env('GMAIL_CLIENT_SECRET'),
    refreshToken: env('GMAIL_REFRESH_TOKEN'),
    user:         env('GMAIL_USER'),
  };
  const required = {
    GMAIL_CLIENT_ID:     cfg.clientId,
    GMAIL_CLIENT_SECRET: cfg.clientSecret,
    GMAIL_REFRESH_TOKEN: cfg.refreshToken,
    GMAIL_USER:          cfg.user,
  };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);

  if (missing.length === Object.keys(required).length) return { enabled: false, warning: null };
  if (missing.length) {
    return {
      enabled: false,
      warning: `Gmail API is partly configured — missing ${missing.join(', ')}; Gmail API driver disabled`,
    };
  }
  return {
    enabled: true,
    user:    cfg.user,
    warning: null,
    client:  createGmailClient({ ...cfg, timeoutMs: HTTP_TIMEOUT_MS }),
  };
})();

// ─────────────────────────────────────────────────────────────────────────────
// Driver chain: GMAIL API → SENDGRID #1..#5 → SMTP → CONSOLE
// (EMAIL_GMAIL_FIRST=false flips it back to SENDGRID #1..#5 → GMAIL API → ...)
// ─────────────────────────────────────────────────────────────────────────────
const GMAIL_FIRST = env('EMAIL_GMAIL_FIRST').toLowerCase() !== 'false';

const DRIVER_CHAIN = (() => {
  const chain = SENDGRID_ACCOUNTS.map(a => a.driver);
  if (GMAIL_API.enabled) {
    if (GMAIL_FIRST) chain.unshift('gmailapi');
    else             chain.push('gmailapi');
  }
  if (env('USE_REAL_EMAIL') === 'true') chain.push('smtp');
  chain.push('console'); // always last
  return chain;
})();

/** The primary (first) driver — used for startup/error logs. */
const DRIVER = DRIVER_CHAIN[0];

/**
 * Per-driver health. 'ok' → try normally. 'degraded' → skipped until retryAt.
 * (Console is not tracked — it cannot fail.)
 */
const _health = Object.fromEntries(
  DRIVER_CHAIN.filter(d => d !== 'console').map(d => [d, {
    status: 'ok', since: null, retryAt: 0, lastError: null, lastOkAt: null,
  }])
);

/**
 * True for errors that mean the driver itself is broken (blocked / expired /
 * over-quota account, bad credentials, unverified sender, unreachable SMTP)
 * rather than a one-off.
 */
function _isPermanentDriverError(driver, msg = '') {
  const m = msg.toLowerCase();
  if (driver === 'smtp' && /timeout|etimedout|econnrefused|enetunreach|ehostunreach|esocket/.test(m)) return true;
  // Gmail API quota / throttling arrives as 429 (or 403 with a rate-limit reason). Retrying it on every
  // send just burns time before SendGrid takes over, so park the driver for the cooldown instead.
  if (driver === 'gmailapi' && (m.includes(' 429:') || /ratelimitexceeded|userratelimitexceeded|quotaexceeded|rate limit exceeded/.test(m))) return true;
  if (m.includes(' 401:') || m.includes(' 403:')) return true;
  return [
    'unauthorized', 'forbidden', 'invalid api key', 'api key is invalid', 'key not found',
    'sender not verified', 'verified sender', 'domain is not verified', 'domain not verified',
    'account suspended', 'account has been', 'temporarily blocked', 'unrecognized ip',
    'unrecognised ip', 'not authorized', 'not authorised', 'authentication failed',
    'invalid login', 'maximum credits exceeded',
    'invalid_grant', 'invalid_client', 'unauthorized_client', 'insufficient permission',
    'daily user sending limit', 'dailylimitexceeded',
  ].some(s => m.includes(s));
}

// ─────────────────────────────────────────────────────────────────────────────
// Delivery tracking (SendGrid Event Webhook) + per-recipient send history
// ─────────────────────────────────────────────────────────────────────────────
/** Verification keys of the Signed Event Webhook, one per SendGrid account (base64 DER, as shown by SendGrid). */
const WEBHOOK_KEYS = (() => {
  const out = [];
  for (let n = 1; n <= 5; n++) {
    const name = `SENDGRID_WEBHOOK_PUBLIC_KEY${n === 1 ? '' : n}`;
    const raw  = env(name);
    if (!raw) continue;
    try {
      const der = Buffer.from(raw.replace(/-----(BEGIN|END) PUBLIC KEY-----|\s+/g, ''), 'base64');
      out.push({ slot: n, key: crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }) });
    } catch (e) {
      console.warn(`⚠️  [emailService] ${name} is not a valid public key (${e.message}) — ignored`);
    }
  }
  return out;
})();

const TRACKING_ENABLED      = WEBHOOK_KEYS.length > 0;
const SLOW_DELIVERY_WARN_MS = Number(env('MAIL_SLOW_WARN_MS')) || 30_000;
let   OTP_FAILOVER_AFTER_MS = Number(env('OTP_FAILOVER_AFTER_MS')) || 0;
if (OTP_FAILOVER_AFTER_MS > 0 && !TRACKING_ENABLED) {
  console.warn('⚠️  [emailService] OTP_FAILOVER_AFTER_MS needs SENDGRID_WEBHOOK_PUBLIC_KEY (delivery events) — failover disabled');
  OTP_FAILOVER_AFTER_MS = 0;
}

const TRACK_TTL_MS      = 60 * 60 * 1000;
const TRACK_MAX         = 500;
const HISTORY_WINDOW_MS = 15 * 60 * 1000;
const REPEAT_WARN_AT    = 3; // warn when this many e-mails went to one address inside the window

const _tracked = new Map(); // SendGrid message id → record
const _history = new Map(); // lower-case e-mail → [{ at, rec }]

function _clearTimers(rec) {
  (rec.timers || []).forEach(clearTimeout);
  rec.timers = [];
}

function _pruneTracked(now = Date.now()) {
  for (const [id, r] of _tracked) {            // Map iterates oldest-first; deleting while iterating is safe
    if (now - r.acceptedAt > TRACK_TTL_MS || _tracked.size > TRACK_MAX) {
      _clearTimers(r);
      _tracked.delete(id);
    }
  }
}

/** Remember an accepted send. Returns { count, prevAgoMs } for this recipient inside the window. */
function _recordSend(to, rec) {
  const key = String(to).trim().toLowerCase();
  const now = Date.now();
  const list = (_history.get(key) || []).filter(h => now - h.at < HISTORY_WINDOW_MS);
  const prev = list[list.length - 1];
  list.push({ at: now, rec });
  _history.set(key, list);
  if (_history.size > 2000) {
    for (const [k, v] of _history) {
      if (!v.length || now - v[v.length - 1].at > HISTORY_WINDOW_MS) _history.delete(k);
    }
  }
  return { count: list.length, prevAgoMs: prev ? now - prev.at : null };
}

/**
 * What do we know about the e-mails sent to this address recently? Used by the verify-otp route so a
 * "wrong code" log line says whether the user is probably typing a code from an e-mail that never arrived.
 */
function getRecipientMailInfo(email) {
  const now  = Date.now();
  const list = (_history.get(String(email || '').trim().toLowerCase()) || []).filter(h => now - h.at < HISTORY_WINDOW_MS);
  if (!list.length) {
    return { sends: 0, summary: 'no e-mail accepted by a provider for this address in the last 15 min (server restarted, or the send failed)' };
  }
  const last = list[list.length - 1];
  const r    = last.rec;
  const ago  = Math.round((now - last.at) / 1000);
  let status;
  if (r.tracked) status = r.status === 'accepted' ? 'accepted by SendGrid, no delivery event yet' : r.status + (r.deferrals ? ` after ${r.deferrals} deferral(s)` : '');
  else if (r.driver === 'gmailapi') status = 'accepted by Gmail API (Gmail gives no delivery events; a bounce would arrive in the Gmail inbox)';
  else           status = `unknown (no delivery events for ${r.driver}${TRACKING_ENABLED ? ' — add its webhook key' : '; webhook not configured'})`;
  const why = r.reason ? ` (${r.reason.slice(0, 160)})` : '';
  return {
    sends: list.length,
    summary: `${list.length} e-mail(s) to this address in 15 min | latest ${r.kind} via ${r.driver} ${ago}s ago | delivery: ${status}${why}`,
  };
}

/** Public keys for routes/sendgridWebhook.js to verify signatures with. Empty = tracking disabled. */
function getWebhookKeys() { return WEBHOOK_KEYS; }

/**
 * Feed SendGrid Event Webhook events in. Logs one line per delivery event with the time since we
 * handed the message over, plus the receiving server's own reply (the real reason for a delay).
 * Returns the number of events handled.
 */
function recordSendGridEvents(events) {
  if (!Array.isArray(events)) return 0;
  let handled = 0;
  for (const ev of events.slice(0, 1000)) {
    if (!ev || typeof ev !== 'object') continue;
    const type = String(ev.event || '');
    if (!['processed', 'deferred', 'delivered', 'bounce', 'dropped', 'blocked', 'spamreport'].includes(type)) continue;
    handled++;

    const id     = String(ev.sg_message_id || '').split('.')[0];
    const rec    = _tracked.get(id);
    const to     = ev.email || rec?.to || '?';
    const evAt   = Number(ev.timestamp) ? Number(ev.timestamp) * 1000 : Date.now();
    const lag    = rec ? Math.max(0, evAt - rec.acceptedAt) : null;
    const lagStr = lag == null ? '' : ` +${(lag / 1000).toFixed(1)}s after we handed it over`;
    const detail = String(ev.response || ev.reason || '').replace(/\s+/g, ' ').slice(0, 300);
    const tag    = rec ? `${rec.kind} via ${rec.driver}` : 'not sent by this process';
    const idStr  = id ? ` | id=${id}` : '';

    if (rec) {
      rec.status      = type;
      rec.lastEventAt = evAt;
      if (type === 'deferred') rec.deferrals++;
      if (detail && type !== 'delivered' && type !== 'processed') rec.reason = detail;
    }

    switch (type) {
      case 'processed':
        break; // SendGrid queued it — nothing to say yet
      case 'delivered':
        if (rec) { rec.delivered = true; rec.reason = null; _clearTimers(rec); }
        if (lag != null && lag > SLOW_DELIVERY_WARN_MS) {
          log.warn(`[MAIL-EVT] 🐌 delivered → ${to} (${tag})${lagStr} — SLOW, the delay was between SendGrid and the recipient's server, not in our app${detail ? ` | ${detail}` : ''}${idStr}`);
        } else {
          log.info(`[MAIL-EVT] ✔ delivered → ${to} (${tag})${lagStr}${detail ? ` | ${detail}` : ''}${idStr}`);
        }
        break;
      case 'deferred':
        log.warn(`[MAIL-EVT] ⏳ deferred (attempt ${ev.attempt || '?'}) → ${to} (${tag})${lagStr} | ${detail || 'no reason given'}${idStr}`);
        break;
      case 'spamreport':
        log.warn(`[MAIL-EVT] 🚩 recipient marked as spam → ${to} (${tag})${idStr}`);
        break;
      default: // bounce | dropped | blocked
        log.error(`[MAIL-EVT] ❌ ${type} → ${to} (${tag})${lagStr} | ${detail || 'no reason given'}${idStr}`);
        if (rec && rec.onFail) rec.onFail(type);
    }
  }
  return handled;
}

/**
 * After SendGrid accepts a message, watch for its delivery event. Warns when it is overdue and — if
 * OTP_FAILOVER_AFTER_MS is set — re-sends through the next driver (same OTP, so a late first e-mail
 * is still valid). `failover(why)` is supplied by the caller and must be idempotent-safe.
 */
function _armDeliveryWatch(rec, failover) {
  if (!TRACKING_ENABLED || !rec.tracked) return;
  rec.timers = [];

  const warnTimer = setTimeout(() => {
    if (rec.delivered) return;
    log.warn(
      `[MAIL] ⏱ ${rec.kind} to ${rec.to} NOT confirmed delivered ${Math.round(SLOW_DELIVERY_WARN_MS / 1000)}s after ${rec.driver} accepted it | ` +
      `SendGrid status=${rec.status}${rec.reason ? ` | last reply: ${rec.reason}` : ' | no event yet'} | id=${rec.id}`
    );
  }, SLOW_DELIVERY_WARN_MS);
  warnTimer.unref();
  rec.timers.push(warnTimer);

  if (OTP_FAILOVER_AFTER_MS > 0 && failover) {
    const run = async (why) => {
      if (rec.delivered || rec.failedOver) return;
      rec.failedOver = true;
      try { await failover(why); }
      catch (e) { log.error(`[MAIL] ↪ failover for ${rec.to} crashed: ${e.message}`); }
    };
    rec.onFail = (type) => run(`SendGrid reported ${type}`);
    const t = setTimeout(
      () => run(`no delivery confirmation ${Math.round(OTP_FAILOVER_AFTER_MS / 1000)}s after ${rec.driver} accepted it`),
      OTP_FAILOVER_AFTER_MS
    );
    t.unref();
    rec.timers.push(t);
  }
}

/** Drivers already tried: the chain up to and including `driver`. */
function _driversThrough(driver, order = DRIVER_CHAIN) {
  return new Set(order.slice(0, order.indexOf(driver) + 1));
}

function _fromFor(driver) {
  if (driver === 'gmailapi') return GMAIL_API.user;
  if (driver === 'smtp')     return FROM_EMAIL();
  return SENDGRID_ACCOUNTS.find(a => a.driver === driver)?.from;
}

// ─────────────────────────────────────────────────────────────────────────────
// SMTP transporter (Gmail) — local/VPS
// ─────────────────────────────────────────────────────────────────────────────
let smtpTransporter = null;

async function initSMTP() {
  smtpTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: env('EMAIL_USER'), pass: env('EMAIL_PASS') },
    // Without these, a blocked port hangs for ~120 s per request.
    connectionTimeout: 8_000,
    greetingTimeout:   8_000,
    socketTimeout:     15_000,
  });

  // Railway blocks outbound SMTP — skip the live verify in production to avoid
  // a startup stall. SendGrid handles production email.
  if (IS_PRODUCTION) {
    console.log('   ℹ  Gmail SMTP configured (verify skipped in production — Railway blocks SMTP ports)');
    return;
  }

  try {
    await smtpTransporter.verify();
    console.log('✅ Gmail SMTP connected —', env('EMAIL_USER'));
  } catch (err) {
    console.error('❌ Gmail SMTP failed:', err.message);
    console.warn('   Make sure EMAIL_PASS is a Gmail App Password (16 chars, no spaces).');
    smtpTransporter = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function generateOTP() {
  const { randomInt } = require('crypto');
  return String(randomInt(100000, 999999));
}

function APP_NAME()  { return process.env.APP_NAME || 'PGA-DAMIS'; }
function APP_URL()   { return process.env.APP_URL  || 'http://localhost:3000'; }

/** Sender used by the Gmail SMTP driver (Gmail sends as the authenticated account anyway). */
function FROM_EMAIL() {
  return env('EMAIL_USER') || SENDGRID_ACCOUNTS[0]?.from || 'noreply@pgadamis.gov.ph';
}

function FROM_ADDRESS() {
  return `"${APP_NAME()}" <${FROM_EMAIL()}>`;
}

/** Hide 6-digit codes when a subject is written to the logs. */
function _redact(s = '') {
  return String(s).replace(/\b\d{6}\b/g, '••••••');
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot — runs once on module load
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  const label = (d) => d === 'smtp' ? 'Gmail SMTP'
                     : d === 'gmailapi' ? 'Gmail API'
                     : d === 'console' ? 'Console (fallback)'
                     : `SendGrid #${SENDGRID_ACCOUNTS.find(a => a.driver === d)?.slot}`;

  SENDGRID_WARNINGS.forEach(w => console.warn(`⚠️  [emailService] ${w}`));
  if (GMAIL_API.warning) console.warn(`⚠️  [emailService] ${GMAIL_API.warning}`);
  if (GMAIL_FIRST && !GMAIL_API.enabled && SENDGRID_ACCOUNTS.length) {
    console.warn('⚠️  [emailService] Gmail API is NOT configured (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN / GMAIL_USER) — SendGrid is the primary mailer');
  }

  if (DRIVER_CHAIN[0] === 'console') {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    if (IS_PRODUCTION) {
      console.log('║  ❌  Email driver : NONE CONFIGURED (production)            ║');
      console.log('║  Verification emails will FAIL until you set               ║');
      console.log('║  SENDGRID_* or GMAIL_* (Gmail API) in Railway variables.   ║');
    } else {
      console.log('║  📧  Email driver : CONSOLE (development mode)             ║');
      console.log('║  Emails are NOT delivered. OTPs will appear here.          ║');
      console.log('║  → Set SENDGRID_*, GMAIL_* (Gmail API) or USE_REAL_EMAIL   ║');
    }
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    return;
  }

  console.log(`✅ Email driver : ${label(DRIVER_CHAIN[0])}`);
  console.log(`   Chain        : ${DRIVER_CHAIN.map(label).join(' → ')}`);
  SENDGRID_ACCOUNTS.forEach(a => console.log(`   SendGrid #${a.slot}  : from=${a.from}`));
  if (GMAIL_API.enabled) console.log(`   Gmail API    : user=${GMAIL_API.user}`);
  console.log(`   Console OTP  : ${CONSOLE_COUNTS_AS_SENT ? 'counts as sent (dev / ALLOW_CONSOLE_OTP)' : 'treated as FAILURE (production)'}`);
  console.log(`   Primary      : ${label(DRIVER_CHAIN[0])}${DRIVER_CHAIN[0] === 'gmailapi' ? ' — SendGrid is fallback only' : GMAIL_API.enabled ? ' (EMAIL_GMAIL_FIRST=false)' : ''}`);
  console.log(`   Delivery log : ${TRACKING_ENABLED
    ? `ON — webhook keys for SendGrid slot(s) ${WEBHOOK_KEYS.map(k => k.slot).join(', ')}, slow-warn ${Math.round(SLOW_DELIVERY_WARN_MS / 1000)}s, OTP failover ${OTP_FAILOVER_AFTER_MS ? `after ${Math.round(OTP_FAILOVER_AFTER_MS / 1000)}s` : 'off'}`
    : 'OFF — set SENDGRID_WEBHOOK_PUBLIC_KEY (+ add the webhook in SendGrid) to see deferred/delivered/bounced events'}`);

  if (DRIVER_CHAIN.includes('smtp')) await initSMTP();
})().catch(console.error);

// ─────────────────────────────────────────────────────────────────────────────
// Per-driver send implementations
// ─────────────────────────────────────────────────────────────────────────────
/** One SendGrid account. Throws "SendGrid #N <status>: <detail>" on failure. */
async function _sendSendGrid(account, { to, subject, html, text, kind }) {
  const label = `SendGrid #${account.slot}`;
  let res;
  try {
    res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${account.key}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from:             { email: account.from, name: APP_NAME() },
        subject,
        content: [
          { type: 'text/plain', value: text },
          { type: 'text/html',  value: html },
        ],
        // Click tracking rewrites every link to a sendgrid.net redirect and open tracking adds a pixel —
        // both are spam signals on a one-time-code e-mail. Category = easy filter in SendGrid's Activity Feed.
        tracking_settings: { click_tracking: { enable: false, enable_text: false }, open_tracking: { enable: false } },
        categories: [`damis-${kind || 'mail'}`],
      }),
      // Without a timeout a stalled connection would hold the HTTP request open.
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`${label} timeout after ${HTTP_TIMEOUT_MS}ms`);
    }
    throw new Error(`${label} network error: ${err.cause?.code || err.message}`);
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let detail = raw || res.statusText;
    try {
      const data = JSON.parse(raw);
      detail = data?.errors?.map(e => e.message).join(', ') || raw;
    } catch { /* keep raw text */ }
    throw new Error(`${label} ${res.status}: ${String(detail).slice(0, 300)}`);
  }
  return res.headers.get('X-Message-Id') || undefined;
}

async function _sendSMTP({ to, subject, html, text }) {
  if (!smtpTransporter) throw new Error('SMTP transporter not available — check EMAIL_USER / EMAIL_PASS.');
  const info = await smtpTransporter.sendMail({ from: FROM_ADDRESS(), to, subject, html, text });
  return info.messageId;
}

/** Gmail API over HTTPS. Throws "Gmail API <status>: <detail>" on failure. */
async function _sendGmailApi({ to, subject, html, text }) {
  return GMAIL_API.client.send({ fromName: APP_NAME(), to, subject, html, text });
}

function _sendConsole({ to, subject, text }) {
  const border = '═'.repeat(60);
  console.log('');
  console.log(`╔${border}╗`);
  console.log(`║  📬  [EMAIL→CONSOLE]  ${subject.slice(0, 37).padEnd(37)}  ║`);
  console.log(`║  To: ${to.padEnd(54)}║`);
  console.log(`╚${border}╝`);
  if (text) console.log(text.trim());
  console.log('');
}

const _DRIVER_FN = {
  smtp: _sendSMTP,
  ...(GMAIL_API.enabled ? { gmailapi: _sendGmailApi } : {}),
  ...Object.fromEntries(SENDGRID_ACCOUNTS.map(a => [a.driver, (msg) => _sendSendGrid(a, msg)])),
};

// ─────────────────────────────────────────────────────────────────────────────
// Core send — waterfall across the driver chain
// Returns { success, driver, messageId?, delivered, error? }
//   delivered=true only when a real provider accepted the message.
// ─────────────────────────────────────────────────────────────────────────────
async function _send({ to, subject, html, text, kind = 'mail', skip = null }) {
  const attempts = []; // human-readable reason per driver that did not deliver
  const order = DRIVER_CHAIN;

  for (const driver of order) {
    if (skip && skip.has(driver)) continue; // already used (failover)

    if (driver === 'console') {
      const reason = attempts.length ? attempts.join(' | ') : 'no real email driver configured';
      console.error(`❌ [emailService] NOT DELIVERED → ${to} | "${_redact(subject).slice(0, 50)}" | ${reason}`);
      if (CONSOLE_COUNTS_AS_SENT) _sendConsole({ to, subject, text });
      return { success: CONSOLE_COUNTS_AS_SENT, driver: 'console', delivered: false, error: reason };
    }

    const h = _health[driver];
    if (h.status === 'degraded' && Date.now() < h.retryAt) {
      const mins = Math.max(1, Math.ceil((h.retryAt - Date.now()) / 60000));
      attempts.push(`${driver}: skipped (degraded: ${h.lastError}; retry in ~${mins}m)`);
      continue;
    }

    const t0 = Date.now();
    try {
      const messageId = await _DRIVER_FN[driver]({ to, subject, html, text, kind });
      const ms = Date.now() - t0;
      if (h.status === 'degraded') console.log(`✅ [emailService] ${driver} recovered — back in rotation`);
      h.status = 'ok'; h.since = null; h.lastError = null; h.lastOkAt = Date.now();
      const rec = {
        id: messageId, to, kind, driver, from: _fromFor(driver), acceptedAt: Date.now(),
        status: 'accepted', reason: null, deferrals: 0, delivered: false, failedOver: false,
        tracked: !!messageId && WEBHOOK_KEYS.some(k => k.slot === SENDGRID_ACCOUNTS.find(a => a.driver === driver)?.slot), timers: [],
      };
      if (rec.tracked) { _pruneTracked(); _tracked.set(messageId, rec); }
      const sends = _recordSend(to, rec);
      return { success: true, driver, messageId, delivered: true, ms, from: rec.from, rec, sends, order };
    } catch (err) {
      const msg = err.message || String(err);
      const ms  = Date.now() - t0;
      h.lastError = msg;
      attempts.push(`${driver}: ${msg} (${ms}ms)`);

      if (_isPermanentDriverError(driver, msg)) {
        h.status  = 'degraded';
        h.since   = h.since || Date.now();
        h.retryAt = Date.now() + COOLDOWN_MS;
        console.error(`❌ [emailService] ${driver} DEGRADED after ${ms}ms (retry in ${Math.round(COOLDOWN_MS / 60000)}m): ${msg}`);
        if (driver === 'gmailapi' && /invalid_grant|invalid_client|unauthorized_client/i.test(msg)) {
          console.error('   ↳ Gmail API credentials were rejected: generate a new GMAIL_REFRESH_TOKEN (and publish the Google OAuth consent screen — "Testing" tokens expire after 7 days). SendGrid is covering meanwhile.');
        }
      } else {
        console.error(`⚠️  [emailService] ${driver} transient error after ${ms}ms: ${msg} → trying next driver`);
      }
    }
  }

  // Unreachable (chain always ends with console) — kept as a safety net.
  return { success: false, driver: 'none', delivered: false, error: attempts.join(' | ') };
}

/** Safe-to-expose snapshot (no secrets) for an admin status endpoint. */
function getHealth() {
  return {
    production: IS_PRODUCTION,
    chain: [...DRIVER_CHAIN],
    sendgridAccounts: SENDGRID_ACCOUNTS.map(a => ({ driver: a.driver, slot: a.slot, from: a.from })),
    gmailApi: GMAIL_API.enabled ? { user: GMAIL_API.user } : null,
    consoleCountsAsSent: CONSOLE_COUNTS_AS_SENT,
    drivers: Object.fromEntries(Object.entries(_health).map(([name, h]) => [name, {
      status:    h.status,
      lastError: h.lastError,
      lastOkAt:  h.lastOkAt ? new Date(h.lastOkAt).toISOString() : null,
      retryInMs: h.status === 'degraded' ? Math.max(0, h.retryAt - Date.now()) : 0,
    }])),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Template helpers
// ─────────────────────────────────────────────────────────────────────────────
function emailWrapper(headerGradient, headerEmoji, headerTitle, headerSub, bodyHtml) {
  const appName = APP_NAME();
  const url     = APP_URL();
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0">
  <tr><td align="center" style="padding:40px 20px;">
    <table width="100%" style="max-width:520px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);">
      <tr>
        <td style="background:${headerGradient};padding:32px;text-align:center;">
          <div style="font-size:26px;font-weight:800;color:#fff;">${headerEmoji} ${headerTitle}</div>
          ${headerSub ? `<div style="color:rgba(255,255,255,.7);font-size:13px;margin-top:4px;">${headerSub}</div>` : ''}
        </td>
      </tr>
      <tr><td style="padding:36px 40px;">${bodyHtml}</td></tr>
      <tr>
        <td style="background:#f8fafc;padding:16px 40px;border-top:1px solid #e2e8f0;text-align:center;">
          <p style="color:#cbd5e1;font-size:12px;margin:0;">
            &copy; 2026 ${appName} &middot; Provincial Government of Aurora<br/>
            <a href="${url}" style="color:#93c5fd;text-decoration:none;">${url}</a>
          </p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

const greeting = (firstName) =>
  `<p style="color:#475569;font-size:15px;margin:0 0 16px;">Hi <strong style="color:#1e293b;">${firstName}</strong>,</p>`;

const para = (text) =>
  `<p style="color:#475569;font-size:15px;margin:0 0 28px;line-height:1.6;">${text}</p>`;

const btn = (href, label, bg = '#1d4ed8') =>
  `<a href="${href}" style="display:inline-block;margin-top:8px;padding:12px 28px;background:${bg};color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px;">${label}</a>`;

const warningBox = (msg) =>
  `<div style="background:#fef3c7;border-left:4px solid #f59e0b;border-radius:8px;padding:12px 16px;margin-bottom:24px;">
    <p style="color:#92400e;font-size:13px;margin:0;">&#9888;&#65039; ${msg}</p>
  </div>`;

const otpBlock = (otp, bg = '#eff6ff', border = '#bfdbfe', color = '#1d4ed8', minutes = 30) =>
  `<div style="text-align:center;margin:0 0 28px;">
    <div style="display:inline-block;background:${bg};border:2px solid ${border};border-radius:16px;padding:20px 40px;">
      <div style="font-size:42px;font-weight:800;color:${color};letter-spacing:14px;font-family:monospace;">${otp}</div>
    </div>
    <p style="color:#94a3b8;font-size:12px;margin:10px 0 0;">&#9200; Expires in <strong>${minutes} minutes</strong></p>
  </div>`;

// ─────────────────────────────────────────────────────────────────────────────
// Public send functions
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {object}   [opts]
 * @param {function} [opts.stillNeeded] returns false once this code is no longer wanted (verified / replaced) —
 *                                      stops a late failover e-mail from going out.
 */
async function sendOTPEmail(toEmail, otp, firstName = 'there', opts = {}) {
  const appName = APP_NAME();
  const body = emailWrapper(
    'linear-gradient(135deg,#1e3a8a,#2563eb)', '&#128309;', 'Email Verification', appName,
    greeting(firstName) +
    para(`Your <strong>${appName}</strong> verification code is below. Enter it on the registration page to verify your email address.`) +
    otpBlock(otp) +
    warningBox(`<strong>Never share this code.</strong> ${appName} staff will never ask for your OTP.`) +
    `<p style="color:#94a3b8;font-size:13px;margin:0;">If you didn't request this, ignore this email.</p>`
  );
  const text = `${appName} Verification\n\nHi ${firstName},\n\nYour verification code: ${otp}\n\nExpires in 30 minutes. Never share this code.\n\nIf you didn't request this, ignore this email.`;
  const msg  = { to: toEmail, subject: `${otp} — Your ${appName} verification code`, html: body, text, kind: 'otp' };
  try {
    const result = await _send(msg);
    if (result.driver !== 'console') {
      const ts = new Date().toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const repeat = result.sends.count >= REPEAT_WARN_AT
        ? ` ⚠ ${result.sends.count} e-mails to this address in 15 min — Gmail may throttle/defer repeats` : '';
      console.log(
        `  ✉  OTP sent [${result.driver}] → ${toEmail} | ${ts}${result.messageId ? ` | id=${result.messageId}` : ''}` +
        ` | handed over in ${result.ms}ms | from=${result.from || '?'}` +
        ` | #${result.sends.count} in 15 min${result.sends.prevAgoMs != null ? ` (previous ${Math.round(result.sends.prevAgoMs / 1000)}s ago)` : ''}${repeat}`
      );

      _armDeliveryWatch(result.rec, async (why) => {
        if (opts.stillNeeded && !opts.stillNeeded()) {
          log.info(`[MAIL] ↪ failover skipped for ${toEmail}: the code was already used or replaced (${why})`);
          return;
        }
        const skip = _driversThrough(result.driver, result.order);
        if (!result.order.some(d => d !== 'console' && !skip.has(d))) {
          log.warn(`[MAIL] ↪ no other e-mail driver to fail over to for ${toEmail} (${why})`);
          return;
        }
        log.warn(`[MAIL] ↪ OTP failover → ${toEmail}: ${why}; re-sending the SAME code through the next driver`);
        const r2 = await _send({ ...msg, skip });
        if (r2.delivered) log.info(`[MAIL] ↪ failover OTP accepted by ${r2.driver} in ${r2.ms}ms → ${toEmail}${r2.messageId ? ` | id=${r2.messageId}` : ''}`);
        else              log.error(`[MAIL] ↪ failover OTP NOT delivered → ${toEmail} | ${r2.error}`);
      });
    }
    return result;
  } catch (err) {
    console.error(`❌ [emailService] sendOTPEmail → ${toEmail} | driver=${DRIVER} | ${err.message}`);
    return { success: false };
  }
}

async function sendPasswordResetEmail(toEmail, otp, firstName = 'there') {
  const appName = APP_NAME();
  const body = emailWrapper(
    'linear-gradient(135deg,#7c3aed,#4f46e5)', '&#128273;', 'Password Reset', appName,
    greeting(firstName) +
    para(`Use this code to reset your <strong>${appName}</strong> password.`) +
    otpBlock(otp, '#f5f3ff', '#c4b5fd', '#4f46e5', 10) +
    `<p style="color:#475569;font-size:13px;margin:0;">If you didn't request a password reset, ignore this email. Your account is safe.</p>`
  );
  const text = `${appName} Password Reset\n\nHi ${firstName},\n\nYour reset code: ${otp}\n\nExpires in 10 minutes.\n\nIf you didn't request this, ignore this email.`;
  try {
    const result = await _send({ to: toEmail, subject: `${otp} — Your ${appName} password reset code`, html: body, text, kind: 'reset' });
    if (result.driver !== 'console') console.log(`  🔑 Password reset sent [${result.driver}] → ${toEmail}`);
    return result;
  } catch (err) {
    console.error(`❌ [emailService] sendPasswordResetEmail → ${toEmail} | driver=${DRIVER} | ${err.message}`);
    return { success: false };
  }
}

async function sendWelcomeEmail(toEmail, firstName) {
  const appName = APP_NAME();
  const body = emailWrapper(
    'linear-gradient(135deg,#1e3a8a,#2563eb)', '&#127881;', `Welcome to ${appName}!`, null,
    greeting(firstName) +
    `<p style="color:#475569;font-size:15px;line-height:1.7;margin:0;">
      Your email is verified &#127882;<br/><br/>
      Your government ID is under review — we'll notify you within <strong>24 hours</strong> once approved.<br/><br/>
      Thank you for joining ${appName}!
    </p>`
  );
  const text = `Welcome to ${appName}!\n\nHi ${firstName}, your email is verified.\n\nYour government ID is under review — we'll notify you within 24 hours once approved.\n\nThank you!`;
  try {
    const result = await _send({ to: toEmail, subject: `Welcome to ${appName}! 🎉`, html: body, text });
    if (result.driver !== 'console') console.log(`  🎉 Welcome email sent [${result.driver}] → ${toEmail}`);
    return result;
  } catch (err) {
    console.error(`❌ [emailService] sendWelcomeEmail → ${toEmail} | driver=${DRIVER} | ${err.message}`);
    return { success: false };
  }
}

async function sendAccountPendingEmail(toEmail, firstName) {
  const appName = APP_NAME();
  const body = emailWrapper(
    'linear-gradient(135deg,#92400e,#d97706)', '&#9203;', 'Account Under Review', appName,
    greeting(firstName) +
    `<p style="color:#475569;font-size:15px;line-height:1.7;margin:0;">
      Thank you for registering. Your account is currently under review by our administrators.<br/><br/>
      We'll send you an email once approved. This usually takes <strong>24 hours</strong>.
    </p>`
  );
  const text = `Account Under Review — ${appName}\n\nHi ${firstName},\n\nYour account is under review. We'll notify you within 24 hours once approved.`;
  try {
    const result = await _send({ to: toEmail, subject: `[${appName}] Your account is under review`, html: body, text });
    if (result.driver !== 'console') console.log(`  ⏳ Account pending email sent [${result.driver}] → ${toEmail}`);
    return result;
  } catch (err) {
    console.error(`❌ [emailService] sendAccountPendingEmail → ${toEmail} | driver=${DRIVER} | ${err.message}`);
    return { success: false };
  }
}

async function sendAccountApprovedEmail(toEmail, firstName) {
  const appName = APP_NAME();
  const appUrl  = APP_URL();
  const body = emailWrapper(
    'linear-gradient(135deg,#14532d,#16a34a)', '&#9989;', 'Account Approved!', appName,
    greeting(firstName) +
    `<p style="color:#475569;font-size:15px;line-height:1.7;margin:0 0 16px;">
      Great news! Your <strong>${appName}</strong> account has been approved. You can now log in and access all features.
    </p>` +
    btn(appUrl, `Go to ${appName}`, '#16a34a')
  );
  const text = `Account Approved — ${appName}\n\nHi ${firstName},\n\nYour account has been approved! Log in at: ${appUrl}`;
  try {
    const result = await _send({ to: toEmail, subject: `[${appName}] Your account has been approved ✅`, html: body, text });
    if (result.driver !== 'console') console.log(`  ✅ Account approved email sent [${result.driver}] → ${toEmail}`);
    return result;
  } catch (err) {
    console.error(`❌ [emailService] sendAccountApprovedEmail → ${toEmail} | driver=${DRIVER} | ${err.message}`);
    return { success: false };
  }
}

// Minimal HTML escaping for admin-typed text that is placed inside an e-mail (reason, checklist notes).
function _escMail(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Sent when an admin returns an application. `flags` = [{ label, note }] (decorated by utils/applicationRevision.js):
 * the items the applicant has to correct. The applicant logs in as usual and their saved answers are waiting.
 */
async function sendAccountRejectedEmail(toEmail, firstName, reason = '', flags = []) {
  const appName = APP_NAME();
  const appUrl  = APP_URL();
  const items   = (Array.isArray(flags) ? flags : []).filter(f => f && f.label);
  const reasonBlock = reason
    ? `<div style="background:#fef2f2;border-left:4px solid #ef4444;border-radius:8px;padding:12px 16px;margin:16px 0;">
         <p style="color:#991b1b;font-size:13px;margin:0;white-space:pre-wrap;"><strong>Admin comment:</strong> ${_escMail(reason)}</p>
       </div>`
    : '';
  const listBlock = items.length
    ? `<div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:12px 16px;margin:16px 0;">
         <p style="color:#92400e;font-size:13px;font-weight:700;margin:0 0 8px;">Please correct or replace:</p>
         <ul style="color:#78350f;font-size:13px;line-height:1.6;margin:0;padding-left:18px;">
           ${items.map(f => `<li><strong>${_escMail(f.label)}</strong>${f.note ? ` &mdash; ${_escMail(f.note)}` : ''}</li>`).join('')}
         </ul>
       </div>`
    : '';
  const body = emailWrapper(
    'linear-gradient(135deg,#7f1d1d,#dc2626)', '&#9888;&#65039;', 'Action needed on your application', appName,
    greeting(firstName) +
    `<p style="color:#475569;font-size:15px;line-height:1.7;margin:0 0 8px;">
      Your <strong>${appName}</strong> dormitory application was <strong>not approved yet</strong>. It was returned to you so you can fix it.
    </p>` +
    reasonBlock + listBlock +
    `<p style="color:#475569;font-size:14px;line-height:1.7;margin:8px 0 16px;">
      <strong>Nothing you entered was lost.</strong> Log in with your email and password (or Google) &mdash; your saved answers and documents will be waiting.
      Correct only the items above, then submit again.
    </p>` +
    btn(appUrl, 'Fix my application', '#dc2626')
  );
  const text = `Action needed on your application — ${appName}\n\nHi ${firstName},\n\nYour dormitory application was not approved yet and has been returned to you so you can fix it.` +
    (reason ? `\n\nAdmin comment: ${reason}` : '') +
    (items.length ? `\n\nPlease correct or replace:\n${items.map(f => `- ${f.label}${f.note ? ' — ' + f.note : ''}`).join('\n')}` : '') +
    `\n\nNothing you entered was lost. Log in at ${appUrl} with your email and password (or Google) — your saved answers and documents are waiting. Correct the items above, then submit again.`;
  try {
    const result = await _send({ to: toEmail, subject: `[${appName}] Action needed on your application`, html: body, text });
    if (result.driver !== 'console') console.log(`  ↩️ Application returned email sent [${result.driver}] → ${toEmail}`);
    return result;
  } catch (err) {
    console.error(`❌ [emailService] sendAccountRejectedEmail → ${toEmail} | driver=${DRIVER} | ${err.message}`);
    return { success: false };
  }
}

async function sendContactEmail(toEmail, senderName, senderEmail, subject, message) {
  const appName = APP_NAME();
  const body = emailWrapper(
    'linear-gradient(135deg,#1e3a8a,#2563eb)', '&#128233;', 'New Contact Form Message', appName,
    `<table style="width:100%;margin-bottom:20px;">
      <tr>
        <td style="color:#64748b;font-size:13px;padding:4px 0;width:80px;"><strong>From:</strong></td>
        <td style="color:#1e293b;font-size:14px;">${senderName} &lt;${senderEmail}&gt;</td>
      </tr>
      <tr>
        <td style="color:#64748b;font-size:13px;padding:4px 0;"><strong>Subject:</strong></td>
        <td style="color:#1e293b;font-size:14px;">${subject}</td>
      </tr>
    </table>
    <div style="background:#f8fafc;border-radius:10px;padding:20px;border:1px solid #e2e8f0;">
      <p style="color:#334155;font-size:14px;line-height:1.8;margin:0;white-space:pre-wrap;">${message}</p>
    </div>`
  );
  const text = `New contact form message\n\nFrom: ${senderName} <${senderEmail}>\nSubject: ${subject}\n\n${message}`;
  try {
    const result = await _send({ to: toEmail, subject: `[${appName} Contact] ${subject}`, html: body, text });
    if (result.driver !== 'console') console.log(`  📩 Contact email sent [${result.driver}] → ${toEmail}`);
    return result;
  } catch (err) {
    console.error(`❌ [emailService] sendContactEmail → ${toEmail} | driver=${DRIVER} | ${err.message}`);
    return { success: false };
  }
}

async function sendDormReminderEmail(toEmail, firstName, month, amount) {
  const appName    = APP_NAME();
  const appUrl     = APP_URL();
  const monthLabel = (() => {
    try {
      const [y, m] = month.split('-');
      return new Date(Number(y), Number(m) - 1).toLocaleString('en-PH', { month: 'long', year: 'numeric' });
    } catch { return month; }
  })();
  const body = emailWrapper(
    'linear-gradient(135deg,#1e3a8a,#2563eb)', '&#127968;', 'Dormitory Payment Reminder', appName,
    greeting(firstName) +
    `<p style="color:#475569;font-size:15px;line-height:1.7;margin:0 0 8px;">
      This is a friendly reminder that your dormitory fee for <strong>${monthLabel}</strong> is due.
    </p>
    <div style="text-align:center;margin:24px 0;">
      <div style="display:inline-block;background:#eff6ff;border:2px solid #bfdbfe;border-radius:12px;padding:16px 32px;">
        <div style="font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.05em;">Amount Due</div>
        <div style="font-size:32px;font-weight:800;color:#1e3a8a;">&#8369;${Number(amount).toLocaleString()}</div>
      </div>
    </div>
    <p style="color:#475569;font-size:14px;line-height:1.7;margin:0;">
      Please coordinate with the dormitory administrator to settle your payment. Thank you!
    </p>`
  );
  const text = `Dormitory Payment Reminder — ${appName}\n\nHi ${firstName},\n\nYour fee for ${monthLabel} is due.\nAmount Due: ₱${Number(amount).toLocaleString()}\n\nPlease contact the dormitory administrator.`;
  try {
    const result = await _send({ to: toEmail, subject: `[${appName}] Dormitory Payment Reminder — ${monthLabel}`, html: body, text });
    if (result.driver !== 'console') console.log(`  🏠 Dorm reminder sent [${result.driver}] → ${toEmail}`);
    return result;
  } catch (err) {
    console.error(`❌ [emailService] sendDormReminderEmail → ${toEmail} | driver=${DRIVER} | ${err.message}`);
    return { success: false };
  }
}

async function sendBedAssignedEmail(toEmail, firstName, roomNumber, bedNumber) {
  const appName = APP_NAME();
  const appUrl  = APP_URL();
  const body = emailWrapper(
    'linear-gradient(135deg,#14532d,#16a34a)', '&#127968;', 'Bed Assignment', appName,
    greeting(firstName) +
    `<p style="color:#475569;font-size:15px;margin:0 0 16px;">You have been assigned a bed in the PGA dormitory:</p>
    <table style="margin:0 0 20px;width:100%;border-collapse:collapse;">
      <tr>
        <td style="padding:12px 16px;background:#f0fdf4;border-bottom:1px solid #dcfce7;border-radius:8px 8px 0 0;">
          <div style="font-size:12px;font-weight:700;color:#16a34a;text-transform:uppercase;letter-spacing:.05em;">Room Number</div>
          <div style="font-size:28px;font-weight:800;color:#14532d;">Room ${roomNumber}</div>
        </td>
      </tr>
      <tr>
        <td style="padding:12px 16px;background:#f0fdf4;border-radius:0 0 8px 8px;">
          <div style="font-size:12px;font-weight:700;color:#16a34a;text-transform:uppercase;letter-spacing:.05em;">Bed Number</div>
          <div style="font-size:28px;font-weight:800;color:#14532d;">Bed ${bedNumber}</div>
        </td>
      </tr>
    </table>
    <p style="color:#475569;font-size:14px;margin:0 0 16px;">Please coordinate with the dormitory administrator for move-in procedures. Welcome! &#127881;</p>` +
    btn(`${appUrl}/feed.html`, 'View My Profile', '#16a34a')
  );
  const text = `Bed Assignment — ${appName}\n\nHi ${firstName},\n\nYou have been assigned:\nRoom: ${roomNumber}\nBed:  ${bedNumber}\n\nContact the dormitory administrator for move-in procedures.`;
  try {
    const result = await _send({ to: toEmail, subject: `[${appName}] Bed Assignment — Room ${roomNumber}, Bed ${bedNumber}`, html: body, text });
    if (result.driver !== 'console') console.log(`  🏠 Bed assigned email sent [${result.driver}] → ${toEmail}`);
    return result;
  } catch (err) {
    console.error(`❌ [emailService] sendBedAssignedEmail → ${toEmail} | driver=${DRIVER} | ${err.message}`);
    return { success: false };
  }
}

async function sendBedUnassignedEmail(toEmail, firstName, roomNumber, bedNumber) {
  const appName = APP_NAME();
  const appUrl  = APP_URL();
  const body = emailWrapper(
    'linear-gradient(135deg,#7c2d12,#ea580c)', '&#127968;', 'Bed Unassignment Notice', appName,
    greeting(firstName) +
    `<p style="color:#475569;font-size:15px;line-height:1.7;margin:0 0 16px;">
      Your bed assignment for <strong>Room ${roomNumber}, Bed ${bedNumber}</strong> has been removed by the dormitory administrator.
    </p>
    <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 16px;">
      If you believe this is an error or would like to request reassignment, please contact the dormitory office.
    </p>` +
    btn(`${appUrl}/feed.html`, 'Contact Admin', '#ea580c')
  );
  const text = `Bed Unassignment Notice — ${appName}\n\nHi ${firstName},\n\nYour bed assignment for Room ${roomNumber}, Bed ${bedNumber} has been removed.\n\nContact the dormitory office if you believe this is an error.`;
  try {
    const result = await _send({ to: toEmail, subject: `[${appName}] Bed Unassignment Notice — Room ${roomNumber}, Bed ${bedNumber}`, html: body, text });
    if (result.driver !== 'console') console.log(`  🏠 Bed unassigned email sent [${result.driver}] → ${toEmail}`);
    return result;
  } catch (err) {
    console.error(`❌ [emailService] sendBedUnassignedEmail → ${toEmail} | driver=${DRIVER} | ${err.message}`);
    return { success: false };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  generateOTP,
  sendOTPEmail,
  sendPasswordResetEmail,
  sendWelcomeEmail,
  sendAccountPendingEmail,
  sendAccountApprovedEmail,
  sendAccountRejectedEmail,
  sendContactEmail,
  sendDormReminderEmail,
  sendBedAssignedEmail,
  sendBedUnassignedEmail,
  /** Returns the primary driver name ('gmailapi' | 'sendgrid' | 'smtp' | 'console') — used by server.js startup log */
  getDriver: () => (DRIVER.startsWith('sendgrid') ? 'sendgrid' : DRIVER),
  /** Per-driver health snapshot (no secrets) — safe to expose on an admin route */
  getHealth,
  /** SendGrid Event Webhook plumbing (routes/sendgridWebhook.js) */
  recordSendGridEvents,
  getWebhookKeys,
  /** Recent-send summary for one address — used in the verify-otp failure log */
  getRecipientMailInfo,
};
