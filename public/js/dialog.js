/**
 * public/js/dialog.js — styled replacements for the browser's confirm() / alert() / prompt().
 *
 *   if (!await damisConfirm('Delete this post?', { title: 'Delete post?', confirmText: 'Delete', tone: 'danger' })) return;
 *   await damisAlert('File too large. Max 10MB.', { title: 'File too large', tone: 'warning' });
 *   const label = await damisPrompt('Label for this snapshot', { title: 'Save snapshot', defaultValue: 'My label' });   // string, or null if cancelled
 *
 * Options: title, confirmText, cancelText, tone ('info' | 'warning' | 'danger' | 'success'),
 *          prompt only: defaultValue, placeholder, maxLength.
 *
 * Behaviour: promise based (callers must be async); several calls are queued and shown one at a time. Text is always
 * inserted as text (never HTML). Esc / tapping outside = cancel. Focus moves into the dialog and is trapped there, the
 * dangerous "Delete"-type confirms start focused on Cancel, and focus returns to where it was. Mobile: slides up as a
 * bottom sheet with 46px buttons and 16px inputs (no iOS zoom); from 640px up it is a centred dialog.
 * Self-contained: injects its own CSS (light + `.dark` class) and uses no icon font.
 */
(function () {
  'use strict';
  if (window.damisConfirm) return;

  var ICONS = {   // inline SVG (stroke = currentColor) so the dialog never depends on Font Awesome loading
    info:    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4"/><path d="M12 17.5h.01"/></svg>',
    warning: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
    danger:  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>',
    success: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m8 12.5 3 3 5-6"/></svg>'
  };

  function injectStyles() {
    if (document.getElementById('damis-dlg-styles')) return;
    var s = document.createElement('style'); s.id = 'damis-dlg-styles';
    s.textContent = [
      '.damis-dlg-ov{position:fixed;inset:0;z-index:100000;display:flex;align-items:flex-end;justify-content:center;padding:16px 16px max(16px,env(safe-area-inset-bottom));background:rgba(15,23,42,.55);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);opacity:0;transition:opacity .15s ease}',
      '.damis-dlg-ov.show{opacity:1}',
      '@media(min-width:640px){.damis-dlg-ov{align-items:center}}',
      '.damis-dlg{box-sizing:border-box;width:100%;max-width:420px;max-height:calc(100dvh - 32px);overflow:auto;background:#fff;color:#0f172a;border-radius:20px;box-shadow:0 24px 64px rgba(2,6,23,.4);padding:22px 20px 18px;transform:translateY(14px) scale(.98);transition:transform .18s ease;font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif;text-align:left}',
      '.damis-dlg-ov.show .damis-dlg{transform:none}',
      '.dark .damis-dlg{background:#0f172a;color:#e2e8f0;border:1px solid #1e293b}',
      '.damis-dlg-hd{display:flex;gap:14px;align-items:flex-start}',
      '.damis-dlg-ic{flex:none;width:44px;height:44px;border-radius:14px;display:flex;align-items:center;justify-content:center}',
      '.damis-dlg-ic.info{background:#dbeafe;color:#0070e0}.damis-dlg-ic.warning{background:#fef3c7;color:#d97706}.damis-dlg-ic.danger{background:#fee2e2;color:#dc2626}.damis-dlg-ic.success{background:#dcfce7;color:#16a34a}',
      '.dark .damis-dlg-ic.info{background:rgba(26,140,255,.18);color:#4da6ff}.dark .damis-dlg-ic.warning{background:rgba(217,119,6,.2);color:#fbbf24}.dark .damis-dlg-ic.danger{background:rgba(220,38,38,.2);color:#f87171}.dark .damis-dlg-ic.success{background:rgba(22,163,74,.2);color:#4ade80}',
      '.damis-dlg-tx{min-width:0;flex:1;padding-top:2px}',
      '.damis-dlg-t{margin:0;font-family:Sora,"DM Sans",system-ui,sans-serif;font-weight:700;font-size:17px;line-height:1.3}',
      '.damis-dlg-m{margin:6px 0 0;font-size:14px;line-height:1.5;color:#475569;white-space:pre-line;overflow-wrap:anywhere}',
      '.dark .damis-dlg-m{color:#94a3b8}',
      '.damis-dlg-in{box-sizing:border-box;display:block;width:100%;min-height:46px;margin-top:14px;padding:10px 12px;font-size:16px;font-family:inherit;color:#0f172a;background:#fff;border:1px solid #cbd5e1;border-radius:12px}',
      '.damis-dlg-in:focus{outline:2px solid #1a8cff;outline-offset:1px;border-color:#1a8cff}',
      '.dark .damis-dlg-in{background:#020617;border-color:#334155;color:#e2e8f0}',
      '.damis-dlg-ft{display:flex;flex-direction:column-reverse;gap:10px;margin-top:20px}',
      '@media(min-width:480px){.damis-dlg-ft{flex-direction:row;justify-content:flex-end}}',
      '.damis-dlg-b{min-height:46px;padding:0 20px;border-radius:12px;border:1px solid transparent;font-family:inherit;font-size:14px;font-weight:700;cursor:pointer;transition:filter .12s ease,transform .06s ease}',
      '.damis-dlg-b:hover{filter:brightness(.95)}.damis-dlg-b:active{transform:scale(.98)}',
      '.damis-dlg-b:focus-visible{outline:3px solid rgba(26,140,255,.55);outline-offset:2px}',
      '.damis-dlg-cancel{background:#fff;border-color:#cbd5e1;color:#334155}',
      '.dark .damis-dlg-cancel{background:transparent;border-color:#334155;color:#cbd5e1}',
      '.damis-dlg-ok{color:#fff;background:#0070e0}.damis-dlg-ok.warning{background:#d97706}.damis-dlg-ok.danger{background:#dc2626}.damis-dlg-ok.success{background:#16a34a}',
      '@media(prefers-reduced-motion:reduce){.damis-dlg-ov,.damis-dlg,.damis-dlg-b{transition:none}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  var queue = [], active = false, uid = 0;
  function enqueue(job) {
    return new Promise(function (resolve) { queue.push({ job: job, resolve: resolve }); pump(); });
  }
  function pump() {
    if (active) return;
    var next = queue.shift(); if (!next) return;
    active = true;
    next.job().then(function (v) { active = false; next.resolve(v); pump(); });
  }

  // kind: 'confirm' | 'alert' | 'prompt'  → resolves true/false, true, or string/null
  function show(kind, message, o) {
    return new Promise(function (resolve) {
      injectStyles();
      var id = 'damis-dlg-' + (++uid);
      var tone = ICONS[o.tone] ? o.tone : 'info';
      var title = o.title || (kind === 'alert' ? 'Notice' : kind === 'prompt' ? 'Enter a value' : 'Please confirm');
      var prevFocus = document.activeElement, prevOverflow = document.body.style.overflow;

      var ov = el('div', 'damis-dlg-ov');
      var dlg = el('div', 'damis-dlg');
      dlg.setAttribute('role', kind === 'prompt' ? 'dialog' : 'alertdialog');
      dlg.setAttribute('aria-modal', 'true');
      dlg.setAttribute('aria-labelledby', id + '-t');
      dlg.setAttribute('aria-describedby', id + '-m');

      var hd = el('div', 'damis-dlg-hd');
      var ic = el('div', 'damis-dlg-ic ' + tone); ic.innerHTML = ICONS[tone];   // static markup above, no user text
      var tx = el('div', 'damis-dlg-tx');
      var t = el('h2', 'damis-dlg-t', title); t.id = id + '-t';
      var m = el('p', 'damis-dlg-m', message == null ? '' : String(message)); m.id = id + '-m';
      tx.appendChild(t); tx.appendChild(m); hd.appendChild(ic); hd.appendChild(tx); dlg.appendChild(hd);

      var input = null;
      if (kind === 'prompt') {
        input = el('input', 'damis-dlg-in'); input.type = 'text'; input.id = id + '-in';
        input.value = o.defaultValue == null ? '' : String(o.defaultValue);
        if (o.placeholder) input.placeholder = o.placeholder;
        if (o.maxLength) input.maxLength = o.maxLength;
        input.setAttribute('aria-labelledby', id + '-m');
        input.autocomplete = 'off';
        dlg.appendChild(input);
      }

      var ft = el('div', 'damis-dlg-ft');
      var cancel = null;
      if (kind !== 'alert') { cancel = el('button', 'damis-dlg-b damis-dlg-cancel', o.cancelText || 'Cancel'); cancel.type = 'button'; ft.appendChild(cancel); }
      var ok = el('button', 'damis-dlg-b damis-dlg-ok ' + tone, o.confirmText || (kind === 'alert' ? 'OK' : kind === 'prompt' ? 'Save' : 'Confirm')); ok.type = 'button';
      ft.appendChild(ok); dlg.appendChild(ft); ov.appendChild(dlg);

      var done = false;
      function close(value) {
        if (done) return; done = true;
        document.removeEventListener('keydown', onKey, true);
        ov.classList.remove('show');
        document.body.style.overflow = prevOverflow;
        setTimeout(function () { if (ov.parentNode) ov.parentNode.removeChild(ov); }, 180);
        if (prevFocus && prevFocus.focus && document.contains(prevFocus)) { try { prevFocus.focus(); } catch (_) { /* element gone */ } }
        resolve(value);
      }
      var cancelValue = kind === 'alert' ? true : kind === 'prompt' ? null : false;
      function accept() { close(kind === 'prompt' ? input.value : true); }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(cancelValue); return; }
        if (e.key === 'Enter' && input && document.activeElement === input) { e.preventDefault(); accept(); return; }
        if (e.key === 'Tab') {   // keep focus inside the dialog
          var f = dlg.querySelectorAll('input,button'); if (!f.length) return;
          var first = f[0], last = f[f.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
          else if (!dlg.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
        }
      }
      ok.addEventListener('click', accept);
      if (cancel) cancel.addEventListener('click', function () { close(cancelValue); });
      var downOnBackdrop = false;   // only a full press-and-release on the dark area cancels (so text selection drags don't)
      ov.addEventListener('mousedown', function (e) { downOnBackdrop = e.target === ov; });
      ov.addEventListener('touchstart', function (e) { downOnBackdrop = e.target === ov; }, { passive: true });
      ov.addEventListener('click', function (e) { if (e.target === ov && downOnBackdrop) close(cancelValue); });
      document.addEventListener('keydown', onKey, true);

      document.body.appendChild(ov);
      document.body.style.overflow = 'hidden';
      requestAnimationFrame(function () { ov.classList.add('show'); });
      // Start on the safe choice: the text box for prompts, Cancel for destructive confirms, otherwise the main button.
      var start = input || (tone === 'danger' && cancel ? cancel : ok);
      setTimeout(function () { start.focus(); if (input) input.select(); }, 30);
    });
  }

  window.damisConfirm = function (message, opts) { return enqueue(function () { return show('confirm', message, opts || {}); }); };
  window.damisAlert   = function (message, opts) { return enqueue(function () { return show('alert', message, opts || {}); }); };
  window.damisPrompt  = function (message, opts) { return enqueue(function () { return show('prompt', message, opts || {}); }); };
})();
