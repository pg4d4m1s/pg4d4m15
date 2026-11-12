/**
 * utils/passport-setup.js  (updated for SQLite db)
 *
 * Same logic as before — only changed:
 *   - Import from utils/db.js instead of utils/userStore.js
 *   - deserializeUser uses findUserById (DB lookup, not array.find)
 *   - Google accounts whose google_id was lost (restored from an archive made before
 *     the archives stored it) are re-linked on their next Google sign-in instead of
 *     being rejected with "email_taken".
 */

const passport       = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { findUserByEmail, findUserById, findRejectedRegistrationByEmail } = require('./db');
const log            = require('./logger');

passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser((id, done) => {
  const user = findUserById(id);
  done(null, user || null);
});

/** Shared status gate: suspended / pending / rejected → block, otherwise log in. */
function gateByStatus(user, done) {
  if (!user.isActive) {
    return done(null, false, { message: 'account_suspended' });
  }
  if (user.accountStatus === 'pending') {
    return done(null, false, { message: 'account_pending' });
  }
  if (user.accountStatus === 'rejected') {
    return done(null, false, { message: 'account_rejected' });
  }
  console.log(`Google login ✅  ${user.email}`);
  return done(null, user);
}

passport.use(new GoogleStrategy(
  {
    clientID:          process.env.GOOGLE_CLIENT_ID,
    clientSecret:      process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:       process.env.GOOGLE_CALLBACK_URL,
    passReqToCallback: true,
  },
  async (req, accessToken, refreshToken, profile, done) => {
    try {
      const email    = profile.emails?.[0]?.value || '';
      const googleId = profile.id;

      // Already fully registered → check status then log in
      const { db } = require('./db');
      const existing = db.prepare('SELECT * FROM users WHERE google_id = ?').get(googleId);
      if (existing) {
        return gateByStatus(findUserById(existing.id), done);
      }

      const byEmail = email ? findUserByEmail(email) : null;
      if (byEmail) {
        // Self-heal: the account was created via Google but its google_id is missing
        // (restore from the deleted/rejected archive used to drop it). Google has just
        // authenticated this exact email, so it is safe to re-link — but ONLY for
        // google-provider accounts and ONLY when Google says the email is verified.
        const emailVerified = String(profile.emails?.[0]?.verified) !== 'false';
        if (byEmail.authProvider === 'google' && !byEmail.googleId && emailVerified) {
          db.prepare(`UPDATE users SET google_id = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(googleId, byEmail.id);
          log.auth(`Google re-linked: @${byEmail.username} (${email}) — google_id was missing`);
          return gateByStatus(findUserById(byEmail.id), done);
        }

        // Email exists but registered locally (or linked to a different Google id) → block
        log.warn(`Google login BLOCKED [email_taken]: ${email} provider=${byEmail.authProvider} hasGoogleId=${!!byEmail.googleId}`);
        return done(null, false, { message: `email_taken:${email}` });
      }

      // Application returned for correction? Google just proved this e-mail is theirs, so (like the e-mail OTP step)
      // the wizard can reopen with their saved answers. routes/auth.js GET /api/auth/revision serves the data.
      const returned = email && String(profile.emails?.[0]?.verified) !== 'false' ? findRejectedRegistrationByEmail(email) : null;
      if (returned) {
        req.session.pendingRegistration = {
          email, password: null, passwordHash: null,
          isGoogleSignup: true, emailVerified: true, revisionId: returned.id,
        };
        log.auth(`Google sign-in by applicant with a returned application: ${email} (record ${returned.id})`);
      }

      // Brand-new user → store in session, do NOT create account yet
      req.session.pendingGoogle = {
        googleId,
        email,
        firstName: profile.name?.givenName  || '',
        lastName:  profile.name?.familyName || '',
        avatar:    profile.photos?.[0]?.value || '',
      };
      console.log(`Google signup 🔄  pending OTP: ${email}`);
      return done(null, false, { message: 'pending_signup' });

    } catch (err) {
      return done(err, null);
    }
  }
));

module.exports = passport;
