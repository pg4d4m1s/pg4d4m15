/**
 * public/js/support-chat.js — Support launcher + chat window for the login page.
 *
 * Replaces the old inline widget that lived in auth.js. Styles: /css/support.css.
 * Server:  POST /api/auth/support-chat   GET /api/auth/support-status
 *          POST /api/auth/contact-admin  (used by the "send a message" form)
 *          FAQ + contacts live server-side in utils/supportKnowledge.js.
 *
 * Public API (global):
 *   showSupportInfo()        open the chat (kept as the old name so existing onclick="" calls work)
 *   SupportChat.open/close()
 *
 * Design notes for future-me
 *   • No innerHTML anywhere: every string (including AI replies) goes through textContent, so a
 *     reply can never inject markup. Only **bold**, bullet lines and http(s)/email links are rendered.
 *   • Mobile: the chat is full-screen and follows window.visualViewport so the composer stays
 *     above the on-screen keyboard. Desktop: floating 400px window (see support.css).
 *   • The launcher hides while a form field is focused on phones (keyboard open) and while the
 *     chat is open. It sits below the site's modals (z-index 40 vs 50).
 *   • Chat text is kept in sessionStorage for the tab only, so a mobile browser that reloads a
 *     backgrounded tab does not wipe the conversation. "Clear chat" removes it.
 */
(function () {
  'use strict';

  // Used only if /api/auth/support-status cannot be reached. The server is the source of truth.
  var FALLBACK_CONTACTS = {
    name: 'Arana Ruther',
    email: 'rutherfordc.arana@gmail.com',
    facebookUrl: 'https://www.facebook.com/usernamenotavailablepleasechooseanotherusername/',
  };
  var FALLBACK_CHIPS = [
    { id: 'cant-login',      label: "Can't log in" },
    { id: 'how-to-register', label: 'How to register' },
    { id: 'account-pending', label: 'Account pending' },
    { id: 'old-account',     label: 'Old account' },
    { id: 'documents',       label: 'Documents needed' },
    { id: 'hard-copy',       label: 'Hard copies?' },
    { id: 'forgot-password', label: 'Forgot password' },
    { id: 'contact',         label: 'Contact the admin' },
  ];

  var STORE_KEY = 'pgadamis_support_chat_v1';
  var MAX_LEN = 300;
  var REQUEST_TIMEOUT_MS = 30000;
  var WELCOME = "👋 Hi! I'm the PGA-DAMIS support assistant.\n\nI can help with **login problems**, **registration**, **documents**, **account approval** and more. Tap a topic or type your question.";

  var state = {
    open: false,
    busy: false,
    retryUntil: 0,
    retryTimer: null,
    contacts: FALLBACK_CONTACTS,
    aiAvailable: true,
    history: [],        // [{role:'user'|'assistant', content}]
    lastFocus: null,
  };
  var el = {};          // cached DOM nodes of the open chat window
  var launcher = null;

  // ── tiny DOM helper ────────────────────────────────────────────
  function h(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }
  function icon(cls) { return h('i', { class: cls, 'aria-hidden': 'true' }); }

  // ── safe rich text: **bold**, bullets/numbers, http(s) + email links ──
  var INLINE_RE = /(\*\*[^*\n]+\*\*)|(https?:\/\/[^\s<>"']+)|([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

  function appendInline(parent, str) {
    var last = 0, m;
    INLINE_RE.lastIndex = 0;
    while ((m = INLINE_RE.exec(str))) {
      if (m.index > last) parent.appendChild(document.createTextNode(str.slice(last, m.index)));
      if (m[1]) {
        parent.appendChild(h('strong', { text: m[1].slice(2, -2) }));
      } else if (m[2]) {
        var url = m[2], trail = '';
        var t = /[.,;:!?)]+$/.exec(url);
        if (t) { trail = t[0]; url = url.slice(0, -trail.length); }
        parent.appendChild(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: url }));
        if (trail) parent.appendChild(document.createTextNode(trail));
      } else if (m[3]) {
        parent.appendChild(h('a', { href: 'mailto:' + m[3], text: m[3] }));
      }
      last = m.index + m[0].length;
    }
    if (last < str.length) parent.appendChild(document.createTextNode(str.slice(last)));
  }

  function renderRich(container, text) {
    String(text).split('\n').forEach(function (line) {
      if (!line.trim()) return;
      var li = /^\s*(•|-|\d+\.)\s+(.*)$/.exec(line);
      if (li) {
        var row = h('div', { class: 'sc-li' }, h('span', { text: li[1] === '-' ? '•' : li[1] }));
        var body = h('span');
        appendInline(body, li[2]);
        row.appendChild(body);
        container.appendChild(row);
      } else {
        var p = h('p');
        appendInline(p, line);
        container.appendChild(p);
      }
    });
  }

  // ── session persistence ─────────────────────────────────────────
  function saveChat() {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify(state.history.slice(-30))); } catch (e) { /* private mode */ }
  }
  function loadChat() {
    try {
      var raw = sessionStorage.getItem(STORE_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter(function (m) { return m && typeof m.content === 'string'; }) : [];
    } catch (e) { return []; }
  }
  function forgetChat() { try { sessionStorage.removeItem(STORE_KEY); } catch (e) {} }

  // ── message rendering ───────────────────────────────────────────
  function scrollDown() { if (el.msgs) el.msgs.scrollTop = el.msgs.scrollHeight; }

  function addBubble(role, text, extraClass) {
    if (!el.msgs) return null;          // chat was closed while a request was in flight
    var b = h('div', { class: 'sc-bubble sc-bubble--' + (role === 'user' ? 'user' : 'bot') + (extraClass ? ' ' + extraClass : '') });
    renderRich(b, text);
    el.msgs.appendChild(b);
    scrollDown();
    return b;
  }

  function addChips(list, onPick) {
    var wrap = h('div', { class: 'sc-chips', role: 'group', 'aria-label': 'Suggested topics' });
    list.forEach(function (c) {
      wrap.appendChild(h('button', {
        type: 'button', class: 'sc-chip' + (c.action ? ' sc-chip--action' : ''), text: c.label,
        onclick: function () { onPick(c, wrap); },
      }));
    });
    el.msgs.appendChild(wrap);
    scrollDown();
    return wrap;
  }

  function typing(show) {
    var t = el.msgs && el.msgs.querySelector('.sc-typing');
    if (show && !t) {
      el.msgs.appendChild(h('div', { class: 'sc-typing', role: 'status', 'aria-label': 'Assistant is typing' }, h('span'), h('span'), h('span')));
      scrollDown();
    } else if (!show && t) {
      t.remove();
    }
  }

  function setStatus() {
    if (!el.status) return;
    var offline = !navigator.onLine;
    el.dot.className = 'sc-dot' + (offline || !state.aiAvailable ? ' sc-dot--off' : '');
    el.statusText.textContent = offline ? 'Offline — check your connection'
      : state.aiAvailable ? 'Online' : 'Online · quick answers only';
    el.note.hidden = !offline;
    if (offline) el.note.textContent = "You're offline. Messages will send once you're back online.";
  }

  // ── contact card (Facebook / email / message form) ──────────────
  function addContactCard() {
    var old = el.msgs.querySelector('.sc-card');
    if (old) old.remove();
    var c = state.contacts || FALLBACK_CONTACTS;
    var actions = h('div', { class: 'sc-card-actions' },
      c.facebookUrl && h('a', { class: 'sc-btn sc-btn--fb', href: c.facebookUrl, target: '_blank', rel: 'noopener noreferrer' },
        icon('fa-brands fa-facebook'), 'Message on Facebook'),
      c.email && h('a', { class: 'sc-btn sc-btn--mail', href: 'mailto:' + c.email + '?subject=' + encodeURIComponent('PGA-DAMIS support') },
        icon('fa-solid fa-envelope'), 'Email'),
      h('button', { type: 'button', class: 'sc-btn sc-btn--ghost', onclick: function () { showContactForm(card, actions); } },
        icon('fa-solid fa-paper-plane'), 'Send a message here')
    );
    var card = h('div', { class: 'sc-card', role: 'group', 'aria-label': 'Contact the admin' },
      h('p', { class: 'sc-card-title', text: 'Talk to the admin' + (c.name ? ' — ' + c.name : '') }),
      h('div', { text: 'Include the email you registered with so they can find your account.' }),
      actions
    );
    el.msgs.appendChild(card);
    scrollDown();
  }

  function showContactForm(card, actions) {
    // Logged-in users have in-app messaging; send them there.
    fetch('/api/auth/me', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) { return !!(d && d.loggedIn); })
      .catch(function () { return false; })
      .then(function (loggedIn) {
        if (loggedIn) { window.location.href = '/messages.html?support=1'; return; }
        renderContactForm(card, actions);
      });
  }

  function renderContactForm(card, actions) {
    var name  = h('input', { id: 'sc-name',  class: 'sc-field', type: 'text', autocomplete: 'name', placeholder: 'Your name (optional)', maxlength: '80' });
    var email = h('input', { id: 'sc-email', class: 'sc-field', type: 'email', inputmode: 'email', autocomplete: 'email', placeholder: 'you@email.com', maxlength: '120' });
    var msg   = h('textarea', { id: 'sc-msg', class: 'sc-field', rows: '4', maxlength: '1000', placeholder: 'Describe your concern…' });
    var status = h('p', { class: 'sc-form-status', role: 'status' });
    var send = h('button', { type: 'button', class: 'sc-btn sc-btn--mail', text: 'Send to admin' });
    var cancel = h('button', { type: 'button', class: 'sc-btn sc-btn--ghost', text: 'Cancel' });
    var form = h('div', { class: 'sc-form' },
      h('label', { for: 'sc-name', text: 'Name' }), name,
      h('label', { for: 'sc-email', text: 'Your email (so the admin can reply)' }), email,
      h('label', { for: 'sc-msg', text: 'Message' }), msg,
      h('div', { class: 'sc-card-actions' }, send, cancel), status);
    actions.hidden = true;
    card.appendChild(form);
    setTimeout(function () { name.focus(); }, 50);

    cancel.addEventListener('click', function () { form.remove(); actions.hidden = false; });
    send.addEventListener('click', function () {
      var text = msg.value.trim();
      status.className = 'sc-form-status err';
      if (text.length < 5) { status.textContent = 'Please write a short message (at least 5 characters).'; return; }
      if (!navigator.onLine) { status.textContent = "You're offline. Please try again when connected."; return; }
      send.disabled = true; send.textContent = 'Sending…'; status.textContent = '';
      fetch('/api/auth/contact-admin', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.value.trim(), email: email.value.trim(), message: text }),
      })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok || res.d.error) throw new Error(res.d.error || 'Failed to send. Please try again.');
          form.remove();
          card.appendChild(h('p', { class: 'sc-form-status ok', role: 'status', text: '✓ Message sent! The admin will reply to your email.' }));
          addBubble('assistant', 'Your message was sent to the admin. Please watch your email for a reply.');
        })
        .catch(function (e) {
          status.className = 'sc-form-status err';
          status.textContent = e.message || 'Network error. Please try again.';
          send.disabled = false; send.textContent = 'Send to admin';
        });
    });
  }

  // ── page actions requested by a reply (buttons that drive the real form) ──
  function runAction(a) {
    if (!a) return;
    if (a.type === 'contact') { addContactCard(); return; }
    close();
    // These helpers are defined in auth.js (loaded before this file).
    if (a.type === 'signup' && typeof window.showTab === 'function') window.showTab('signup');
    else if (a.type === 'login' && typeof window.showTab === 'function') window.showTab('login');
    else if (a.type === 'forgot' && typeof window.showForgot === 'function') window.showForgot();
  }

  // ── sending ─────────────────────────────────────────────────────
  function lockComposer(secs) {
    clearInterval(state.retryTimer);
    state.retryUntil = Date.now() + secs * 1000;
    var tick = function () {
      var left = Math.max(0, Math.ceil((state.retryUntil - Date.now()) / 1000));
      if (el.send) {
        el.send.disabled = left > 0 || state.busy;
        el.input.placeholder = left > 0 ? 'Please wait ' + left + 's…' : 'Type your message…';
      }
      if (left <= 0) clearInterval(state.retryTimer);
    };
    tick();
    state.retryTimer = setInterval(tick, 500);
  }

  function setBusy(b) {
    state.busy = b;
    if (el.send) el.send.disabled = b || Date.now() < state.retryUntil;
  }

  /** Add the user's bubble + history entry, then deliver. */
  function ask(message, faqId) {
    if (state.busy || Date.now() < state.retryUntil) return false;
    if (!navigator.onLine) { setStatus(); return false; }
    addBubble('user', message);
    state.history.push({ role: 'user', content: message });
    saveChat();
    deliver(message, faqId);
    return true;
  }

  /** Network part (also used by "Try again", which must not add a second user bubble). */
  function deliver(message, faqId) {
    setBusy(true);
    typing(true);
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, REQUEST_TIMEOUT_MS);
    var hist = state.history.slice(0, -1).slice(-6);   // everything before the message just added

    fetch('/api/auth/support-chat', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message, faq: faqId || undefined, history: hist }),
      signal: ctrl ? ctrl.signal : undefined,
    })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (d) {
        clearTimeout(timer);
        typing(false);
        if (!d || !d.reply) { showError(message, faqId, 'The assistant sent an empty reply.'); return; }
        handleReply(d);
      })
      .catch(function (e) {
        clearTimeout(timer);
        typing(false);
        console.warn('[support-chat] request failed:', e);
        showError(message, faqId, e && e.name === 'AbortError'
          ? 'That took too long. Your connection may be slow.'
          : "I couldn't reach the server. Please check your connection.");
      })
      .then(function () { setBusy(false); if (el.input && Date.now() >= state.retryUntil) maybeFocusInput(); });
  }

  function showError(message, faqId, text) {
    var bubble = addBubble('assistant', text, 'sc-bubble--err');
    if (!bubble) return;
    bubble.appendChild(h('div', { style: 'margin-top:8px' },
      h('button', {
        type: 'button', class: 'sc-chip', text: 'Try again',
        onclick: function () { bubble.remove(); if (!navigator.onLine) { setStatus(); return; } deliver(message, faqId); },
      })));
    scrollDown();
  }

  function handleReply(d) {
    if (!el.msgs) {                     // chat closed meanwhile: keep the answer for when it reopens
      state.history.push({ role: 'assistant', content: d.reply });
      saveChat();
      return;
    }
    if (typeof d.aiAvailable === 'boolean') { state.aiAvailable = d.aiAvailable; setStatus(); }
    addBubble('assistant', d.reply);
    state.history.push({ role: 'assistant', content: d.reply });
    saveChat();

    if (d.retryAfter) lockComposer(Math.min(Number(d.retryAfter) || 15, 120));

    if (d.contacts) state.contacts = d.contacts;
    if (d.escalate || d.contacts) addContactCard();

    var buttons = [];
    (d.actions || []).forEach(function (a) { buttons.push({ label: a.label, action: a }); });
    (d.followups || []).forEach(function (f) { buttons.push({ label: f.label, faq: f.id }); });
    if (buttons.length) {
      addChips(buttons, function (c, wrap) {
        if (c.action) { runAction(c.action); return; }
        wrap.remove();
        ask(c.label, c.faq);
      });
    }
  }

  function sendFromInput() {
    var text = el.input.value.trim();
    if (!text) return;
    if (ask(text)) {
      el.input.value = '';
      autosize();
      updateCount();
    }
  }

  // ── composer helpers ────────────────────────────────────────────
  function autosize() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 110) + 'px';
  }
  function updateCount() {
    var n = el.input.value.length;
    el.count.textContent = n + '/' + MAX_LEN;
    el.count.className = 'sc-count' + (n >= MAX_LEN ? ' max' : n > MAX_LEN - 40 ? ' warn' : '');
  }
  function maybeFocusInput() {
    // Do not pop the keyboard on phones unprompted; it would cover the answer.
    if (window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches && el.input) el.input.focus();
  }

  // ── open / close ────────────────────────────────────────────────
  function build() {
    el.dot = h('span', { class: 'sc-dot', 'aria-hidden': 'true' });
    el.statusText = h('span', { text: 'Online' });
    el.status = h('p', { class: 'sc-status' }, el.dot, el.statusText);
    el.note = h('div', { class: 'sc-note', role: 'status', hidden: true });
    el.msgs = h('div', { class: 'sc-msgs', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', tabindex: '0', 'aria-label': 'Conversation' });

    el.input = h('textarea', {
      class: 'sc-input', rows: '1', maxlength: String(MAX_LEN), placeholder: 'Type your message…',
      'aria-label': 'Type your message', enterkeyhint: 'send', autocomplete: 'off', autocapitalize: 'sentences',
    });
    el.send = h('button', { type: 'button', class: 'sc-send', 'aria-label': 'Send message' }, icon('fa-solid fa-paper-plane'));
    el.count = h('span', { class: 'sc-count', text: '0/' + MAX_LEN });

    el.clearBtn = h('button', { type: 'button', class: 'sc-icon-btn', 'aria-label': 'Clear chat', title: 'Clear chat' }, icon('fa-solid fa-trash-can'));
    el.closeBtn = h('button', { type: 'button', class: 'sc-icon-btn', 'aria-label': 'Close support chat', title: 'Close' }, icon('fa-solid fa-xmark'));

    el.panel = h('section', { class: 'sc-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sc-title', tabindex: '-1' },
      h('header', { class: 'sc-head' },
        h('div', { class: 'sc-avatar', 'aria-hidden': 'true' }, icon('fa-solid fa-headset')),
        h('div', { class: 'sc-head-text' }, h('h2', { class: 'sc-title', id: 'sc-title', text: 'PGA-DAMIS Support' }), el.status),
        el.clearBtn, el.closeBtn),
      el.note,
      el.msgs,
      h('div', { class: 'sc-composer' },
        h('div', { class: 'sc-row' }, el.input, el.send),
        h('div', { class: 'sc-meta' },
          h('span', { class: 'sc-hint', text: 'Enter to send · Shift+Enter for a new line' }), el.count))
    );
    el.backdrop = h('div', { class: 'sc-backdrop', id: 'support-overlay' }, el.panel);

    // events
    el.backdrop.addEventListener('mousedown', function (e) { if (e.target === el.backdrop) close(); });
    el.closeBtn.addEventListener('click', close);
    el.clearBtn.addEventListener('click', clearChat);
    el.send.addEventListener('click', sendFromInput);
    el.input.addEventListener('input', function () { autosize(); updateCount(); });
    el.input.addEventListener('keydown', function (e) {
      // Desktop: Enter sends. Touch keyboards: Enter = new line (use the send button).
      var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse) { e.preventDefault(); sendFromInput(); }
    });
    document.body.appendChild(el.backdrop);
  }

  function renderWelcome() {
    var saved = loadChat();
    if (saved.length) {
      state.history = saved;
      saved.forEach(function (m) { addBubble(m.role, m.content); });
      return;
    }
    addBubble('assistant', WELCOME);
    el.welcomeChips = addChips(FALLBACK_CHIPS.map(function (c) { return { label: c.label, faq: c.id }; }), function (c, wrap) {
      wrap.remove();
      ask(c.label, c.faq);
    });
  }

  function clearChat() {
    state.history = [];
    forgetChat();
    el.msgs.textContent = '';
    renderWelcome();
  }

  function fetchStatus() {
    fetch('/api/auth/support-status', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !state.open) return;
        if (d.contacts) state.contacts = d.contacts;
        if (typeof d.aiAvailable === 'boolean') state.aiAvailable = d.aiAvailable;
        // Refresh the welcome chips from the server list if the user hasn't used them yet.
        if (el.welcomeChips && el.welcomeChips.isConnected && Array.isArray(d.chips) && d.chips.length) {
          el.welcomeChips.textContent = '';
          d.chips.forEach(function (c) {
            el.welcomeChips.appendChild(h('button', {
              type: 'button', class: 'sc-chip', text: c.label,
              onclick: function () { el.welcomeChips.remove(); ask(c.label, c.id); },
            }));
          });
        }
        setStatus();
      })
      .catch(function () { /* keep fallbacks */ });
  }

  // Keep the chat above the on-screen keyboard on phones.
  function syncViewport() {
    if (!el.panel || !window.visualViewport) return;
    var vv = window.visualViewport;
    if (window.innerWidth < 640) {
      el.panel.style.height = vv.height + 'px';
      el.panel.style.top = vv.offsetTop + 'px';
    } else {
      el.panel.style.height = '';
      el.panel.style.top = '';
    }
    scrollDown();
  }

  function onKeydown(e) {
    if (!state.open) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    // Keep keyboard focus inside the dialog.
    var nodes = Array.prototype.filter.call(
      el.panel.querySelectorAll('a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex="0"]'),
      function (n) { return n.offsetParent !== null; });
    if (!nodes.length) return;
    var first = nodes[0], lastN = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastN.focus(); }
    else if (!e.shiftKey && document.activeElement === lastN) { e.preventDefault(); first.focus(); }
  }

  function open() {
    if (state.open) return;
    state.open = true;
    state.lastFocus = document.activeElement;
    build();
    document.documentElement.classList.add('sc-lock');
    if (launcher) launcher.classList.add('sc-hidden');
    renderWelcome();
    setStatus();
    updateCount();
    document.addEventListener('keydown', onKeydown, true);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncViewport);
      window.visualViewport.addEventListener('scroll', syncViewport);
      syncViewport();
    }
    if (Date.now() < state.retryUntil) lockComposer(Math.ceil((state.retryUntil - Date.now()) / 1000));
    fetchStatus();
    setTimeout(function () {
      if (window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches) el.input.focus();
      else el.panel.focus();
    }, 60);
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    document.removeEventListener('keydown', onKeydown, true);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', syncViewport);
      window.visualViewport.removeEventListener('scroll', syncViewport);
    }
    if (el.backdrop) el.backdrop.remove();
    el = {};
    clearInterval(state.retryTimer);
    document.documentElement.classList.remove('sc-lock');
    if (launcher) launcher.classList.remove('sc-hidden');
    var back = state.lastFocus;
    if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
  }

  // ── floating launcher ───────────────────────────────────────────
  function isFormField(n) {
    return !!n && /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName) && !(n.closest && n.closest('.sc-panel'));
  }

  function mountLauncher() {
    if (launcher || document.getElementById('support-launcher')) return;
    launcher = h('button', {
      type: 'button', id: 'support-launcher', class: 'sc-launcher',
      'aria-label': 'Need help? Chat with support', 'aria-haspopup': 'dialog',
      onclick: function () { open(); },
    }, icon('fa-solid fa-headset'), h('span', { class: 'sc-launcher-label', text: 'Need help?' }));
    document.body.appendChild(launcher);
    document.body.classList.add('sc-has-launcher');

    // On phones, tuck the launcher away while a field is focused (keyboard open) so it never covers input.
    var showTimer = null;
    document.addEventListener('focusin', function (e) {
      if (window.innerWidth < 768 && isFormField(e.target) && !state.open) {
        clearTimeout(showTimer); launcher.classList.add('sc-hidden');
      }
    });
    document.addEventListener('focusout', function () {
      clearTimeout(showTimer);
      showTimer = setTimeout(function () { if (!state.open && launcher) launcher.classList.remove('sc-hidden'); }, 200);
    });
  }

  window.addEventListener('online',  function () { setStatus(); });
  window.addEventListener('offline', function () { setStatus(); });

  window.SupportChat = { open: open, close: close };
  window.showSupportInfo = open;   // backwards-compatible name used by onclick="showSupportInfo()"

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountLauncher);
  else mountLauncher();
})();
