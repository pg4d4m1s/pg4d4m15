// public/js/auth.js

'use strict';

// ═══════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════
const API = {
  SEND_OTP:       '/api/auth/send-otp',
  RESEND_OTP:     '/api/auth/resend-otp',
  VERIFY_OTP:     '/api/auth/verify-otp',
  COMPLETE_REG:   '/api/auth/complete-registration',
  CHECK_PHONE:    '/api/auth/check-phone',
  FORGOT_PASS:    '/api/auth/forgot-password',
  VERIFY_RESET:   '/api/auth/verify-reset-otp',
  RESET_PASS:     '/api/auth/reset-password',
  LOGIN:          '/api/auth/login',
  LOGOUT:         '/api/auth/logout',
  ME:             '/api/auth/me',
  GOOGLE:         '/auth/google',
  PENDING_GOOGLE: '/api/auth/pending-google',
};

// Philippine Standard Geographic Code API base

const PASSWORD_RULES = [
  { id: 'req-len',   test: p => p.length >= 8 },
  { id: 'req-upper', test: p => /[A-Z]/.test(p) },
  { id: 'req-lower', test: p => /[a-z]/.test(p) },
  { id: 'req-num',   test: p => /[0-9]/.test(p) },
  { id: 'req-sym',   test: p => /[^A-Za-z0-9]/.test(p) },
  { id: 'req-ns',    test: p => !/\s/.test(p) && p.length > 0 },
];
const SEG_COLORS = ['#ef4444','#f97316','#f59e0b','#10b981'];
const STR_LABELS = ['','Weak — keep going','Fair — almost there','Good — one more','Strong ✓'];
const STR_TW     = ['','#ef4444','#f97316','#f59e0b','#10b981'];

let countdownInterval = null;
let currentStep    = 1;
let isGoogleSignup = false;
let otpVerified    = false;     // locked true after successful OTP
let usernameCheckTimeout = null;
let phoneCheckTimeout    = null;
// Availability status: null=unchecked, true=available, false=taken
var usernameAvailableStatus = null;
var phoneAvailableStatus    = null;
// Last value that was actually sent to the server — so we don't re-check unchanged values
var usernameLastChecked = '';
var phoneLastChecked    = '';
let cameraStream = null;
let capturedPhotoData = null;   // base64 from camera capture
let avatarFileRef = null;       // File object for avatar upload (works for both picker + drag-drop)
let idFileRef = null;           // File object for ID upload (works for both picker + drag-drop)

// In-memory username registry for client-side dupe check
// (in production this hits the backend; here we track locally)
const registeredUsernames = new Set();

// ═══════════════════════════════════════════════════
// DOM UTILITIES
// ═══════════════════════════════════════════════════
const $ = id => document.getElementById(id);

function showStepError(step, msg) {
  const box = $('err-' + step);
  if (!box) return;
  $('err-' + step + '-txt').textContent = msg;
  box.classList.remove('hidden');
  box.classList.add('anim-shake');
  setTimeout(() => box.classList.remove('anim-shake'), 500);
}
function hideStepError(step) { $('err-' + step)?.classList.add('hidden'); }

function showToast(message, type) {
  type = type || 'success';
  document.querySelectorAll('.ch-toast').forEach(function(t){ t.remove(); });
  var toast = document.createElement('div');
  var bg = type === 'success' ? 'bg-green-600' : type === 'error' ? 'bg-red-600' : 'bg-slate-700';
  toast.className = 'ch-toast fixed bottom-6 right-6 z-50 ' + bg + ' text-white text-sm font-semibold px-5 py-3 rounded-xl shadow-xl anim-fade-up flex items-center gap-2';
  toast.innerHTML = (type === 'success' ? '✅ ' : type === 'error' ? '❌ ' : 'ℹ️ ') + message;
  document.body.appendChild(toast);
  setTimeout(function(){ toast.style.opacity='0'; toast.style.transition='opacity .3s'; setTimeout(function(){ toast.remove(); },300); }, 4000);
}

// ═══════════════════════════════════════════════════
// TAB SWITCHING
// ═══════════════════════════════════════════════════
function showTab(tab) {
  var isLogin = tab === 'login';
  $('panel-login').classList.toggle('hidden', !isLogin);
  $('panel-signup').classList.toggle('hidden', isLogin);
  var a = 'flex-1 py-4 text-sm font-bold text-brand-600 border-b-2 border-brand-600 transition-all';
  var i = 'flex-1 py-4 text-sm font-bold text-slate-400 border-b-2 border-transparent hover:text-slate-600 transition-all';
  $('tab-login').className  = isLogin ? a : i;
  $('tab-signup').className = !isLogin ? a : i;
}

// ═══════════════════════════════════════════════════
// MULTI-STEP NAVIGATION
// ═══════════════════════════════════════════════════
async function go(from) {
  // Show loading state on the Continue button during async server checks
  var continueBtn = from === 3 ? $('btn-step3') : (from === 1 ? $('btn-step1') : null);
  if (continueBtn) {
    continueBtn.disabled = true;
    continueBtn.innerHTML = '<span class="spinner mr-2"></span> Checking…';
  }
  var valid = await validateStep(from);
  if (continueBtn) {
    continueBtn.disabled = false;
    continueBtn.innerHTML = from === 1
      ? 'Continue <i class="fa-solid fa-arrow-right ml-1.5"></i>'
      : 'Continue <i class="fa-solid fa-arrow-right ml-1"></i>';
  }
  if (!valid) return;
  $('step-' + from).classList.add('hidden');
  currentStep = from + 1;
  var next = $('step-' + currentStep);
  if (next) next.classList.remove('hidden');
  updateProgress(currentStep);
  document.querySelector('.overflow-y-auto').scrollTop = 0;
  RegResilience.onStepChange(currentStep);   // save progress so a refresh resumes here

  // Step 5 has the live room-preference picker — (re)load it every time the step is entered.
  if (currentStep === 5) loadRoomPreferences(false);

  // When entering step 3, re-run availability checks on any pre-filled fields
  if (currentStep === 3) {
    initAddrDropdowns();
    // Auto-fill email display
    var emailSrc = $('reg-email');
    var emailDisp = $('reg-email-display');
    if (emailSrc && emailDisp) emailDisp.value = emailSrc.value;
    // Re-check username if field has a value (handles returning from Step 4/5)
    var uval = $('reg-uname') ? $('reg-uname').value.trim() : '';
    if (uval.length >= 3) {
      usernameLastChecked = ''; // force re-check
      checkUsernameAvailability(uval);
    } else {
      usernameAvailableStatus = null;
      usernameLastChecked = '';
    }
    // Re-check phone if field has a value
    var pval = $('reg-phone') ? $('reg-phone').value.replace(/\D/g,'') : '';
    if (pval.length === 10 && pval[0] === '9') {
      phoneLastChecked = ''; // force re-check
      checkPhoneAvailability(pval);
    } else {
      phoneAvailableStatus = null;
      phoneLastChecked = '';
    }
  }
}

function back(from) {
  // After OTP is verified, user CANNOT go back to step 2 from step 3+
  if (otpVerified && from <= 3) {
    showToast('Email already verified — you cannot go back to that step.', 'info');
    return;
  }
  stopCamera();
  stopSelfieCamera();
  $('step-' + from).classList.add('hidden');
  currentStep = from - 1;   // BUGFIX: was never decremented, so Back did nothing on steps 4 and 5
  var prev = $('step-' + currentStep);
  if (prev) prev.classList.remove('hidden');
  updateProgress(currentStep);
  document.querySelector('.overflow-y-auto').scrollTop = 0;
  // Re-trigger availability checks when returning to step 3
  if (currentStep === 3) {
    var uval = $('reg-uname') ? $('reg-uname').value.trim() : '';
    if (uval.length >= 3) { usernameLastChecked = ''; checkUsernameAvailability(uval); }
    var pval = $('reg-phone') ? $('reg-phone').value.replace(/\D/g,'') : '';
    if (pval.length === 10 && pval[0] === '9') { phoneLastChecked = ''; checkPhoneAvailability(pval); }
  }
}

function updateProgress(s) {
  $('prog-bar').style.width = (s / 5 * 100) + '%';
  for (var i = 1; i <= 5; i++) {
    var dot = $('dot' + i), lbl = $('lbl' + i);
    if (!dot) continue;
    if (i < s) {
      dot.textContent = '✓';
      dot.className = 'w-6 h-6 rounded-full bg-green-500 text-white text-xs font-bold flex items-center justify-center';
      if (lbl) lbl.className = 'text-xs font-semibold text-green-500 hidden sm:inline';
    } else if (i === s) {
      dot.textContent = i;
      dot.className = 'w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center';
      if (lbl) lbl.className = 'text-xs font-bold text-blue-600 hidden sm:inline';
    } else {
      dot.textContent = i;
      dot.className = 'w-6 h-6 rounded-full bg-slate-200 text-slate-400 text-xs font-bold flex items-center justify-center';
      if (lbl) lbl.className = 'text-xs font-semibold text-slate-300 hidden sm:inline';
    }
  }
}

// ═══════════════════════════════════════════════════
// NAME INLINE VALIDATION
// ═══════════════════════════════════════════════════
function validateNameInline(inputId, errId) {
  var val = $(inputId).value.trim();
  var errEl = $(errId);
  if (!val) {
    $(inputId).classList.add('is-error');
    errEl.textContent = 'This field is required.';
    errEl.classList.remove('hidden');
    return false;
  }
  if (val.length < 2) {
    $(inputId).classList.add('is-error');
    errEl.textContent = 'Must be at least 2 characters.';
    errEl.classList.remove('hidden');
    return false;
  }
  if (val.length > 50) {
    $(inputId).classList.add('is-error');
    errEl.textContent = 'Must not exceed 50 characters.';
    errEl.classList.remove('hidden');
    return false;
  }
  if (/[0-9]/.test(val)) {
    $(inputId).classList.add('is-error');
    errEl.textContent = 'Name must not contain numbers.';
    errEl.classList.remove('hidden');
    return false;
  }
  // Production regex — letters (includes Filipino/Latin Extended: ñ, Ñ, accented),
  // spaces, hyphens, apostrophes, periods. No digits, no symbols.
  if (/[^\u0041-\u005A\u0061-\u007A\u00C0-\u00FF\u0100-\u024F\u1E00-\u1EFF '\-.]/.test(val)) {
    $(inputId).classList.add('is-error');
    errEl.textContent = 'Only letters, spaces, hyphens, and apostrophes are allowed.';
    errEl.classList.remove('hidden');
    return false;
  }
  if (/^[' \-.]/u.test(val) || /[' \-.]$/.test(val)) {
    $(inputId).classList.add('is-error');
    errEl.textContent = 'Name must start and end with a letter.';
    errEl.classList.remove('hidden');
    return false;
  }
  if (/['.\-]{2,}/.test(val)) {
    $(inputId).classList.add('is-error');
    errEl.textContent = 'Name must not have consecutive punctuation (e.g. --, \'\').';
    errEl.classList.remove('hidden');
    return false;
  }
  $(inputId).classList.remove('is-error');
  errEl.classList.add('hidden');
  return true;
}

function blockInvalidUsernameChars(input) {
  // Username: only a-z, A-Z, 0-9, underscore, period
  var val = input.value;
  var cleaned = val.replace(/[^a-zA-Z0-9_.]/g, '');
  if (cleaned !== val) {
    var pos = input.selectionStart - (val.length - cleaned.length);
    input.value = cleaned;
    input.setSelectionRange(Math.max(0, pos), Math.max(0, pos));
  }
}

function blockInvalidNameChars(input) {
  // Strip any character that can never be in a name: digits, symbols, etc.
  // Allowed: Unicode letters, space, hyphen, apostrophe, period
  var val = input.value;
  var cleaned = val.replace(/[0-9!@#$%^&*()_+=\[\]{};:"\\|<>,/?`~]/g, '');
  if (cleaned !== val) {
    var pos = input.selectionStart - (val.length - cleaned.length);
    input.value = cleaned;
    input.setSelectionRange(Math.max(0, pos), Math.max(0, pos));
  }
}

// ═══════════════════════════════════════════════════
// PHONE VALIDATION & FORMATTING
// ═══════════════════════════════════════════════════
function formatPhone(input) {
  // Input is the 10-digit field (after +63 prefix is locked)
  var raw = input.value.replace(/\D/g, '');
  if (raw.length > 10) raw = raw.slice(0, 10);
  input.value = raw;
  $('phone-err-msg').classList.add('hidden');
  $('phone-ok-icon').classList.add('hidden');
  // Live digit counter
  var counter = $('phone-digit-count');
  if (counter) {
    counter.textContent = raw.length + '/10';
    counter.className = raw.length === 10
      ? 'text-xs font-semibold text-green-500'
      : 'text-xs text-slate-400';
  }
}

function validatePhoneInline() {
  var digits = $('reg-phone').value.replace(/\D/g, '');
  var errEl  = $('phone-err-msg');
  var okIcon = $('phone-ok-icon');
  if (!digits) {
    $('reg-phone').classList.add('is-error');
    errEl.textContent = 'Phone number is required.';
    errEl.classList.remove('hidden');
    okIcon.classList.add('hidden');
    return false;
  }
  if (digits.length !== 10) {
    $('reg-phone').classList.add('is-error');
    errEl.textContent = 'Enter 10 digits after +63 (e.g. 9171234567).';
    errEl.classList.remove('hidden');
    okIcon.classList.add('hidden');
    return false;
  }
  // Must start with 9 (valid PH mobile)
  if (digits[0] !== '9') {
    $('reg-phone').classList.add('is-error');
    errEl.textContent = 'Mobile number must start with 9 (e.g. 9171234567).';
    errEl.classList.remove('hidden');
    okIcon.classList.add('hidden');
    return false;
  }
  $('reg-phone').classList.remove('is-error');
  errEl.classList.add('hidden');
  okIcon.classList.remove('hidden');
  // Format is valid — also kick off availability check
  checkPhoneAvailability(digits);
  return true;
}

// ═══════════════════════════════════════════════════
// USERNAME AVAILABILITY CHECK
// ═══════════════════════════════════════════════════
function checkUsernameAvailability(value) {
  clearTimeout(usernameCheckTimeout);
  var icon  = $('uname-status-icon');
  var msg   = $('uname-status-msg');
  var input = $('reg-uname');

  if (!value || value.length < 3) {
    icon.classList.add('hidden');
    msg.textContent = ''; msg.style.color = '';
    input.classList.remove('is-error');
    usernameAvailableStatus = null;
    usernameLastChecked = '';
    return;
  }

  if (!/^[a-zA-Z0-9_.]{3,20}$/.test(value)) {
    icon.textContent = '✗'; icon.style.color = '#ef4444'; icon.classList.remove('hidden');
    msg.textContent = '3–20 chars, letters / numbers / _ or . only.';
    msg.style.color = '#ef4444';
    input.classList.add('is-error');
    usernameAvailableStatus = false;
    usernameLastChecked = value;
    return;
  }

  // If we already have a definitive result for this exact value, keep it — don't re-show spinner
  if (value === usernameLastChecked && usernameAvailableStatus !== null) return;

  // Show spinner — but only reset status if value actually changed
  if (value !== usernameLastChecked) usernameAvailableStatus = null;
  icon.textContent = '…'; icon.style.color = '#94a3b8'; icon.classList.remove('hidden');
  msg.textContent = 'Checking availability…'; msg.style.color = '#94a3b8';

  usernameCheckTimeout = setTimeout(async function() {
    try {
      var res  = await fetch('/api/auth/check-username?username=' + encodeURIComponent(value));
      var data = await res.json();
      usernameLastChecked = value;

      if (!res.ok) {
        // 429 or server error — show neutral state, don't mark as available
        icon.textContent = '?'; icon.style.color = '#94a3b8';
        msg.textContent = 'Could not check availability. Will verify on Continue.';
        msg.style.color = '#94a3b8';
        usernameAvailableStatus = null; // unknown — validateStep will re-check
        return;
      }

      if (data.available) {
        icon.textContent = '✓'; icon.style.color = '#10b981';
        msg.textContent = '@' + value + ' is available!'; msg.style.color = '#10b981';
        input.classList.remove('is-error');
        usernameAvailableStatus = true;
      } else {
        icon.textContent = '✗'; icon.style.color = '#ef4444';
        msg.textContent = '@' + value + ' is already taken. Try another.'; msg.style.color = '#ef4444';
        input.classList.add('is-error');
        usernameAvailableStatus = false;
      }
    } catch(e) {
      usernameLastChecked = value;
      var taken = registeredUsernames.has(value.toLowerCase());
      usernameAvailableStatus = !taken;
      if (taken) {
        icon.textContent = '✗'; icon.style.color = '#ef4444';
        msg.textContent = '@' + value + ' is already taken. Try another.'; msg.style.color = '#ef4444';
        input.classList.add('is-error');
      } else {
        icon.textContent = '✓'; icon.style.color = '#10b981';
        msg.textContent = '@' + value + ' is available!'; msg.style.color = '#10b981';
        input.classList.remove('is-error');
      }
    }
  }, 500);
}

// ═══════════════════════════════════════════════════
// PHONE AVAILABILITY CHECK (live, like username)
// ═══════════════════════════════════════════════════
function checkPhoneAvailability(digits) {
  clearTimeout(phoneCheckTimeout);
  var errEl  = $('phone-err-msg');
  var okIcon = $('phone-ok-icon');
  var input  = $('reg-phone');

  // ⚠️ DEV MODE: live phone duplicate check disabled. Remove the next 6 lines to re-enable.
  phoneAvailableStatus = true; phoneLastChecked = digits;
  if (errEl)  { errEl.classList.add('hidden'); errEl.style.color = ''; }
  if (okIcon) okIcon.classList.remove('hidden');
  if (input)  input.classList.remove('is-error');
  return;
  // ── end dev bypass ──

  // Only check when format is valid
  if (!digits || digits.length !== 10 || digits[0] !== '9') return;

  // Already have a definitive answer for this exact number — keep it, no spinner
  if (digits === phoneLastChecked && phoneAvailableStatus !== null) return;

  // Value changed — mark as pending but DON'T wipe the old result yet (avoid flicker)
  if (digits !== phoneLastChecked) phoneAvailableStatus = null;

  // Show checking indicator
  if (errEl)  { errEl.textContent = 'Checking\u2026'; errEl.style.color = '#94a3b8'; errEl.classList.remove('hidden'); }
  if (okIcon) okIcon.classList.add('hidden');

  phoneCheckTimeout = setTimeout(async function() {
    try {
      var res  = await fetch(API.CHECK_PHONE + '?phone=' + encodeURIComponent(digits));
      var data = await res.json();
      phoneLastChecked = digits;

      if (!res.ok) {
        // 429 or server error — neutral state, don't show green checkmark
        if (errEl) { errEl.textContent = 'Could not verify. Will check on Continue.'; errEl.style.color = '#94a3b8'; errEl.classList.remove('hidden'); }
        if (okIcon) okIcon.classList.add('hidden');
        phoneAvailableStatus = null;
        return;
      }

      if (data.available) {
        phoneAvailableStatus = true;
        if (errEl)  { errEl.classList.add('hidden'); errEl.style.color = ''; }
        if (okIcon) okIcon.classList.remove('hidden');
        if (input)  input.classList.remove('is-error');
      } else {
        phoneAvailableStatus = false;
        if (okIcon) okIcon.classList.add('hidden');
        if (input)  input.classList.add('is-error');
        if (errEl)  {
          errEl.textContent = 'This number is already registered. Use a different number.';
          errEl.style.color = '';
          errEl.classList.remove('hidden');
        }
      }
    } catch(e) {
      // Network error — don't block the user
      phoneLastChecked = digits;
      phoneAvailableStatus = true;
      if (errEl) errEl.classList.add('hidden');
      if (okIcon) okIcon.classList.remove('hidden');
    }
  }, 600);
}

// ═══════════════════════════════════════════════════
// PASSWORD STRENGTH
// ═══════════════════════════════════════════════════
function evalPass(password) {
  var score = 0;
  PASSWORD_RULES.forEach(function(rule) {
    var ok = rule.test(password);
    var el = $(rule.id);
    if (!el) return;
    el.classList.toggle('ok', ok);
    el.classList.toggle('bad', !ok);
    el.querySelector('i').className = ok ? 'fa-solid fa-circle-check text-[10px]' : 'fa-solid fa-circle-dot text-[10px]';
    if (ok && PASSWORD_RULES.indexOf(rule) < 4) score++;
  });
  for (var i = 1; i <= 4; i++) $('seg' + i).style.background = i <= score ? SEG_COLORS[score-1] : '#e2e8f0';
  var lbl = $('str-lbl');
  lbl.textContent = password.length ? STR_LABELS[score] : '';
  lbl.style.color = STR_TW[score] || '#94a3b8';
  checkMatch();
}

function checkMatch() {
  var p1 = $('reg-pass').value, p2 = $('reg-conf').value, msg = $('match-msg');
  if (!p2) { msg.textContent = ''; return; }
  if (p1 === p2) { msg.textContent = '✓ Passwords match'; msg.style.color = '#10b981'; $('reg-conf').classList.remove('is-error'); }
  else           { msg.textContent = '✗ Passwords do not match'; msg.style.color = '#ef4444'; $('reg-conf').classList.add('is-error'); }
}

function toggleVis(inputId, btn) {
  var inp = $(inputId), ico = btn.querySelector('i');
  inp.type = inp.type === 'password' ? 'text' : 'password';
  ico.classList.toggle('fa-eye',       inp.type === 'password');
  ico.classList.toggle('fa-eye-slash', inp.type === 'text');
}

// ═══════════════════════════════════════════════════
// EMAIL TAKEN INLINE LABEL
// ═══════════════════════════════════════════════════
function showEmailTaken(msg) {
  $('email-taken-txt').textContent = msg;
  $('email-taken-msg').classList.remove('hidden');
  $('reg-email').classList.add('is-error');
}
function clearEmailTakenMsg() {
  $('email-taken-msg').classList.add('hidden');
  $('reg-email').classList.remove('is-error');
}

// ═══════════════════════════════════════════════════
// STEP VALIDATION
// ═══════════════════════════════════════════════════
async function validateStep(step) {

  if (step === 1) {
    var email = $('reg-email').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showStepError(1, 'Please enter a valid email address.');
      return false;
    }
    if (!isGoogleSignup) {
      var pass = $('reg-pass').value, conf = $('reg-conf').value;
      var failed = PASSWORD_RULES.slice(0,5).filter(function(r){ return !r.test(pass); });
      if (failed.length) { showStepError(1, 'Your password must meet all 6 requirements above.'); return false; }
      if (pass !== conf) { showStepError(1, 'Passwords do not match.'); return false; }
    }
    hideStepError(1);
    return await sendOTP();
  }

  if (step === 3) {
    // Names
    var fOk = validateNameInline('reg-fname','fname-err');
    var lOk = validateNameInline('reg-lname','lname-err');
    if (!fOk) { showStepError(3, 'First name is required and must contain only letters.'); return false; }
    if (!lOk) { showStepError(3, 'Last name is required and must contain only letters.'); return false; }

    // Username removed — auto-generated server-side

    // Birthday
    var bday = $('reg-bday').value;
    if (!bday) { showStepError(3, 'Date of birth is required.'); return false; }
    var age = Math.floor((Date.now() - new Date(bday)) / (365.25 * 24 * 3600 * 1000));
    // Age check: applicants must be of appropriate age

    // Civil Status
    if (!$('reg-civil') || !$('reg-civil').value) { showStepError(3, 'Please select your civil status.'); return false; }

    // Sex
    var sex = document.querySelector('input[name="sex"]:checked');
    if (!sex) { showStepError(3, 'Please select your sex.'); return false; }

    // Phone
    if (!validatePhoneInline()) { showStepError(3, 'A valid Philippine phone number is required.'); $('reg-phone').focus(); return false; }
    // ⚠️ DEV MODE: submit-time phone check disabled. Uncomment the block below to re-enable.
    /* try {
      var phoneDigits = $('reg-phone').value.replace(/\D/g,'');
      var phoneRes  = await fetch(API.CHECK_PHONE + '?phone=' + encodeURIComponent(phoneDigits));
      var phoneData = await phoneRes.json();
      if (!phoneRes.ok) { showStepError(3, 'Could not verify phone number. Please try again.'); $('reg-phone').focus(); return false; }
      if (!phoneData.available) {
        var pErr = $('phone-err-msg');
        if (pErr) { pErr.textContent = 'This number is already registered.'; pErr.classList.remove('hidden'); }
        showStepError(3, 'This phone number is already registered. Please use a different number.');
        $('reg-phone').focus(); return false;
      }
      phoneAvailableStatus = true; phoneLastChecked = phoneDigits;
    } catch(e) {
      showStepError(3, 'Network error. Please check your connection and try again.');
      return false;
    } */

    // Permanent Address (required)
    if (!$('perm-region') || !$('perm-region').value) { showStepError(3, 'Please select your Permanent Address Region.'); return false; }
    if (!$('perm-city') || !$('perm-city').value)     { showStepError(3, 'Please select your Permanent Address City/Municipality.'); return false; }
    if (!$('perm-brgy') || !$('perm-brgy').value)     { showStepError(3, 'Please select your Permanent Address Barangay.'); return false; }
    if (PUROK_REQUIRED && !addrCleanPurok(($('perm-purok') || {}).value)) { showStepError(3, 'Please enter your Permanent Address Purok / Sitio.'); $('perm-purok') && $('perm-purok').focus(); return false; }
    buildAddrString('perm');

    // Present Address (required unless same-as-permanent checked)
    if (!$('same-as-permanent') || !$('same-as-permanent').checked) {
      if (!$('pres-region') || !$('pres-region').value) { showStepError(3, 'Please select your Present Address Region.'); return false; }
      if (!$('pres-city') || !$('pres-city').value)     { showStepError(3, 'Please select your Present Address City/Municipality.'); return false; }
      if (!$('pres-brgy') || !$('pres-brgy').value)     { showStepError(3, 'Please select your Present Address Barangay.'); return false; }
      if (PUROK_REQUIRED && !addrCleanPurok(($('pres-purok') || {}).value)) { showStepError(3, 'Please enter your Present Address Purok / Sitio.'); $('pres-purok') && $('pres-purok').focus(); return false; }
      buildAddrString('pres');
    } else {
      // Copy permanent to present
      if ($('pres-addr-hidden')) $('pres-addr-hidden').value = $('perm-addr-hidden') ? $('perm-addr-hidden').value : '';
    }

    // School Name / Address — required even in manual-entry mode
    if (!$('reg-school') || !$('reg-school').value.trim())       { showStepError(3, 'School Name is required.'); return false; }
    if (!$('reg-schooladdr') || !$('reg-schooladdr').value.trim()) { showStepError(3, 'School Address is required.'); return false; }

    // School — Year Level first, then Course, then optional Specialization.
    // Each has an independent "Not listed" checkbox — checked means the
    // dropdown is irrelevant and only its plain-text sibling is validated.
    var yearManualEl = $('reg-yearlevel-manual');
    var yearIsManual = !!($('yearlevel-manual-toggle') && $('yearlevel-manual-toggle').checked);
    if (yearIsManual) {
      if (!yearManualEl || !yearManualEl.value.trim()) { showStepError(3, 'Please type your year level.'); yearManualEl?.focus(); return false; }
    } else {
      if (!$('reg-yearlevel') || !$('reg-yearlevel').value) { showStepError(3, 'Please select your year level.'); return false; }
    }

    var courseManualEl = $('reg-course-manual');
    var courseIsManual = !!($('course-manual-toggle') && $('course-manual-toggle').checked);
    if (courseIsManual) {
      if (!courseManualEl || !courseManualEl.value.trim()) { showStepError(3, 'Please type your program / course.'); courseManualEl?.focus(); return false; }
    } else {
      if (!$('reg-course') || !$('reg-course').value) { showStepError(3, 'Please select your program / course.'); return false; }
    }

    // Specialization: required only when the row is visible. Manual course
    // entry forces specialization to optional free text (no cascade exists
    // for a course we don't recognize); otherwise it follows its own toggle.
    var specRow = $('specialization-row');
    if (specRow && !specRow.classList.contains('hidden') && !courseIsManual) {
      var specIsManual = !!($('specialization-manual-toggle') && $('specialization-manual-toggle').checked);
      if (specIsManual) {
        if (!$('reg-specialization-manual') || !$('reg-specialization-manual').value.trim()) {
          showStepError(3, 'Please type your major / specialization.'); return false;
        }
      } else if (!$('reg-specialization') || !$('reg-specialization').value) {
        showStepError(3, 'Please select your major / specialization.'); return false;
      }
    }

    // Monthly Income
    if (!$('reg-income') || !$('reg-income').value)    { showStepError(3, 'Please select your combined monthly income bracket.'); return false; }

    // ── Parent Information ─────────────────────────────────────────────────
    // Name is always required (it identifies the parent even if deceased);
    // contact/employer/address are skipped when the "deceased" box is checked.
    var fDeceased = !!($('father-deceased') && $('father-deceased').checked);
    var fFname    = ($('father-fname')||{}).value?.trim();
    var fLname    = ($('father-lname')||{}).value?.trim();
    if (!fFname) { showStepError(3, "Father's first name is required."); $('father-fname')?.focus(); return false; }
    if (!fLname) { showStepError(3, "Father's last name is required.");  $('father-lname')?.focus(); return false; }
    var fPhone = '', fEmployer = '', fAddr = '';
    if (!fDeceased) {
      fPhone    = ($('father-phone')||{}).value?.replace(/\D/g,'') || '';
      fEmployer = ($('father-employer')||{}).value?.trim();
      fAddr     = ($('father-addr-hidden')||{}).value?.trim();
      if (!fPhone || fPhone.length < 10) { showStepError(3, "Father's contact number must be 10 digits."); $('father-phone')?.focus(); return false; }
      if (fPhone[0] !== '9') { showStepError(3, "Father's contact number must start with 9."); $('father-phone')?.focus(); return false; }
      if (!fEmployer) { showStepError(3, "Father's employer / company is required."); $('father-employer')?.focus(); return false; }
      // Address required unless "Same as Permanent" is checked (which populates the hidden field)
      var fatherErr = familyAddrError('father', "Father");
      if (fatherErr) { showStepError(3, fatherErr.msg); $(fatherErr.focusId)?.focus(); return false; }
    }

    var mDeceased = !!($('mother-deceased') && $('mother-deceased').checked);
    var mFname    = ($('mother-fname')||{}).value?.trim();
    var mLname    = ($('mother-lname')||{}).value?.trim();
    if (!mFname) { showStepError(3, "Mother's first name is required."); $('mother-fname')?.focus(); return false; }
    if (!mLname) { showStepError(3, "Mother's last name is required.");  $('mother-lname')?.focus(); return false; }
    var mPhone = '', mEmployer = '', mAddr = '';
    if (!mDeceased) {
      mPhone    = ($('mother-phone')||{}).value?.replace(/\D/g,'') || '';
      mEmployer = ($('mother-employer')||{}).value?.trim();
      mAddr     = ($('mother-addr-hidden')||{}).value?.trim();
      if (!mPhone || mPhone.length < 10) { showStepError(3, "Mother's contact number must be 10 digits."); $('mother-phone')?.focus(); return false; }
      if (mPhone[0] !== '9') { showStepError(3, "Mother's contact number must start with 9."); $('mother-phone')?.focus(); return false; }
      if (!mEmployer) { showStepError(3, "Mother's employer / company is required."); $('mother-employer')?.focus(); return false; }
      var motherErr = familyAddrError('mother', "Mother");
      if (motherErr) { showStepError(3, motherErr.msg); $(motherErr.focusId)?.focus(); return false; }
    }

    // ── Guardian Information (required only when BOTH parents are deceased) ──
    if (fDeceased && mDeceased) {
      var gFname = ($('guardian-fname')||{}).value?.trim();
      var gLname = ($('guardian-lname')||{}).value?.trim();
      var gRel   = ($('guardian-relationship')||{}).value?.trim();
      var gPhone = ($('guardian-phone')||{}).value?.replace(/\D/g,'') || '';
      var gAddr  = ($('guardian-addr-hidden')||{}).value?.trim();
      if (!gFname) { showStepError(3, "Guardian's first name is required."); $('guardian-fname')?.focus(); return false; }
      if (!gLname) { showStepError(3, "Guardian's last name is required.");  $('guardian-lname')?.focus(); return false; }
      if (!gRel)   { showStepError(3, "Guardian's relationship to the resident is required."); $('guardian-relationship')?.focus(); return false; }
      if (!gPhone || gPhone.length < 10) { showStepError(3, "Guardian's contact number must be 10 digits."); $('guardian-phone')?.focus(); return false; }
      if (gPhone[0] !== '9') { showStepError(3, "Guardian's contact number must start with 9."); $('guardian-phone')?.focus(); return false; }
      var guardianErr = familyAddrError('guardian', "Guardian");
      if (guardianErr) { showStepError(3, guardianErr.msg); $(guardianErr.focusId)?.focus(); return false; }
    }

    hideStepError(3);
    return true;
  }

  if (step === 4) {
    // Profile photo only - required
    var hasPhoto = avatarFileRef || capturedPhotoData || ($('av-cropped-data') && $('av-cropped-data').value);
    if (_scan) { showStepError(4, 'Finish the face scan first \u2014 follow the instructions on the camera.'); return false; }
    if (!hasPhoto) { showStepError(4, 'Please take a live selfie with the camera to continue.'); return false; }
    if (!selfieIsVerified()) { showStepError(4, 'Your selfie has not passed the face scan. Tap \u201cRetake Selfie\u201d and follow the on-screen steps.'); return false; }
    hideStepError(4);
    return true;
  }

  return true;
}

// ═══════════════════════════════════════════════════
// SEND OTP (step 1 Continue)
// ═══════════════════════════════════════════════════
async function sendOTP() {
  var btn = $('btn-step1');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner mr-2"></span> Sending code...';

  var email = $('reg-email').value.trim();
  var body = isGoogleSignup
    ? { email: email, isGoogleSignup: true }
    : { email: email, password: $('reg-pass').value, confirmPassword: $('reg-conf').value };

  try {
    var res  = await fetch(API.SEND_OTP, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    var data = await res.json();

    btn.disabled = false;
    btn.innerHTML = 'Continue <i class="fa-solid fa-arrow-right ml-1.5"></i>';

    if (!res.ok) {
      if (res.status === 409) { showEmailTaken(data.error); return false; }
      showStepError(1, data.error || 'Failed to send verification code.');
      return false;
    }

    if (data.alreadyVerified) {
      // Refreshed mid-form and tapped Google again: this e-mail is already verified in the server session.
      // Resume at step 3 (with saved answers) instead of waiting for a code that was never sent.
      var resumed = false;
      try { resumed = await RegResilience.maybeResume({ googleEmail: email }); } catch (e) { console.warn('[Resume]', e); }
      if (resumed) return false;   // maybeResume() already switched the UI; stop go() from moving to step 2
    }

    $('otp-email').textContent = email;
    startCountdown();
    showToast('Code sent to ' + email + '!');
    return true;

  } catch(e) {
    btn.disabled = false;
    btn.innerHTML = 'Continue <i class="fa-solid fa-arrow-right ml-1.5"></i>';
    showStepError(1, 'Network error. Please check your connection.');
    return false;
  }
}

async function resendOTP() {
  var email = $('reg-email').value.trim();
  $('resend-btn').textContent = 'Sending...';
  $('resend-btn').disabled = true;
  try {
    var res  = await fetch(API.RESEND_OTP, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email: email }) });
    var data = await res.json();
    if (!res.ok) showStepError(2, data.error || 'Failed to resend code.');
    else { showToast('New code sent!'); startCountdown(); }
  } catch(e) { showStepError(2, 'Network error. Please try again.'); }
  $('resend-btn').disabled = false;
}

function startCountdown() {
  var secs = 60;
  clearInterval(countdownInterval);
  $('resend-timer').classList.remove('hidden');
  $('resend-btn').classList.add('hidden');
  $('cd').textContent = secs;
  countdownInterval = setInterval(function(){
    secs--;
    $('cd').textContent = secs;
    if (secs <= 0) { clearInterval(countdownInterval); $('resend-timer').classList.add('hidden'); $('resend-btn').classList.remove('hidden'); }
  }, 1000);
}

function lockOtpStepUi() {
  // Disable the Back button on step 2 (and step 3 back will also be blocked)
  var step2BackBtn = $('step-2').querySelector('button:last-child');
  if (step2BackBtn) {
    step2BackBtn.disabled = true;
    step2BackBtn.title = 'Email already verified';
    step2BackBtn.classList.add('opacity-40', 'cursor-not-allowed');
  }

  // Disable step 3 back button
  setTimeout(function() {
    var s3back = $('btn-step3-back');
    if (s3back) {
      s3back.disabled = true;
      s3back.title = 'Email already verified — cannot return to OTP step';
      s3back.classList.add('opacity-40', 'cursor-not-allowed');
      s3back.innerHTML = '<i class="fa-solid fa-lock mr-1 text-xs"></i> Email Verified';
    }
  }, 100);
}

async function verifyOTP() {
  var otp = otpGetValue();
  if (otp.length < 6) {
    showStepError(2, 'Please enter all 6 digits.');
    return;
  }

  var btn = $('btn-verify');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner mr-2"></span> Verifying...';

  try {
    var res  = await fetch(API.VERIFY_OTP, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email: $('reg-email').value.trim(), otp: otp }) });
    var data = await res.json();

    if (!res.ok) {
      var errMsg2 = data.error || 'Incorrect code. Please try again.';
      // Mark all boxes red + shake
      OTP_IDS.forEach(function(id){ var el = $(id); if (el) el.classList.add('otp-error'); });
      setTimeout(function(){ otpClearError(); }, 1500);
      showStepError(2, errMsg2);

      // If locked out (5 attempts exhausted) — disable boxes and verify button
      var isLocked = errMsg2.toLowerCase().includes('too many') || errMsg2.toLowerCase().includes('new code');
      if (isLocked) {
        OTP_IDS.forEach(function(id){ var el=$(id); if(el){ el.disabled=true; el.classList.add('opacity-50'); } });
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-lock mr-2"></i> Code Expired — Restart Registration';
        // Show resend/restart option
        var resendRow = $('resend-locked-msg');
        if (!resendRow) {
          resendRow = document.createElement('p');
          resendRow.id = 'resend-locked-msg';
          resendRow.className = 'text-center mt-3 text-xs text-slate-500';
          resendRow.innerHTML = 'Too many wrong attempts. <button onclick="resendOTP()" class="text-blue-600 font-semibold hover:underline">Request a new code</button>.';
          btn.parentNode.insertBefore(resendRow, btn.nextSibling);
        }
        resendRow.classList.remove('hidden');
      } else {
        btn.disabled = false;
        btn.innerHTML = 'Verify &amp; Continue <i class="fa-solid fa-arrow-right ml-1"></i>';
      }
      return;
    }

    // ✅ Email verified — lock OTP step so user can't go back
    otpVerified = true;
    clearInterval(countdownInterval);
    hideStepError(2);

    lockOtpStepUi();   // disables the Back buttons (shared with the resume flow)

    $('step-2').classList.add('hidden');
    currentStep = 3;
    $('step-3').classList.remove('hidden');
    updateProgress(3);
    document.querySelector('.overflow-y-auto').scrollTop = 0;
    // populate address dropdowns, then restore any saved answers for this e-mail (e.g. session expired earlier)
    initAddrDropdowns()
      .then(function(){ return RegResilience.restoreAfterVerify(); })
      .catch(function(e){ console.warn('[Resume]', e); });
    RegResilience.onStepChange(3);

  } catch(e) {
    showStepError(2, 'Network error. Please try again.');
    btn.disabled = false;
    btn.innerHTML = 'Verify &amp; Continue <i class="fa-solid fa-arrow-right ml-1"></i>';
  }
}

// ═══════════════════════════════════════════════════
// OTP BOX HELPERS
// ═══════════════════════════════════════════════════
var OTP_IDS = ['o1','o2','o3','o4','o5','o6'];

function otpClearError() {
  OTP_IDS.forEach(function(id) {
    var el = $(id);
    if (el) el.classList.remove('otp-error');
  });
  hideStepError(2);
}

function otpMove(cur, prevId, nextId) {
  // Strip non-digits
  cur.value = cur.value.replace(/[^0-9]/g, '');
  otpClearError();
  if (cur.value && nextId) {
    var next = $(nextId);
    if (next) next.focus();
  }
  // Auto-submit when all 6 boxes filled
  otpCheckAutoSubmit();
}

function otpBack(e, prevId) {
  if (e.key === 'Backspace' && !e.target.value && prevId) {
    var prev = $(prevId);
    if (prev) { prev.value = ''; prev.focus(); }
  }
}

function otpPaste(e) {
  e.preventDefault();
  var pasted = (e.clipboardData || window.clipboardData).getData('text');
  // Extract only digits from the pasted string
  var digits = pasted.replace(/\D/g, '').slice(0, 6);
  if (!digits.length) return;

  // Find which box was the paste target, fill from there
  var targetId = e.target.id;
  var startIdx = OTP_IDS.indexOf(targetId);
  if (startIdx === -1) startIdx = 0;

  otpClearError();
  for (var i = 0; i < digits.length && (startIdx + i) < OTP_IDS.length; i++) {
    var box = $(OTP_IDS[startIdx + i]);
    if (box) box.value = digits[i];
  }

  // Focus last filled box (or last box if all filled)
  var lastFilled = Math.min(startIdx + digits.length - 1, OTP_IDS.length - 1);
  var focusBox = $(OTP_IDS[lastFilled]);
  if (focusBox) focusBox.focus();

  otpCheckAutoSubmit();
}

function otpCheckAutoSubmit() {
  var allFilled = OTP_IDS.every(function(id) {
    var el = $(id);
    return el && el.value.length === 1;
  });
  if (allFilled) {
    // Short delay so user sees all boxes filled before verify fires
    setTimeout(function() { verifyOTP(); }, 300);
  }
}

function otpGetValue() {
  return OTP_IDS.map(function(id) {
    var el = $(id);
    return el ? el.value : '';
  }).join('');
}

// ═══════════════════════════════════════════════════
// PROFILE PICTURE — UPLOAD & CAMERA
// ═══════════════════════════════════════════════════
// ── Photo mode: cleanly separate UI toggle from actions ─────────
function setPhotoModeUI(mode) {
  // Just updates button styles + camera panel visibility. No side effects.
  var uploadBtn   = $('btn-upload-photo');
  var cameraBtn   = $('btn-camera-photo');
  var cameraPanel = $('camera-panel');
  var active   = 'flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold bg-blue-600 text-white shadow-sm shadow-blue-200 transition-all';
  var inactive = 'flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold border border-slate-200 text-slate-600 hover:bg-slate-50 transition-all';
  if (mode === 'upload') {
    if (uploadBtn) uploadBtn.className = active;
    if (cameraBtn) cameraBtn.className = inactive;
    if (cameraPanel) cameraPanel.classList.add('hidden');
  } else {
    if (uploadBtn) uploadBtn.className = inactive;
    if (cameraBtn) cameraBtn.className = active;
    if (cameraPanel) cameraPanel.classList.remove('hidden');
  }
}

function doUploadPhoto() {
  // Stop camera if running, switch UI to upload, open file picker
  stopCamera();
  setPhotoModeUI('upload');
  var inp = $('av-input');
  if (inp) inp.click();
}

async function doCameraPhoto() {
  // Check camera availability first before changing UI
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showStepError(4, 'Your browser does not support camera access. Please upload a photo instead.');
    return;
  }
  // Test permission without committing to camera mode UI yet
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    // Camera is available — now switch UI and show feed
    setPhotoModeUI('camera');
    var feed = $('camera-feed');
    if (feed) feed.srcObject = cameraStream;
  } catch(err) {
    var msg = (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')
      ? 'Camera permission denied. Please allow camera access in your browser settings, or upload a photo instead.'
      : 'Camera is unavailable on this device. Please upload a photo instead.';
    showStepError(4, msg);
    // Stay on upload mode — do not switch UI
    setPhotoModeUI('upload');
  }
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(function(t){ t.stop(); });
    cameraStream = null;
  }
  setPhotoModeUI('upload');
}

function capturePhoto() {
  var video  = $('camera-feed');
  var canvas = $('camera-canvas');
  if (!video || !canvas) return;
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  var dataUrl = canvas.toDataURL('image/jpeg', 0.88);
  capturedPhotoData = dataUrl;
  avatarFileRef = null;  // camera capture path — no File object needed
  $('av-ph').classList.add('hidden');
  $('av-prev').src = dataUrl;
  $('av-prev').classList.remove('hidden');
  // Show thumbnail + progress info for captured photo
  var bytes = Math.round((dataUrl.length * 3) / 4);
  var wrap = $('av-progress');
  if (wrap) {
    wrap.classList.remove('hidden');
    var bar = $('av-bar');
    if (bar) { bar.style.transition='none'; bar.style.width='100%'; }
    var st = $('av-status');   if (st) st.textContent = 'Captured ✓';
    var ld = $('av-loaded');   if (ld) ld.textContent = formatBytes(bytes) + ' / ' + formatBytes(bytes);
    var sp = $('av-speed');    if (sp) sp.textContent = '';
  }
  var thumb = $('av-thumb'); var thumbImg = $('av-thumb-img');
  var thumbName = $('av-thumb-name'); var thumbSize = $('av-thumb-size');
  if (thumb && thumbImg) {
    thumbImg.src = dataUrl;
    if (thumbName) thumbName.textContent = 'Camera capture';
    if (thumbSize) thumbSize.textContent = formatBytes(bytes);
    thumb.classList.remove('hidden');
  }
  stopCamera();
  hideStepError(4);
}

function previewAvatar(event) {
  var file = event.target.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    showStepError(4, 'Image is too large. Maximum size is 5MB.');
    event.target.value = '';
    return;
  }
  hideStepError(4);
  readFileWithProgress(file, {
    wrapperId: 'av-progress',
    barId:     'av-bar',
    loadedId:  'av-loaded',
    speedId:   'av-speed',
    statusId:  'av-status',
    onDone: function(dataUrl) {
      // Store dataUrl so file-upload path uses the same reliable blob-conversion
      // path as camera capture during FormData submission
      capturedPhotoData = dataUrl;
      avatarFileRef = file;        // keep File ref as backup
      // Small circular preview (existing)
      $('av-ph').classList.add('hidden');
      $('av-prev').src = dataUrl;
      $('av-prev').classList.remove('hidden');
      // Large thumbnail card
      var thumb = $('av-thumb');
      var thumbImg = $('av-thumb-img');
      var thumbName = $('av-thumb-name');
      var thumbSize = $('av-thumb-size');
      if (thumb && thumbImg) {
        thumbImg.src = dataUrl;
        if (thumbName) thumbName.textContent = file.name.length > 28 ? file.name.slice(0,26)+'…' : file.name;
        if (thumbSize) thumbSize.textContent = formatBytes(file.size);
        thumb.classList.remove('hidden');
      }
    }
  });
}


// ═══════════════════════════════════════════════════
// UPLOAD HELPERS — real-time progress, speed, size
// ═══════════════════════════════════════════════════

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024)          return bytes + ' B';
  if (bytes < 1024 * 1024)   return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

// cfg = {
//   wrapperId   : 'av-progress' | 'id-progress'
//   loadedId    : 'av-loaded'   | 'id-loaded'    (e.g. "1.2 MB / 3.4 MB")
//   speedId     : 'av-speed'    | 'id-speed'     (e.g. "820 KB/s")
//   barId       : 'av-bar'      | 'id-bar'
//   statusId    : 'av-status'   | 'id-status'    ("Reading file…" / "Done ✓")
//   onDone      : function(dataUrl) called with result
// }
function readFileWithProgress(file, cfg) {
  var wrap = $(cfg.wrapperId);
  if (wrap) wrap.classList.remove('hidden');

  var bar      = $(cfg.barId);
  var loadedEl = $(cfg.loadedId);
  var speedEl  = $(cfg.speedId);
  var statusEl = $(cfg.statusId);

  var startTime  = Date.now();
  var lastLoaded = 0;
  var lastTime   = startTime;

  function setBar(pct) {
    if (bar) { bar.style.transition = 'width 0.1s linear'; bar.style.width = pct + '%'; }
  }
  function setStatus(txt) { if (statusEl) statusEl.textContent = txt; }
  function setLoaded(loaded, total) {
    if (loadedEl) loadedEl.textContent = formatBytes(loaded) + ' / ' + formatBytes(total);
  }
  function setSpeed(bps) {
    if (speedEl) speedEl.textContent = bps > 0 ? formatBytes(Math.round(bps)) + '/s' : '';
  }

  var reader = new FileReader();

  reader.onloadstart = function() {
    setBar(0);
    setStatus('Reading file…');
    setLoaded(0, file.size);
    setSpeed(0);
  };

  reader.onprogress = function(e) {
    if (!e.lengthComputable) return;
    var pct  = Math.round((e.loaded / e.total) * 95); // cap at 95 until done
    var now  = Date.now();
    var dt   = (now - lastTime) / 1000;  // seconds since last event
    var bps  = dt > 0 ? (e.loaded - lastLoaded) / dt : 0;
    lastLoaded = e.loaded;
    lastTime   = now;
    setBar(pct);
    setLoaded(e.loaded, e.total);
    setSpeed(bps);
  };

  reader.onload = function(e) {
    var elapsed = (Date.now() - startTime) / 1000;
    var avgSpeed = elapsed > 0 ? file.size / elapsed : file.size;
    setBar(100);
    // Turn bar green to signal completion
    if (bar) bar.style.background = 'linear-gradient(90deg,#10b981,#34d399)';
    setLoaded(file.size, file.size);
    setSpeed(avgSpeed);
    setStatus('Done ✓');
    if (speedEl) {
      // Fade out speed after 2s
      setTimeout(function() {
        if (speedEl) speedEl.style.opacity = '0';
        setTimeout(function() {
          if (speedEl) { speedEl.textContent = ''; speedEl.style.opacity = '1'; }
        }, 400);
      }, 2000);
    }
    if (cfg.onDone) cfg.onDone(e.target.result);
  };

  reader.onerror = function() {
    setStatus('Error reading file');
    if (bar) { bar.style.background = '#ef4444'; bar.style.width = '100%'; }
  };

  reader.readAsDataURL(file);
}

// ═══════════════════════════════════════════════════
// ═══════════════════════════════════════════════════
// DAMIS MULTI-ADDRESS CASCADE
// loadAddrCascade(prefix, next) — prefix: pres/perm/father/mother
// ═══════════════════════════════════════════════════
var _addrCache = {};
var _addrInflight = {};
var PSGC_BASE = 'https://psgc.gitlab.io/api/';
var PSGC_LS = 'damis_psgc_v1:';

// Purok / Sitio / Street — free-text line shown under the Barangay dropdown of every address block.
// Required (red *) for the Permanent and Present address and for every parent/guardian address that is
// not a "Same as Permanent" copy. Set to false to make it optional again (also remove the * in index.html).
var PUROK_REQUIRED = true;
var ADDR_PUROK_MAX = 60;

// Address lookup order (see psgc-data.js):
//   1. Bundled Region III / Aurora data  — instant, no network (PSGC_PREFER_BUNDLED)
//   2. localStorage copy of an earlier live response
//   3. Live PSGC API  — 12 s timeout x 3 attempts (2 x 6 s when a bundled fallback exists)
//   4. Bundled data as a last resort if the live call failed
// A FAILED fetch returns [] with .__failed = true so callers can tell "service unreachable" apart from
// "this region genuinely has no provinces". Only non-Aurora addresses can still fail now.
async function psgcFetchAddr(endpoint) {
  if (_addrCache[endpoint]) return _addrCache[endpoint];
  if (_addrInflight[endpoint]) return _addrInflight[endpoint];
  _addrInflight[endpoint] = (async function () {
    var bundled = (typeof psgcBundled === 'function') ? psgcBundled(endpoint) : null;
    if (bundled && bundled.preferred) { _addrCache[endpoint] = bundled.list; return bundled.list; }

    try {
      var raw = localStorage.getItem(PSGC_LS + endpoint);
      if (raw) { var cached = JSON.parse(raw); if (Array.isArray(cached) && cached.length) { _addrCache[endpoint] = cached; return cached; } }
    } catch (_) {}

    var lastErr = null;
    var attempts = bundled ? 2 : 3, timeoutMs = bundled ? 6000 : 12000;
    for (var attempt = 1; attempt <= attempts; attempt++) {
      var ctrl = ('AbortController' in window) ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function(){ ctrl.abort(); }, timeoutMs) : null;
      try {
        var r = await fetch(PSGC_BASE + endpoint + '.json', ctrl ? { signal: ctrl.signal } : undefined);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var data = await r.json();
        var list = Array.isArray(data) ? data : [data];
        _addrCache[endpoint] = list;
        try { localStorage.setItem(PSGC_LS + endpoint, JSON.stringify(list)); } catch (_) {}
        return list;
      } catch (e) {
        lastErr = e;
        console.warn('[PSGC] ' + endpoint + ' attempt ' + attempt + '/' + attempts + ' failed:', e && e.message);
        if (attempt < attempts) await new Promise(function(res){ setTimeout(res, 800 * attempt); });
      } finally { if (timer) clearTimeout(timer); }
    }

    var errMsg = String(lastErr && lastErr.message || lastErr);
    if (bundled) {
      console.warn('[PSGC] live API unreachable — using bundled data for ' + endpoint);
      if (window.RegResilience) RegResilience.report('address_fallback_used', { kind: 'psgc', phase: endpoint.slice(0, 28), message: errMsg });
      _addrCache[endpoint] = bundled.list;   // memory only — never written to the localStorage "live" cache
      return bundled.list;
    }
    if (window.RegResilience) RegResilience.report('address_load_failed', { kind: 'psgc', phase: endpoint.slice(0, 28), message: errMsg });
    var failed = []; failed.__failed = true; return failed;
  })();
  try { return await _addrInflight[endpoint]; } finally { delete _addrInflight[endpoint]; }
}

// Purok / Sitio text → safe single address segment.
// The stored address is "[Purok - ]Barangay, City/Municipality, Province, Region, Philippines" and several
// server/admin parsers split it on commas by position, so the purok must never contain a comma and must stay
// INSIDE the first (barangay) segment. Markup characters are dropped as defence in depth (output is escaped too).
function addrCleanPurok(v) {
  var s = String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/[,;]+/g, ' / ')
    .replace(/(?:\s*\/\s*){2,}/g, ' / ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\/\s*|\s*\/$/g, '')
    .trim();
  return s.slice(0, ADDR_PUROK_MAX).trim();
}

function addrLoadFailed(what) {
  showToast("Couldn't load the list of " + what + ". Check your signal and select the previous field again. Living in Aurora? Choose Region III (Central Luzon) \u2192 Aurora.", 'error');
}

function resetAddrSelect(id, placeholder) {
  var el = $(id);
  if (!el) return;
  el.innerHTML = '<option value="">' + placeholder + '</option>';
  el.disabled = true;
}

function populateAddrSelect(id, items, placeholder) {
  var el = $(id);
  if (!el) return;
  el.innerHTML = '<option value="">' + placeholder + '</option>';
  items.sort(function(a,b){ return (a.name||'').localeCompare(b.name||''); }).forEach(function(item) {
    var o = document.createElement('option');
    o.value = item.code;
    o.textContent = item.name;
    el.appendChild(o);
  });
  el.disabled = false;
}

async function loadAddrCascade(prefix, next) {
  var regionEl   = $(prefix + '-region');
  var provinceEl = $(prefix + '-province');
  var cityEl     = $(prefix + '-city');
  var brgyEl     = $(prefix + '-brgy');

  if (next === 'province') {
    resetAddrSelect(prefix + '-province', '— Select Province —');
    resetAddrSelect(prefix + '-city',     '— Select City/Municipality —');
    resetAddrSelect(prefix + '-brgy',     '— Select Barangay —');
    if (!regionEl || !regionEl.value) return;
    var regionCode = regionEl.value;
    var regionCode9 = (typeof psgcNorm9 === 'function') ? psgcNorm9(regionCode) : regionCode;
    if (regionCode9 === '130000000' || regionCode === '1300000000') {   // NCR — no provinces
      if (provinceEl) { provinceEl.innerHTML = '<option value="__ncr__">N/A — NCR</option>'; }
      var cities = await psgcFetchAddr('regions/' + regionCode + '/cities-municipalities');
    if (cities.__failed) return addrLoadFailed('cities');
      populateAddrSelect(prefix + '-city', cities, '— Select City —');
    } else {
      var provinces = await psgcFetchAddr('regions/' + regionCode + '/provinces');
    if (provinces.__failed) return addrLoadFailed('provinces');
      if (provinces.length > 0) {
        populateAddrSelect(prefix + '-province', provinces, '— Select Province —');
      } else {
        if (provinceEl) { provinceEl.innerHTML = '<option value="__none__">N/A</option>'; }
        var cities2 = await psgcFetchAddr('regions/' + regionCode + '/cities-municipalities');
    if (cities2.__failed) return addrLoadFailed('cities');
        populateAddrSelect(prefix + '-city', cities2, '— Select City —');
      }
    }
  } else if (next === 'city') {
    resetAddrSelect(prefix + '-city', '— Select City/Municipality —');
    resetAddrSelect(prefix + '-brgy', '— Select Barangay —');
    if (!provinceEl) return;
    var provCode = provinceEl.value;
    if (!provCode || provCode === '__ncr__' || provCode === '__none__') return;
    var cities3 = await psgcFetchAddr('provinces/' + provCode + '/cities-municipalities');
    if (cities3.__failed) return addrLoadFailed('cities');
    populateAddrSelect(prefix + '-city', cities3, '— Select City/Municipality —');
  } else if (next === 'brgy') {
    resetAddrSelect(prefix + '-brgy', '— Select Barangay —');
    if (!cityEl || !cityEl.value) return;
    var barangays = await psgcFetchAddr('cities-municipalities/' + cityEl.value + '/barangays');
    if (barangays.__failed) return addrLoadFailed('barangays');
    populateAddrSelect(prefix + '-brgy', barangays, '— Select Barangay —');
  }
  buildAddrString(prefix);
}

function buildAddrString(prefix) {
  function selTxt(id) {
    var el = $(id); if (!el || el.selectedIndex <= 0) return '';
    return el.options[el.selectedIndex].text.replace(/\s+\(\d{4}\)$/, '').trim();
  }
  var parts = [];
  var brgy = selTxt(prefix + '-brgy'), city = selTxt(prefix + '-city');
  var prov = selTxt(prefix + '-province'), reg = selTxt(prefix + '-region');
  if (brgy && !brgy.startsWith('—') && !brgy.startsWith('N/A')) parts.push(brgy);
  if (city) parts.push(city);
  if (prov && !prov.startsWith('N/A')) parts.push(prov);
  if (reg) parts.push(reg);
  // Purok / Sitio joins the FIRST segment with " - " (never its own comma part) so positional parsers
  // (public coarse location, admin slip, DiCaDi check) keep reading city/province from the same places.
  var purok = addrCleanPurok(($(prefix + '-purok') || {}).value);
  if (purok && parts.length) parts[0] = purok + ' - ' + parts[0];
  parts.push('Philippines');
  var str = parts.join(', ');
  var hidden = $(prefix + '-addr-hidden');
  if (hidden) hidden.value = str;
  if (prefix === 'perm') syncSameAsPermanentCopies();
}

// "Same as Permanent" copies the permanent string when ticked. If the applicant then edits the permanent
// address (e.g. types the purok last), refresh every block that is still ticked so nothing goes out stale.
function syncSameAsPermanentCopies() {
  var permVal = ($('perm-addr-hidden') || {}).value || '';
  [['same-as-permanent', 'pres'], ['father-same-as-perm', 'father'], ['mother-same-as-perm', 'mother'], ['guardian-same-as-perm', 'guardian']]
    .forEach(function (pair) {
      var chk = $(pair[0]), h = $(pair[1] + '-addr-hidden');
      if (chk && chk.checked && h) h.value = permVal;
    });
}

function toggleSameAsPresent() {
  var chk = $('same-as-present');
  var fields = $('perm-addr-fields');
  if (!fields) return;
  if (chk && chk.checked) {
    fields.style.opacity = '0.4';
    fields.style.pointerEvents = 'none';
    var ph = $('perm-addr-hidden');
    if (ph) ph.value = $('pres-addr-hidden') ? $('pres-addr-hidden').value : '';
  } else {
    fields.style.opacity = '';
    fields.style.pointerEvents = '';
  }
}

// ── Default address: Region III (Central Luzon) → Aurora ─────────────────────
// Nearly all applicants live in Aurora, so every address block starts there (faster application).
// City/Municipality and Barangay are still chosen by the applicant, and Region/Province can be changed freely.
function addrSelectByCode(sel, code9) {
  if (!sel || typeof psgcNorm9 !== 'function') return false;
  for (var i = 0; i < sel.options.length; i++) {
    if (psgcNorm9(sel.options[i].value) === code9) { sel.selectedIndex = i; return true; }
  }
  return false;
}
async function applyDefaultAddress(prefix) {
  if (typeof PSGC_REGION_III === 'undefined' || typeof PSGC_AURORA === 'undefined') return;
  var r = $(prefix + '-region');
  if (!r || r.value) return;                       // never override something already chosen
  if (!addrSelectByCode(r, PSGC_REGION_III)) return;
  await loadAddrCascade(prefix, 'province');
  if (!addrSelectByCode($(prefix + '-province'), PSGC_AURORA)) return;
  await loadAddrCascade(prefix, 'city');
}

// Parent / guardian address check. The hidden address string is never empty once the defaults are applied,
// so check the dropdowns + purok directly. Skipped when "Same as Permanent" is ticked (copy of an address
// that was already validated). Returns null when fine, else { msg, focusId }.
function familyAddrError(prefix, who) {
  var same = $(prefix + '-same-as-perm');
  if (same && same.checked) return null;
  var checks = [['region', 'region'], ['province', 'province'], ['city', 'city / municipality'], ['brgy', 'barangay']];
  for (var i = 0; i < checks.length; i++) {
    var el = $(prefix + '-' + checks[i][0]);
    if (!el || !el.value) return { msg: who + "'s address: please select the " + checks[i][1] + ' (or check "Same as Permanent").', focusId: prefix + '-' + checks[i][0] };
  }
  if (PUROK_REQUIRED && !addrCleanPurok(($(prefix + '-purok') || {}).value)) return { msg: who + "'s address: Purok / Sitio / Street is required.", focusId: prefix + '-purok' };
  return null;
}

// Initialize address dropdowns on page load
async function initAddrDropdowns() {
  var prefixes = ['pres', 'perm', 'father', 'mother', 'guardian'];
  var data = await psgcFetchAddr('regions');
  if (data.__failed) {
    // Without regions the resident is stuck on step 3 — retry automatically and say so (previously: silent empty dropdown).
    window._addrRetries = (window._addrRetries || 0) + 1;
    window._addrErrShown = true;
    if (window._addrRetries <= 6) {
      showStepError(3, "Couldn't load the address list (the address service didn't respond). Retrying automatically…");
      setTimeout(initAddrDropdowns, 4000 * Math.min(window._addrRetries, 3));
    } else {
      showStepError(3, "Couldn't load the address list. Check your internet connection, then reload this page — your answers are saved.");
    }
    return;
  }
  if (window._addrErrShown) { window._addrErrShown = false; window._addrRetries = 0; hideStepError(3); }
  prefixes.forEach(function(prefix) {
    var el = $(prefix + '-region');
    if (!el) return;
    el.innerHTML = '<option value="">— Select Region —</option>';
    data.sort(function(a,b){ return (a.name||'').localeCompare(b.name||''); }).forEach(function(item) {
      var o = document.createElement('option'); o.value = item.code; o.textContent = item.name; el.appendChild(o);
    });
  });
  // Default every block to Region III → Aurora (instant: the data is bundled in psgc-data.js)
  await Promise.all(prefixes.map(function(prefix) { return applyDefaultAddress(prefix); }));
}

// ═══════════════════════════════════════════════════
// DAMIS DOCUMENT UPLOAD (Step 5)
// ═══════════════════════════════════════════════════
window._damis_docs = {};

function handleDocFile(evt, key) {
  var file = evt.target.files && evt.target.files[0];
  if (!file) return;
  var isImage = file.type.startsWith('image/');
  var isPdf   = file.type === 'application/pdf';
  var isDocx  = file.name.toLowerCase().endsWith('.docx');
  if (!isImage && !isPdf && !isDocx) { showStepError(5, 'Accepted formats: JPG, PNG, WEBP, PDF, DOCX.'); return; }
  // Photos are compressed before upload (reg-resilience.js), so big camera originals are fine; PDF/DOCX stay capped.
  var maxBytes = isImage ? 30 * 1024 * 1024 : 10 * 1024 * 1024;
  if (file.size > maxBytes) { showStepError(5, 'File too large (' + formatBytes(file.size) + '). Maximum ' + (isImage ? '30 MB per photo.' : '10 MB per document.')); return; }
  hideStepError(5);
  window._damis_docs[key] = file;
  RegResilience.onDocSelected(key, file);   // compress in background + keep a copy for draft resume
  var def = $('doc-def-' + key), prev = $('doc-prev-' + key), fn = $('doc-fn-' + key);
  var sz  = $('doc-sz-' + key);
  var thumb = $('doc-thumb-' + key);
  if (def)  def.classList.add('hidden');
  if (prev) prev.classList.remove('hidden');
  if (fn)   fn.textContent = file.name.length > 32 ? file.name.slice(0, 30) + '\u2026' : file.name;
  // ── Show file size ───────────────────────────────
  if (sz)   sz.textContent = formatBytes(file.size);
  console.log('[DAMIS Doc] ' + key + ' uploaded: ' + file.name + ' (' + formatBytes(file.size) + ')');
  // Show thumbnail
  if (thumb) {
    thumb.innerHTML = '';
    if (isImage) {
      var reader = new FileReader();
      reader.onload = function(e) {
        var img = document.createElement('img');
        img.src = e.target.result;
        img.className = 'w-full object-contain max-h-48';
        thumb.appendChild(img);
      };
      reader.readAsDataURL(file);
    } else if (isPdf) {
      // Show embedded PDF preview with full-page open link
      var pdfObjUrl = URL.createObjectURL(file);
      thumb.dataset.pdfObjUrl = pdfObjUrl; // store for revoke on clear
      thumb.innerHTML =
        '<div style="position:relative;width:100%;height:440px;background:#f8fafc;">'
        + '<iframe src="' + pdfObjUrl + '#toolbar=0&navpanes=0&scrollbar=1&view=FitH" '
        + 'style="width:100%;height:100%;border:none;" title="' + file.name + '"></iframe>'
        + '<a href="' + pdfObjUrl + '" target="_blank" rel="noopener" '
        + 'onclick="event.stopPropagation()" '
        + 'style="position:absolute;top:8px;right:8px;background:rgba(0,0,0,0.6);color:#fff;'
        + 'font-size:11px;font-weight:700;padding:5px 11px;border-radius:7px;text-decoration:none;'
        + 'display:flex;align-items:center;gap:5px;z-index:10;box-shadow:0 2px 8px rgba(0,0,0,0.25);">'
        + '<i class="fa-solid fa-up-right-from-square" style="font-size:10px;"></i> Open Full Page</a>'
        + '</div>';
    } else if (isDocx) {
      // Convert DOCX → PDF on the server via LibreOffice for an accurate print-preview.
      // Mammoth's client-side HTML conversion drops most formatting; a server-side PDF
      // round-trip renders the document exactly as it looks when printed.
      thumb.innerHTML =
        '<div class="flex flex-col items-center justify-center py-6 gap-2 text-slate-400">'
        + '<i class="fa-solid fa-spinner fa-spin text-2xl"></i>'
        + '<p class="text-xs">Converting to PDF preview…</p>'
        + '</div>';
      (async () => {
        try {
          var arrayBuf = await file.arrayBuffer();
          var fd       = new FormData();
          fd.append('file', new Blob([arrayBuf], { type: file.type }), file.name);

          var resp = await fetch('/api/auth/convert-docx-to-pdf', { method: 'POST', body: fd });
          if (!resp.ok) {
            var errData = await resp.json().catch(function(){ return {}; });
            throw new Error(errData.error || ('Server error ' + resp.status));
          }

          var pdfBlob = await resp.blob();
          var pdfUrl  = URL.createObjectURL(pdfBlob);
          thumb.dataset.pdfObjUrl = pdfUrl; // reuse existing revoke logic in clearDocFile

          thumb.innerHTML =
            '<div style="position:relative;width:100%;height:440px;background:#f8fafc;">'
            + '<iframe src="' + pdfUrl + '#toolbar=0&navpanes=0&scrollbar=1&view=FitH" '
            + 'style="width:100%;height:100%;border:none;" title="' + file.name + '"></iframe>'
            + '<a href="' + pdfUrl + '" target="_blank" rel="noopener" '
            + 'onclick="event.stopPropagation()" '
            + 'style="position:absolute;top:8px;right:8px;background:rgba(0,0,0,0.6);color:#fff;'
            + 'font-size:11px;font-weight:700;padding:5px 11px;border-radius:7px;text-decoration:none;'
            + 'display:flex;align-items:center;gap:5px;z-index:10;box-shadow:0 2px 8px rgba(0,0,0,0.25);">'
            + '<i class="fa-solid fa-up-right-from-square" style="font-size:10px;"></i> Open Full Page</a>'
            + '</div>';

          console.log('[DAMIS Doc] ' + key + ' DOCX→PDF preview ready (' + Math.round(pdfBlob.size / 1024) + ' KB)');
        } catch (err) {
          console.error('[DAMIS Doc] DOCX→PDF error for ' + key + ':', err);
          thumb.innerHTML =
            '<div class="flex flex-col items-center justify-center py-6 gap-2">'
            + '<i class="fa-solid fa-file-word text-blue-500 text-4xl"></i>'
            + '<p class="text-sm font-semibold text-slate-600">Word Document</p>'
            + '<p class="text-xs text-slate-400">Preview unavailable — file will upload correctly.</p>'
            + '<p class="text-xs text-red-400">' + (err.message || 'Conversion error') + '</p>'
            + '</div>';
        }
      })();
    }
  }
}

function handleDocDrop(evt, key) {
  evt.preventDefault();
  var zone = $('doc-zone-' + key);
  if (zone) zone.classList.remove('drag-over');
  var file = evt.dataTransfer && evt.dataTransfer.files && evt.dataTransfer.files[0];
  if (!file) return;
  handleDocFile({ target: { files: [file] } }, key);
}

function clearDocFile(evt, key) {
  if (evt) evt.stopPropagation();
  delete window._damis_docs[key];
  RegResilience.onDocCleared(key);
  var fileInput = $('doc-file-' + key), def = $('doc-def-' + key), prev = $('doc-prev-' + key);
  var thumb = $('doc-thumb-' + key);
  var sz    = $('doc-sz-' + key);
  if (fileInput) fileInput.value = '';
  if (def)  def.classList.remove('hidden');
  if (prev) prev.classList.add('hidden');
  if (sz)   sz.textContent = '';
  if (thumb) {
    if (thumb.dataset.pdfObjUrl)  { URL.revokeObjectURL(thumb.dataset.pdfObjUrl);  delete thumb.dataset.pdfObjUrl; }
    if (thumb.dataset.docxBlobUrl) { URL.revokeObjectURL(thumb.dataset.docxBlobUrl); delete thumb.dataset.docxBlobUrl; }
    thumb.innerHTML = '';
  }
  console.log('[DAMIS Doc] ' + key + ' cleared');
  hideStepError(5);
}

// ═══════════════════════════════════════════════════
// PSGC CASCADING ADDRESS
// psgc.cloud hierarchy endpoints — always correct child data
// Region → Province → City/Muni → Barangay
// NCR skips Province layer (no provinces)
// ═══════════════════════════════════════════════════

var _psgcCache = {};  // keyed by endpoint URL

async function psgcFetch(endpoint) {
  var url = 'https://psgc.cloud/api/' + endpoint;
  if (_psgcCache[url]) return _psgcCache[url];

  var loadEl = $('loc-loading');
  if (loadEl) loadEl.classList.remove('hidden');
  try {
    var res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    _psgcCache[url] = data;
    return data;
  } catch(e) {
    console.warn('[PSGC] fetch failed:', url, e.message);
    showToast('Could not load address data. Check your connection.', 'error');
    return [];
  } finally {
    if (loadEl) loadEl.classList.add('hidden');
  }
}

function populateSelect(selId, items, placeholder, labelFn) {
  var sel = $(selId);
  if (!sel) return;
  sel.innerHTML = '<option value="">' + placeholder + '</option>';
  var sorted = items.slice().sort(function(a, b) {
    return a.name.trim().localeCompare(b.name.trim());
  });
  sorted.forEach(function(item) {
    var opt = document.createElement('option');
    opt.value = item.code;
    opt.textContent = labelFn ? labelFn(item) : item.name.trim();
    sel.appendChild(opt);
  });
  sel.disabled = false;
}

function resetSelect(selId, placeholder) {
  var sel = $(selId);
  if (!sel) return;
  sel.innerHTML = '<option value="">' + placeholder + '</option>';
  sel.disabled = true;
}

function hideSummary() {
  var s = $('loc-summary');
  if (s) s.classList.add('hidden');
}

// ── Step 1: Regions (loaded once on entering step 3) ──────────────
async function loadRegions() {
  var data = await psgcFetch('regions');
  populateSelect('loc-region', data, '— Select Region —');
  resetSelect('loc-province', '— Select Province —');
  resetSelect('loc-city',     '— Select City / Municipality —');
  resetSelect('loc-brgy',     '— Select Barangay —');
  $('reg-loc').value = '';
  hideSummary();
}

// ── Step 2: Provinces (or skip to cities for NCR) ─────────────────
async function loadProvinces() {
  var regionCode = $('loc-region').value;
  resetSelect('loc-province', '— Select Province —');
  resetSelect('loc-city',     '— Select City / Municipality —');
  resetSelect('loc-brgy',     '— Select Barangay —');
  $('reg-loc').value = '';
  hideSummary();
  if (!regionCode) return;

  // NCR (1300000000) has no provinces — jump straight to cities
  if (regionCode === '1300000000') {
    var provSel = $('loc-province');
    provSel.innerHTML = '<option value="__ncr__">N/A — NCR has no provinces</option>';
    provSel.disabled = true;
    var cities = await psgcFetch('regions/' + regionCode + '/cities-municipalities');
    populateSelect('loc-city', cities, '— Select City / Municipality —', function(c) {
      return c.name.trim();
    });
    return;
  }

  var provinces = await psgcFetch('regions/' + regionCode + '/provinces');
  if (provinces.length > 0) {
    populateSelect('loc-province', provinces, '— Select Province —');
  } else {
    // Some regions (BARMM special units) may have no provinces
    var provSel = $('loc-province');
    provSel.innerHTML = '<option value="__none__">N/A — No provinces</option>';
    provSel.disabled = true;
    var cities = await psgcFetch('regions/' + regionCode + '/cities-municipalities');
    populateSelect('loc-city', cities, '— Select City / Municipality —', function(c) {
      return c.name.trim();
    });
  }
}

// ── Step 3: Cities / Municipalities ───────────────────────────────
async function loadCities() {
  var provinceCode = $('loc-province').value;
  resetSelect('loc-city', '— Select City / Municipality —');
  resetSelect('loc-brgy', '— Select Barangay —');
  $('reg-loc').value = '';
  hideSummary();
  if (!provinceCode || provinceCode === '__ncr__' || provinceCode === '__none__') return;

  // Use hierarchy endpoint: /provinces/{code}/cities-municipalities
  // This returns ONLY the cities & municipalities in this exact province
  var cities = await psgcFetch('provinces/' + provinceCode + '/cities-municipalities');
  populateSelect('loc-city', cities, '— Select City / Municipality —', function(c) {
    return c.name.trim();
  });
}

// ── Step 4: Barangays ─────────────────────────────────────────────
async function loadBarangays() {
  var cityCode = $('loc-city').value;
  resetSelect('loc-brgy', '— Select Barangay —');
  $('reg-loc').value = '';
  hideSummary();
  if (!cityCode) return;

  // Use hierarchy endpoint: /cities-municipalities/{code}/barangays
  var barangays = await psgcFetch('cities-municipalities/' + cityCode + '/barangays');
  if (barangays.length > 0) {
    populateSelect('loc-brgy', barangays, '— Select Barangay —');
  } else {
    // NCR cities have sub-municipalities instead of direct barangays
    // Try sub-municipalities then list their barangays combined
    var submunis = await psgcFetch('cities-municipalities/' + cityCode + '/sub-municipalities');
    if (submunis.length > 0) {
      var allBrgy = [];
      for (var i = 0; i < submunis.length; i++) {
        var brgy = await psgcFetch('sub-municipalities/' + submunis[i].code + '/barangays');
        allBrgy = allBrgy.concat(brgy);
      }
      populateSelect('loc-brgy', allBrgy, '— Select Barangay —');
    } else {
      var el = $('loc-brgy');
      el.innerHTML = '<option value="">— No barangay data —</option>';
      el.disabled = false;
    }
  }
}

// ── Build final location string ────────────────────────────────────
function buildLocationString() {
  function selText(id) {
    var el = $(id);
    if (!el || el.selectedIndex <= 0) return '';
    var t = el.options[el.selectedIndex].text;
    // Strip zip code suffix added for display
    return t.replace(/\s+\(\d{4}\)$/, '').trim();
  }

  var brgy = selText('loc-brgy');
  var city = selText('loc-city');
  var prov = selText('loc-province');
  var reg  = selText('loc-region');

  var skipProv = !prov || prov.startsWith('N/A');
  var parts = [];
  if (brgy && !brgy.startsWith('—') && !brgy.startsWith('No barangay')) parts.push(brgy);
  if (city) parts.push(city);
  if (!skipProv) parts.push(prov);
  if (reg) parts.push(reg);
  parts.push('Philippines');

  var locStr = parts.join(', ');
  $('reg-loc').value = locStr;
  $('loc-summary-txt').textContent = locStr;
  $('loc-summary').classList.remove('hidden');
}

// ═══════════════════════════════════════════════════
// ROOM PREFERENCE (Step 5) — live list of rooms that still have free beds
// ═══════════════════════════════════════════════════
// Backed by GET /api/auth/room-availability?sex=… (public, counts only).
// A pick is a REQUEST stored on the application; it never assigns a bed.
// The chosen room number lives in the hidden input #reg-room-pref so
// RegResilience can save/restore it with the rest of the draft.
var _roomPrefRooms = [];      // last list received from the server
var _roomPrefSeq   = 0;       // guards against out-of-order responses
var _roomPrefTimer = null;    // light polling while Step 5 is on screen

function _roomPrefStatus(msg, isError) {
  var el = $('room-pref-status');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'text-xs mt-2 ' + (isError ? 'text-amber-600' : 'text-slate-400');
}

function _roomPrefCard(attrs, selected, inner, extraCls) {
  return '<button type="button" role="radio" aria-checked="' + (selected ? 'true' : 'false') + '" ' + attrs +
    ' class="text-left rounded-xl border-2 px-3 py-2.5 transition-all ' + (extraCls || '') + ' ' +
    (selected
      ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30 ring-2 ring-blue-200 dark:ring-blue-900'
      : 'border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 hover:border-blue-300') +
    '">' + inner + '</button>';
}

function renderRoomPrefList() {
  var list = $('room-pref-list');
  if (!list) return;
  var selected = ($('reg-room-pref') || {}).value || '';

  var html = _roomPrefCard('onclick="selectRoomPref(\'\')"', selected === '',
    '<p class="text-sm font-bold text-slate-700 dark:text-slate-100"><i class="fa-solid fa-shuffle text-slate-400 mr-1.5"></i>No preference</p>' +
    '<p class="text-xs text-slate-400 mt-0.5">Let the dormitory manager decide.</p>', 'col-span-2');

  _roomPrefRooms.forEach(function (r) {
    var n        = Number(r.roomNumber);
    var free     = Number(r.freeBeds);
    var cap      = Number(r.capacity);
    var wanted   = Number(r.interested);
    var inDemand = wanted > 0 && wanted >= free;
    var demandHtml = wanted === 0
      ? '<p class="text-xs text-slate-400 mt-0.5">No requests yet</p>'
      : '<p class="text-xs mt-0.5 ' + (inDemand ? 'text-amber-600 font-semibold' : 'text-slate-500') + '">' +
          '<i class="fa-solid fa-users text-[10px] mr-1"></i>' + wanted + ' want' + (wanted === 1 ? 's' : '') + ' this room' +
          (inDemand ? ' &middot; high demand' : '') + '</p>';
    html += _roomPrefCard('onclick="selectRoomPref(' + n + ')"', String(n) === String(selected),
      '<p class="text-sm font-bold text-slate-700 dark:text-slate-100"><i class="fa-solid fa-door-open text-teal-500 mr-1.5"></i>Room ' + n + '</p>' +
      '<p class="text-xs text-green-600 font-semibold mt-0.5">' + free + ' of ' + cap + ' bed' + (cap === 1 ? '' : 's') + ' free</p>' +
      demandHtml);
  });

  if (!_roomPrefRooms.length) {
    html += '<p class="col-span-2 text-xs text-slate-400 py-2 text-center">No rooms with free beds right now. You can still submit with no preference.</p>';
  }
  list.innerHTML = html;
}

function selectRoomPref(roomNumber) {
  var el = $('reg-room-pref');
  if (!el) return;
  el.value = roomNumber === '' || roomNumber == null ? '' : String(roomNumber);
  renderRoomPrefList();
}

async function loadRoomPreferences(manual) {
  var list = $('room-pref-list');
  if (!list) return;

  var sexEl = document.querySelector('input[name="sex"]:checked');
  var sex   = sexEl ? sexEl.value : '';
  if (sex !== 'male' && sex !== 'female') {
    _roomPrefRooms = [];
    list.innerHTML = '<p class="col-span-2 text-xs text-slate-400 py-3 text-center">Select your sex in Step 3 to see the rooms available to you.</p>';
    return;
  }

  var seq = ++_roomPrefSeq;
  if (manual) _roomPrefStatus('Refreshing\u2026');

  try {
    var res  = await fetch('/api/auth/room-availability?sex=' + encodeURIComponent(sex), { cache: 'no-store' });
    var data = await res.json().catch(function () { return {}; });
    if (seq !== _roomPrefSeq) return;                       // a newer request already answered
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));

    _roomPrefRooms = Array.isArray(data.rooms) ? data.rooms : [];

    // A selected room that has filled up (or no longer matches the sex chosen in Step 3) is dropped.
    var cur = ($('reg-room-pref') || {}).value || '';
    if (cur && !_roomPrefRooms.some(function (r) { return String(r.roomNumber) === String(cur); })) {
      $('reg-room-pref').value = '';
      showToast('Room ' + cur + ' is no longer available \u2014 please choose another room.', 'info');
    }

    renderRoomPrefList();
    _roomPrefStatus(_roomPrefRooms.length + ' room' + (_roomPrefRooms.length === 1 ? '' : 's') +
      ' with free beds \u00b7 updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));

    if (!_roomPrefTimer) {
      _roomPrefTimer = setInterval(function () {
        if (currentStep !== 5) { clearInterval(_roomPrefTimer); _roomPrefTimer = null; return; }
        if (!document.hidden) loadRoomPreferences(false);
      }, 30000);
    }
  } catch (e) {
    if (seq !== _roomPrefSeq) return;
    console.warn('[DAMIS] room availability failed:', e.message);
    // Keep whatever list we already had; the field is optional so this never blocks submitting.
    if (!_roomPrefRooms.length) renderRoomPrefList();
    _roomPrefStatus('Could not load rooms (' + e.message + '). You can tap Refresh, or submit with no preference.', true);
  }
}

// ═══════════════════════════════════════════════════
// COMPLETE REGISTRATION (Step 5 submit button)
// ═══════════════════════════════════════════════════
async function completeRegistration() {
  var docs = window._damis_docs || {};
  // Safety net: a draft restored after a refresh can land on Step 5 with a photo that never passed the live scan.
  if (!selfieIsVerified() || !(avatarFileRef || capturedPhotoData)) {
    clearSelfiePhoto();
    backToSelfieStep('Please take your live selfie again \u2014 it has to pass the face scan before you can submit.');
    return;
  }
  if (!docs['school-id'])  { showStepError(5, 'Please upload your School ID or a valid Government ID.'); return; }
  if (!docs['residency'])  { showStepError(5, 'Please upload your Certificate of Residency.'); return; }
  if (!docs['low-income']) { showStepError(5, 'Please upload your Certificate of Low Income.'); return; }
  if (!docs['enrollment']) { showStepError(5, 'Please upload your Certificate of Registration/Enrollment.'); return; }
  if (!docs['grades'])     { showStepError(5, 'Please upload your Report Card / Certificate of Grades from last semester.'); return; }
  if (!$('chk-terms').checked) { showStepError(5, 'You must agree to the Terms & Conditions.'); return; }

  // NOTE: the Student Residents Questionnaire used to be required here before
  // an application could be submitted. It has moved to a dismissible card on
  // the resident's feed (public/js/resident-survey.js) — see
  // utils/researchSurvey.js for why: the manuscript's instrument is meant to
  // be answered "after [respondents] had interacted with and evaluated the
  // system", which an applicant at this step has not yet done, and gating a
  // dormitory application on an unrelated research survey ran against the
  // instrument's own consent statement ("has NO effect on the outcome of
  // your dormitory application").

  if (RegResilience.isUploading()) return;   // ignore double-taps while an upload is running

  var btn = $('btn-complete');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner mr-2"></span> Submitting application...';

  try {
    var phoneRaw = $('reg-phone') ? $('reg-phone').value.trim() : '';

    // Build FormData — send everything (fields + ID file) in ONE request
    var fd = new FormData();
    fd.append('firstName',  $('reg-fname').value.trim());
    fd.append('middleName', $('reg-mname') ? $('reg-mname').value.trim() : '');
    fd.append('lastName',   $('reg-lname').value.trim());
    fd.append('suffix',     $('reg-suffix') ? $('reg-suffix').value : '');
    fd.append('username',   ($('reg-uname') ? $('reg-uname').value.trim() : ''));
    fd.append('birthday',        $('reg-bday').value);
    fd.append('sex',             (document.querySelector('input[name="sex"]:checked') || {}).value || '');
    fd.append('civilStatus',     $('reg-civil') ? $('reg-civil').value : '');
    fd.append('phone',           phoneRaw);
    fd.append('bio',             $('reg-bio') ? $('reg-bio').value.trim() : '');
    fd.append('idType',          ($('reg-id-type') && $('reg-id-type').value) || 'school_id');

    // Present / Permanent address
    var permAddr = $('perm-addr-hidden') ? $('perm-addr-hidden').value : '';
    var presAddr = ($('same-as-permanent') && $('same-as-permanent').checked)
      ? permAddr
      : ($('pres-addr-hidden') ? $('pres-addr-hidden').value : '');
    fd.append('presentAddress',  presAddr);
    fd.append('permanentAddress', permAddr);
    fd.append('location',        presAddr);

    // School — either the default (readonly) value or whatever was manually typed
    fd.append('schoolName',   $('reg-school') ? $('reg-school').value.trim() : 'Aurora State College of Technology');
    fd.append('schoolAddress', $('reg-schooladdr') ? $('reg-schooladdr').value.trim() : 'Zabali, Baler, Aurora');

    // Year Level — manual text wins over the dropdown label when "Not listed" is checked
    var yearIsManual = !!($('yearlevel-manual-toggle') && $('yearlevel-manual-toggle').checked);
    var yearLevelVal = yearIsManual
      ? (($('reg-yearlevel-manual')||{}).value||'').trim()
      : ($('reg-yearlevel') ? $('reg-yearlevel').options[$('reg-yearlevel').selectedIndex].text : '');
    fd.append('yearLevel', yearLevelVal);

    // Course: if a specialization was selected, its value IS the specific course code
    // (e.g. BSIT-AP); otherwise the family key equals the code for single-track programs.
    // Manual course/specialization text (typed when "Not listed" is checked) takes priority.
    var courseIsManual = !!($('course-manual-toggle') && $('course-manual-toggle').checked);
    var specRow  = $('specialization-row');
    var specSel  = $('reg-specialization');
    var specIsManual = !!($('specialization-manual-toggle') && $('specialization-manual-toggle').checked);
    var specVal, courseVal;
    if (courseIsManual) {
      courseVal = (($('reg-course-manual')||{}).value||'').trim();
      specVal   = (($('reg-specialization-manual')||{}).value||'').trim();
    } else if (specIsManual) {
      specVal   = (($('reg-specialization-manual')||{}).value||'').trim();
      courseVal = specVal || ($('reg-course') ? $('reg-course').value : '');
    } else {
      specVal   = (specRow && !specRow.classList.contains('hidden') && specSel && specSel.value) ? specSel.value : '';
      courseVal = specVal || ($('reg-course') ? $('reg-course').value : '');
    }
    fd.append('course',         courseVal);
    fd.append('specialization', specVal);
    console.log('[REG] course=' + courseVal + ' (manual=' + courseIsManual + ') specialization=' + (specVal || '(none)'));

    // Family info — "deceased" is recorded on the JSON blob itself so the
    // shape stays identical to how the backend has always stored it; no new
    // top-level fields required. Contact/employer/address are left blank
    // when deceased (toggleParentDeceased() already clears them client-side).
    var fatherDeceased = !!($('father-deceased') && $('father-deceased').checked);
    var motherDeceased = !!($('mother-deceased') && $('mother-deceased').checked);
    var fatherInfo = JSON.stringify({
      firstName: ($('father-fname')||{}).value||'', middleName: ($('father-mname')||{}).value||'',
      lastName:  ($('father-lname')||{}).value||'', suffix:     ($('father-suffix')||{}).value||'',
      phone:     ($('father-phone')||{}).value||'', employer:   ($('father-employer')||{}).value||'',
      address:   ($('father-addr-hidden')||{}).value||'', deceased: fatherDeceased
    });
    var motherInfo = JSON.stringify({
      firstName: ($('mother-fname')||{}).value||'', middleName: ($('mother-mname')||{}).value||'',
      lastName:  ($('mother-lname')||{}).value||'', suffix:     ($('mother-suffix')||{}).value||'',
      phone:     ($('mother-phone')||{}).value||'', employer:   ($('mother-employer')||{}).value||'',
      address:   ($('mother-addr-hidden')||{}).value||'', deceased: motherDeceased
    });
    fd.append('fatherInfo',    fatherInfo);
    fd.append('motherInfo',    motherInfo);

    // Guardian info — only meaningful (and only validated) when both parents
    // are deceased, but we send it whenever present so nothing is silently lost.
    if (fatherDeceased && motherDeceased) {
      var guardianInfo = JSON.stringify({
        firstName: ($('guardian-fname')||{}).value||'', middleName: ($('guardian-mname')||{}).value||'',
        lastName:  ($('guardian-lname')||{}).value||'', suffix:     ($('guardian-suffix')||{}).value||'',
        relationship: ($('guardian-relationship')||{}).value||'',
        phone:     ($('guardian-phone')||{}).value||'', employer:   ($('guardian-employer')||{}).value||'',
        address:   ($('guardian-addr-hidden')||{}).value||''
      });
      fd.append('guardianInfo', guardianInfo);
    }
    fd.append('monthlyIncome', $('reg-income') ? $('reg-income').value : '');

    // Room preference (optional request — empty string = no preference) + note for the dorm manager.
    fd.append('roomPreference', $('reg-room-pref') ? $('reg-room-pref').value : '');
    fd.append('roommateNote',   $('reg-roommate-note') ? $('reg-roommate-note').value.trim().slice(0, 300) : '');

    // Attach DAMIS document files + profile photo.
    // Photos are resized to ≤1600 px JPEG first (a 4 MB phone photo → a few hundred KB) and files are copied
    // into memory, so the upload is small and cannot be broken by a picker file disappearing (reg-resilience.js).
    var prep = await RegResilience.prepareFiles({ docs: window._damis_docs || {} });
    var pd = prep.docs;
    if (pd['school-id'])  fd.append('id_front',        pd['school-id'].blob,  pd['school-id'].name);
    if (pd['residency'])  fd.append('cert_residency',  pd['residency'].blob,  pd['residency'].name);
    if (pd['low-income']) fd.append('cert_low_income', pd['low-income'].blob, pd['low-income'].name);
    if (pd['enrollment']) fd.append('cert_enrollment', pd['enrollment'].blob, pd['enrollment'].name);
    if (pd['grades'])     fd.append('cert_grades',     pd['grades'].blob,     pd['grades'].name);
    // Crop position is saved separately (percentages), so resizing the image does not move the crop.
    if (prep.avatar) {
      fd.append('avatar', prep.avatar.blob, prep.avatar.name || 'avatar.jpg');
      fd.append('selfie', prep.avatar.blob, prep.avatar.name || 'selfie.jpg');
    }
    // What the in-browser face scanner reported (the server only logs it — it re-checks the photo itself).
    fd.append('selfieCheck', JSON.stringify(window._selfieReport || { status: selfieIsVerified() ? 'restored-draft' : 'none', method: 'face-api@' + FACE_API_VERSION }));

    // ── Face crop position (percentage of original image) ────────
    var faceX = $('avatar-face-x') ? parseFloat($('avatar-face-x').value) : 50;
    var faceY = $('avatar-face-y') ? parseFloat($('avatar-face-y').value) : 50;
    var cropX  = $('avatar-crop-x')    ? parseFloat($('avatar-crop-x').value)    : 25;
    var cropY  = $('avatar-crop-y')    ? parseFloat($('avatar-crop-y').value)    : 25;
    var cropSz = $('avatar-crop-size') ? parseFloat($('avatar-crop-size').value) : 50;
    fd.append('avatarFaceX',    isNaN(faceX) ? 50   : Math.min(100, Math.max(0, faceX)));
    fd.append('avatarFaceY',    isNaN(faceY) ? 50   : Math.min(100, Math.max(0, faceY)));
    fd.append('avatarCropX',    isNaN(cropX) ? 25   : Math.min(100, Math.max(0, cropX)));
    fd.append('avatarCropY',    isNaN(cropY) ? 25   : Math.min(100, Math.max(0, cropY)));
    fd.append('avatarCropSize', isNaN(cropSz) ? 50  : Math.min(100, Math.max(5,  cropSz)));

    // ── Diagnostic: log what we're sending ───────────────────────
    var fdKeys = [];
    try { fd.forEach(function(v,k){ fdKeys.push(k+(v instanceof File||v instanceof Blob?' [file:'+((v.size/1024).toFixed(1))+'KB]':'')); }); } catch(e){}
    var docKeys = Object.keys(window._damis_docs || {});
    console.log('[DAMIS] FormData fields:', fdKeys.join(', ') || '(empty)');
    console.log('[DAMIS] Documents uploaded:', docKeys.length ? docKeys.join(', ') : 'none');
    console.log('[DAMIS] Avatar source:', capturedPhotoData ? 'camera' : avatarFileRef ? 'file' : 'none');

    // Upload with a real progress bar, stall/timeout detection and specific error messages
    var outcome = await RegResilience.submit(API.COMPLETE_REG, fd, { sizes: prep.sizes });

    if (!outcome.ok) {
      var fl = outcome.failure;
      var errMsg = fl.message + (fl.hint ? ' ' + fl.hint : '');
      if (fl.goStep === 4 || /^SELFIE_/.test(fl.code || '')) {
        // The server's own face check rejected the photo (or it was missing) — make them retake it.
        clearSelfiePhoto();
        btn.disabled = false;
        btn.innerHTML = 'Submit Application <i class="fa-solid fa-paper-plane ml-1"></i>';
        backToSelfieStep(fl.message);
        return;
      }
      var isUsernameTaken = fl.message.toLowerCase().includes('username') && fl.message.toLowerCase().includes('taken');
      var isPhoneTaken    = fl.message.toLowerCase().includes('phone') && fl.message.toLowerCase().includes('registered');
      if (isUsernameTaken || isPhoneTaken || fl.goStep === 3) {
        $('step-5').classList.add('hidden');
        $('step-3').classList.remove('hidden');
        currentStep = 3;
        updateProgress(3);
        if (!isUsernameTaken && !isPhoneTaken) showStepError(3, errMsg);
        if (isUsernameTaken) {
          var unameEl = $('reg-uname'); // field removed; username auto-generated
          if (unameEl) { unameEl.classList.add('is-error'); }
          var unameMsg = $('uname-status-msg');
          if (unameMsg) { unameMsg.textContent = errMsg; unameMsg.style.color = '#ef4444'; }
          var unameIcon = $('uname-status-icon');
          if (unameIcon) { unameIcon.textContent = '\u2717'; unameIcon.style.color = '#ef4444'; unameIcon.classList.remove('hidden'); }
          usernameAvailableStatus = false;
          usernameLastChecked = ($('reg-uname') || {}).value || '';
          showStepError(3, errMsg);
          if (unameEl) unameEl.focus();
        }
        if (isPhoneTaken) {
          var phoneEl = $('reg-phone');
          if (phoneEl) { phoneEl.classList.add('is-error'); }
          var phoneErr = $('phone-err-msg');
          if (phoneErr) { phoneErr.textContent = errMsg; phoneErr.style.color = ''; phoneErr.classList.remove('hidden'); }
          phoneAvailableStatus = false;
          phoneLastChecked = $('reg-phone') ? $('reg-phone').value.replace(/\D/g,'') : '';
          showStepError(3, errMsg);
          if (phoneEl) phoneEl.focus();
        }
      } else {
        // The picked room filled up / was removed between picking and submitting → refresh the list so they can re-pick.
        if (fl.code === 'ROOM_UNAVAILABLE') loadRoomPreferences(true);
        showStepError(5, errMsg);
      }
      btn.disabled = false;
      btn.innerHTML = 'Submit Application <i class="fa-solid fa-paper-plane ml-1"></i>';
      return;
    }

    RegResilience.onSubmitted();   // wipe the saved draft + photos from this device
    hideStepError(5);
    $('step-5').classList.add('hidden');
    $('step-ok').classList.remove('hidden');
    $('prog-bar').style.width = '100%';
    $('prog-bar').style.background = '#f59e0b';
    // Show the email address in the confirmation screen
    var confirmEmail = $('reg-confirm-email');
    if (confirmEmail) {
      var emailEl = $('reg-email') || $('reg-email-display');
      confirmEmail.textContent = emailEl ? emailEl.value.trim() : '';
    }
    showToast('Registration submitted! Check your email for next steps. ⏳');

  } catch(e) {
    console.error('completeRegistration error:', e);
    RegResilience.progressUI.hide();
    if (e && e.kind === 'file_unreadable') {
      var ex = RegResilience.explain(e);
      showStepError(5, ex.message + ' ' + ex.hint);
    } else {
      RegResilience.report('submit_exception', { message: String((e && e.message) || e) });
      showStepError(5, 'The app hit an unexpected problem while preparing your submission (' + String((e && e.message) || e).slice(0, 80) + '). ' +
                       'Please reload the page — your answers are saved — and try again.');
    }
    btn.disabled = false;
    btn.innerHTML = 'Submit Application <i class="fa-solid fa-paper-plane ml-1"></i>';
  }
}

// ═══════════════════════════════════════════════════
// ID DROP ZONE
// ═══════════════════════════════════════════════════
function processIdFile(file) {
  if (!file) return;
  // Only accept image files — PDFs not accepted for ID verification
  if (!file.type.startsWith('image/')) {
    showStepError(5, 'Only image files (JPG, PNG, WEBP, HEIC) are accepted. PDFs are not allowed for ID verification.');
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showStepError(5, 'ID file is too large. Maximum size is 10MB.');
    return;
  }
  hideStepError(5);
  readFileWithProgress(file, {
    wrapperId: 'id-progress',
    barId:     'id-bar',
    loadedId:  'id-loaded',
    speedId:   'id-speed',
    statusId:  'id-status',
    onDone: function(dataUrl) {
      // Compact drop-zone confirmed state
      $('id-def').classList.add('hidden');
      $('id-prev').classList.remove('hidden');
      var fn = $('id-fn');
      if (fn) fn.textContent = file.name.length > 28 ? file.name.slice(0,26)+'\u2026' : file.name;
      var sz = $('id-file-size');
      if (sz) sz.textContent = '\u2713 Ready \u00b7 ' + formatBytes(file.size);
      // Large thumbnail card — always an image now
      var thumb    = $('id-thumb');
      var thumbImg = $('id-thumb-img');
      var thumbPdf = $('id-thumb-pdf');
      var thumbName = $('id-thumb-name');
      var thumbSize = $('id-thumb-size');
      if (thumb) {
        var label = file.name.length > 28 ? file.name.slice(0,26)+'\u2026' : file.name;
        if (thumbName) thumbName.textContent = label;
        if (thumbSize) thumbSize.textContent = formatBytes(file.size);
        if (thumbImg) { thumbImg.src = dataUrl; thumbImg.classList.remove('hidden'); }
        if (thumbPdf) thumbPdf.classList.add('hidden');
        thumb.classList.remove('hidden');
      }
    }
  });
}
function handleIdFile(event) {
  var file = event.target.files[0];
  if (file) idFileRef = file;
  processIdFile(file);
}
function handleIdDrop(event) {
  event.preventDefault();
  $('id-zone').classList.remove('drag-over');
  var file = event.dataTransfer.files[0];
  if (!file) return;
  idFileRef = file;  // store reference reliably
  try { var dt = new DataTransfer(); dt.items.add(file); $('id-file').files = dt.files; } catch(e) {}
  processIdFile(file);
}
function clearIdFile(event) {
  event.stopPropagation();
  idFileRef = null;
  $('id-prev').classList.add('hidden');
  $('id-def').classList.remove('hidden');
  $('id-file').value = '';
  var wrap = $('id-progress'); if (wrap) wrap.classList.add('hidden');
  var bar  = $('id-bar');      if (bar)  { bar.style.width='0%'; bar.style.background=''; }
  var st   = $('id-status');   if (st)   st.textContent = 'Reading file\u2026';
  var ld   = $('id-loaded');   if (ld)   ld.textContent = '';
  var sp   = $('id-speed');    if (sp)   sp.textContent = '';
  var thumb = $('id-thumb');   if (thumb) thumb.classList.add('hidden');
}

// ═══════════════════════════════════════════════════
// TERMS MODAL
// ═══════════════════════════════════════════════════
function openTerms()  { var m=$('terms-modal'); m.classList.remove('hidden'); m.classList.add('flex'); }
function closeTerms() { var m=$('terms-modal'); m.classList.add('hidden'); m.classList.remove('flex'); }
function acceptTerms(){ $('chk-terms').checked = true; closeTerms(); showToast('Terms accepted!'); }

// ═══════════════════════════════════════════════════
// LIGHTBOX — full-screen image viewer
// ═══════════════════════════════════════════════════
function openLightbox(imgId, nameId, sizeId) {
  var img  = $(imgId);
  var name = $(nameId);
  var size = $(sizeId);
  if (!img || !img.src || img.classList.contains('hidden')) return;
  var lb = $('lightbox');
  var lbImg = $('lb-img');
  var lbName = $('lb-name');
  var lbSize = $('lb-size');
  lbImg.src = img.src;
  if (lbName) lbName.textContent = name ? name.textContent : '';
  if (lbSize) lbSize.textContent = size ? size.textContent : '';
  lb.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeLightbox(e) {
  // Only close if clicking the backdrop (not the image itself)
  if (e && e.target.id === 'lb-img') return;
  closeLightboxBtn();
}
function closeLightboxBtn() {
  $('lightbox').classList.add('hidden');
  document.body.style.overflow = '';
}
// Escape key closes lightbox
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    if (!$('lightbox').classList.contains('hidden')) closeLightboxBtn();
    if (!$('panel-forgot').classList.contains('hidden')) hideForgot();
  }
});

// ═══════════════════════════════════════════════════
// FORGOT PASSWORD
// ═══════════════════════════════════════════════════
var fpEmail = '';  // holds email across forgot-password sub-steps

function showForgot() {
  fpEmail = '';
  $('fp-email').value = $('login-email').value.trim(); // pre-fill from login
  $('fp-email-err').classList.add('hidden');
  ['fp-email-step','fp-otp-step','fp-pass-step','fp-done-step'].forEach(function(id) {
    var el = $(id); if (el) el.classList.add('hidden');
  });
  $('fp-email-step').classList.remove('hidden');
  $('panel-forgot').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  setTimeout(function() { $('fp-email').focus(); }, 100);
}

function hideForgot() {
  $('panel-forgot').classList.add('hidden');
  document.body.style.overflow = '';
}

function fpShowStep(stepId) {
  ['fp-email-step','fp-otp-step','fp-pass-step','fp-done-step'].forEach(function(id) {
    var el = $(id); if (el) el.classList.add('hidden');
  });
  var el = $(stepId); if (el) el.classList.remove('hidden');
}

function fpShowErr(errId, msg) {
  var el = $(errId); if (!el) return;
  el.querySelector('span').textContent = msg;
  el.classList.remove('hidden');
}
function fpHideErr(errId) {
  var el = $(errId); if (el) el.classList.add('hidden');
}

// ── Step 1: send OTP to email ─────────────────────
async function sendResetOTP() {
  var email = $('fp-email').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fpShowErr('fp-email-err', 'Please enter a valid email address.'); return;
  }
  fpHideErr('fp-email-err');
  var btn = $('fp-email-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner mr-2"></span> Sending…';
  try {
    var res  = await fetch(API.FORGOT_PASS, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email }) });
    var data = await res.json();
    if (!res.ok) {
      // 400 = Google account or validation error — these we CAN reveal
      fpShowErr('fp-email-err', data.error || 'Could not send reset code. Please try again.');
      btn.disabled = false;
      btn.innerHTML = 'Send Reset Code <i class="fa-solid fa-arrow-right ml-1"></i>';
      return;
    }
    // 200 — always advance to OTP step regardless of whether email exists
    // The server only sends a code if the account exists; we never reveal which
    fpEmail = email;
    $('fp-otp-email').textContent = email;
    // Clear OTP boxes
    ['ro1','ro2','ro3','ro4','ro5','ro6'].forEach(function(id) {
      var el = $(id); if (el) { el.value = ''; el.classList.remove('otp-error'); el.disabled = false; el.classList.remove('opacity-50'); }
    });
    fpHideErr('fp-otp-err');
    // Start resend countdown
    fpStartResendCountdown();
    fpShowStep('fp-otp-step');
    setTimeout(function() { $('ro1').focus(); }, 100);
  } catch(e) {
    fpShowErr('fp-email-err', 'Network error. Please try again.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Send Reset Code <i class="fa-solid fa-arrow-right ml-1"></i>';
  }
}

// Resend countdown for forgot-password OTP
var fpResendInterval = null;
function fpStartResendCountdown() {
  var timerEl  = $('fp-resend-timer');
  var resendEl = $('fp-resend-btn');
  var cdEl     = $('fp-resend-cd');
  if (!timerEl || !resendEl || !cdEl) return;
  clearInterval(fpResendInterval);
  var secs = 60;
  timerEl.classList.remove('hidden');
  resendEl.classList.add('hidden');
  cdEl.textContent = secs;
  fpResendInterval = setInterval(function() {
    secs--;
    cdEl.textContent = secs;
    if (secs <= 0) {
      clearInterval(fpResendInterval);
      timerEl.classList.add('hidden');
      resendEl.classList.remove('hidden');
    }
  }, 1000);
}

async function fpResendCode() {
  var btn = $('fp-resend-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    var res  = await fetch(API.FORGOT_PASS, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email: fpEmail }) });
    if (res.ok) {
      ['ro1','ro2','ro3','ro4','ro5','ro6'].forEach(function(id) {
        var el=$(id); if(el){ el.value=''; el.classList.remove('otp-error','opacity-50'); el.disabled=false; }
      });
      fpHideErr('fp-otp-err');
      fpStartResendCountdown();
      showToast('Reset code resent to ' + fpEmail);
      setTimeout(function(){ $('ro1').focus(); }, 100);
    } else {
      var d = await res.json();
      fpShowErr('fp-otp-err', d.error || 'Could not resend code. Please try again.');
    }
  } catch(e) {
    fpShowErr('fp-otp-err', 'Network error. Please try again.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Resend Code'; }
  }
}

function fpBackToEmail() {
  fpHideErr('fp-email-err');
  fpShowStep('fp-email-step');
  setTimeout(function() { $('fp-email').focus(); }, 100);
}

// ── Step 2: verify reset OTP ──────────────────────
var RESET_OTP_IDS = ['ro1','ro2','ro3','ro4','ro5','ro6'];

function resetOtpMove(cur, prevId, nextId) {
  cur.value = cur.value.replace(/[^0-9]/g, '');
  fpHideErr('fp-otp-err');
  RESET_OTP_IDS.forEach(function(id){ var el=$(id); if(el) el.classList.remove('otp-error'); });
  if (cur.value && nextId) { var n=$(nextId); if(n) n.focus(); }
  var allFilled = RESET_OTP_IDS.every(function(id){ var el=$(id); return el && el.value.length===1; });
  if (allFilled) setTimeout(verifyResetOTPCode, 300);
}
function resetOtpBack(e, prevId) {
  if (e.key==='Backspace' && !e.target.value && prevId) { var p=$(prevId); if(p){p.value='';p.focus();} }
}
function resetOtpPaste(e) {
  e.preventDefault();
  var digits = (e.clipboardData||window.clipboardData).getData('text').replace(/\D/g,'').slice(0,6);
  if (!digits.length) return;
  var startIdx = RESET_OTP_IDS.indexOf(e.target.id);
  if (startIdx === -1) startIdx = 0;
  RESET_OTP_IDS.forEach(function(id){ var el=$(id); if(el) el.classList.remove('otp-error'); });
  for (var i=0; i<digits.length && (startIdx+i)<RESET_OTP_IDS.length; i++) {
    var box=$(RESET_OTP_IDS[startIdx+i]); if(box) box.value=digits[i];
  }
  var last = Math.min(startIdx+digits.length-1, RESET_OTP_IDS.length-1);
  var fb=$(RESET_OTP_IDS[last]); if(fb) fb.focus();
  var allFilled = RESET_OTP_IDS.every(function(id){ var el=$(id); return el && el.value.length===1; });
  if (allFilled) setTimeout(verifyResetOTPCode, 300);
}

async function verifyResetOTPCode() {
  var otp = RESET_OTP_IDS.map(function(id){ var el=$(id); return el?el.value:''; }).join('');
  if (otp.length < 6) {
    fpShowErr('fp-otp-err', 'Please enter all 6 digits.'); return;
  }
  var btn = $('fp-otp-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner mr-2"></span> Verifying…';
  try {
    var res  = await fetch(API.VERIFY_RESET, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email: fpEmail, otp }) });
    var data = await res.json();
    if (!res.ok) {
      var fpErrMsg = data.error || 'Incorrect code. Please try again.';
      RESET_OTP_IDS.forEach(function(id){ var el=$(id); if(el) el.classList.add('otp-error'); });
      setTimeout(function(){ RESET_OTP_IDS.forEach(function(id){ var el=$(id); if(el) el.classList.remove('otp-error'); }); }, 1500);
      fpShowErr('fp-otp-err', fpErrMsg);

      var fpLocked = fpErrMsg.toLowerCase().includes('too many') || fpErrMsg.toLowerCase().includes('new code');
      if (fpLocked) {
        clearInterval(fpResendInterval);
        RESET_OTP_IDS.forEach(function(id){ var el=$(id); if(el){ el.disabled=true; el.classList.add('opacity-50'); } });
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-lock mr-2"></i> Code Locked';
        // Show resend immediately
        var timerEl = $('fp-resend-timer'); if(timerEl) timerEl.classList.add('hidden');
        var resendEl = $('fp-resend-btn'); if(resendEl) resendEl.classList.remove('hidden');
      } else {
        btn.disabled = false;
        btn.innerHTML = 'Verify Code <i class="fa-solid fa-arrow-right ml-1"></i>';
      }
      return;
    }
    // Move to new password step — reset all state
    $('fp-pass1').value = '';
    $('fp-pass2').value = '';
    var fpMatchMsg = $('fp-match-msg'); if (fpMatchMsg) fpMatchMsg.textContent = '';
    // Reset rule checklist to 'bad' state
    ['fp-req-len','fp-req-upper','fp-req-lower','fp-req-num','fp-req-sym','fp-req-ns'].forEach(function(id){
      var el=$(id); if(!el) return;
      el.classList.remove('ok'); el.classList.add('bad');
      el.querySelector('i').className = 'fa-solid fa-circle-dot text-[10px]';
    });
    for (var si=1;si<=4;si++){ var s=$('fp-seg'+si); if(s) s.style.background='#e2e8f0'; }
    var fpLbl=$('fp-str-lbl'); if(fpLbl) fpLbl.textContent='';
    fpHideErr('fp-pass-err');
    fpShowStep('fp-pass-step');
    setTimeout(function() { $('fp-pass1').focus(); }, 100);
  } catch(e) {
    fpShowErr('fp-otp-err', 'Network error. Please try again.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Verify Code <i class="fa-solid fa-arrow-right ml-1"></i>';
  }
}

// ── Step 3: set new password ──────────────────────
// Full PASSWORD_RULES-based evaluator for forgot-password new password step
// Uses fp- prefixed element IDs to avoid conflict with registration step 1
const FP_PASSWORD_RULES = [
  { id: 'fp-req-len',   test: function(p){ return p.length >= 8; } },
  { id: 'fp-req-upper', test: function(p){ return /[A-Z]/.test(p); } },
  { id: 'fp-req-lower', test: function(p){ return /[a-z]/.test(p); } },
  { id: 'fp-req-num',   test: function(p){ return /[0-9]/.test(p); } },
  { id: 'fp-req-sym',   test: function(p){ return /[^A-Za-z0-9]/.test(p); } },
  { id: 'fp-req-ns',    test: function(p){ return !/\s/.test(p) && p.length > 0; } },
];

function evalResetPass(val) {
  var score = 0;
  FP_PASSWORD_RULES.forEach(function(rule) {
    var ok = rule.test(val);
    var el = $(rule.id);
    if (!el) return;
    el.classList.toggle('ok', ok);
    el.classList.toggle('bad', !ok);
    el.querySelector('i').className = ok ? 'fa-solid fa-circle-check text-[10px]' : 'fa-solid fa-circle-dot text-[10px]';
    if (ok && FP_PASSWORD_RULES.indexOf(rule) < 4) score++;
  });
  for (var i = 1; i <= 4; i++) {
    var seg = $('fp-seg' + i);
    if (seg) seg.style.background = i <= score ? SEG_COLORS[score - 1] : '#e2e8f0';
  }
  var lbl = $('fp-str-lbl');
  if (lbl) { lbl.textContent = val.length ? STR_LABELS[score] : ''; lbl.style.color = STR_TW[score] || '#94a3b8'; }
  fpCheckMatch();
}

function fpCheckMatch() {
  var p1  = $('fp-pass1').value;
  var p2  = $('fp-pass2').value;
  var msg = $('fp-match-msg');
  if (!msg) return;
  if (!p2) { msg.textContent = ''; return; }
  if (p1 === p2) { msg.textContent = '\u2713 Passwords match'; msg.style.color = '#10b981'; $('fp-pass2').classList.remove('is-error'); }
  else           { msg.textContent = '\u2717 Passwords do not match'; msg.style.color = '#ef4444'; $('fp-pass2').classList.add('is-error'); }
}

async function submitResetPassword() {
  var pass1 = $('fp-pass1').value;
  var pass2 = $('fp-pass2').value;
  // Must meet all 6 rules
  var failed = FP_PASSWORD_RULES.filter(function(r){ return !r.test(pass1); });
  if (failed.length) {
    fpShowErr('fp-pass-err', 'Your password must meet all 6 requirements listed above.'); return;
  }
  if (pass1 !== pass2) {
    fpShowErr('fp-pass-err', 'Passwords do not match.'); return;
  }
  fpHideErr('fp-pass-err');
  var btn = $('fp-pass-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner mr-2"></span> Updating…';
  try {
    var res  = await fetch(API.RESET_PASS, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email: fpEmail, password: pass1 }) });
    var data = await res.json();
    if (!res.ok) {
      fpShowErr('fp-pass-err', data.error || 'Could not update password. Please try again.');
      btn.disabled = false;
      btn.innerHTML = 'Update Password <i class="fa-solid fa-check ml-1"></i>';
      return;
    }
    // Auto-fill login email and show success
    $('login-email').value = fpEmail;
    fpShowStep('fp-done-step');
  } catch(e) {
    fpShowErr('fp-pass-err', 'Network error. Please try again.');
    btn.disabled = false;
    btn.innerHTML = 'Update Password <i class="fa-solid fa-check ml-1"></i>';
  }
}

// ═══════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════
async function handleLogin() {
  var email = $('login-email').value.trim();
  var pass  = $('login-pass').value;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showLoginError('Please enter a valid email address.'); return; }
  if (!pass) { showLoginError('Password cannot be empty.'); return; }

  var btn = $('btn-login');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner mr-2"></span> Signing in...';

  try {
    var res  = await fetch(API.LOGIN, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email: email, password: pass }) });
    var data = await res.json();

    if (!res.ok) {
      var errMsg = data.error || 'Invalid credentials.';
      // Special visual treatment for pending/rejected accounts
      if (data.code === 'ACCOUNT_PENDING') {
        showLoginError('⏳ ' + errMsg);
      } else if (data.code === 'ACCOUNT_REJECTED') {
        showLoginError('🚫 ' + errMsg);
      } else if (data.code === 'NO_PASSWORD') {
        // Account was restored from rejection — no password on file yet. Auto-open forgot-password.
        showLoginError('🔑 ' + errMsg);
        var fpEmailInput = $('fp-email');
        if (fpEmailInput) fpEmailInput.value = email;
        setTimeout(function(){ showForgot(); }, 800);
      } else {
        showLoginError(errMsg);
      }
      // 429 = account locked — keep button disabled, show countdown
      if (res.status === 429) {
        btn.innerHTML = '<i class="fa-solid fa-lock mr-2"></i> Account Locked';
        btn.classList.add('bg-red-500', 'hover:bg-red-500');
        // Re-enable after 15 minutes
        setTimeout(function() {
          btn.disabled = false;
          btn.textContent = 'Sign In';
          btn.classList.remove('bg-red-500', 'hover:bg-red-500');
          showLoginError('');
          $('login-err').classList.add('hidden');
        }, 15 * 60 * 1000);
      } else {
        btn.disabled = false;
        btn.textContent = 'Sign In';
      }
      return;
    }

    showToast('Welcome back, ' + data.user.firstName + '! 👋');
    btn.innerHTML = '✓ Success! Redirecting...';
    // [TESTING] Admins go directly to admin panel
    var dest = (data.user && data.user.role === 'admin') ? '/admin.html' : '/feed.html';
    setTimeout(function(){ window.location.href = dest; }, 1200);

  } catch(e) {
    showLoginError('Network error. Please check your connection.');
    btn.disabled = false; btn.textContent = 'Sign In';
  }
}

function showLoginError(msg) {
  var b = $('login-err');
  $('login-err-txt').textContent = msg;
  b.classList.remove('hidden');
  b.classList.add('anim-shake');
  setTimeout(function(){ b.classList.remove('anim-shake'); }, 500);
}

// ═══════════════════════════════════════════════════
// GOOGLE AUTH
// ═══════════════════════════════════════════════════
function handleGoogleAuth(intent) {
  sessionStorage.setItem('googleIntent', intent || 'login');
  window.location.href = API.GOOGLE;
}

// ═══════════════════════════════════════════════════
// URL PARAMS — handle Google OAuth redirect
// ═══════════════════════════════════════════════════
// Shared by checkUrlParams() and the resume flow (reg-resilience.js): puts the sign-up form into "Google" mode.
function applyGoogleSignupUi(email) {
  isGoogleSignup = true;
  showTab('signup');

  var emailInput = $('reg-email');
  emailInput.value    = email;
  emailInput.readOnly = true;
  emailInput.style.background = '#eff6ff';
  emailInput.style.color = '#1d4ed8';
  emailInput.style.fontWeight = '600';

  $('google-banner-email').textContent = email;
  $('google-banner').classList.remove('hidden');
  $('pass-fields').classList.add('hidden');
  $('btn-google-signup').classList.add('hidden');
}

async function checkUrlParams() {
  var params = new URLSearchParams(window.location.search);
  window.history.replaceState({}, '', '/');

  if (params.get('unauthorized') === 'admin') {
    showTab('login');
    showLoginError('Admin access only. Please log in with an admin account.');
    return;
  }

  if (params.get('login') === 'google') {
    showToast('Signed in with Google! 👋');
    setTimeout(function(){ window.location.href = '/feed.html'; }, 1200);
    return;
  }

  if (params.get('error') === 'google_failed') {
    showTab('login');
    showLoginError('Google sign-in failed. Please try again.');
    return;
  }

  if (params.get('error') === 'google_email_taken') {
    var email = decodeURIComponent(params.get('email') || '');
    showTab('login');
    showLoginError(email
      ? email + ' already has an account with a password. Please log in with your email and password below.'
      : 'That Google account email is already registered. Please log in with your password.');
    if (email) $('login-email').value = email;
    return;
  }

  if (params.get('error') === 'google_pending') {
    showTab('login');
    showLoginError('Your account is pending admin approval. You will be notified by email once it is reviewed.');
    return;
  }

  if (params.get('error') === 'google_rejected') {
    showTab('login');
    showLoginError('Your account registration was not approved. Please contact support.');
    return;
  }

  if (params.get('error') === 'google_suspended') {
    showTab('login');
    showLoginError('Your account has been suspended. Please contact support.');
    return;
  }

  if (params.get('google') === 'pending_signup') {
    try {
      var res  = await fetch(API.PENDING_GOOGLE);
      var data = await res.json();

      if (data.pending) {
        applyGoogleSignupUi(data.email);

        // Already verified earlier in this session? Skip the OTP and restore saved answers.
        var resumedG = false;
        try { resumedG = await RegResilience.maybeResume({ googleEmail: data.email }); } catch (re) { console.warn('[Resume]', re); }
        window.__regResumeHandled = true;
        if (!resumedG) showToast('Google account recognised. Please complete your registration.', 'info');
      } else {
        showTab('login');
        showLoginError('Google session expired. Please try signing up again.');
      }
    } catch(e) {
      showTab('login');
      showLoginError('Something went wrong. Please try again.');
    }
    return;
  }
}

// ═══════════════════════════════════════════════════
// BIRTHDAY SETUP
// ═══════════════════════════════════════════════════
function setupBirthdayField() {
  var bd = $('reg-bday');
  if (!bd) return;
  var now = new Date();
  bd.max = new Date(now.getFullYear()-13, now.getMonth(), now.getDate()).toISOString().split('T')[0];
  bd.min = new Date(now.getFullYear()-120, now.getMonth(), now.getDate()).toISOString().split('T')[0];
  bd.addEventListener('change', function(){
    var msg = $('age-msg');
    var age = Math.floor((Date.now() - new Date(this.value)) / (365.25*24*3600*1000));
    if (age < 13) { msg.textContent = '⚠ Must be at least 13 years old.'; msg.style.color = '#ef4444'; }
    else          { msg.textContent = '✓ Age confirmed: ' + age + ' years old'; msg.style.color = '#10b981'; }
  });
}

// ═══════════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════════════
document.addEventListener('keydown', function(e){
  if (e.key === 'Escape') closeTerms();
  if (e.key === 'Enter' && !$('panel-login').classList.contains('hidden')) handleLogin();
});

// ═══════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════
// ── Contact Support chat ───────────────────────────────────────────────
// The support launcher + chat window now live in /js/support-chat.js and /css/support.css
// (showSupportInfo() is still available globally). FAQ + contacts: utils/supportKnowledge.js.

// ═══════════════════════════════════════════════════
// ASCOT COURSE CATALOG — now lives in js/course-catalog.js (loaded before this file).
// ASCOT_COURSES, ascotByValue() and ascotFamily() are globals defined there.
// ═══════════════════════════════════════════════════

// ── Year Level → Course cascade ───────────────────────────────────────────────
//
// Filtering rules (applied in order):
//   1. Year-range  : keep entries where minYear ≤ selectedYear ≤ maxYear
//   2. 1st-year    : per school, if ANY non-degree entries (diploma/associate/
//                    certificate) survived step 1, remove all bachelor/postgrad
//                    entries for that school.  Schools with ONLY bachelor entries
//                    keep those entries.
//   3. Dedup       : show ONE <option> per family (first occurrence wins).
//
function onYearLevelChange() {
  var yearSel   = $('reg-yearlevel');
  var courseSel = $('reg-course');
  var specRow   = $('specialization-row');
  var specSel   = $('reg-specialization');

  var yearVal = yearSel ? parseInt(yearSel.value, 10) : 0;

  // Reset downstream fields
  if (courseSel) {
    courseSel.innerHTML = '<option value="">' +
      (yearVal ? '\u2014 Select Program / Course \u2014' : '\u2014 Select Year Level first \u2014') + '</option>';
    courseSel.disabled = !yearVal;
  }
  if (specRow) specRow.classList.add('hidden');
  if (specSel) specSel.innerHTML = '<option value="">\u2014 Select Major / Specialization \u2014</option>';

  if (!yearVal) {
    console.log('[ASCOT] Year level cleared — cascades reset');
    return;
  }

  // ── Step 1: year-range filter ─────────────────────────────────────────────
  // Keep only programs whose duration covers the selected year.
  var inRange = ASCOT_COURSES.filter(function(c) {
    return yearVal >= c.minYear && yearVal <= c.maxYear;
  });

  // ── Step 2: lowest-tier non-degree rule (applies to ALL year levels) ───────
  //
  // For each school, find all non-degree programs (diploma / associate /
  // certificate) that survived step 1.  If any exist:
  //   a) Suppress ALL bachelor / postgrad entries for that school.
  //   b) Among the surviving non-degree entries, keep ONLY those whose maxYear
  //      equals the SMALLEST maxYear in that school — i.e. the shortest programs
  //      still active at this year level.
  //
  // This produces the correct tier per school per year:
  //   Yr 1  Industrial Tech → certificates only   (maxYear 1 is the minimum)
  //   Yr 2  Industrial Tech → associates only     (certs done; maxYear 2 is min)
  //   Yr 3  Industrial Tech → diplomas only       (assocs done; maxYear 3 is min)
  //   Yr 4  Industrial Tech → BIT bachelor        (all non-degree done)
  //   Yr 1  Forestry        → DFT diploma         (only non-degree option)
  //   Yr 3  Forestry        → BSF + BSES          (DFT done at yr 2)
  //
  var nonDegreeTypes = { certificate: true, associate: true, diploma: true };

  // Per school: track the lowest maxYear among its surviving non-degree programs.
  // undefined → school has no non-degree programs in range (bachelor-only school).
  var schoolLowestTierMax = {};
  inRange.forEach(function(c) {
    if (!nonDegreeTypes[c.type]) return;
    if (schoolLowestTierMax[c.school] === undefined ||
        c.maxYear < schoolLowestTierMax[c.school]) {
      schoolLowestTierMax[c.school] = c.maxYear;
    }
  });

  var visible = inRange.filter(function(c) {
    var lowestMax = schoolLowestTierMax[c.school];
    if (lowestMax !== undefined) {
      // School still has non-degree options at this year level:
      //   a) drop all degree/postgrad entries
      if (!nonDegreeTypes[c.type]) return false;
      //   b) keep only the lowest-tier non-degree entries
      return c.maxYear === lowestMax;
    }
    return true; // bachelor-only school — keep all
  });

  var suppressed = inRange.length - visible.length;
  if (suppressed > 0) {
    console.log('[ASCOT] Year ' + yearVal + ': suppressed ' + suppressed +
      ' entries (degree programs + higher-tier non-degree hidden while lower-tier exists)');
  }

  // ── Step 3: deduplicate by family ─────────────────────────────────────────
  var seenFamilies = {};
  var bySchool     = {};
  visible.forEach(function(c) {
    if (seenFamilies[c.family]) return;
    seenFamilies[c.family] = true;
    if (!bySchool[c.school]) bySchool[c.school] = [];
    bySchool[c.school].push(c);
  });

  // ── Build <optgroup> elements ──────────────────────────────────────────────
  Object.keys(bySchool).sort().forEach(function(school) {
    var og = document.createElement('optgroup');
    og.label = school;
    bySchool[school].forEach(function(c) {
      var opt         = document.createElement('option');
      opt.value       = c.family;      // family key → specific code via specialization
      opt.textContent = c.familyLabel;
      og.appendChild(opt);
    });
    if (courseSel) courseSel.appendChild(og);
  });

  var totalShown = Object.keys(seenFamilies).length;
  console.log('[ASCOT] Year ' + yearVal + ' → ' + visible.length +
    ' programs visible → ' + totalShown + ' unique course entries in dropdown');
}

// ── Manual-entry toggles ───────────────────────────────────────────────────
// Independent checkboxes, deliberately NOT tied to any dropdown option value
// or datalist/autocomplete — "not listed" means the resident's answer is not
// among the fixed choices, so it must not be constrained back to them, and
// the toggle state must not depend on (and reset with) the dropdown's value.

function toggleYearLevelManualMode() {
  var manual = $('yearlevel-manual-toggle').checked;
  var sel    = $('reg-yearlevel');
  var input  = $('reg-yearlevel-manual');
  var hint   = $('yearlevel-hint');
  if (manual) {
    sel.classList.add('hidden');
    input.classList.remove('hidden');
    input.focus();
    if (hint) hint.classList.add('hidden');
    // Can't filter courses by an unknown/non-standard year level — fall back
    // to letting the resident pick from the full unfiltered course list.
    buildFullCourseList();
  } else {
    sel.classList.remove('hidden');
    input.classList.add('hidden');
    input.value = '';
    if (hint) hint.classList.remove('hidden');
    onYearLevelChange(); // rebuild the course list filtered by the select's current value
  }
  console.log('[DAMIS] Year Level manual entry = ' + manual);
}

function buildFullCourseList() {
  var courseSel = $('reg-course');
  var specRow   = $('specialization-row');
  if (!courseSel) return;
  courseSel.innerHTML = '<option value="">\u2014 Select Program / Course \u2014</option>';
  courseSel.disabled = false;
  var seen = {}, bySchool = {};
  ASCOT_COURSES.forEach(function(c) {
    if (seen[c.family]) return;
    seen[c.family] = true;
    if (!bySchool[c.school]) bySchool[c.school] = [];
    bySchool[c.school].push(c);
  });
  Object.keys(bySchool).sort().forEach(function(school) {
    var og = document.createElement('optgroup'); og.label = school;
    bySchool[school].forEach(function(c) {
      var opt = document.createElement('option');
      opt.value = c.family; opt.textContent = c.familyLabel;
      og.appendChild(opt);
    });
    courseSel.appendChild(og);
  });
  if (specRow) specRow.classList.add('hidden');
  console.log('[ASCOT] Year level is manual — showing full unfiltered course list');
}

function toggleCourseManualMode() {
  var manual = $('course-manual-toggle').checked;
  var sel    = $('reg-course');
  var input  = $('reg-course-manual');
  var specRow      = $('specialization-row');
  var specSel      = $('reg-specialization');
  var specManual   = $('reg-specialization-manual');
  var specToggle   = $('specialization-manual-toggle');
  var specToggleWrap = $('specialization-manual-toggle-wrap');
  var specRequiredMark = $('specialization-required-mark');
  if (manual) {
    sel.classList.add('hidden');
    input.classList.remove('hidden');
    input.focus();
    // No known majors for a manually-typed course — expose Specialization as
    // an optional plain-text field instead of trying to cascade from it.
    if (specRow) specRow.classList.remove('hidden');
    if (specSel) specSel.classList.add('hidden');
    if (specManual) specManual.classList.remove('hidden');
    if (specToggleWrap) specToggleWrap.classList.add('hidden'); // already forced manual — no need to offer the toggle
    if (specRequiredMark) { specRequiredMark.textContent = ''; specRequiredMark.classList.remove('text-red-400'); }
  } else {
    sel.classList.remove('hidden');
    input.classList.add('hidden');
    input.value = '';
    if (specToggleWrap) specToggleWrap.classList.remove('hidden');
    if (specToggle) specToggle.checked = false;
    if (specRequiredMark) { specRequiredMark.textContent = '*'; specRequiredMark.classList.add('text-red-400'); }
    onCourseChange(); // rebuild the specialization cascade for whatever course is currently selected
  }
  console.log('[DAMIS] Program/Course manual entry = ' + manual);
}

function toggleSpecializationManualMode() {
  var manual = $('specialization-manual-toggle').checked;
  var sel    = $('reg-specialization');
  var input  = $('reg-specialization-manual');
  if (manual) {
    sel.classList.add('hidden');
    input.classList.remove('hidden');
    input.focus();
  } else {
    sel.classList.remove('hidden');
    input.classList.add('hidden');
    input.value = '';
  }
  console.log('[DAMIS] Major/Specialization manual entry = ' + manual);
}

// ── Course → Specialization cascade ──────────────────────────────────────────
//
// reg-course value = family key (e.g. "BSIT", "BIT", "BSEd").
// If the family has members with a `major` field → show Specialization dropdown.
// The reg-specialization value = specific track code (e.g. "BSIT-AP") sent to
// the backend.  For single-track families, family key === value code.
//
function onCourseChange() {
  var courseSel = $('reg-course');
  var specRow   = $('specialization-row');
  var specSel   = $('reg-specialization');

  if (!specRow || !specSel) return;

  var familyKey = courseSel ? courseSel.value : '';

  // Reset specialization
  specSel.innerHTML = '<option value="">\u2014 Select Major / Specialization \u2014</option>';

  if (!familyKey) {
    specRow.classList.add('hidden');
    return;
  }

  // Find all members of this family that carry a major/specialization
  var members = ASCOT_COURSES.filter(function(c) {
    return c.family === familyKey && c.major;
  });

  if (members.length > 0) {
    members.forEach(function(c) {
      var opt       = document.createElement('option');
      opt.value     = c.value;   // specific code sent to backend
      opt.textContent = c.major;
      specSel.appendChild(opt);
    });
    specRow.classList.remove('hidden');
    console.log('[ASCOT] Family "' + familyKey + '" → ' +
      members.length + ' specialization(s) shown');
  } else {
    // No specialization — single-track program
    specRow.classList.add('hidden');
    console.log('[ASCOT] Family "' + familyKey + '" → single-track (no specialization)');
  }
}

// ═══════════════════════════════════════════════════
// LIVE SELFIE — Step 4: camera-only capture + on-device face scanner
//
// Gallery uploads were removed on purpose (applicants were choosing photos that were not theirs). The photo can now
// only come from the live camera, and a frame is only accepted after the scanner has seen, in order:
//   1. exactly ONE face, well sized, centred in the oval, facing the camera, in decent light
//   2. two RANDOM actions (turn head left / turn head right / open mouth) — a printed photo or a still image on a
//      screen cannot do these
//   3. the face held still, looking straight, for a few frames → that frame is the profile photo, and the captured
//      still is itself re-checked (one face, frontal, big enough) before it is accepted.
// Detection runs fully in the browser (face-api.js Tiny Face Detector + 68-point tiny landmarks, loaded lazily from
// jsDelivr only when the camera opens — about 1.5 MB once, then cached). Nothing is uploaded until "Submit".
//
// This is a deterrent for casual misuse, not proof of identity: a determined person can still bypass any browser
// code. The server therefore re-checks the uploaded photo too (utils/faceCheck.js) and admins still review it.
// ═══════════════════════════════════════════════════
var FACE_API_VERSION = '1.7.12';
var FACE_API_SRC     = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@' + FACE_API_VERSION + '/dist/face-api.js';
var FACE_API_MODELS  = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@' + FACE_API_VERSION + '/model/';

var _selfieStream   = null;   // MediaStream while the camera is open
var _scan           = null;   // the running scan session (null when the camera is closed)
var _faceLibPromise = null;   // memoised library+model load (reset on failure so "Start" can retry)
var _lumaCanvas     = null;   // tiny canvas reused for brightness sampling

var SCAN_CHALLENGE_TEXT = {
  left:  '\u2190 Turn your head slowly LEFT',
  right: 'Turn your head slowly RIGHT \u2192',
  mouth: 'Open your mouth wide'
};

function selfieIsVerified() { var el = $('selfie-verified'); return !!el && el.value === 'passed'; }
function setSelfieVerified(on) { var el = $('selfie-verified'); if (el) el.value = on ? 'passed' : ''; }
function _dist(p, q) { var dx = p.x - q.x, dy = p.y - q.y; return Math.sqrt(dx * dx + dy * dy); }

function selfieHasPhoto() {
  var vf = $('av-viewfinder-wrap');
  return !!(vf && !vf.classList.contains('hidden') && (capturedPhotoData || avatarFileRef));
}

// idle = nothing taken yet · scanning = camera open · captured = verified photo is showing
function setStep4Mode(mode) {
  var panel = $('selfie-panel'), ph = $('av-placeholder-wrap'), vf = $('av-viewfinder-wrap');
  var btn = $('btn-selfie-start'), txt = $('btn-selfie-start-txt'), hint = $('selfie-hint');
  function show(el, on) { if (el) el.classList.toggle('hidden', !on); }
  if (mode === 'scanning') {
    show(panel, true); show(ph, false); show(btn, false); show(hint, false);
    if (vf) { vf.classList.add('hidden'); vf.classList.remove('flex'); }
  } else if (mode === 'captured') {
    show(panel, false); show(ph, false); show(btn, true); show(hint, true);
    if (txt) txt.textContent = 'Retake Selfie';
    if (hint) { hint.textContent = '\u2713 Face verified \u2014 drag the box to adjust the crop if needed.'; hint.className = 'text-xs text-green-600 font-semibold mb-2 mt-3 text-center'; }
  } else {   // idle
    show(panel, false); show(ph, true); show(btn, true); show(hint, true);
    if (vf) { vf.classList.add('hidden'); vf.classList.remove('flex'); }
    if (txt) txt.textContent = 'Start Live Selfie';
    if (hint) { hint.textContent = 'Live camera only \u00b7 no uploads'; hint.className = 'text-xs text-slate-400 mb-2 mt-3'; }
  }
}

function setScanLoading(on, text) {
  var box = $('selfie-loading'), t = $('selfie-loading-txt');
  if (box) box.classList.toggle('hidden', !on);
  if (t && text) t.textContent = text;
}

function setScanDots(n) {
  document.querySelectorAll('#selfie-steps .selfie-dot').forEach(function (d, i) {
    d.classList.toggle('bg-green-500', i < n);
    d.classList.toggle('bg-slate-300', i >= n);
  });
}

// ── library + model loading (lazy, cached by the browser after the first time) ──
function loadFaceScanner() {
  try {
    if (window.faceapi && faceapi.nets.tinyFaceDetector.isLoaded && faceapi.nets.faceLandmark68TinyNet.isLoaded) return Promise.resolve();
  } catch (e) { /* fall through to a normal load */ }
  if (_faceLibPromise) return _faceLibPromise;
  _faceLibPromise = new Promise(function (resolve, reject) {
    function loadModels() {
      faceapi.nets.tinyFaceDetector.loadFromUri(FACE_API_MODELS)
        .then(function () { return faceapi.nets.faceLandmark68TinyNet.loadFromUri(FACE_API_MODELS); })
        .then(resolve, reject);
    }
    if (window.faceapi) { loadModels(); return; }
    var sc = document.createElement('script');
    sc.src = FACE_API_SRC; sc.async = true; sc.crossOrigin = 'anonymous';
    sc.onload  = function () { if (window.faceapi) loadModels(); else reject(new Error('face scanner library loaded but is unusable')); };
    sc.onerror = function () { reject(new Error('could not download the face scanner library')); };
    document.head.appendChild(sc);
  }).catch(function (e) { _faceLibPromise = null; throw e; });
  return _faceLibPromise;
}

// ── open the camera and start scanning ──
async function doModeSelfie() {
  if (_scan) return;                                   // already running (double tap)
  hideStepError(4);
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showStepError(4, 'This browser cannot open the camera. Please use the latest Chrome, Safari or Edge on a phone or laptop that has a camera.');
    return;
  }
  var session = {
    cancelled: false, done: false, stage: 'align', challenges: [], idx: 0, good: 0, chHold: 0, chStart: 0,
    resets: 0, errors: 0, tick: 0, luma: null, lostSince: 0, lastCx: null, flash: '', flashUntil: 0,
    hadPhoto: selfieHasPhoto(), prevVerified: selfieIsVerified()
  };
  _scan = session;
  setSelfieVerified(false);                            // a retake invalidates the previous pass until the new one succeeds
  setStep4Mode('scanning');
  setScanDots(0);
  setScanLoading(true, 'Opening camera\u2026');
  var oval = $('selfie-oval'); if (oval) oval.style.borderColor = 'rgba(255,255,255,0.6)';
  var instr = $('selfie-instruction'); if (instr) instr.classList.add('hidden');

  try {
    _selfieStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
    if (session.cancelled) { stopSelfieCamera(); return; }
    var feed = $('selfie-feed');
    feed.srcObject = _selfieStream;
    try { await feed.play(); } catch (e) { /* autoplay attribute covers this */ }
    setScanLoading(true, 'Loading face scanner\u2026 (first time only)');
    await loadFaceScanner();
    if (session.cancelled) return;
  } catch (err) {
    if (session.cancelled) return;
    scanFailed(err);
    return;
  }
  setScanLoading(false);
  console.log('[Selfie] camera + scanner ready');
  startScanLoop(session);
}

function cancelSelfie() {
  var s = _scan;
  stopSelfieCamera();                                  // also cancels the session
  hideStepError(4);
  if (s && s.hadPhoto) { setSelfieVerified(s.prevVerified); setStep4Mode('captured'); var vf = $('av-viewfinder-wrap'); if (vf) { vf.classList.remove('hidden'); vf.classList.add('flex'); } }
  else setStep4Mode('idle');
}

function scanFailed(err) {
  var s = _scan;
  console.warn('[Selfie] scanner stopped:', err && (err.name || ''), err && err.message);
  stopSelfieCamera();
  var name = (err && err.name) || '', msg;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError')
    msg = 'Camera permission was denied. Allow camera access for this site in your browser settings, then tap Start Live Selfie again.';
  else if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError')
    msg = 'No camera was found on this device. A live selfie is required, so please use a phone or laptop with a camera.';
  else if (name === 'NotReadableError' || name === 'TrackStartError')
    msg = 'The camera is being used by another app. Close it and tap Start Live Selfie again.';
  else if (err && err.message === 'SCAN_GAVE_UP')
    msg = 'We could not complete the face scan. Move to a well-lit place, remove sunglasses/mask, hold the phone at eye level and try again \u2014 or tap \u201cNeed help?\u201d to contact support.';
  else
    msg = 'The face scanner could not start (' + String((err && err.message) || 'unknown error').slice(0, 80) + '). Check your internet connection and tap Start Live Selfie to try again.';
  if (s && s.hadPhoto) { setSelfieVerified(s.prevVerified); setStep4Mode('captured'); var vf = $('av-viewfinder-wrap'); if (vf) { vf.classList.remove('hidden'); vf.classList.add('flex'); } }
  else setStep4Mode('idle');
  showStepError(4, msg);
}

function stopSelfieCamera() {
  if (_scan) { _scan.cancelled = true; _scan = null; }
  if (_selfieStream) {
    _selfieStream.getTracks().forEach(function (t) { t.stop(); });
    _selfieStream = null;
    console.log('[Selfie] Camera stream stopped');
  }
  var feed = $('selfie-feed');
  if (feed) feed.srcObject = null;
}

// Throw away a rejected / unusable selfie so the applicant has to take a new one.
function clearSelfiePhoto() {
  capturedPhotoData = null; avatarFileRef = null;
  window._selfieReport = null;
  setSelfieVerified(false);
  var cd = $('av-cropped-data'); if (cd) cd.value = '';
  setStep4Mode('idle');
}

// Send the applicant back to Step 4 (used when Step 5 is reached/submitted without a verified selfie).
function backToSelfieStep(message) {
  var from = $('step-' + currentStep); if (from) from.classList.add('hidden');
  currentStep = 4;
  $('step-4').classList.remove('hidden');
  updateProgress(4);
  var sc = document.querySelector('.overflow-y-auto'); if (sc) sc.scrollTop = 0;
  RegResilience.onStepChange(4);
  if (message) showStepError(4, message);
}

// ── geometry helpers ──
// The <video> uses object-fit:cover, so only part of the camera frame is visible. All "is the face in the oval /
// big enough" checks, and the captured photo, use that visible part so what the applicant sees is what is judged.
function selfieVisibleRect(video) {
  var vw = video.videoWidth, vh = video.videoHeight;
  var cw = video.clientWidth || vw, ch = video.clientHeight || vh;
  var scale = Math.max(cw / vw, ch / vh);
  var w = cw / scale, h = ch / scale;
  return { x: (vw - w) / 2, y: (vh - h) / 2, w: w, h: h };
}

function frameBrightness(video, vis) {
  if (!_lumaCanvas) _lumaCanvas = document.createElement('canvas');
  _lumaCanvas.width = 32; _lumaCanvas.height = 24;
  var ctx = _lumaCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, vis.x, vis.y, vis.w, vis.h, 0, 0, 32, 24);
  var d = ctx.getImageData(0, 0, 32, 24).data, sum = 0;
  for (var i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return sum / (d.length / 4);
}

// Turns raw detections into { state: none|multi|adjust|ok, msg, yaw, mar, score, box, vis }.
//   yaw ≈ 0.5 facing the camera; > 0.66 head turned to the viewer's LEFT; < 0.34 turned RIGHT
//   mar = mouth-open ratio (≈ 0 closed, ≥ 0.35 clearly open)
function analyseFace(video, res) {
  if (!res || !res.length) return { state: 'none', msg: 'No face found \u2014 look at the camera' };
  if (res.length > 1)      return { state: 'multi', msg: 'Only one person in the frame, please' };
  var r = res[0], box = r.detection.box, vis = selfieVisibleRect(video), p = r.landmarks.positions;
  var out = {
    state: 'adjust', box: box, vis: vis, score: r.detection.score,
    yaw: (p[30].x - p[0].x) / ((p[16].x - p[0].x) || 1),
    mar: _dist(p[62], p[66]) / (_dist(p[60], p[64]) || 1)
  };
  var hRatio = box.height / vis.h;
  var cx = (box.x + box.width / 2 - vis.x) / vis.w, cy = (box.y + box.height / 2 - vis.y) / vis.h;
  if (out.score < 0.6)                                            { out.msg = 'Hold still \u2014 we can\u2019t see your face clearly'; return out; }
  if (hRatio < 0.30)                                              { out.msg = 'Move a little closer'; return out; }
  if (hRatio > 0.72)                                              { out.msg = 'Move back a little'; return out; }
  if (Math.abs(cx - 0.5) > 0.16 || Math.abs(cy - 0.5) > 0.18)     { out.msg = 'Center your face in the oval'; return out; }
  out.state = 'ok'; out.msg = 'Face detected';
  return out;
}

function newScanChallenges(s) {
  // After two failed rounds fall back to the two head turns only — they are the most reliable to detect.
  var pool = s.resets >= 2 ? ['left', 'right'] : ['left', 'right', 'mouth'];
  for (var i = pool.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
  s.challenges = pool.slice(0, 2);
}

function resetScan(s, msg) {
  s.resets++;
  console.log('[Selfie] scan restarted (' + s.resets + '): ' + msg);
  if (s.resets >= 5) { scanFailed(new Error('SCAN_GAVE_UP')); return; }
  s.stage = 'align'; s.good = 0; s.idx = 0; s.chHold = 0; s.lostSince = 0; s.lastCx = null;
  newScanChallenges(s);
  setScanDots(0);
  s.flash = msg; s.flashUntil = Date.now() + 2500;
}

function paintScan(s, a, state, instruction) {
  var oval = $('selfie-oval'), st = $('selfie-status'), ins = $('selfie-instruction');
  var st2 = state || a.state;
  if (oval) oval.style.borderColor = st2 === 'ok' ? '#22c55e' : st2 === 'adjust' ? '#f59e0b' : st2 === 'multi' ? '#ef4444' : 'rgba(255,255,255,0.6)';
  var statusText;
  if (Date.now() < s.flashUntil) statusText = s.flash;
  else if (s.stage === 'challenge' && a.state !== 'none' && a.state !== 'multi') statusText = 'Action ' + (s.idx + 1) + ' of ' + s.challenges.length;
  else if (s.stage === 'final' && a.state === 'ok') statusText = 'Almost done';
  else statusText = a.msg || '';
  if (st && st.textContent !== statusText) st.textContent = statusText;
  var insText = instruction || (s.stage === 'align' && a.state !== 'none' && a.state !== 'multi' ? 'Look straight at the camera' : '');
  if (ins) { ins.textContent = insText; ins.classList.toggle('hidden', !insText); }
}

function startScanLoop(session) {
  var video = $('selfie-feed');
  var opts  = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 });
  newScanChallenges(session);
  (async function tick() {
    if (session.cancelled || _scan !== session) return;
    var t0 = Date.now();
    try {
      var track = _selfieStream && _selfieStream.getVideoTracks()[0];
      if (!track || track.readyState === 'ended') { scanFailed(new Error('the camera stopped')); return; }
      if (video.readyState >= 2 && video.videoWidth) {
        var res = await faceapi.detectAllFaces(video, opts).withFaceLandmarks(true);
        if (session.cancelled || _scan !== session) return;
        await handleScanFrame(session, video, res, opts);
        if (session.cancelled || session.done || _scan !== session) return;
      }
    } catch (e) {
      session.errors++;
      console.warn('[Selfie] frame error:', e.message);
      if (session.errors >= 8) { scanFailed(new Error('the scanner crashed: ' + e.message)); return; }
    }
    setTimeout(tick, Math.max(30, 140 - (Date.now() - t0)));   // ~7 fps max; slower phones just run slower
  })();
}

async function handleScanFrame(s, video, res, opts) {
  var now = Date.now(), a = analyseFace(video, res);

  if (a.state === 'ok') {                               // lighting only matters once the face is otherwise well placed
    if ((s.tick++ % 4) === 0) s.luma = frameBrightness(video, a.vis);
    if (s.luma !== null && s.luma < 50)       { a.state = 'adjust'; a.msg = 'Too dark \u2014 turn toward a light'; }
    else if (s.luma !== null && s.luma > 230) { a.state = 'adjust'; a.msg = 'Too bright \u2014 reduce the glare'; }
  }

  if (a.state === 'none' || a.state === 'multi') {
    s.good = 0; s.chHold = 0;
    if (!s.lostSince) s.lostSince = now;
    if (s.stage !== 'align' && now - s.lostSince > 3000) { resetScan(s, 'Face lost \u2014 let\u2019s start again'); if (s.cancelled) return; }
    paintScan(s, a);
    return;
  }
  s.lostSince = 0;

  var frontal = a.state === 'ok' && a.yaw >= 0.40 && a.yaw <= 0.60 && a.mar < 0.30;

  if (s.stage === 'align') {
    s.good = frontal ? s.good + 1 : 0;
    paintScan(s, a, frontal ? 'ok' : 'adjust');
    if (s.good >= 3) { s.stage = 'challenge'; s.idx = 0; s.good = 0; s.chHold = 0; s.chStart = now; setScanDots(1); }
    return;
  }

  if (s.stage === 'challenge') {
    var ch  = s.challenges[s.idx];
    var met = a.score >= 0.5 && ((ch === 'left' && a.yaw >= 0.66) || (ch === 'right' && a.yaw <= 0.34) || (ch === 'mouth' && a.mar >= 0.35));
    s.chHold = met ? s.chHold + 1 : 0;
    paintScan(s, a, met ? 'ok' : 'adjust', SCAN_CHALLENGE_TEXT[ch]);
    if (s.chHold >= 2) {
      s.idx++; s.chHold = 0; s.chStart = now; setScanDots(1 + s.idx);
      if (s.idx >= s.challenges.length) { s.stage = 'final'; s.good = 0; s.lastCx = null; }
    } else if (now - s.chStart > 15000) {
      resetScan(s, 'That took too long \u2014 let\u2019s try again');
    }
    return;
  }

  // final: look straight and hold still, then capture
  var steady = frontal;
  var cx = a.box.x + a.box.width / 2;
  if (steady && s.lastCx !== null && Math.abs(cx - s.lastCx) > a.vis.w * 0.04) steady = false;
  s.lastCx = cx;
  s.good = steady ? s.good + 1 : 0;
  paintScan(s, a, steady ? 'ok' : 'adjust', 'Look straight \u2014 hold still\u2026');
  if (s.good >= 4) await finishSelfieScan(s, video, opts);
}

// Grab the verified frame, re-check the still itself, then hand it to the crop viewfinder.
async function finishSelfieScan(s, video, opts) {
  var canvas = $('selfie-canvas');
  var vis = selfieVisibleRect(video);
  var k = Math.min(1, 1280 / Math.max(vis.w, vis.h));    // keep phone photos small
  canvas.width = Math.round(vis.w * k); canvas.height = Math.round(vis.h * k);
  canvas.getContext('2d').drawImage(video, vis.x, vis.y, vis.w, vis.h, 0, 0, canvas.width, canvas.height);

  var check = await faceapi.detectAllFaces(canvas, opts).withFaceLandmarks(true);
  var ok = false, yaw = null;
  if (check.length === 1) {
    var d = check[0], p = d.landmarks.positions;
    yaw = (p[30].x - p[0].x) / ((p[16].x - p[0].x) || 1);
    var h = d.detection.box.height / canvas.height;
    ok = d.detection.score >= 0.6 && h >= 0.26 && h <= 0.8 && yaw >= 0.36 && yaw <= 0.64;
  }
  if (!ok) { resetScan(s, 'That shot didn\u2019t pass \u2014 let\u2019s try again'); return; }
  if (s.cancelled) return;

  var dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  capturedPhotoData = dataUrl;
  avatarFileRef = null;

  var fakeFile = null;
  try {
    var parts = dataUrl.split(','), mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/jpeg';
    var bStr = atob(parts[1]), ab = new Uint8Array(bStr.length);
    for (var i = 0; i < bStr.length; i++) ab[i] = bStr.charCodeAt(i);
    fakeFile = new File([new Blob([ab], { type: mime })], 'selfie.jpg', { type: mime });
  } catch (e) { /* old browser — the raw data URL is used instead */ }

  window._selfieReport = { status: 'passed', method: 'face-api@' + FACE_API_VERSION, challenges: s.challenges.slice(), resets: s.resets, yaw: yaw === null ? null : Math.round(yaw * 100) / 100, ts: Date.now() };
  setSelfieVerified(true);
  setScanDots(4);
  s.done = true;
  stopSelfieCamera();
  setStep4Mode('captured');
  previewAvatarViewfinder({ target: { result: dataUrl, files: fakeFile ? [fakeFile] : [] } }, true);
  hideStepError(4);
  console.log('[Selfie] verified + captured (' + formatBytes(Math.round(dataUrl.length * 3 / 4)) + ', challenges: ' + s.challenges.join('+') + ', restarts: ' + s.resets + ')');
  showToast('Face verified! Adjust the crop frame if needed.', 'success');
}

document.addEventListener('DOMContentLoaded', async function(){
  // ── Already logged-in? Skip the login page entirely ──
  try {
    var meRes  = await fetch('/api/auth/me');
    var meData = await meRes.json();
    if (meData.loggedIn && meData.user) {
      var dest = meData.user.role === 'admin' ? '/admin.html' : '/feed.html';
      window.location.replace(dest);
      return; // stop further init
    }
  } catch (_) { /* network error — show login form normally */ }

  setupBirthdayField();
  RegResilience.init();                         // autosave + diagnostics hooks
  window.addEventListener('online', function(){ if (window._addrErrShown) initAddrDropdowns(); });
  var hadParams = window.location.search.length > 1;   // checkUrlParams() wipes the query string
  await checkUrlParams();
  if (!window.__regResumeHandled && !hadParams) {
    // Plain reload mid-registration: the verified e-mail still lives in the server session — pick up where they left off.
    try { await RegResilience.maybeResume({}); } catch (e) { console.warn('[Resume]', e); }
  }
  $('terms-modal').addEventListener('click', function(e){ if (e.target === $('terms-modal')) closeTerms(); });
  console.log('PGA-DAMIS auth module loaded ✅ (v2 enhanced)');
});
