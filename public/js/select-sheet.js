/**
 * select-sheet.js — a searchable bottom-sheet picker for long <select> lists on phones.
 *
 * Why: on mobile the native dropdown for a <select> with <optgroup>s is a plain, unstyled list (school names look the same
 * as courses, no search), so finding a course among ~50 is slow. On small screens a tap on a  <select data-sheet>  opens a
 * sheet with a search box, school headings and big tap targets. On desktop (>= 768px) nothing changes: the native select is used.
 *
 * The real <select> stays the source of truth (value, disabled, required, onchange handlers, form validation all keep working):
 * the sheet only sets select.value and dispatches a normal "change" event. It reads the options each time it opens, so lists
 * rebuilt by onYearLevelChange() / buildFullCourseList() need no extra wiring.
 *
 * Usage:  <select id="reg-course" data-sheet data-sheet-title="Program / Course" data-sheet-search="Search your course…">
 */
(function () {
  'use strict';
  var MQ = window.matchMedia ? window.matchMedia('(max-width: 767px)') : { matches: false };
  var openSel = null, root = null, lastFocus = null;

  var css = '' +
    '.ss-back{position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,.6);display:flex;align-items:flex-end;justify-content:center}' +
    '.ss-panel{width:100%;max-width:640px;height:88vh;height:88dvh;background:#fff;color:#0f172a;border-radius:20px 20px 0 0;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 -10px 40px rgba(0,0,0,.35);animation:ss-up .18s ease-out}' +
    '@keyframes ss-up{from{transform:translateY(24px);opacity:.6}to{transform:none;opacity:1}}' +
    '.ss-head{display:flex;align-items:center;gap:8px;padding:14px 8px 8px 18px}' +
    '.ss-title{flex:1;font-weight:800;font-size:17px;min-width:0}' +
    '.ss-x{width:44px;height:44px;border:0;background:transparent;border-radius:50%;font-size:18px;color:#64748b;cursor:pointer}' +
    '.ss-searchwrap{padding:0 16px 10px}' +
    '.ss-search{width:100%;box-sizing:border-box;font-size:16px;padding:12px 14px;border-radius:12px;border:1.5px solid #cbd5e1;background:#f8fafc;color:inherit;outline:none}' +
    '.ss-search:focus{border-color:#6366f1;background:#fff}' +
    '.ss-list{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:0 0 max(16px,env(safe-area-inset-bottom))}' +
    '.ss-group{position:sticky;top:0;z-index:1;padding:9px 18px;font-size:12px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#4338ca;background:#eef2ff;border-top:1px solid #e0e7ff;border-bottom:1px solid #e0e7ff}' +
    '.ss-opt{display:flex;align-items:center;gap:12px;width:100%;min-height:52px;padding:10px 18px;text-align:left;font-size:15px;line-height:1.3;background:transparent;border:0;border-bottom:1px solid #f1f5f9;color:inherit;cursor:pointer}' +
    '.ss-opt:active{background:#eef2ff}' +
    '.ss-opt .ss-t{flex:1;min-width:0}' +
    '.ss-radio{flex:none;width:22px;height:22px;border-radius:50%;border:2px solid #94a3b8;position:relative}' +
    '.ss-opt[aria-selected=true]{background:#eef2ff;font-weight:700}' +
    '.ss-opt[aria-selected=true] .ss-radio{border-color:#4f46e5}' +
    '.ss-opt[aria-selected=true] .ss-radio:after{content:"";position:absolute;inset:3px;border-radius:50%;background:#4f46e5}' +
    '.ss-empty{padding:28px 18px;text-align:center;color:#64748b;font-size:14px}' +
    '.dark .ss-panel{background:#0f172a;color:#e2e8f0}' +
    '.dark .ss-search{background:#1e293b;border-color:#334155}.dark .ss-search:focus{background:#0f172a;border-color:#818cf8}' +
    '.dark .ss-group{background:#1e1b4b;color:#a5b4fc;border-color:#312e81}' +
    '.dark .ss-opt{border-bottom-color:#1e293b}.dark .ss-opt:active,.dark .ss-opt[aria-selected=true]{background:#1e293b}' +
    '.dark .ss-radio{border-color:#64748b}.dark .ss-opt[aria-selected=true] .ss-radio{border-color:#818cf8}.dark .ss-opt[aria-selected=true] .ss-radio:after{background:#818cf8}' +
    '@media (prefers-reduced-motion:reduce){.ss-panel{animation:none}}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  function readOptions(sel) {
    var out = [], group = '';
    Array.prototype.forEach.call(sel.children, function (n) {
      if (n.tagName === 'OPTGROUP') {
        Array.prototype.forEach.call(n.children, function (o) { out.push({ v: o.value, t: o.textContent, g: n.label, off: o.disabled }); });
      } else if (n.tagName === 'OPTION' && n.value !== '') {
        out.push({ v: n.value, t: n.textContent, g: '', off: n.disabled });
      }
    });
    return out;
  }

  function render(listEl, opts, q, current) {
    q = (q || '').trim().toLowerCase();
    listEl.textContent = '';
    var lastG = null, shown = 0, frag = document.createDocumentFragment(), selEl = null;
    opts.forEach(function (o) {
      if (q && (o.t + ' ' + o.g).toLowerCase().indexOf(q) === -1) return;
      if (o.g && o.g !== lastG) { var h = document.createElement('div'); h.className = 'ss-group'; h.textContent = o.g; frag.appendChild(h); }
      lastG = o.g;
      var b = document.createElement('button'); b.type = 'button'; b.className = 'ss-opt'; b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', o.v === current ? 'true' : 'false'); b.dataset.v = o.v; b.disabled = !!o.off;
      var t = document.createElement('span'); t.className = 'ss-t'; t.textContent = o.t;
      var r = document.createElement('span'); r.className = 'ss-radio'; r.setAttribute('aria-hidden', 'true');
      b.appendChild(t); b.appendChild(r); frag.appendChild(b); shown++;
      if (o.v === current) selEl = b;
    });
    if (!shown) { var e = document.createElement('div'); e.className = 'ss-empty'; e.textContent = 'Nothing matches “' + q + '”. Try a shorter word, or close this and tick “Not listed”.'; frag.appendChild(e); }
    listEl.appendChild(frag);
    return selEl;
  }

  function close() {
    if (!root) return;
    document.body.style.overflow = root._prevOverflow || '';
    root.remove(); root = null;
    var f = lastFocus; openSel = null; lastFocus = null;
    if (f && f.focus) { try { f.focus({ preventScroll: true }); } catch (_) { /* ignore */ } }
  }

  function open(sel) {
    if (root) return;
    var opts = readOptions(sel);
    if (!opts.length) return;                              // nothing to choose yet (e.g. year level not picked): keep native behaviour
    openSel = sel; lastFocus = sel;
    root = document.createElement('div'); root.className = 'ss-back';
    root._prevOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    var title = sel.getAttribute('data-sheet-title') || 'Choose one';
    root.innerHTML = '<div class="ss-panel" role="dialog" aria-modal="true"><div class="ss-head"><div class="ss-title"></div>' +
      '<button type="button" class="ss-x" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>' +
      '<div class="ss-searchwrap"><input class="ss-search" type="search" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false"></div>' +
      '<div class="ss-list" role="listbox"></div></div>';
    root.querySelector('.ss-title').textContent = title;
    var input = root.querySelector('.ss-search'), list = root.querySelector('.ss-list');
    input.placeholder = sel.getAttribute('data-sheet-search') || 'Search…';
    input.setAttribute('aria-label', input.placeholder);
    var current = sel.value;
    var selEl = render(list, opts, '', current);
    document.body.appendChild(root);
    if (selEl) list.scrollTop = Math.max(0, selEl.offsetTop - list.clientHeight / 3);
    input.addEventListener('input', function () { render(list, opts, input.value, current); list.scrollTop = 0; });
    list.addEventListener('click', function (e) {
      var b = e.target.closest('.ss-opt'); if (!b || b.disabled) return;
      var target = openSel; close();
      target.value = b.dataset.v;
      target.dispatchEvent(new Event('change', { bubbles: true }));
    });
    root.addEventListener('click', function (e) { if (e.target === root || e.target.closest('.ss-x')) close(); });
    root.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    // No autofocus on purpose: the on-screen keyboard would cover the list. Tapping the search box brings it up.
  }

  function usable(sel) { return MQ.matches && !sel.disabled && sel.hasAttribute('data-sheet'); }

  // Capture phase so we beat the native picker. mousedown covers touch (synthesised) and mouse; click is a safety net.
  document.addEventListener('mousedown', function (e) {
    var sel = e.target.closest && e.target.closest('select[data-sheet]');
    if (sel && usable(sel) && readOptions(sel).length) { e.preventDefault(); sel.blur(); open(sel); }
  }, true);
  document.addEventListener('click', function (e) {
    var sel = e.target.closest && e.target.closest('select[data-sheet]');
    if (sel && usable(sel) && readOptions(sel).length) { e.preventDefault(); if (!root) open(sel); }
  }, true);
  document.addEventListener('keydown', function (e) {                // keyboard / switch-access users on a narrow window
    var sel = e.target.closest && e.target.closest('select[data-sheet]');
    if (sel && usable(sel) && (e.key === 'Enter' || e.key === ' ') && readOptions(sel).length) { e.preventDefault(); open(sel); }
  }, true);
})();
