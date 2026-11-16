/**
 * routes/auth.js  (updated for SQLite db)
 *
 * Everything is identical to v2 except:
 *   - Import from ../utils/db instead of ../utils/userStore
 *   - createUser() call replaces users.push()
 */

const express  = require('express');
const passport = require('passport');
const bcrypt   = require('bcryptjs');
const router   = express.Router();
const log      = require('../utils/logger');
const geminiPool = require('../utils/geminiPool');
const supportKb  = require('../utils/supportKnowledge');
const rateLimit  = require('express-rate-limit');

const { generateOTP, sendOTPEmail, getRecipientMailInfo, sendWelcomeEmail, sendPasswordResetEmail, sendAccountPendingEmail, sendAccountApprovedEmail, sendAccountRejectedEmail, sendContactEmail } = require('../utils/emailService');
const { rejectDisposableEmail } = require('../utils/disposableEmailCheck');
const { uploadIdDocs } = require('../middleware/upload');
const { checkSelfie } = require('../utils/faceCheck');
// Step-5 document checks: free upload-time checks (utils/documentChecks.js), the AI submit-time gate that refuses a wrong / repeated
// document while the applicant is still on Step 5, and the after-submit AI badge for the admin (both in utils/docClassifier.js)
const { requireDistinctDocuments, persistDocumentFingerprints } = require('../utils/documentChecks');
const { enqueueDocumentAudit, requireMatchingDocuments } = require('../utils/docClassifier');
const { trackUpload, uploadSummary, clientReportHandler, clientIp } = require('../middleware/uploadDiagnostics');
const {
  findUserByEmail, findUserById, findUserByUsername, findUserByPhone,
  createUser, submitIdVerification,
  getPendingAccounts, approveAccount, rejectAccount,
  saveOTP, verifyOTP, issueOTP, isCurrentOTP, saveResetOTP, verifyResetOTP, consumeResetOTP,
  recordFailedLogin, checkLoginLock, clearLoginAttempts,
  getRoomAvailability, resolveRoomPreference,
  findRejectedRegistrationByEmail, getRejectedRegistrationById, deleteRejectedRegistration, setUserApplicationMeta,
} = require('../utils/db');
const { REVISION_ITEMS, parseFlags, decorateFlags, sanitizeSnapshot } = require('../utils/applicationRevision');
const admission = require('../utils/admission');


// ─── Live-selfie gate (runs BEFORE any file is sent to Cloudinary) ───────────────────────────
// Step 4 of the wizard is now live-camera only (no gallery upload) and the browser runs a face scanner +
// liveness challenges. The browser can be bypassed by a hand-made request, so the server (a) requires the
// profile photo and (b) re-checks that it really shows exactly one real face (utils/faceCheck.js; fail-open
// if the AI service is unavailable). `selfieCheck` is the browser scanner's own report — logged for
// debugging only, never trusted.
async function requireLiveSelfie(req, res, next) {
  const ref = req._id;
  const fail = (status, code, error) => {
    log.warn(`[REG-FAIL] ${code} (HTTP ${status}) — ${error} | ref=${ref} email=${(req.session.pendingRegistration || {}).email || '—'} ip=${clientIp(req)}`);
    return res.status(status).json({ error, code, ref, field: 'avatar' });
  };
  try {
    const avatar = req.files && req.files.avatar && req.files.avatar[0];
    // Returned application: the applicant may KEEP the photo that was already accepted. Only a flagged selfie must be retaken.
    if (!avatar && req.revision && !req.revision.flagged.has('selfie')) {
      log.info(`[SELFIE] keeping the saved photo (returned application, selfie not flagged) ref=${ref}`);
      return next();
    }
    if (!avatar)
      return fail(400, 'SELFIE_REQUIRED', 'A live selfie is required. Please go back to the Profile step and take your selfie with the camera.');

    let report = null;
    try { report = JSON.parse(req.body && req.body.selfieCheck); } catch (_) { /* absent or malformed */ }
    log.info(`[SELFIE] browser scanner report: ${report ? `status=${report.status} method=${report.method} challenges=${(report.challenges || []).join('+')} mouthOpenRatio=${Number.isFinite(Number(report.mar)) && report.mar !== null ? Number(report.mar) : 'n/a'}` : 'NONE (older page or bypassed client)'} ref=${ref}`);

    const verdict = await checkSelfie(avatar.buffer, avatar.mimetype, { ref, applicant: (req.session.pendingRegistration || {}).email || '' });
    if (!verdict.ok) return fail(422, verdict.code, verdict.message);
    if (verdict.skipped) log.warn(`[SELFIE-CHECK] not verified server-side for ref=${ref} — review this applicant's photo manually.`);
    next();
  } catch (e) {
    // Never block a real applicant because our own check crashed.
    log.error(`[SELFIE-CHECK] crashed (letting the request through): ${e.message} ref=${ref}`);
    next();
  }
}

// ID types the applicant can pick on Step 5 (anything else falls back to school_id).
const ID_TYPES = new Set(['school_id', 'philid', 'drivers_license', 'passport', 'umid', 'voters_id', 'prc_id', 'postal_id', 'other_gov_id']);

// ─── helpers ────────────────────────────────────────
function validatePassword(p) {
  const e = [];
  if (!p || p.length < 8)        e.push('At least 8 characters');
  if (!/[A-Z]/.test(p))          e.push('One uppercase letter');
  if (!/[a-z]/.test(p))          e.push('One lowercase letter');
  if (!/[0-9]/.test(p))          e.push('One number');
  if (!/[^A-Za-z0-9]/.test(p))  e.push('One special character');
  if (/\s/.test(p))              e.push('No spaces allowed');
  return e;
}
function getAge(dob) {
  const b = new Date(dob), n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--;
  return a;
}

// ════════════════════════════════════════════════════
// POST /api/auth/send-otp
// ════════════════════════════════════════════════════
// NOTE: rejectDisposableEmail middleware disabled for testing — re-enable in production:
// router.post('/api/auth/send-otp', rejectDisposableEmail, async (req, res) => {
router.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { email, password, confirmPassword, isGoogleSignup } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      return res.status(400).json({ error: 'Please enter a valid email address.' });

    // Admissions closed for everyone (switch ON, or every bed taken) → no new sign-ups. An applicant whose application
    // was returned earlier still goes through (the final submit re-checks their sex).
    if (admission.getStatus().allClosed && !findRejectedRegistrationByEmail(email.trim())) {
      return res.status(403).json({ code: 'REGISTRATION_CLOSED', error: 'Applications are currently closed. Please check the announcements on this page for updates.' });
    }

    const existing = findUserByEmail(email.trim());
    if (existing) {
      return res.status(409).json({
        error: existing.authProvider === 'google'
          ? 'This email is already registered via Google Sign-In. Please use the Google button to log in.'
          : 'This email already has an account. Please log in instead.',
      });
    }

    // Google sign-ups that are already verified in this session: do NOT send another OTP.
    // (Happens when a resident refreshes mid-form and taps "Continue with Google" again.)
    // Password sign-ups are excluded on purpose — they may have typed a different password.
    const prior = req.session.pendingRegistration;
    if (isGoogleSignup && prior && prior.emailVerified && prior.isGoogleSignup &&
        String(prior.email).toLowerCase() === email.trim().toLowerCase()) {
      log.info(`[REG] send-otp skipped — ${email.trim()} is already verified in this session (client resumes at step 3) ip=${clientIp(req)}`);
      return res.json({ success: true, alreadyVerified: true, message: 'Your email is already verified.' });
    }

    if (!isGoogleSignup) {
      const passErrors = validatePassword(password);
      if (passErrors.length > 0)
        return res.status(400).json({ error: 'Password requirements not met.', details: passErrors });
      if (password !== confirmPassword)
        return res.status(400).json({ error: 'Passwords do not match.' });

      // ── BUG FIX: If a user started Google OAuth but refreshed and is now
      // registering with a normal email/password, purge the leftover Google
      // session so it doesn't contaminate the new local account.
      delete req.session.pendingGoogle;
    }

    const pg        = req.session.pendingGoogle;
    const firstName = pg?.firstName || req.body.firstName || 'there';
    // Re-use the code that is already waiting (a late first e-mail must still work), otherwise make a new one.
    const { otp, reused, ageMs } = issueOTP(email.trim(), firstName, generateOTP);
    if (reused) log.info(`[OTP] ${req.path} ${email.trim()}: re-sending the SAME code (issued ${Math.round(ageMs / 1000)}s ago) so earlier e-mails stay valid [${req._id}]`);
    const result    = await sendOTPEmail(email.trim(), otp, firstName, { stillNeeded: () => isCurrentOTP(email.trim(), otp) });
    if (!result.success)
      return res.status(500).json({ error: 'Failed to send verification email. Please try again.' });

    req.session.pendingRegistration = {
      email:          email.trim(),
      password:       isGoogleSignup ? null : password,
      isGoogleSignup: !!isGoogleSignup,
      emailVerified:  false,
    };
    const response = { success: true, message: `Verification code sent to ${email.trim()}` };
    if (result.previewUrl) response.previewUrl = result.previewUrl;
    return res.json(response);
  } catch (err) {
    console.error('send-otp error:', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ════════════════════════════════════════════════════
// POST /api/auth/resend-otp
// ════════════════════════════════════════════════════
// NOTE: rejectDisposableEmail middleware disabled for testing — re-enable in production
router.post('/api/auth/resend-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });
    const pending = req.session.pendingRegistration;
    if (!pending || pending.email !== email.trim())
      return res.status(400).json({ error: 'Session expired. Please start registration again.' });
    const pg        = req.session.pendingGoogle;
    const firstName = pg?.firstName || 'there';
    // Re-use the code that is already waiting (a late first e-mail must still work), otherwise make a new one.
    const { otp, reused, ageMs } = issueOTP(email.trim(), firstName, generateOTP);
    if (reused) log.info(`[OTP] ${req.path} ${email.trim()}: re-sending the SAME code (issued ${Math.round(ageMs / 1000)}s ago) so earlier e-mails stay valid [${req._id}]`);
    const result    = await sendOTPEmail(email.trim(), otp, firstName, { stillNeeded: () => isCurrentOTP(email.trim(), otp) });
    if (!result.success) return res.status(500).json({ error: 'Failed to resend. Please try again.' });
    const response = { success: true, message: 'New code sent!' };
    if (result.previewUrl) response.previewUrl = result.previewUrl;
    return res.json(response);
  } catch (err) {
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ════════════════════════════════════════════════════
// POST /api/auth/verify-otp
// ════════════════════════════════════════════════════
router.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'Email and code are required.' });
    const result = verifyOTP(email.trim(), otp.trim());
    if (!result.valid) {
      // Say what we know about the e-mails sent to this address, so "wrong code" can be told apart from
      // "the e-mail never arrived and the resident is typing an older code".
      log.warn(`[OTP] verify failed for ${email.trim()}: ${result.reason} | ${getRecipientMailInfo(email.trim()).summary} [${req._id}]`);
      return res.status(400).json({ error: result.reason });
    }
    const pending = req.session.pendingRegistration;
    if (!pending || pending.email !== email.trim())
      return res.status(400).json({ error: 'Session expired. Please register again.' });
    pending.emailVerified = true;
    // An admin may have returned this e-mail's earlier application for correction → the wizard reopens with the saved answers.
    const returned = findRejectedRegistrationByEmail(email.trim());
    if (returned) pending.revisionId = returned.id; else delete pending.revisionId;
    req.session.pendingRegistration = pending;
    log.info(`[REG] email verified: ${pending.email} (${pending.isGoogleSignup ? 'google' : 'password'})${returned ? ' — RETURNED application found, reopening it' : ''} ip=${clientIp(req)}`);
    return res.json({ success: true, revision: !!returned, message: 'Email verified! Continue to fill in your profile.' });
  } catch (err) {
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ════════════════════════════════════════════════════
// RETURNED APPLICATIONS (admin "Reject" = send back for correction)
// The applicant's saved application is in rejected_registrations. After they prove who they are (password login,
// Google, or the e-mail OTP) the session carries pendingRegistration.revisionId and the wizard reopens with:
//   - every saved answer + document, - the admin's comment, - the checklist of items to correct.
// ════════════════════════════════════════════════════
function revisionRecordFor(pending) {
  if (!pending || !pending.revisionId || !pending.emailVerified) return null;
  const rec = getRejectedRegistrationById(pending.revisionId);
  if (!rec || String(rec.email).toLowerCase() !== String(pending.email).toLowerCase()) return null;
  return rec;
}

// What the browser needs to reopen the wizard. Session-gated: only the person who just proved ownership of the e-mail gets it.
router.get('/api/auth/revision', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const pending = req.session.pendingRegistration;
  const rec = revisionRecordFor(pending);
  if (!rec) {
    if (pending && pending.revisionId) {   // the record was removed (e.g. an admin deleted it) — stop pointing at it
      delete pending.revisionId; req.session.pendingRegistration = pending;
      log.warn(`[REVISION] saved application ${pending.revisionId || '?'} no longer exists — continuing as a new application (${pending.email})`);
    }
    return res.json({ revision: null });
  }
  let snapshot = null;
  try { snapshot = rec.form_snapshot ? JSON.parse(rec.form_snapshot) : null; } catch (_) { snapshot = null; }
  const docs = {};
  for (const item of Object.values(REVISION_ITEMS)) if (item.docKey) docs[item.docKey] = rec[item.urlCol] || '';
  log.info(`[REVISION] ${rec.email} reopened returned application ${rec.id} (snapshot=${snapshot ? 'yes' : 'no — legacy record'}) ip=${clientIp(req)}`);
  return res.json({
    revision: {
      id: rec.id, email: rec.email, isGoogle: (rec.auth_provider || 'local') === 'google',
      reason: rec.rejection_reason || '', rejectedAt: rec.rejected_at || '', resubmitCount: rec.resubmit_count || 0,
      flags: decorateFlags(parseFlags(rec.rejection_flags)),
      snapshot, docs,
      avatarUrl: rec.avatar || rec.selfie_url || '',
      idType: rec.id_type || 'school_id',
      // Records rejected BEFORE wizard snapshots existed: the browser restores the form from these saved columns instead.
      // (Address, school, year level and course are included — without them a legacy record reopened with those fields blank.)
      fields: snapshot ? null : {
        firstName: rec.first_name, middleName: rec.middle_name, lastName: rec.last_name, suffix: rec.suffix,
        birthday: rec.birthday, sex: rec.sex, civilStatus: rec.civil_status, phone: rec.phone, bio: rec.bio,
        monthlyIncome: rec.monthly_income, fatherInfo: rec.father_info, motherInfo: rec.mother_info, guardianInfo: rec.guardian_info,
        permanentAddress: rec.permanent_address || '', presentAddress: rec.present_address || '',
        schoolName: rec.school_name || '', schoolAddress: rec.school_address || '',
        yearLevel: rec.year_level || '', course: rec.course || '', specialization: rec.specialization || '',
        roomPreference: Number.isInteger(rec.room_preference) ? rec.room_preference : null, roommateNote: rec.roommate_note || '',
      },
    },
  });
});

// Runs after multer (so req.files / req.body exist) and BEFORE anything is sent to Cloudinary.
// Enforces the admin's checklist on the server too — the browser cannot be trusted to have done it.
function loadRevisionContext(req, res, next) {
  const pending = req.session.pendingRegistration;
  if (!pending || !pending.revisionId) return next();
  const ref = req._id;
  const rec = revisionRecordFor(pending);
  if (!rec) {
    log.warn(`[REG-FAIL] REVISION_GONE (HTTP 409) — saved application ${pending.revisionId} is gone | ref=${ref} email=${pending.email}`);
    delete pending.revisionId; req.session.pendingRegistration = pending;
    return res.status(409).json({
      error: 'Your saved application is no longer available (an administrator may have removed it). Please reload this page — you will need to enter your details and upload your documents again.',
      code: 'REVISION_GONE', ref,
    });
  }
  const flags = parseFlags(rec.rejection_flags);
  req.revision = { rec, flags, flagged: new Set(flags.map(f => f.key)) };

  for (const f of flags) {
    const item = REVISION_ITEMS[f.key];
    if (item.group === 'doc' && !(req.files && req.files[item.field] && req.files[item.field][0])) {
      log.warn(`[REG-FAIL] REVISION_DOC_REQUIRED (HTTP 400) — ${f.key} was flagged but not replaced | ref=${ref} email=${pending.email}`);
      return res.status(400).json({ error: `The admin asked you to replace: ${item.label}. Please upload a new file for it.`, code: 'REVISION_DOC_REQUIRED', field: item.field, ref });
    }
  }
  let ack = [];
  try { ack = JSON.parse((req.body && req.body.revisionAck) || '[]'); } catch (_) { ack = []; }
  const missing = flags.filter(f => REVISION_ITEMS[f.key].group === 'info' && !(Array.isArray(ack) && ack.includes(f.key)));
  if (missing.length) {
    log.warn(`[REG-FAIL] REVISION_ACK_REQUIRED (HTTP 400) — not confirmed: ${missing.map(m => m.key).join(',')} | ref=${ref} email=${pending.email}`);
    return res.status(400).json({
      error: `Please review and correct: ${missing.map(m => REVISION_ITEMS[m.key].label).join('; ')}, then tick “I have corrected this” for each.`,
      code: 'REVISION_ACK_REQUIRED', ref,
    });
  }
  next();
}

// Early session guard for complete-registration.
// Runs AFTER multer has parsed the body (so the browser finishes its upload and can read our
// JSON reply) but BEFORE processIdDocument (so a dead session never wastes six Cloudinary uploads).
function requireVerifiedRegistration(req, res, next) {
  const pending = req.session.pendingRegistration;
  if (pending && pending.emailVerified) return next();

  const done = req.session.registrationSubmitted;
  if (!pending && done && Date.now() - done.at < 24 * 60 * 60 * 1000) {
    // The first request succeeded but the browser never saw the reply (timeout / refresh) and retried.
    log.info(`[REG] duplicate submit ignored — ${done.email} was already submitted ${Math.round((Date.now() - done.at) / 1000)}s ago (ref=${req._id})`);
    return res.json({
      success: true, pending: true, alreadySubmitted: true,
      message: 'Registration submitted! An admin will review and approve your account shortly.',
    });
  }

  const code  = pending ? 'EMAIL_NOT_VERIFIED' : 'SESSION_EXPIRED';
  const error = pending
    ? 'Your email has not been verified yet. Please go back to the code step and enter the 6-digit code we emailed you.'
    : 'Your sign-up session expired before your application could be saved (sessions last 24 hours and end if cookies are cleared). ' +
      'Please verify your email again — your answers will be restored automatically.';
  log.warn(
    `[REG-FAIL] ${code} (HTTP 400) — ${req.headers.cookie ? 'session cookie was sent but no pending registration is stored (expired / server data reset)' : 'NO session cookie sent (cookies blocked or cleared?)'}` +
    ` | ref=${req._id} ip=${clientIp(req)} body=${req.headers['content-length'] || '?'}B`
  );
  return res.status(400).json({ error, code, ref: req._id });
}

// ════════════════════════════════════════════════════
// POST /api/auth/complete-registration
// Accepts multipart/form-data (fields + optional id_front file)
//
// Chain: trackUpload → multer → requireVerifiedRegistration → processIdDocument → handler
// (uploadIdDocs = [multer.fields(...), processIdDocument] — see middleware/upload.js)
// ════════════════════════════════════════════════════
router.post('/api/auth/complete-registration',
  trackUpload('complete-registration'), uploadIdDocs[0], requireVerifiedRegistration, loadRevisionContext, requireLiveSelfie, requireDistinctDocuments, requireMatchingDocuments, uploadIdDocs[1],
  async (req, res) => {
  const ref = req._id;
  // One structured WARN line for the log + a specific {error, code, field, ref} for the resident.
  const fail = (status, code, error, extra = {}) => {
    log.warn(`[REG-FAIL] ${code} (HTTP ${status}) — ${error} | ref=${ref} email=${(req.session.pendingRegistration || {}).email || '—'} ip=${clientIp(req)}`);
    return res.status(status).json({ error, code, ref, ...extra });
  };
  try {
    const pending = req.session.pendingRegistration;
    if (!pending || !pending.emailVerified)
      return fail(400, 'SESSION_EXPIRED', 'Your sign-up session expired before your application was saved. Please verify your email again — your answers will be restored automatically.');

    const {
      firstName, middleName, lastName, suffix, username, birthday, sex, phone, bio,
      location, idType,
      // DAMIS new fields
      civilStatus, presentAddress, permanentAddress,
      schoolName, course, yearLevel, schoolAddress, specialization,
      fatherInfo, motherInfo, guardianInfo, monthlyIncome,
      avatarFaceX, avatarFaceY,
      roomPreference, roommateNote,
    } = req.body;
    if (!firstName?.trim()) return fail(400, 'VALIDATION', 'First name is required.', { field: 'firstName' });
    if (!lastName?.trim())  return fail(400, 'VALIDATION', 'Last name is required.',  { field: 'lastName' });
    // username validation removed — username field removed from registration form
    if (!birthday)          return fail(400, 'VALIDATION', 'Date of birth is required.', { field: 'birthday' });
    if (getAge(birthday) < 13) return fail(400, 'VALIDATION', 'You must be at least 13 years old.', { field: 'birthday' });
    if (!sex)               return fail(400, 'VALIDATION', 'Sex is required.', { field: 'sex' });

    // Address / year level / course. The wizard requires them on Step 3, but a returned application reopens on the first
    // flagged step (often Step 5), so half-restored answers used to reach this route and overwrite the saved data with blanks.
    // "[Purok - ]Barangay, City, [Province,] Region, Philippines" has at least 4 comma segments; fewer means a dropdown was left empty.
    const addrSegments = (a) => String(a || '').split(',').map(s => s.trim()).filter(Boolean).length;
    if (addrSegments(permanentAddress) < 4)
      return fail(400, 'VALIDATION', 'Your permanent address is incomplete. Please choose your city/municipality and barangay and enter your purok / sitio.', { field: 'permanentAddress' });
    if (addrSegments(presentAddress) < 4)
      return fail(400, 'VALIDATION', 'Your present address is incomplete. Please choose your city/municipality and barangay and enter your purok / sitio.', { field: 'presentAddress' });
    // The dormitory only takes applicants whose PERMANENT address is in another Aurora municipality — not Baler.
    // City/municipality is the 2nd comma segment; the whole tail is checked too so "Municipality of Baler" can't slip through.
    const permSegs = String(permanentAddress || '').split(',').map(s => s.trim().toLowerCase());
    if (permSegs.slice(1).some(seg => /^(municipality of |city of )?baler$/.test(seg)))
      return fail(400, 'VALIDATION', 'Sorry, the dormitory only accepts applicants whose permanent address is in other municipalities of Aurora. Applicants from Baler are not accepted.', { field: 'permanentAddress' });
    const yearLevelClean = String(yearLevel || '').trim();
    if (!yearLevelClean || /^[\u2014\u2013-]|^select\b/i.test(yearLevelClean))   // a dropdown placeholder is not an answer
      return fail(400, 'VALIDATION', 'Please select your year level.', { field: 'yearLevel' });
    if (!String(course || '').trim())
      return fail(400, 'VALIDATION', 'Please select your program / course.', { field: 'course' });

    if (!phone?.trim()) return fail(400, 'VALIDATION', 'Phone number is required.', { field: 'phone' });
    const phoneClean = phone.trim().replace(/\D/g, '');
    if (!/^(9\d{9}|09\d{9})$/.test(phoneClean))
      return fail(400, 'VALIDATION', 'Invalid phone number. Enter 10 digits after +63.', { field: 'phone' });
    const phoneFormatted = '+63' + (phoneClean.length === 11 ? phoneClean.slice(1) : phoneClean);

    // ⚠️ TESTING MODE: phone uniqueness check disabled — duplicate phones get an auto-suffix
    // so registration never blocks during testing. Re-enable the PRODUCTION block below when done.
    let phoneForDb = phoneFormatted;
    if (findUserByPhone(phoneFormatted)) {
      const suffix = Date.now().toString().slice(-5); // 5-digit ms suffix → always unique
      phoneForDb = phoneFormatted.slice(0, -5) + suffix;
      log.warn(`[TEST] phone ${phoneFormatted} already in DB — using surrogate ${phoneForDb} for this test account.`);
    }
    // ── PRODUCTION: uncomment to enforce phone uniqueness (and remove block above) ──
    // if (findUserByPhone(phoneFormatted))
    //   return fail(409, 'PHONE_TAKEN', 'This phone number is already registered to another account.', { field: 'phone' });
    // Username uniqueness check removed
    if (findUserByEmail(pending.email))
      return fail(409, 'EMAIL_TAKEN', 'This email was just registered by someone else.', { field: 'email' });

    // ── Admissions: closed for this sex? (authoritative check — the form only hints) ──────────────
    // "Slots full" closes that sex for everyone. The master switch closes new applicants only; a returned application may resubmit.
    {
      const adm = admission.getStatus();
      const sk = String(sex).toLowerCase();
      if (sk === 'male' || sk === 'female') {
        const g = adm[sk];
        if (g.full || (g.reason === 'manual' && !req.revision)) {
          return fail(403, 'REGISTRATION_CLOSED', g.full
            ? `Sorry, all ${sk} dormitory slots are already full, so we can't accept new ${sk} applications right now.`
            : 'Applications are currently closed. Please check the announcements on this page for updates.', { field: 'sex' });
        }
      }
    }

    // ── Room preference (optional) + roommate note (optional) ──────────────
    // The picker only offers rooms that matched the applicant's sex and had a
    // free bed, but that was a moment ago — re-check here. A bad value fails
    // loudly (ROOM_UNAVAILABLE, not VALIDATION, so the wizard stays on Step 5
    // instead of bouncing to Step 3). Empty = "No preference" and is fine.
    const roomCheck = resolveRoomPreference(roomPreference, sex);
    if (!roomCheck.ok) {
      log.warn(`[REG] Room preference rejected (${roomCheck.reason}) — value="${String(roomPreference).slice(0, 20)}" sex=${sex} ref=${ref}`);
      return fail(409, 'ROOM_UNAVAILABLE',
        'The room you selected is no longer available. Please choose another room (or "No preference") and submit again.',
        { field: 'roomPreference' });
    }
    // Free text: strip control characters, trim, cap at 300 chars (the form enforces the same cap).
    const roommateNoteClean = String(roommateNote || '')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim()
      .slice(0, 300);

    const pg             = req.session.pendingGoogle;
    // pending.passwordHash = applicant logged in with their old password (returned application) — keep it as is.
    const hashedPassword = pending.passwordHash || (pending.password ? await bcrypt.hash(pending.password, 12) : null);

    // ── Returned application: new uploads win; everything NOT replaced is carried over from the saved record ──
    // (URLs come from OUR database, never from the browser.)
    const rev    = req.revision ? req.revision.rec : null;
    const idUrls = Object.assign({}, req.idDocUrls || {});
    let keptAvatar = false;
    if (rev) {
      for (const item of Object.values(REVISION_ITEMS)) {
        if (item.group === 'doc' && !idUrls[item.field] && rev[item.urlCol]) idUrls[item.field] = rev[item.urlCol];
      }
      if (!idUrls.id_back && rev.id_back_url) idUrls.id_back = rev.id_back_url;
      if (!idUrls.avatar) {            // selfie not retaken → keep the accepted photo and its crop position
        keptAvatar = true;
        idUrls.avatar = rev.avatar || '';
        idUrls.selfie = rev.selfie_url || rev.avatar || '';
      }
      log.info(`[REVISION] resubmission of ${pending.email}: replaced=[${Object.keys(req.idDocUrls || {}).join(',') || 'nothing'}] keptAvatar=${keptAvatar} flagged=[${[...req.revision.flagged].join(',') || 'none'}] ref=${ref}`);
    }

    const newUser = createUser({
      googleId:         pg?.googleId || null,
      email:            pending.email,
      password:         hashedPassword,
      firstName:        firstName.trim(),
      middleName:       middleName?.trim() || '',
      lastName:         lastName.trim(),
      suffix:           suffix || '',
      username:         (username?.trim() || (rev && rev.username && !findUserByUsername(rev.username) ? rev.username : (firstName.trim().toLowerCase().replace(/[^a-z0-9]/g,'') + Math.floor(Math.random()*9000+1000)))),
      birthday,
      sex,
      civilStatus:      civilStatus?.trim()      || '',
      phone:            phoneForDb,
      bio:              bio?.trim()              || '',
      location:         presentAddress?.trim()   || location?.trim() || '',
      presentAddress:   presentAddress?.trim()   || '',
      permanentAddress: permanentAddress?.trim() || '',
      schoolName:       schoolName?.trim()       || 'Aurora State College of Technology',
      course:           course?.trim()           || '',
      yearLevel:        yearLevel?.trim()        || '',
      schoolAddress:    schoolAddress?.trim()    || 'Zabali, Baler, Aurora',
      specialization:   specialization?.trim()  || '',
      fatherInfo:       fatherInfo              || '',
      motherInfo:       motherInfo              || '',
      guardianInfo:     guardianInfo            || '',
      monthlyIncome:    monthlyIncome?.trim()    || '',
      avatar:           idUrls.avatar            || pg?.avatar || '',
      avatarFaceX:      keptAvatar ? (rev.avatar_face_x ?? 50) : (parseInt(avatarFaceX, 10) || 50),
      avatarFaceY:      keptAvatar ? (rev.avatar_face_y ?? 50) : (parseInt(avatarFaceY, 10) || 50),
      emailVerified:    true,
      idVerified:       false,
      authProvider:     pg ? 'google' : 'local',
      roomPreference:   roomCheck.roomNumber,   // number | null
      roommateNote:     roommateNoteClean,
    });

    log.divider('NEW REGISTRATION');
    log.reg(`${firstName.trim()} ${lastName.trim()} — @${newUser.username} — ${pending.email}`);
    log.dump('User details', {
      id:               newUser.id,
      name:             `${firstName.trim()} ${middleName?.trim() || ''} ${lastName.trim()} ${suffix || ''}`.trim(),
      username:         `@${newUser.username}`,
      email:            pending.email,
      phone:            phoneForDb,
      birthday,
      sex,
      civilStatus:      civilStatus || '(not set)',
      presentAddress:   presentAddress || '(not set)',
      permanentAddress: permanentAddress || '(same as present)',
      yearLevel:        yearLevel || '(not set)',
      course:           course || '(not set)',
      specialization:   specialization || '(none)',
      monthlyIncome:    monthlyIncome || '(not set)',
      guardianInfo:     guardianInfo ? '(provided — both parents marked deceased)' : '(none)',
      roomPreference:   roomCheck.roomNumber ? `Room ${roomCheck.roomNumber}` : '(no preference)',
      roommateNote:     roommateNoteClean ? `(${roommateNoteClean.length} chars)` : '(none)',
      authProvider:     pg ? 'google' : 'local',
    });

    // ── Submit ID verification if files were uploaded ──
    // (idUrls was built above: new uploads + anything kept from a returned application)
    log.dump('Uploaded files', {
      avatar:           idUrls.avatar           ? `✔ ${String(idUrls.avatar).slice(0, 55)}…`           : '✖ missing',
      id_front:         idUrls.id_front         ? `✔ ${String(idUrls.id_front).slice(0, 55)}…`         : '✖ missing',
      selfie:           idUrls.selfie           ? `✔ ${String(idUrls.selfie).slice(0, 55)}…`           : '✖ missing',
      cert_residency:   idUrls.cert_residency   ? `✔ ${String(idUrls.cert_residency).slice(0, 55)}…`   : '✖ missing',
      cert_low_income:  idUrls.cert_low_income  ? `✔ ${String(idUrls.cert_low_income).slice(0, 55)}…`  : '✖ missing',
      cert_enrollment:  idUrls.cert_enrollment  ? `✔ ${String(idUrls.cert_enrollment).slice(0, 55)}…`  : '✖ missing',
      cert_grades:      idUrls.cert_grades      ? `✔ ${String(idUrls.cert_grades).slice(0, 55)}…`      : '✖ missing',
    });
    if (idUrls.id_front || idUrls.cert_residency || idUrls.cert_low_income || idUrls.cert_enrollment || idUrls.cert_grades || idUrls.selfie || idUrls.avatar) {
      try {
        submitIdVerification({
          userId:             newUser.id,
          idFrontUrl:         idUrls.id_front        || '',
          idBackUrl:          idUrls.id_back          || '',
          selfieUrl:          idUrls.selfie           || idUrls.avatar || '',
          idType:             ID_TYPES.has(idType) ? idType : (rev && ID_TYPES.has(rev.id_type) ? rev.id_type : 'school_id'),
          certResidencyUrl:   idUrls.cert_residency   || '',
          certLowIncomeUrl:   idUrls.cert_low_income  || '',
          certEnrollmentUrl:  idUrls.cert_enrollment  || '',
          certGradesUrl:      idUrls.cert_grades      || '',
        });
        log.upload(`Documents stored for @${newUser.username}: school_id=${!!idUrls.id_front}, residency=${!!idUrls.cert_residency}, low_income=${!!idUrls.cert_low_income}, enrollment=${!!idUrls.cert_enrollment}, grades=${!!idUrls.cert_grades}, idType=${ID_TYPES.has(idType) ? idType : 'school_id'}`);
        // Save file fingerprints + "already used by another applicant" flags (free checks ran earlier, in
        // requireDistinctDocuments), then queue the AI badge job. If the submit-time gate (requireMatchingDocuments) already
        // asked the model, its answers are reused (req.docAiAnswers) so this costs no second request; otherwise the job asks
        // once itself. It runs AFTER this reply (setImmediate) - the applicant never waits - and fails open.
        persistDocumentFingerprints({
          userId: newUser.id, email: newUser.email,
          name: `${newUser.firstName} ${newUser.lastName}`.trim(),
          prints: req.docPrints, flags: req.docFlags || {},
        });
        const _ioForChecks = req.app.get('io');
        setImmediate(() => enqueueDocumentAudit(newUser.id, { io: _ioForChecks, answers: req.docAiAnswers || null }));
      } catch (idErr) {
        log.error(`ID verification insert failed (non-fatal): ${idErr.message}`);
      }
    } else {
      log.warn(`No documents received for @${newUser.username} — account saved without files. Check frontend FormData.`);
    }

    // ── Keep the wizard's exact answers (so a future return-for-correction restores every dropdown) + resubmission bookkeeping ──
    try {
      setUserApplicationMeta(newUser.id, {
        formSnapshot:  sanitizeSnapshot(req.body.formSnapshot),
        resubmitCount: rev ? (rev.resubmit_count || 0) + 1 : 0,
        prevRejection: rev ? JSON.stringify({ reason: rev.rejection_reason || '', flags: parseFlags(rev.rejection_flags), at: rev.rejected_at || '' }) : '',
      });
      if (rev) {
        deleteRejectedRegistration(rev.id);   // the application is live again — it leaves the Rejected tab
        log.success(`[REVISION] @${newUser.username} (${newUser.email}) resubmitted — resubmission #${(rev.resubmit_count || 0) + 1}, rejected record ${rev.id} removed ref=${ref}`);
      }
    } catch (metaErr) {
      log.error(`Application snapshot/bookkeeping failed (non-fatal): ${metaErr.message}`);
    }

    delete req.session.pendingRegistration;
    delete req.session.pendingGoogle;
    // Lets the browser recover if our reply is lost (see GET /api/auth/registration-status) and
    // turns an accidental double-submit into a harmless success instead of a confusing error.
    req.session.registrationSubmitted = { email: newUser.email, at: Date.now() };
    log.success(`Account created and pending approval: @${newUser.username} (${newUser.email}) ref=${ref}${uploadSummary(req)}`);
    log.divider();

    // Account is pending approval — do NOT log them in yet
    sendAccountPendingEmail(newUser.email, newUser.firstName).catch(console.error);

    // Notify admin panel in real-time
    const io = req.app.get('io');
    if (io) {
      io.to('admins').emit('new-registration', {
        userId:    newUser.id,
        username:  newUser.username,
        firstName: newUser.firstName,
        lastName:  newUser.lastName,
        email:     newUser.email,
        createdAt: new Date().toISOString(),
        resubmission: !!rev,
      });
    }

    return res.json({
      success: true,
      pending: true,
      resubmitted: !!rev,
      message: 'Registration submitted! An admin will review and approve your account shortly.',
    });
  } catch (err) {
    // ── Structured error diagnostics ──────────────────────────────────────
    const isUniquePhone = err.code === 'SQLITE_CONSTRAINT_UNIQUE' && err.message?.includes('users.phone');
    const isUniqueEmail = err.code === 'SQLITE_CONSTRAINT_UNIQUE' && err.message?.includes('users.email');
    const isUniqueUser  = err.code === 'SQLITE_CONSTRAINT_UNIQUE' && err.message?.includes('users.username');

    log.error('complete-registration failed');
    log.dump('Error details', {
      type:       err.constructor?.name || 'Error',
      code:       err.code             || '—',
      message:    err.message          || '—',
      phone_dup:  isUniquePhone,
      email_dup:  isUniqueEmail,
      user_dup:   isUniqueUser,
    });
    if (process.env.NODE_ENV === 'development') {
      // Print the first 6 stack frames for faster pinpointing
      const frames = (err.stack || '').split('\n').slice(1, 7).join('\n');
      log.error('Stack (dev):\n' + frames);
    }

    if (isUniquePhone) {
      return res.status(409).json({
        error: 'This phone number is already registered to another account.',
        field: 'phone', code: 'PHONE_TAKEN', ref,
        // dev hint surfaced to browser console
        _dev: process.env.NODE_ENV === 'development'
          ? 'SQLITE UNIQUE constraint on users.phone — use a different number or clear the DB.'
          : undefined,
      });
    }
    if (isUniqueEmail) {
      return res.status(409).json({ error: 'This email was just registered by someone else.', field: 'email', code: 'EMAIL_TAKEN', ref });
    }
    if (isUniqueUser) {
      return res.status(409).json({ error: 'Username already taken. Please choose another.', field: 'username', code: 'USERNAME_TAKEN', ref });
    }

    log.error(`[REG-FAIL] SERVER_ERROR (HTTP 500) — ref=${ref} ${err.message}`);
    return res.status(500).json({
      error: 'Something went wrong while saving your application on our server. Your answers are still saved on this device — please try again in a minute. ' +
             'If it keeps happening, contact the dorm office and quote the reference code shown.',
      code: 'SERVER_ERROR', ref,
    });
  }
});

// ════════════════════════════════════════════════════
// POST /api/auth/login
// ════════════════════════════════════════════════════
router.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    const lockStatus = checkLoginLock(email.trim());
    if (lockStatus.locked)
      return res.status(429).json({ error: `Account temporarily locked. Try again in ${lockStatus.minsLeft} minute${lockStatus.minsLeft !== 1 ? 's' : ''}.` });

    const user = findUserByEmail(email.trim());
    if (!user) {
      // No account — but maybe an admin RETURNED this applicant's application for correction. A correct password
      // reopens the registration wizard with all saved answers (no new OTP: the e-mail was verified when they applied).
      const returned = findRejectedRegistrationByEmail(email.trim());
      if (returned) {
        if ((returned.auth_provider || 'local') === 'google') {
          log.warn(`Login [returned application, google]: ${email.trim()} — must use Google Sign-In`);
          return res.status(400).json({ error: 'Your application was returned for correction. It was made with Google Sign-In — tap “Continue with Google” to fix it.', code: 'RETURNED_GOOGLE' });
        }
        if (!returned.password_hash) {
          log.warn(`Login [returned application]: ${email.trim()} — no password saved with the record; asking for the e-mail OTP route`);
          return res.status(401).json({ error: 'Your application was returned for correction, but no password was saved with it. Tap “Create account”, enter this email and the 6-digit code we send — your saved answers will be restored.', code: 'RETURNED_NO_PASSWORD' });
        }
        if (await bcrypt.compare(password, returned.password_hash)) {
          clearLoginAttempts(email.trim());
          req.session.pendingRegistration = {
            email: returned.email, password: null, passwordHash: returned.password_hash,
            isGoogleSignup: false, emailVerified: true, revisionId: returned.id,
          };
          delete req.session.pendingGoogle;
          delete req.session.registrationSubmitted;
          log.auth(`Login OK [returned application]: ${returned.email} — reopening record ${returned.id}`);
          return res.json({ success: true, applicationReturned: true, message: 'Your application needs a few corrections. Opening it now…' });
        }
        // wrong password → fall through to the normal "Invalid email or password" + lockout counting below
      }
      recordFailedLogin(email.trim());
      const remaining = checkLoginLock(email.trim());
      const hint = (!remaining.locked && remaining.attemptsLeft <= 3) ? ` (${remaining.attemptsLeft} attempt${remaining.attemptsLeft !== 1 ? 's' : ''} left)` : '';
      log.warn(`Login FAIL [no user]: ${email.trim()} — email not found in DB`);
      return res.status(401).json({ error: 'Invalid email or password.' + hint });
    }
    if (user.authProvider === 'google') {
      log.warn(`Login FAIL [google account]: ${email.trim()} — must use Google Sign-In`);
      return res.status(400).json({ error: 'This account uses Google Sign-In. Please use the Google button.' });
    }

    if (!user.password) {
      log.warn(`Login FAIL [no password]: @${user.username} (${email.trim()}) — account has no password set`);
      return res.status(401).json({
        error: 'Your account has no password set. Please use "Forgot Password" to create one.',
        code: 'NO_PASSWORD',
      });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      recordFailedLogin(email.trim());
      const remaining = checkLoginLock(email.trim());
      log.warn(`Login FAIL [wrong password]: @${user.username} (${email.trim()}) — ${remaining.attemptsLeft} attempts left`);
      if (remaining.locked) return res.status(429).json({ error: 'Too many failed attempts. Account locked for 15 minutes.' });
      const hint = remaining.attemptsLeft <= 3 ? ` (${remaining.attemptsLeft} attempt${remaining.attemptsLeft !== 1 ? 's' : ''} left before lockout)` : '';
      return res.status(401).json({ error: 'Invalid email or password.' + hint });
    }

    if (!user.isActive) {
      log.warn(`Login FAIL [banned]: @${user.username} (${email.trim()}) — is_active=0`);
      return res.status(403).json({ error: 'Your account has been suspended. Please contact support.' });
    }

    if (user.accountStatus === 'pending') {
      log.warn(`Login FAIL [pending]: @${user.username} (${email.trim()}) — account_status=pending`);
      return res.status(403).json({
        error: 'Your account is pending admin approval. You will receive an email once approved.',
        code: 'ACCOUNT_PENDING',
      });
    }
    if (user.accountStatus === 'rejected') {
      log.warn(`Login FAIL [rejected]: @${user.username} (${email.trim()}) — account_status=rejected`);
      return res.status(403).json({
        error: 'Your account registration was not approved. Please contact support.',
        code: 'ACCOUNT_REJECTED',
      });
    }

    clearLoginAttempts(email.trim());
    log.auth(`Login OK: @${user.username} (${email.trim()}) role=${user.role}`);
    req.login(user, (err) => {
      if (err) {
        log.error(`Login session error for @${user.username}: ${err.message}`);
        return res.status(500).json({ error: 'Login error. Please try again.' });
      }
      return res.json({
        success: true,
        message: `Welcome back, ${user.firstName}!`,
        user: { id: user.id, firstName: user.firstName, email: user.email, role: user.role, idVerified: user.idVerified },
      });
    });
  } catch (err) {
    log.error(`Login route unhandled error: ${err.message}`);
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ════════════════════════════════════════════════════
// LOGOUT
// ════════════════════════════════════════════════════
router.get('/api/auth/logout', (req, res) => {
  req.logout((err) => {
    if (err) return res.status(500).json({ error: 'Logout failed.' });
    req.session.destroy(() => res.json({ success: true }));
  });
});

// ════════════════════════════════════════════════════
// CHECK USERNAME / PHONE
// ════════════════════════════════════════════════════
router.get('/api/auth/check-username', (req, res) => {
  const { username } = req.query;
  if (!username || !/^[a-zA-Z0-9_.]{3,20}$/.test(username))
    return res.status(400).json({ available: false, error: 'Invalid username format.' });
  return res.json({ available: !findUserByUsername(username), username });
});

router.get('/api/auth/check-phone', (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ available: false, error: 'Phone is required.' });
  const raw = phone.replace(/\D/g, '');
  let tenDigits;
  if (raw.length === 10 && raw[0] === '9')      tenDigits = raw;
  else if (raw.length === 11 && raw[0] === '0') tenDigits = raw.slice(1);
  else if (raw.length === 12 && raw.startsWith('63')) tenDigits = raw.slice(2);
  else return res.status(400).json({ available: false, error: 'Invalid phone format.' });
  return res.json({ available: !findUserByPhone('+63' + tenDigits) });
});

// ════════════════════════════════════════════════════
// ROOM AVAILABILITY (registration Step 5 — room preference picker)
// Public on purpose: applicants have no account yet. Returns counts only
// (free beds + how many people already prefer the room) — never names.
// Rate-limited with checkLimiter in server.js.
// ════════════════════════════════════════════════════
router.get('/api/auth/room-availability', (req, res) => {
  try {
    const sex = String(req.query.sex || '').toLowerCase();
    if (sex !== 'male' && sex !== 'female')
      return res.status(400).json({ error: 'sex must be "male" or "female".' });
    const rooms = getRoomAvailability(sex);
    res.set('Cache-Control', 'no-store');   // live numbers — never serve a stale list
    return res.json({ success: true, sex, rooms });
  } catch (err) {
    log.error(`[room-availability] ${err.message}`);
    return res.status(500).json({ error: 'Could not load room availability. Please try again.' });
  }
});

// ════════════════════════════════════════════════════
// ADMISSION STATUS (login page counter + sign-up gate)
// Public on purpose; aggregate numbers only — approved residents / max beds / remaining, per sex. Never names.
// ════════════════════════════════════════════════════
router.get('/api/auth/admission-status', (req, res) => {
  try {
    admission.syncAnnouncements();   // keeps the automatic notices in step if beds were added / a resident left
    const st = admission.getStatus();
    const pub = g => ({ approved: g.approved, max: g.max, remaining: g.remaining, open: g.open, reason: g.reason });
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, manualClosed: st.manualClosed, allClosed: st.allClosed, male: pub(st.male), female: pub(st.female) });
  } catch (err) {
    log.error(`[admission-status] ${err.message}`);
    return res.status(500).json({ error: 'Could not load slot numbers.' });
  }
});

// ════════════════════════════════════════════════════
// ME / PENDING GOOGLE
// ════════════════════════════════════════════════════
router.get('/api/auth/me', (req, res) => {
  if (!req.isAuthenticated()) return res.json({ loggedIn: false });
  const u = req.user;
  return res.json({
    loggedIn: true,
    user: {
      id: u.id, firstName: u.firstName, lastName: u.lastName, email: u.email,
      username: u.username, avatar: u.avatar || null, idVerified: u.idVerified, authProvider: u.authProvider,
      role: u.role || 'user',
    }
  });
});

// ── Support AI chat — no login required ──────────────────────────────
// ── Contact admin without account (used by support chat escalation) ──
router.post('/api/auth/contact-admin', async (req, res) => {
  try {
    const { name, email, message } = req.body;
    if (!message?.trim() || message.trim().length < 5)
      return res.status(400).json({ error: 'Message is too short.' });
    if (message.trim().length > 2000)
      return res.status(400).json({ error: 'Message is too long (max 2000 chars).' });
    // Basic email format check if provided
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      return res.status(400).json({ error: 'Invalid email address.' });

    // Send to the configured admin inbox, not back to the submitter
    const toEmail = process.env.ADMIN_EMAIL || process.env.EMAIL_USER || process.env.SENDGRID_FROM;
    const subject = `Support message from ${name?.trim() || 'Anonymous'}`;
    const result = await sendContactEmail(
      toEmail,
      name?.trim()  || 'Anonymous',
      email?.trim() || null,
      subject,
      message.trim()
    );
    if (!result.success)
      return res.status(500).json({ error: 'Failed to send message. Please email us directly.' });

    log.info(`Contact form submitted by ${name || 'anonymous'} (${email || 'no email'})`);
    return res.json({ success: true });
  } catch (err) {
    log.error(`contact-admin error: ${err.message}`);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ── AI support chat — public (no login) ─────────────────────────────
// How a message is answered (cheapest first):
//   1. A tapped chip (`faq` id)              → instant FAQ answer, no AI.
//   2. A strong keyword match in the FAQ     → instant FAQ answer, no AI.
//   3. Everything else                       → Gemini pool (auto-rotates keys) → DeepSeek fallback.
//   4. AI unavailable / out of quota         → best FAQ guess, else a "contact the admin" reply.
// The FAQ + contacts live in utils/supportKnowledge.js — edit answers THERE, not here.
const SUPPORT_MSG_MAX      = 500;           // server-side cap (the widget limits to 300)
const SUPPORT_HISTORY_TURNS = 6;
const SUPPORT_AI_PER_IP     = 8;            // AI calls allowed per IP …
const SUPPORT_AI_WINDOW_MS  = 10 * 60 * 1000; // … per 10 minutes (FAQ answers are unlimited)
const SUPPORT_AI_TIMEOUT_MS = 20000;

// Per-minute cap on the whole endpoint (FAQ + AI). The AI budget below is stricter.
const supportChatLimiter = rateLimit({
  windowMs: 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => {
    log.warn(`🛑 RATE LIMITED [support-chat] ip=${req.ip}`);
    res.status(429).json({
      reply: '⏳ You are sending messages too quickly. Please wait a few seconds and try again.',
      source: 'system', retryAfter: 15,
    });
  },
});

// In-memory per-IP budget for AI calls. Protects the shared Gemini quota (≈800/day across all
// keys) from one visitor draining it. Resets on restart, which is fine for an abuse guard.
const _supportAiHits = new Map();
function supportAiBudgetOk(ip) {
  const now = Date.now();
  const hits = (_supportAiHits.get(ip) || []).filter(t => now - t < SUPPORT_AI_WINDOW_MS);
  if (hits.length >= SUPPORT_AI_PER_IP) { _supportAiHits.set(ip, hits); return false; }
  hits.push(now);
  _supportAiHits.set(ip, hits);
  if (_supportAiHits.size > 5000) {            // keep the map from growing forever
    for (const [k, v] of _supportAiHits) if (!v.some(t => now - t < SUPPORT_AI_WINDOW_MS)) _supportAiHits.delete(k);
  }
  return true;
}

function supportAiAvailable() {
  const ps = geminiPool.getStatus();
  return (ps.configured && ps.availableKeys > 0) || !!process.env.GITHUB_TOKEN;
}

/** Merge consecutive same-role turns (Gemini/DeepSeek expect alternating roles). */
function supportNormalizeHistory(history, message) {
  const turns = (Array.isArray(history) ? history : [])
    .filter(m => m && typeof m.content === 'string' && m.content.trim())
    .slice(-SUPPORT_HISTORY_TURNS)
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content.trim().slice(0, 600) }));
  turns.push({ role: 'user', content: message.slice(0, 500) });
  const out = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.content += '\n' + t.content;
    else out.push({ ...t });
  }
  while (out.length && out[0].role !== 'user') out.shift(); // must start with the user
  return out;
}

/**
 * Ask the AI. Returns { reply } | { retryAfter } | { unavailable: true }.
 * Order: Gemini pool (rotating on daily-quota 429) → DeepSeek-V3 via GitHub Models.
 */
async function askSupportAi(systemPrompt, messages) {
  let retryAfter = 0;

  // 1) Gemini
  let key = geminiPool.getKey();
  while (key) {
    let resp;
    try {
      resp = await fetch(geminiPool.buildUrl(key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        signal: AbortSignal.timeout(SUPPORT_AI_TIMEOUT_MS),
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
          generationConfig: { maxOutputTokens: 500, temperature: 0.3 },
        }),
      });
    } catch (e) {
      log.aiError(`Support chat Gemini …${key.slice(-6)} network/timeout: ${e.message}`);
      break; // try DeepSeek
    }

    if (resp.ok) {
      geminiPool.trackRequest(key);
      const data = await resp.json().catch(() => ({}));
      const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
      if (text) return { reply: text, provider: 'gemini' };
      log.aiError(`Support chat Gemini …${key.slice(-6)} returned an empty reply (finishReason=${data.candidates?.[0]?.finishReason || '?'})`);
      break;
    }

    const errBody = await resp.text().catch(() => '(no body)');
    log.aiError(`Support chat Gemini …${key.slice(-6)} — HTTP ${resp.status}\n${errBody.slice(0, 300)}`);
    if (resp.status === 429) {
      if (geminiPool.markExhausted(key, errBody)) {           // daily quota → next key
        const next = geminiPool.getKey();
        if (next) { log.info(`Support chat rotating Gemini key …${key.slice(-6)} → …${next.slice(-6)}`); key = next; continue; }
        log.warn('Support chat: all Gemini keys exhausted → DeepSeek fallback');
      } else {                                                 // per-minute limit
        retryAfter = parseInt(resp.headers.get('Retry-After') || '30', 10) || 30;
      }
    }
    break; // any other error → DeepSeek
  }

  // 2) DeepSeek-V3 via GitHub Models
  const gh = (process.env.GITHUB_TOKEN || '').trim();
  if (gh) {
    try {
      const r = await fetch('https://models.github.ai/inference/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gh}` },
        signal: AbortSignal.timeout(SUPPORT_AI_TIMEOUT_MS),
        body: JSON.stringify({
          model: 'deepseek/DeepSeek-V3-0324', max_tokens: 500, temperature: 0.3,
          messages: [{ role: 'system', content: systemPrompt }, ...messages],
        }),
      });
      if (r.ok) {
        const d = await r.json().catch(() => ({}));
        const text = d.choices?.[0]?.message?.content?.trim();
        if (text) return { reply: text, provider: 'deepseek' };
      } else {
        log.aiError(`Support chat DeepSeek/GitHub — HTTP ${r.status}\n${(await r.text().catch(() => '')).slice(0, 300)}`);
      }
    } catch (e) {
      log.aiError(`Support chat DeepSeek network/timeout: ${e.message}`);
    }
  }

  return retryAfter ? { retryAfter } : { unavailable: true };
}

// GET /api/auth/support-status — public. Lets the widget show contacts + chips and the AI state.
router.get('/api/auth/support-status', (req, res) => {
  const ps = geminiPool.getStatus();
  const limit = ps.keyCount * ps.rpdLimit;
  const used  = (ps.keys || []).reduce((a, k) => a + k.rpdUsed, 0);
  res.json({
    aiAvailable: supportAiAvailable(),
    used, limit, remaining: Math.max(0, limit - used),
    keys: ps.keyCount, availableKeys: ps.availableKeys,
    contacts: supportKb.getContacts(),
    chips: supportKb.getChips(),
  });
});

// POST /api/auth/support-chat  { message, history?, faq? }
router.post('/api/auth/support-chat', supportChatLimiter, async (req, res) => {
  try {
    const faqId   = typeof req.body?.faq === 'string' ? req.body.faq : '';
    const message = String(req.body?.message || '').trim();
    const history = req.body?.history;

    // 1) Chip tap → exact FAQ entry, never AI.
    if (faqId) {
      const entry = supportKb.getEntry(faqId);
      if (entry) { log.ai(`Support chat [chip:${entry.id}]`); return res.json(supportKb.toPayload(entry)); }
    }

    if (!message) return res.status(400).json({ error: 'Message is required.' });
    if (message.length > SUPPORT_MSG_MAX) return res.status(400).json({ error: 'Message too long.' });

    // 2) Strong keyword match → instant FAQ answer. After the first turn, demand a stronger match
    //    so follow-ups like "and if I already did that?" go to the AI with context.
    const m = supportKb.matchFaq(message);
    const turns = Array.isArray(history) ? history.length : 0;
    if (m.entry && !m.ambiguous && m.score >= (turns ? 5 : 3)) {
      log.ai(`Support chat [faq:${m.entry.id} score=${m.score}] "${message.slice(0, 60)}"`);
      return res.json(supportKb.toPayload(m.entry));
    }

    // 3) AI path (guarded by an availability check and a per-IP budget).
    const noAiPayload = () => {
      // 4) Fallback — a weak FAQ guess beats nothing; otherwise point to a human.
      if (m.entry) {
        log.ai(`Support chat [faq-fallback:${m.entry.id} score=${m.score}] "${message.slice(0, 60)}"`);
        return supportKb.toPayload(m.entry);
      }
      log.ai(`Support chat [no-answer] "${message.slice(0, 80)}"`);
      return {
        reply: "I couldn't find an answer to that in my FAQ, and my AI helper is unavailable right now. Please contact the admin and they'll help you directly.",
        source: 'system', escalate: true, contacts: supportKb.getContacts(), actions: [], followups: [],
      };
    };

    if (!supportAiAvailable() || !supportAiBudgetOk(req.ip)) return res.json({ ...noAiPayload(), aiAvailable: supportAiAvailable() });

    log.ai(`Support chat [ai] unmatched → "${message.slice(0, 80)}"`); // review these to grow the FAQ
    const ai = await askSupportAi(
      supportKb.buildSystemPrompt(process.env.APP_NAME || 'PGA-DAMIS'),
      supportNormalizeHistory(history, message)
    );

    if (ai.retryAfter) {
      return res.json({
        reply: `⏳ Too many requests right now. Please wait **${ai.retryAfter < 90 ? ai.retryAfter + ' seconds' : Math.ceil(ai.retryAfter / 60) + ' min'}** and try again.`,
        source: 'system', retryAfter: ai.retryAfter,
      });
    }
    if (ai.unavailable) return res.json({ ...noAiPayload(), aiAvailable: false });

    // The model ends with [[ESCALATE]] when a human is needed — strip it so users never see it.
    const flagged = /\[\[\s*ESCALATE\s*\]\]/i.test(ai.reply) || /\bESCALATE\b/.test(ai.reply);
    const reply = ai.reply.replace(/\[\[\s*ESCALATE\s*\]\]/gi, '').replace(/\bESCALATE\b/g, '').trim().slice(0, 1500)
                  || 'Sorry, I could not process that. Please try again.';
    log.ai(`Support chat [${ai.provider}] → ${reply.slice(0, 60).replace(/\n/g, ' ')}${flagged ? ' (escalate)' : ''}`);
    return res.json({
      reply, source: 'ai', escalate: flagged, aiAvailable: true,
      contacts: flagged ? supportKb.getContacts() : undefined,
      actions: [], followups: [],
    });
  } catch (err) {
    log.aiError(`Support chat exception: ${err.stack || err.message}`);
    return res.json({
      reply: "I'm having trouble right now. Please contact the admin and they'll help you shortly.",
      source: 'system', escalate: true, contacts: supportKb.getContacts(), actions: [], followups: [],
    });
  }
});

// ── Support: return the first admin user ID so the UI can open a DM ──
router.get('/api/auth/support-admin', (req, res) => {
  const { db } = require('../utils/db');
  const admin = db.prepare(
    "SELECT id, first_name, last_name, username, avatar FROM users WHERE role IN ('admin','superadmin') AND is_active=1 ORDER BY created_at ASC LIMIT 1"
  ).get();
  if (!admin) return res.status(404).json({ error: 'No admin available.' });
  return res.json({
    id:        admin.id,
    firstName: admin.first_name,
    lastName:  admin.last_name,
    username:  admin.username,
    avatar:    admin.avatar || '',
  });
});

router.get('/api/auth/pending-google', (req, res) => {
  const pg = req.session.pendingGoogle;
  if (pg) return res.json({ pending: true, email: pg.email, firstName: pg.firstName, avatar: pg.avatar });
  return res.json({ pending: false });
});

// ════════════════════════════════════════════════════
// REGISTRATION RESUME SUPPORT
// The sign-up state lives in the server session (SQLite store, 24 h), so a page refresh does NOT
// lose the verified email — the browser just never asked. These endpoints let it ask, so a resident
// who refreshes (or whose phone reloads the tab after the camera/file picker) resumes at step 3
// instead of requesting a brand-new OTP.
// ════════════════════════════════════════════════════
router.get('/api/auth/registration-status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const p = req.session.pendingRegistration;
  if (p) {
    return res.json({
      active: true,
      email: p.email,
      emailVerified: !!p.emailVerified,
      isGoogleSignup: !!p.isGoogleSignup,
      firstName: (req.session.pendingGoogle || {}).firstName || null,
      revision: !!p.revisionId,
    });
  }
  const done = req.session.registrationSubmitted;
  if (done && Date.now() - done.at < 24 * 60 * 60 * 1000) {
    return res.json({ active: false, submitted: true, email: done.email });
  }
  return res.json({ active: false });
});

router.post('/api/auth/registration-reset', (req, res) => {
  const had = req.session.pendingRegistration && req.session.pendingRegistration.email;
  delete req.session.pendingRegistration;
  delete req.session.pendingGoogle;
  delete req.session.registrationSubmitted;
  if (had) log.info(`[REG] registration reset by the resident ("start over"): ${had} ip=${clientIp(req)}`);
  return res.json({ success: true });
});

// Browser-side failure reports (timeouts, offline, page left mid-upload, upload speeds).
router.post('/api/auth/client-report', clientReportHandler);

// ════════════════════════════════════════════════════
// GOOGLE OAUTH
// ════════════════════════════════════════════════════
router.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

router.get('/auth/google/callback',
  (req, res, next) => {
    passport.authenticate('google', { session: false }, (err, user, info) => {
      if (err) return res.redirect('/?error=google_failed');
      if (user) {
        req.login(user, (e) => {
          if (e) return res.redirect('/?error=google_failed');
          return res.redirect('/feed.html');
        });
        return;
      }
      if (info?.message === 'pending_signup')  return res.redirect('/?google=pending_signup');
      if (info?.message === 'account_pending')  return res.redirect('/?error=google_pending');
      if (info?.message === 'account_rejected') return res.redirect('/?error=google_rejected');
      if (info?.message === 'account_suspended') return res.redirect('/?error=google_suspended');
      if (info?.message?.startsWith('email_taken:')) {
        const email = encodeURIComponent(info.message.split(':')[1]);
        return res.redirect(`/?error=google_email_taken&email=${email}`);
      }
      return res.redirect('/?error=google_failed');
    })(req, res, next);
  }
);

// ════════════════════════════════════════════════════
// PASSWORD RESET
// ════════════════════════════════════════════════════
router.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email?.trim()) return res.status(400).json({ error: 'Email address is required.' });
    const user = findUserByEmail(email.trim());
    if (!user) return res.json({ success: true, message: 'If that email exists, a reset code was sent.' });
    if (user.authProvider === 'google') return res.status(400).json({ error: 'This account uses Google Sign-In. No password to reset.' });
    const otp    = generateOTP();
    saveResetOTP(email.trim(), otp);
    const result = await sendPasswordResetEmail(email.trim(), otp, user.firstName);
    if (!result.success) return res.status(500).json({ error: 'Failed to send reset email. Please try again.' });
    return res.json({ success: true, message: 'Reset code sent.' });
  } catch (err) {
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

router.post('/api/auth/verify-reset-otp', (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Email and code are required.' });
  const result = verifyResetOTP(email.trim(), otp.trim());
  if (!result.valid) return res.status(400).json({ error: result.reason });
  return res.json({ success: true });
});

router.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and new password are required.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const consumed = consumeResetOTP(email.trim());
    if (!consumed) return res.status(400).json({ error: 'Reset session expired. Please start over.' });
    const user = findUserByEmail(email.trim());
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    const { updateUser } = require('../utils/db');
    updateUser(user.id, { password: await bcrypt.hash(password, 12) });
    console.log('🔑 Password reset for:', email);
    return res.json({ success: true, message: 'Password updated successfully.' });
  } catch (err) {
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ── DOCX → PDF conversion (used by the registration document preview) ─────────
// Accepts a DOCX file upload and returns a PDF so the browser can show an
// accurate print-preview with formatting intact.  No auth required because this
// is called during account creation before the user has a session.
//
// POST /api/auth/convert-docx-to-pdf   multipart: 'file' field (DOCX)
// Returns: application/pdf stream, or JSON error on failure.
{
  const multer = require('multer');
  const os     = require('os');
  const fs     = require('fs');
  const path   = require('path');
  const { execFile } = require('child_process');

  const docxUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => {
      const ok = file.originalname.toLowerCase().endsWith('.docx') ||
                 file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      cb(ok ? null : new Error('Only .docx files are accepted'), ok);
    },
  }).single('file');

  router.post('/api/auth/convert-docx-to-pdf', (req, res) => {
    docxUpload(req, res, async (err) => {
      if (err) {
        log.warn('[docx-convert] Upload error:', err.message);
        return res.status(400).json({ error: err.message });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'No DOCX file received.' });
      }

      // Write the uploaded buffer to a temp file so LibreOffice can read it
      const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'damis-docx-'));
      const inPath  = path.join(tmpDir, 'input.docx');
      const outPath = path.join(tmpDir, 'input.pdf');

      try {
        fs.writeFileSync(inPath, req.file.buffer);

        await new Promise((resolve, reject) => {
          // --headless --convert-to pdf --outdir <dir> <file>
          // LibreOffice names the output <basename>.pdf in the same outdir.
          execFile(
            'libreoffice',
            ['--headless', '--convert-to', 'pdf', '--outdir', tmpDir, inPath],
            { timeout: 30_000 },
            (convErr, _stdout, stderr) => {
              if (convErr) {
                log.warn('[docx-convert] LibreOffice error:', stderr || convErr.message);
                return reject(new Error('Conversion failed — LibreOffice error'));
              }
              resolve();
            }
          );
        });

        if (!fs.existsSync(outPath)) {
          throw new Error('PDF not generated — unexpected LibreOffice output');
        }

        const pdfBuf = fs.readFileSync(outPath);
        log.info(`[docx-convert] Converted ${req.file.originalname} → PDF (${pdfBuf.length} bytes)`);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="preview.pdf"');
        res.setHeader('Content-Length', pdfBuf.length);
        return res.send(pdfBuf);
      } catch (convErr) {
        log.warn('[docx-convert]', convErr.message);
        return res.status(500).json({ error: convErr.message });
      } finally {
        // Clean up temp files regardless of outcome
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
      }
    });
  });
}

module.exports = router;
