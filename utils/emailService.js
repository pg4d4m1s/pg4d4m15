/**
 * utils/emailService.js
 *
 * WATERFALL DRIVER SYSTEM — drivers are tried in priority order until one
 * accepts the message. Chain (only configured drivers are included):
 *
 *   SENDGRID #1 → #2 → #3 → #4 → #5 → SMTP (Gmail) → CONSOLE
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
 * Env values are trimmed and stripped of accidental wrapping quotes, because
 * pasting KEY="abc" into the Railway variables UI keeps the quotes.
 */

'use strict';

const nodemailer = require('nodemailer');

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
// Driver chain: SENDGRID #1..#5 → SMTP → CONSOLE
// ─────────────────────────────────────────────────────────────────────────────
const DRIVER_CHAIN = (() => {
  const chain = SENDGRID_ACCOUNTS.map(a => a.driver);
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
  if (m.includes(' 401:') || m.includes(' 403:')) return true;
  return [
    'unauthorized', 'forbidden', 'invalid api key', 'api key is invalid', 'key not found',
    'sender not verified', 'verified sender', 'domain is not verified', 'domain not verified',
    'account suspended', 'account has been', 'temporarily blocked', 'unrecognized ip',
    'unrecognised ip', 'not authorized', 'not authorised', 'authentication failed',
    'invalid login', 'maximum credits exceeded',
  ].some(s => m.includes(s));
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
                     : d === 'console' ? 'Console (fallback)'
                     : `SendGrid #${SENDGRID_ACCOUNTS.find(a => a.driver === d)?.slot}`;

  SENDGRID_WARNINGS.forEach(w => console.warn(`⚠️  [emailService] ${w}`));

  if (DRIVER_CHAIN[0] === 'console') {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    if (IS_PRODUCTION) {
      console.log('║  ❌  Email driver : NONE CONFIGURED (production)            ║');
      console.log('║  Verification emails will FAIL until you set               ║');
      console.log('║  SENDGRID_API_KEY + SENDGRID_FROM in Railway variables.    ║');
    } else {
      console.log('║  📧  Email driver : CONSOLE (development mode)             ║');
      console.log('║  Emails are NOT delivered. OTPs will appear here.          ║');
      console.log('║  → Set SENDGRID_API_KEY + SENDGRID_FROM, or USE_REAL_EMAIL ║');
    }
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    return;
  }

  console.log(`✅ Email driver : ${label(DRIVER_CHAIN[0])}`);
  console.log(`   Chain        : ${DRIVER_CHAIN.map(label).join(' → ')}`);
  SENDGRID_ACCOUNTS.forEach(a => console.log(`   SendGrid #${a.slot}  : from=${a.from}`));
  console.log(`   Console OTP  : ${CONSOLE_COUNTS_AS_SENT ? 'counts as sent (dev / ALLOW_CONSOLE_OTP)' : 'treated as FAILURE (production)'}`);

  if (DRIVER_CHAIN.includes('smtp')) await initSMTP();
})().catch(console.error);

// ─────────────────────────────────────────────────────────────────────────────
// Per-driver send implementations
// ─────────────────────────────────────────────────────────────────────────────
/** One SendGrid account. Throws "SendGrid #N <status>: <detail>" on failure. */
async function _sendSendGrid(account, { to, subject, html, text }) {
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
  ...Object.fromEntries(SENDGRID_ACCOUNTS.map(a => [a.driver, (msg) => _sendSendGrid(a, msg)])),
};

// ─────────────────────────────────────────────────────────────────────────────
// Core send — waterfall across the driver chain
// Returns { success, driver, messageId?, delivered, error? }
//   delivered=true only when a real provider accepted the message.
// ─────────────────────────────────────────────────────────────────────────────
async function _send({ to, subject, html, text }) {
  const attempts = []; // human-readable reason per driver that did not deliver

  for (const driver of DRIVER_CHAIN) {
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

    try {
      const messageId = await _DRIVER_FN[driver]({ to, subject, html, text });
      if (h.status === 'degraded') console.log(`✅ [emailService] ${driver} recovered — back in rotation`);
      h.status = 'ok'; h.since = null; h.lastError = null; h.lastOkAt = Date.now();
      return { success: true, driver, messageId, delivered: true };
    } catch (err) {
      const msg = err.message || String(err);
      h.lastError = msg;
      attempts.push(`${driver}: ${msg}`);

      if (_isPermanentDriverError(driver, msg)) {
        h.status  = 'degraded';
        h.since   = h.since || Date.now();
        h.retryAt = Date.now() + COOLDOWN_MS;
        console.error(`❌ [emailService] ${driver} DEGRADED (retry in ${Math.round(COOLDOWN_MS / 60000)}m): ${msg}`);
      } else {
        console.error(`⚠️  [emailService] ${driver} transient error: ${msg} → trying next driver`);
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

const otpBlock = (otp, bg = '#eff6ff', border = '#bfdbfe', color = '#1d4ed8') =>
  `<div style="text-align:center;margin:0 0 28px;">
    <div style="display:inline-block;background:${bg};border:2px solid ${border};border-radius:16px;padding:20px 40px;">
      <div style="font-size:42px;font-weight:800;color:${color};letter-spacing:14px;font-family:monospace;">${otp}</div>
    </div>
    <p style="color:#94a3b8;font-size:12px;margin:10px 0 0;">&#9200; Expires in <strong>10 minutes</strong></p>
  </div>`;

// ─────────────────────────────────────────────────────────────────────────────
// Public send functions
// ─────────────────────────────────────────────────────────────────────────────
async function sendOTPEmail(toEmail, otp, firstName = 'there') {
  const appName = APP_NAME();
  const body = emailWrapper(
    'linear-gradient(135deg,#1e3a8a,#2563eb)', '&#128309;', 'Email Verification', appName,
    greeting(firstName) +
    para(`Your <strong>${appName}</strong> verification code is below. Enter it on the registration page to verify your email address.`) +
    otpBlock(otp) +
    warningBox(`<strong>Never share this code.</strong> ${appName} staff will never ask for your OTP.`) +
    `<p style="color:#94a3b8;font-size:13px;margin:0;">If you didn't request this, ignore this email.</p>`
  );
  const text = `${appName} Verification\n\nHi ${firstName},\n\nYour verification code: ${otp}\n\nExpires in 10 minutes. Never share this code.\n\nIf you didn't request this, ignore this email.`;
  try {
    const result = await _send({ to: toEmail, subject: `${otp} — Your ${appName} verification code`, html: body, text });
    if (result.driver !== 'console') {
      const ts = new Date().toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      console.log(`  ✉  OTP sent [${result.driver}] → ${toEmail} | ${ts}${result.messageId ? ` | id=${result.messageId}` : ''}`);
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
    otpBlock(otp, '#f5f3ff', '#c4b5fd', '#4f46e5') +
    `<p style="color:#475569;font-size:13px;margin:0;">If you didn't request a password reset, ignore this email. Your account is safe.</p>`
  );
  const text = `${appName} Password Reset\n\nHi ${firstName},\n\nYour reset code: ${otp}\n\nExpires in 10 minutes.\n\nIf you didn't request this, ignore this email.`;
  try {
    const result = await _send({ to: toEmail, subject: `${otp} — Your ${appName} password reset code`, html: body, text });
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

async function sendAccountRejectedEmail(toEmail, firstName, reason = '') {
  const appName = APP_NAME();
  const appUrl  = APP_URL();
  const reasonBlock = reason
    ? `<div style="background:#fef2f2;border-left:4px solid #ef4444;border-radius:8px;padding:12px 16px;margin:16px 0;">
         <p style="color:#991b1b;font-size:13px;margin:0;"><strong>Reason:</strong> ${reason}</p>
       </div>`
    : '';
  const body = emailWrapper(
    'linear-gradient(135deg,#7f1d1d,#dc2626)', '&#10060;', 'Account Not Approved', appName,
    greeting(firstName) +
    `<p style="color:#475569;font-size:15px;line-height:1.7;margin:0 0 8px;">
      Unfortunately, your <strong>${appName}</strong> account application was not approved at this time.
    </p>` +
    reasonBlock +
    `<p style="color:#475569;font-size:14px;line-height:1.7;margin:8px 0 16px;">
      You may re-apply with the correct documents. If you believe this is an error, please contact the dormitory office.
    </p>` +
    btn(appUrl, 'Contact Admin', '#dc2626')
  );
  const text = `Account Not Approved — ${appName}\n\nHi ${firstName},\n\nYour account application was not approved.${reason ? `\n\nReason: ${reason}` : ''}\n\nContact the dormitory office for assistance.`;
  try {
    const result = await _send({ to: toEmail, subject: `[${appName}] Account application update`, html: body, text });
    if (result.driver !== 'console') console.log(`  ❌ Account rejected email sent [${result.driver}] → ${toEmail}`);
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
  /** Returns the active driver name — used by server.js startup log */
  getDriver: () => (DRIVER.startsWith('sendgrid') ? 'sendgrid' : DRIVER),
  /** Per-driver health snapshot (no secrets) — safe to expose on an admin route */
  getHealth,
};
