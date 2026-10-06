/**
 * server.js — PGA-DAMIS Entry Point
 *
 * Provincial Government of Aurora — Dormitory Application &
 * Management Information System
 *
 * Features:
 *   - Admin account management & approval workflow
 *   - Post moderation queue (pending → approved/rejected)
 *   - AI-assisted content moderation (Gemini pool)
 *   - ID verification workflow with document uploads
 *   - Dormitory bed assignment & billing management
 *   - Maintenance requests & utility bill tracking
 *   - User ban/unban, audit logging, real-time via Socket.IO
 *   - Student Residents Questionnaire (ISO/IEC 25010 research instrument)
 */

require('dotenv').config();

const http      = require('http');
const express   = require('express');
const morgan    = require('morgan');
const session   = require('express-session');
const passport  = require('passport');
const flash     = require('connect-flash');
const helmet    = require('helmet');
const cors      = require('cors');
const path      = require('path');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const log       = require('./utils/logger');
const { seedAdmin } = require('./utils/seedAdmin');
const { seedTestUsers } = require('./utils/seedTestUsers');

// ── Routes ────────────────────────────────────────────
const authRoutes         = require('./routes/auth');
const postsRoutes        = require('./routes/posts');
const usersRoutes        = require('./routes/users');
const notifRoutes        = require('./routes/notifications');
const messagesRoutes     = require('./routes/messages');
const adminRoutes        = require('./routes/admin');
const aiRoutes           = require('./routes/ai');
const researchRoutes     = require('./routes/research');

const app        = express();
const httpServer = http.createServer(app);
const io         = new Server(httpServer);

// Make io available inside routes via req.app.get('io')
app.set('io', io);

// ── Security headers ──────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,
  // CDN resources (Tailwind, Font Awesome, jsDelivr, Google Fonts) are cross-origin.
  // Helmet v7 defaults crossOriginResourcePolicy to 'same-origin', which blocks them.
  // 'cross-origin' restores the pre-Helmet-v7 behaviour for resource loads.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cors());

// ── Rate limiting ─────────────────────────────────────
// express-rate-limit answers 429 BEFORE morgan / the request logger below ever run, so a
// throttled resident used to leave NO trace in the logs. limiterHandler() logs every 429
// (which limiter, which route, real IP vs express IP) and then replies exactly as before.
function limiterHandler(name) {
  return (req, res, _next, options) => {
    const real = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || '?';
    log.warn(
      `🛑 RATE LIMITED [${name}] ${req.method} ${req.originalUrl.split('?')[0]} → 429 | ` +
      `limit ${options.limit ?? options.max}/${Math.round(options.windowMs / 60000)}min | real-ip=${real} express-ip=${req.ip}` +
      (real !== '?' && real !== req.ip
        ? '  ⚠ express-ip ≠ real-ip: IP-keyed limits are SHARED between residents (try TRUST_PROXY_HOPS=2)'
        : '')
    );
    res.status(options.statusCode || 429).json(options.message);
  };
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  message: { error: 'Too many attempts. Please wait 15 minutes and try again.' },
  standardHeaders: true, legacyHeaders: false,
  handler: limiterHandler('auth'),
});
const checkLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, max: 60,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true, legacyHeaders: false,
  handler: limiterHandler('check'),
});
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, max: 120,
  message: { error: 'Too many requests. Slow down!' },
  standardHeaders: true, legacyHeaders: false,
  handler: limiterHandler('api'),
});
// AI support chat rate limiting is handled at the Gemini API level (20 RPD)

// NOTE: the OTP / complete-registration limiters are mounted further down, AFTER the body
// parser and session middleware, because they are keyed per e-mail (see "Registration limiters").
app.use('/api/auth/login',                 authLimiter);
app.use('/api/auth/forgot-password',       authLimiter);
app.use('/api/auth/verify-reset-otp',      authLimiter);
app.use('/api/auth/reset-password',        authLimiter);
app.use('/api/auth/check-username',        checkLimiter);
app.use('/api/auth/check-phone',           checkLimiter);
app.use('/api/',                           apiLimiter);

// ── Request logging (morgan) ──────────────────────────
// Skip high-frequency polling endpoints that flood the terminal.
// The custom request-logger below handles errors/mutations on these routes anyway.
const MORGAN_SKIP_RE = /^\/api\/admin\/(maintenance\/stats|users\/[^/]+\/reputation)$/;
const morganSkip = (req) =>
  req.method === 'GET' && MORGAN_SKIP_RE.test(req.path);

if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev', { skip: morganSkip }));
} else {
  app.use(morgan('combined', { skip: morganSkip }));
}

// ── Body parsers ──────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Trust Railway's reverse proxy ────────────────────
// Number of proxy hops in front of the app. Leave at 1 unless the "RATE LIMITED" / "incoming" log
// lines show express-ip ≠ real-ip (then req.ip is Railway's edge, shared by every resident) —
// in that case set TRUST_PROXY_HOPS=2 in Railway and redeploy. Default keeps today's behaviour.
const TRUST_PROXY_HOPS = parseInt(process.env.TRUST_PROXY_HOPS || '1', 10) || 1;
app.set('trust proxy', TRUST_PROXY_HOPS);

// ── Sessions ──────────────────────────────────────────
// better-sqlite3-session-store already lives in package.json and shares the
// same DB file as the rest of the app.  The 'sessions' table is created
// automatically on first boot.  TTL matches cookie maxAge; expired rows are
// pruned on the interval below so the table doesn't grow unboundedly.
const SqliteStore       = require('better-sqlite3-session-store')(session);
const { db: sessionDb } = require('./utils/db');

app.use(session({
  store: new SqliteStore({
    client: sessionDb,
    expired: {
      clear:      true,
      intervalMs: 15 * 60 * 1000, // prune expired rows every 15 min
    },
  }),
  secret: process.env.SESSION_SECRET || 'fallback-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure:   process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge:   24 * 60 * 60 * 1000,
  }
}));

// ── Registration limiters (keyed per E-MAIL, not per IP) ──────────────
// Behind Railway, req.ip can be the proxy's address — shared by every resident — so 5 OTP
// requests / 20 attempts per "IP" per 15 min could throttle unrelated residents at once.
// Per-email keys give each resident their own budget; a generous per-IP ceiling remains as an
// abuse backstop. Every 429 is logged by limiterHandler() above.
const emailKey = (req) => {
  const e = String((req.body && req.body.email) || (req.session && req.session.pendingRegistration && req.session.pendingRegistration.email) || '')
    .trim().toLowerCase();
  return e ? `email:${e}` : `ip:${req.ip}`;
};
const otpEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5, keyGenerator: emailKey,
  message: { error: 'Too many verification codes requested for this email. Please wait 15 minutes and try again.', code: 'RATE_LIMITED' },
  standardHeaders: true, legacyHeaders: false, handler: limiterHandler('otp-per-email'),
});
const otpIpCeiling = rateLimit({
  windowMs: 15 * 60 * 1000, max: 60,
  message: { error: 'Too many verification code requests from this network. Please wait a few minutes and try again.', code: 'RATE_LIMITED' },
  standardHeaders: true, legacyHeaders: false, handler: limiterHandler('otp-ip-ceiling'),
});
const verifyEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, keyGenerator: emailKey,
  message: { error: 'Too many attempts for this email. Please wait 15 minutes and try again.', code: 'RATE_LIMITED' },
  standardHeaders: true, legacyHeaders: false, handler: limiterHandler('verify-per-email'),
});
const regEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30, keyGenerator: emailKey,
  message: { error: 'Too many submit attempts. Please wait a few minutes and try again.', code: 'RATE_LIMITED' },
  standardHeaders: true, legacyHeaders: false, handler: limiterHandler('register-per-email'),
});
const regIpCeiling = rateLimit({
  windowMs: 15 * 60 * 1000, max: 300,
  message: { error: 'Too many requests from this network. Please wait a few minutes and try again.', code: 'RATE_LIMITED' },
  standardHeaders: true, legacyHeaders: false, handler: limiterHandler('register-ip-ceiling'),
});
const clientReportLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30, keyGenerator: (req) => `sid:${req.sessionID || req.ip}`,
  standardHeaders: true, legacyHeaders: false,
  handler: (_req, res) => res.status(204).end(),   // diagnostics must never surface errors to residents
});
app.use('/api/auth/send-otp',              otpIpCeiling, otpEmailLimiter);
app.use('/api/auth/resend-otp',            otpIpCeiling, otpEmailLimiter);
app.use('/api/auth/verify-otp',            regIpCeiling, verifyEmailLimiter);
app.use('/api/auth/complete-registration', regIpCeiling, regEmailLimiter);
app.use('/api/auth/client-report',         clientReportLimiter);

// ── Passport ──────────────────────────────────────────
require('./utils/passport-setup');
app.use(passport.initialize());
app.use(passport.session());

// ── Flash ─────────────────────────────────────────────
app.use(flash());
app.use((req, res, next) => {
  res.locals.user    = req.user || null;
  res.locals.success = req.flash('success');
  res.locals.error   = req.flash('error');
  next();
});

// ── Admin HTML guard (BEFORE static so the file is never served raw) ──
// Session + passport run first above, so req.user is fully populated here.
app.get('/admin.html', (req, res) => {
  // Admin access guard — requires authenticated admin/superadmin role
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.redirect('/?unauthorized=admin');
  }
  if (req.user?.role !== 'admin' && req.user?.role !== 'superadmin') {
    return res.status(403).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>403 – Forbidden</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{display:flex;align-items:center;justify-content:center;min-height:100vh;
       background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
  .card{text-align:center;padding:48px 40px;background:#fff;border-radius:24px;
        box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:400px;width:90%}
  .icon{font-size:56px;margin-bottom:16px}
  h1{font-size:20px;font-weight:700;color:#0f172a;margin-bottom:8px}
  p{color:#64748b;font-size:14px;margin-bottom:24px;line-height:1.6}
  a{display:inline-block;padding:10px 24px;background:#0070e0;color:#fff;
    border-radius:12px;text-decoration:none;font-size:14px;font-weight:600}
  a:hover{background:#0058b0}
  .code{font-size:11px;color:#94a3b8;margin-top:20px}
</style></head>
<body><div class="card">
  <div class="icon">🚫</div>
  <h1>Access Denied</h1>
  <p>Your account does not have admin privileges.<br>This attempt has been logged.</p>
  <a href="/feed.html">← Back to PGA-DAMIS</a>
  <p class="code">HTTP 403 Forbidden</p>
</div></body></html>`);
  }
  // Admin confirmed — serve the file
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── Static files (after guard so admin.html route wins) ───────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Request logger ────────────────────────────────────────────────
const _reqLog = require('./utils/logger');
const { uploadSummary, isUploadError, handleUploadError } = require('./middleware/uploadDiagnostics');

// Attach a short 6-char hex request ID to every request for cross-line correlation.
// e.g. ERROR and its matching request line share the same [a1b2c3] tag.
app.use((req, _res, next) => {
  req._id = require('crypto').randomBytes(3).toString('hex');
  next();
});

// Capture the {error, code} of every 4xx/5xx JSON reply so the request logger can print WHY a
// request failed (before this only 500s showed a reason; a 400 just said "BAD REQUEST").
app.use((req, res, next) => {
  const _json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 400 && body && typeof body === 'object') {
      res._errMsg  = body.error || body.message;
      res._errCode = body.code;
    }
    return _json(body);
  };
  next();
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms    = Date.now() - start;
    const s     = res.statusCode;
    const user  = req.user ? `@${req.user.username}` : 'anon';
    const rawIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '?';
    const ip    = rawIp.split(',')[0].trim().replace(/^::ffff:/, '').replace('::1', 'localhost');
    const isApi = req.path.startsWith('/api/');
    const isDorm = req.path.startsWith('/api/admin/dormitory');
    const isFileRoute = /upload|avatar|document|complete.registration/i.test(req.path);

    // Short request ID for correlation with domain-log lines emitted by route handlers
    const rid = `\x1b[2m[${req._id}]\x1b[0m`;

    // Colour-code status
    const statusStr = s >= 500 ? `\x1b[1m\x1b[31m${s}\x1b[0m`
                    : s >= 400 ? `\x1b[33m${s}\x1b[0m`
                    : s >= 300 ? `\x1b[36m${s}\x1b[0m`
                    :            `\x1b[32m${s}\x1b[0m`;

    // Timing colour (raised thresholds for file-upload routes)
    const slowLimit = isFileRoute ? 15000 : 2000;
    const warnLimit = isFileRoute ?  6000 :  500;
    const msStr = ms > slowLimit ? `\x1b[1m\x1b[31m${ms}ms\x1b[0m`
                : ms > warnLimit ? `\x1b[33m${ms}ms\x1b[0m`
                :                  `${ms}ms`;

    // Include query string for GET requests (helps debug wrong filter values)
    const qs = req.method === 'GET' && req.query && Object.keys(req.query).length
      ? `\x1b[2m?${new URLSearchParams(req.query).toString().slice(0, 80)}\x1b[0m`
      : '';

    // Inline body snippet for mutations in dev (passwords etc. scrubbed)
    let bodyHint = '';
    if (process.env.NODE_ENV !== 'production' && req.body && req.method !== 'GET') {
      const SENSITIVE = /password|passwd|secret|token|otp|code|key|auth|credential/i;
      const scrubbed  = Object.fromEntries(
        Object.entries(req.body).map(([k, v]) => [k, SENSITIVE.test(k) ? '[redacted]' : v])
      );
      const snippet = JSON.stringify(scrubbed).slice(0, 160);
      bodyHint = `\n   \x1b[2m↳ body: ${snippet}${snippet.length >= 160 ? '…' : ''}\x1b[0m`;
    }

    // For 500s, show the error message that the route handler stashed on res._errMsg
    const errHint = s >= 400 && res._errMsg
      ? `\n   ${s >= 500 ? '\x1b[31m' : '\x1b[33m'}↳ ${s >= 500 ? 'error' : 'reason'}: ${res._errMsg}${res._errCode ? ` [${res._errCode}]` : ''}\x1b[0m`
      : '';

    const base = `${rid} ${req.method.padEnd(6)} ${req.path}${qs} → ${statusStr} ${msStr} [${user}]  ip=${ip}`;

    if (s >= 500) {
      _reqLog.error(`${base} 🔴 SERVER ERROR${errHint}${bodyHint}`);
    } else if (s === 409 && isApi) {
      _reqLog.warn(`${base} ⚡ CONFLICT${errHint}`);
    } else if (s === 404 && isApi) {
      _reqLog.warn(`${base} ⚠ NOT FOUND${errHint}`);
    } else if (s === 403 && isApi) {
      _reqLog.warn(`${base} 🚫 FORBIDDEN${errHint}`);
    } else if (s === 401 && isApi) {
      _reqLog.warn(`${base} 🔒 UNAUTHORIZED${errHint}`);
    } else if (s === 400 && isApi) {
      _reqLog.warn(`${base} ✗ BAD REQUEST${errHint}${bodyHint}`);
    } else if (s === 429 && isApi) {
      _reqLog.warn(`${base} 🛑 RATE LIMITED${errHint}`);
    } else if (s >= 400 && isApi) {
      _reqLog.warn(`${base} ⚠ CLIENT ERROR${errHint}`);
    } else if (!isFileRoute && ms > slowLimit && isApi) {
      _reqLog.warn(`${base} 🐌 VERY SLOW (>${ms}ms)`);
    } else if (!isFileRoute && ms > warnLimit && isApi) {
      _reqLog.warn(`${base} ⏱ SLOW (>${ms}ms)`);
    } else if (isFileRoute && ms > slowLimit) {
      _reqLog.warn(`${base} 🐌 VERY SLOW — file upload${uploadSummary(req)}${bodyHint}`);
    } else if (isFileRoute && ms > warnLimit && req.method !== 'GET') {
      _reqLog.warn(`${base} ⏱ SLOW — file upload${uploadSummary(req)}`);
    } else if (isDorm && s < 400) {
      // Always log dormitory API calls (GET + mutations) — helps debug room/billing issues
      _reqLog.dorm(`${base}${bodyHint}`);
    } else if (isApi && req.method !== 'GET' && req.method !== 'OPTIONS' && s < 300) {
      _reqLog.info(`${base}${bodyHint}`);
    }
    // Suppress: 2xx/3xx GETs for non-admin APIs and static assets
  });
  next();
});

// ── Routes ────────────────────────────────────────────
app.use('/', authRoutes);
app.use('/', postsRoutes);
app.use('/', usersRoutes);
app.use('/', notifRoutes);
app.use('/', messagesRoutes);
app.use('/', adminRoutes);
app.use('/', aiRoutes);
app.use('/', researchRoutes);

// ── Socket.io ─────────────────────────────────────────
const onlineUsers = new Map(); // userId → socketId

io.on('connection', (socket) => {
  // Client joins their own room + broadcasts online
  socket.on('join', (userId) => {
    if (!userId) return;
    socket.join(`user:${userId}`);
    socket.userId = userId;
    onlineUsers.set(userId, socket.id);
    log.socket(`User connected: ${userId} (online: ${onlineUsers.size})`);
    socket.broadcast.emit('user-online', { userId });
  });

  // Admins join a special room to receive real-time registration/moderation alerts
  socket.on('join-admin', (userId) => {
    if (!userId) return;
    socket.join('admins');
    log.socket(`Admin joined monitoring room: ${userId}`);
  });

  // Join a specific DM room (both participants)
  socket.on('join-dm', ({ myId, theirId }) => {
    if (myId && theirId) {
      const room = [myId, theirId].sort().join(':');
      socket.join(`dm:${room}`);
    }
  });

  // Send a DM via socket (complementary to REST POST)
  socket.on('send-dm', ({ toUserId, fromUserId, content }) => {
    if (!toUserId || !fromUserId || !content) return;
    io.to(`user:${toUserId}`).emit('receive-dm', {
      fromUserId,
      content,
      createdAt: new Date().toISOString(),
    });
  });

  // Typing indicators
  socket.on('typing-start', ({ toUserId, fromUserId }) => {
    io.to(`user:${toUserId}`).emit('user-typing', {
      fromUserId,
    });
  });

  socket.on('typing-stop', ({ toUserId, fromUserId }) => {
    io.to(`user:${toUserId}`).emit('user-stopped-typing', { fromUserId });
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      onlineUsers.delete(socket.userId);
      socket.broadcast.emit('user-offline', { userId: socket.userId });
    }
  });
});

// ── Fallback: serve index.html for client-side routes only ────
app.get('*', (req, res) => {
  // Don't intercept static .html files or API routes — those 404 naturally
  if (req.path.startsWith('/api/') || req.path.includes('.')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Global error handler ──────────────────────────────
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  // multer / file-type / aborted-upload errors → specific message + log line (see middleware/uploadDiagnostics.js).
  // (Previously every LIMIT_FILE_SIZE said "Maximum size is 5 MB" although the real limit is 15 MB.)
  if (isUploadError(err)) return handleUploadError(err, req, res);
  log.error(`Unhandled error [${req._id}] ${req.method} ${req.originalUrl.split('?')[0]}: ${err.message}`);
  console.error(err.stack || err);
  res.status(500).json({ error: 'Server error. Please try again.', code: 'SERVER_ERROR', ref: req._id });
});

// ── Start ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, async () => {
  const env = process.env.NODE_ENV || 'development';
  console.log('\x1b[36m\x1b[1m');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║    PGA-DAMIS  —  Dormitory Application & Management  🏛️  ║');
  console.log('║         Provincial Government of Aurora                  ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('\x1b[0m');
  log.success(`Server listening on http://localhost:${PORT}`);
  log.success(`Admin panel    →  http://localhost:${PORT}/admin.html`);
  log.success(`Resident portal→  http://localhost:${PORT}/`);
  log.info(`Environment  : ${env} | Node ${process.version}`);
  log.info(`Sessions     : ✔ SQLite store (${(process.env.DATA_DIR || '(project root)')}/connecthub.db → sessions table)`);
  log.info(`Proxy hops   : ${TRUST_PROXY_HOPS} (TRUST_PROXY_HOPS) — rate limits are per-email for OTP/registration`);
  log.info(`Cloudinary   : ${process.env.CLOUDINARY_CLOUD_NAME ? '✔ configured' : '✖ NOT configured (base64 fallback)'}`);
  log.info(`Google OAuth : ${process.env.GOOGLE_CLIENT_ID      ? '✔ configured' : '✖ NOT configured'}`);
  const geminiPool   = require('./utils/geminiPool');
  const poolStatus   = geminiPool.getStatus();
  const hasGithub = !!process.env.GITHUB_TOKEN;
  const aiStatus = poolStatus.keyCount > 0
    ? `✔ Gemini (free) · ${poolStatus.keyCount} key${poolStatus.keyCount>1?'s':''} · ${poolStatus.keyCount*poolStatus.rpdLimit} req/day total${hasGithub ? ' · DeepSeek fallback ✔' : ''}`
    : hasGithub ? '✔ DeepSeek-V3 (GitHub Models)' : '✖ NOT configured';
  log.info(`AI Moderation: ${aiStatus}`);
  const { getDriver } = require('./utils/emailService');
  const emailDriverLabel = {
    sendgrid: `✔ SendGrid API (${process.env.SENDGRID_FROM || process.env.EMAIL_USER || '?'})`,
    smtp:     `✔ Gmail SMTP (${process.env.EMAIL_USER || '?'})`,
    console:  '⚠ Console/dev — no real delivery (set SENDGRID_API_KEY + SENDGRID_FROM for production)',
  }[getDriver()] || '?';
  log.info(`Email        : ${emailDriverLabel}`);
  log.divider();

  // Auto-create admin account from .env if not already present
  await seedAdmin();
  await seedTestUsers();

  // ── Security status announcement ────────────────────────────────────
  log.divider();
  if (env === 'production') {
    log.success('Security     : ✔ Production mode — all access guards active');
  } else {
    log.success('Security     : ✔ Guards active — /admin.html and /api/admin/* require admin role');
    log.info('Testing tip  : Use two different browsers (e.g. Brave + Firefox) to test admin + resident simultaneously');
  }
  log.divider();
});


// ── Auto-remind billing scheduler ────────────────────────────────────────
// Runs every 6 hours; sends reminders in the last 5 days of month if bills unpaid.
(function startBillingRemindScheduler() {
  const { db: dbRaw, getSetting, setSetting, createNotification } = require('./utils/db');
  const { sendDormReminderEmail } = require('./utils/emailService');

  // Guard: if a run is already in progress (e.g. slow email sends),
  // skip the next interval tick rather than stacking executions.
  let _isRunning = false;

  async function runAutoRemind() {
    if (_isRunning) {
      log.warn('[AutoRemind] Previous run still in progress — skipping this tick.');
      return;
    }
    _isRunning = true;
    try {
      const enabled = getSetting('auto_billing_remind', '1');
      if (enabled === '0') { return; }
      const now = new Date();
      const day = now.getDate();
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const daysLeft = daysInMonth - day;
      if (daysLeft > 5) { return; } // Only trigger last 5 days of month
      const month = now.toISOString().slice(0, 7);
      const lastRan = getSetting('auto_remind_last_month', '');
      if (lastRan === month) { return; } // Already ran this month
      const unpaidBills = dbRaw.prepare(
        "SELECT b.*, u.first_name, u.last_name, u.email, u.username, u.id as user_id " +
        "FROM dorm_billing b JOIN users u ON u.id=b.user_id " +
        "WHERE b.month=? AND b.status='unpaid'"
      ).all(month);
      if (!unpaidBills.length) {
        setSetting('auto_remind_last_month', month);
        return;
      }
      let sent = 0;
      for (const bill of unpaidBills) {
        try {
          createNotification({
            userId: bill.user_id, type: 'billing_reminder',
            actorId: null, targetId: null,
            message: `Auto-reminder: Your dorm bill of \u20b1${bill.amount} for ${bill.month} is due soon. Please settle before month-end.`,
          });
          io.to(`user:${bill.user_id}`).emit('new-notification', { userId: bill.user_id });
          await sendDormReminderEmail(bill.email, bill.first_name, bill.month, bill.amount);
          sent++;
        } catch (e) {
          log.warn(`[AutoRemind] Failed for @${bill.username || bill.email}: ${e.message}`);
        }
      }
      setSetting('auto_remind_last_month', month);
      log.billing(`🤖 Auto-remind ran for ${month} — ${sent} student${sent !== 1 ? 's' : ''} notified (${daysLeft} day${daysLeft !== 1 ? 's' : ''} left in month)`);
    } catch (e) {
      log.warn(`[AutoRemind] Scheduler error: ${e.message}`);
    } finally {
      _isRunning = false;
    }
  }

  setInterval(runAutoRemind, 6 * 60 * 60 * 1000);
  setTimeout(runAutoRemind, 30_000);
  log.info('Billing auto-remind scheduler started (checks every 6h, triggers last 5 days of month)');
})();

// ── Graceful shutdown ─────────────────────────────────
function shutdown(signal) {
  log.warn(`${signal} received — shutting down gracefully…`);
  httpServer.close(() => {
    log.success('HTTP server closed cleanly.');
    process.exit(0);
  });
  setTimeout(() => { log.error('Forced exit after timeout.'); process.exit(1); }, 10000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = app;
