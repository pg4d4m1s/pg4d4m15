/**
 * public/js/login-announcements.js — announcements banner on the login page
 *
 * Loads GET /api/announcements/public and renders the notices into
 * #login-announcements (inside the Log In panel of index.html).
 *
 * Behaviour
 *  • Never breaks the login page: any failure just means no banner (logged to the console).
 *  • Text is inserted with textContent — announcements are never parsed as HTML.
 *  • Phones: long messages are collapsed to 3 lines with a "Read more" toggle so the
 *    sign-in form is not pushed off-screen; every button is at least 44×44 px.
 *  • Flaky mobile networks: 8 s timeout, and the list is refreshed when the phone comes
 *    back online or the tab becomes visible again (at most once a minute).
 *  • A visitor can dismiss a notice; it stays dismissed until an admin edits it.
 *    (localStorage is wrapped in try/catch — private mode / blocked storage still works.)
 *  • "Create Account" button calls the existing showTab('signup') from auth.js.
 */
(function () {
  'use strict';

  var ENDPOINT     = '/api/announcements/public';
  var DISMISS_KEY  = 'damis.dismissedAnnouncements';
  var TIMEOUT_MS   = 8000;
  var MIN_REFRESH  = 60 * 1000;
  var COLLAPSE_AT  = 180; // characters — a longer first notice starts collapsed (3 lines)
  var COLLAPSE_AT_COMPACT = 70; // same, for 2nd+ notices (1 line)

  var box = document.getElementById('login-announcements');
  if (!box) return;

  var lastFetch = 0;
  var inFlight  = false;
  var current   = [];

  // Icon + label per style, so meaning never relies on colour alone.
  var STYLES = {
    info:    { icon: 'fa-circle-info',           label: 'Notice',
               cls: 'bg-blue-50 border-blue-200 text-blue-900 dark:bg-blue-950/40 dark:border-blue-800 dark:text-blue-100' },
    success: { icon: 'fa-circle-check',          label: 'Good news',
               cls: 'bg-emerald-50 border-emerald-200 text-emerald-900 dark:bg-emerald-950/40 dark:border-emerald-800 dark:text-emerald-100' },
    warning: { icon: 'fa-triangle-exclamation',  label: 'Important',
               cls: 'bg-amber-50 border-amber-300 text-amber-900 dark:bg-amber-950/40 dark:border-amber-700 dark:text-amber-100' },
    urgent:  { icon: 'fa-circle-exclamation',    label: 'Urgent',
               cls: 'bg-red-50 border-red-300 text-red-900 dark:bg-red-950/40 dark:border-red-700 dark:text-red-100' }
  };

  // ── dismissed list (best effort) ─────────────────────────────────────────
  function dismissKey(a) { return a.id + '@' + (a.updatedAt || ''); }

  function readDismissed() {
    try {
      var v = JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]');
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }

  function saveDismissed(list) {
    try { localStorage.setItem(DISMISS_KEY, JSON.stringify(list.slice(-50))); } catch (e) { /* ignore */ }
  }

  // ── rendering ────────────────────────────────────────────────────────────
  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try {
      return d.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) { return d.toDateString(); }
  }

  function goToSignup() {
    if (typeof window.showTab === 'function') window.showTab('signup');
    var scroller = box.closest ? box.closest('.overflow-y-auto') : null;
    if (scroller) scroller.scrollTop = 0;
  }

  // The first notice gets room to breathe; any further ones are compact so the sign-in
  // form is not pushed off a phone screen. Literal class names so Tailwind picks them up.
  function buildCard(a, index) {
    var primary   = index === 0;
    var clampCls  = primary ? 'line-clamp-3' : 'line-clamp-1';
    var collapseAt = primary ? COLLAPSE_AT : COLLAPSE_AT_COMPACT;
    var st = STYLES[a.type] || STYLES.info;

    var card = el('article', 'rounded-xl border p-3.5 ' + st.cls);
    var row  = el('div', 'flex items-start gap-3');

    var icon = el('i', 'fa-solid ' + st.icon + ' mt-0.5 flex-shrink-0');
    icon.setAttribute('aria-hidden', 'true');

    var main = el('div', 'min-w-0 flex-1');
    var meta = fmtDate(a.createdAt);
    main.appendChild(el('p', 'text-[11px] font-bold uppercase tracking-wider opacity-80',
      st.label + (meta ? ' · ' + meta : '')));
    main.appendChild(el('h2', 'text-sm font-extrabold leading-snug break-words mt-0.5', a.title));

    // Buttons live in one column (phone) / row (desktop) so they can never overlap.
    var actions = el('div', 'mt-1 flex flex-col items-start sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4');

    if (a.body) {
      var body = el('p', 'text-sm leading-relaxed mt-1.5 break-words whitespace-pre-line', a.body);
      main.appendChild(body);

      if (a.body.length > collapseAt) {
        body.classList.add(clampCls);
        var more = el('button', 'inline-flex items-center min-h-[44px] text-xs font-bold underline underline-offset-2', 'Read more');
        more.type = 'button';
        more.setAttribute('aria-expanded', 'false');
        more.addEventListener('click', function () {
          var open = more.getAttribute('aria-expanded') === 'true';
          body.classList.toggle(clampCls, open);
          more.setAttribute('aria-expanded', open ? 'false' : 'true');
          more.textContent = open ? 'Read more' : 'Show less';
        });
        actions.appendChild(more);
      }
    }

    if (a.ctaSignup) {
      var cta = el('button', 'w-full sm:w-auto min-h-[44px] px-5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold transition-colors', 'Create Account');
      cta.type = 'button';
      cta.addEventListener('click', goToSignup);
      actions.appendChild(cta);
    }

    if (actions.childNodes.length) main.appendChild(actions);

    var close = el('button', 'w-11 h-11 -mt-2.5 -mr-2.5 flex items-center justify-center flex-shrink-0 rounded-full opacity-70 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/10 transition');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss announcement: ' + a.title);
    var x = el('i', 'fa-solid fa-xmark');
    x.setAttribute('aria-hidden', 'true');
    close.appendChild(x);
    close.addEventListener('click', function () {
      var list = readDismissed();
      list.push(dismissKey(a));
      saveDismissed(list);
      render();
    });

    row.appendChild(icon);
    row.appendChild(main);
    row.appendChild(close);
    card.appendChild(row);
    return card;
  }

  function render() {
    var dismissed = readDismissed();
    var visible = current.filter(function (a) { return dismissed.indexOf(dismissKey(a)) === -1; });

    box.textContent = '';
    if (!visible.length) { box.classList.add('hidden'); return; }

    var wrap = el('div', 'space-y-3');
    visible.forEach(function (a, i) { wrap.appendChild(buildCard(a, i)); });
    box.appendChild(wrap);
    box.classList.remove('hidden');
  }

  // ── loading ──────────────────────────────────────────────────────────────
  function load() {
    if (inFlight) return;
    inFlight = true;

    var ctrl  = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);

    fetch(ENDPOINT, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        lastFetch = Date.now();
        current = Array.isArray(data.announcements) ? data.announcements : [];
        render();
      })
      .catch(function (err) {
        // Keep whatever is already on screen; the login form must keep working.
        console.warn('[announcements] could not load:', err && err.message ? err.message : err);
      })
      .then(function () {
        clearTimeout(timer);
        inFlight = false;
      });
  }

  function refreshIfStale() {
    if (Date.now() - lastFetch > MIN_REFRESH) load();
  }

  window.addEventListener('online', load);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') refreshIfStale();
  });

  load();
})();
