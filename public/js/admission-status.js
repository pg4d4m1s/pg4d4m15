/**
 * public/js/admission-status.js — live dormitory slots on the login page
 *
 * Loads GET /api/auth/admission-status and
 *  • fills every [data-admission-card] box with "approved / max beds" + slots left for Male and Female
 *    (the same numbers the admin sees in Registrations);
 *  • when a sex is FULL, disables that sex in the sign-up form (Step 3) so nobody fills a long form for nothing;
 *  • when applications are closed for everyone, shows a notice on the sign-up tab.
 * The server re-checks everything on submit (routes/auth.js), so this file is only a hint — it can never open anything.
 *
 * Phones: stacked cards on small screens, side by side from 400px; refreshes when the tab becomes visible or the
 * phone comes back online (at most every 30 s) and once a minute while visible. Failures keep the last numbers.
 * Text is inserted with textContent only.
 */
(function () {
  'use strict';

  var ENDPOINT = '/api/auth/admission-status';
  var TIMEOUT_MS = 8000, MIN_REFRESH = 30 * 1000, POLL_MS = 60 * 1000;
  var last = 0, inFlight = false, state = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function cell(sex, g) {
    var male = sex === 'male';
    var box = el('div', 'flex-1 min-w-0 rounded-xl border px-3 py-2.5 bg-white dark:bg-slate-800 ' +
      (g.open ? 'border-slate-200 dark:border-slate-700' : 'border-red-200 dark:border-red-800'));
    var head = el('div', 'flex items-center justify-between gap-2 mb-1');
    var title = el('span', 'text-xs font-bold text-slate-600 dark:text-slate-300 flex items-center gap-1.5');
    var icon = el('i', 'fa-solid ' + (male ? 'fa-mars text-blue-500' : 'fa-venus text-pink-500'));
    icon.setAttribute('aria-hidden', 'true');
    title.appendChild(icon);
    title.appendChild(document.createTextNode(male ? 'Male' : 'Female'));
    var badge = el('span', 'text-[11px] font-bold rounded-full px-2 py-0.5 whitespace-nowrap ' +
      (g.open ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'),
      g.open ? 'Open' : (g.reason === 'full' ? 'Full' : 'Closed'));
    head.appendChild(title); head.appendChild(badge);

    var nums = el('p', 'text-slate-800 dark:text-slate-100 leading-tight');
    nums.appendChild(el('span', 'text-2xl font-extrabold', String(g.approved)));
    nums.appendChild(el('span', 'text-slate-400 mx-1', '/'));
    nums.appendChild(el('span', 'text-base font-semibold text-slate-500 dark:text-slate-300', String(g.max)));

    var left;
    if (g.reason === 'manual') left = 'Applications closed';
    else if (g.reason === 'full') left = 'No slots left';
    else if (g.max <= 0) left = 'Not available';
    else left = g.remaining + (g.remaining === 1 ? ' slot' : ' slots') + ' available';
    var sub = el('p', 'text-xs mt-0.5 ' + (g.open ? 'text-slate-500 dark:text-slate-400' : 'text-red-600 dark:text-red-300 font-semibold'), left);

    box.appendChild(head); box.appendChild(nums); box.appendChild(sub);
    return box;
  }

  function renderCards() {
    var cards = document.querySelectorAll('[data-admission-card]');
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      c.textContent = '';
      var h = el('p', 'text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2');
      var hi = el('i', 'fa-solid fa-bed mr-1.5'); hi.setAttribute('aria-hidden', 'true');
      h.appendChild(hi); h.appendChild(document.createTextNode('Dormitory slots · approved residents / beds'));
      var row = el('div', 'flex flex-col min-[400px]:flex-row gap-2');
      row.appendChild(cell('male', state.male));
      row.appendChild(cell('female', state.female));
      c.appendChild(h); c.appendChild(row);
      if (state.allClosed) {
        var note = el('p', 'mt-2 text-xs font-semibold text-red-600 dark:text-red-300',
          state.manualClosed ? 'Applications are currently closed.' : 'All slots are full — applications are closed.');
        c.appendChild(note);
      }
      c.classList.remove('hidden');
    }
  }

  // Sign-up form: disable a sex whose beds are full; show a notice on Step 1 when everything is closed.
  function applyToForm() {
    var radios = document.querySelectorAll('input[name="sex"]');
    for (var i = 0; i < radios.length; i++) {
      var r = radios[i], g = state[r.value];
      if (!g) continue;
      var full = g.reason === 'full';
      r.disabled = full;
      if (full && r.checked) r.checked = false;
      var lab = r.closest('label');
      if (lab) {
        lab.style.opacity = full ? '0.5' : '';
        lab.style.cursor = full ? 'not-allowed' : '';
        var tag = lab.querySelector('[data-sex-full]');
        if (full && !tag) {
          tag = el('span', 'text-[10px] font-bold text-red-600', 'Slots full');
          tag.setAttribute('data-sex-full', '1');
          lab.appendChild(tag);
        } else if (!full && tag) { tag.remove(); }
      }
    }
    var notice = document.getElementById('admission-closed-notice');
    if (notice) {
      notice.classList.toggle('hidden', !state.allClosed);
      var t = notice.querySelector('[data-text]');
      if (t) t.textContent = state.manualClosed
        ? 'Applications are currently closed. Please check the announcements on the Log In tab for updates.'
        : 'All dormitory slots are full, so applications are closed. Please check the announcements on the Log In tab for updates.';
    }
  }

  function refresh(force) {
    var now = Date.now();
    if (inFlight || (!force && now - last < MIN_REFRESH)) return;
    inFlight = true;
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);
    fetch(ENDPOINT, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        if (!d || !d.male || !d.female) return;
        state = d; last = Date.now();
        renderCards(); applyToForm();
      })
      .catch(function (e) { console.warn('[admission-status]', e && e.message); })   // keep the last numbers; never break the page
      .then(function () { clearTimeout(timer); inFlight = false; });
  }

  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(false); });
  window.addEventListener('online', function () { refresh(true); });
  setInterval(function () { if (!document.hidden) refresh(true); }, POLL_MS);
  // The wizard shows Step 3 later; re-apply when radios might have been re-rendered or restored.
  document.addEventListener('click', function () { if (state) setTimeout(applyToForm, 0); }, true);
  refresh(true);
})();
