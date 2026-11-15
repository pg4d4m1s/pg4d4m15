/**
 * public/js/my-application.js — "My Application" for approved residents (feed.html → My Dormitory panel)
 *
 *   • My Application sheet: the resident's own application at a glance (details + documents + PDF buttons)
 *   • Request a correction: pick what is wrong + why  → the admin must approve it
 *   • After approval: Edit / Replace buttons appear ONLY on the approved items, for a limited time.
 *     Edits are saved as DRAFTS; tap "Submit for review" and the admin must approve the changes again before they
 *     replace anything on the real application.
 *
 * Everything here is a mirror of rules the server enforces (utils/residentRevisions.js); hiding a button is never
 * the protection. Layout: mobile-first bottom sheets (≥44px touch targets, 16px inputs so iOS does not zoom),
 * becoming a right-hand drawer / centred dialog from 640px up. No hover-only interactions.
 *
 * Globals it adds: openMyApplication, viewMyApplicationPdf, loadMyApplicationCard.
 * Uses (if present) the page's toast() and the course catalog (/js/course-catalog.js).
 */
(function () {
  'use strict';

  const API = '/api/users/me';
  const DOC_FIELD = { doc_school_id: 'id_front', doc_residency: 'cert_residency', doc_low_income: 'cert_low_income', doc_enrollment: 'cert_enrollment', doc_grades: 'cert_grades' };
  const MAX_BYTES = 15 * 1024 * 1024;                       // same limit as the server's multer
  const OK_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
  const GROUP_ICON = { info_personal: 'fa-user', info_address: 'fa-location-dot', info_school: 'fa-graduation-cap', info_family: 'fa-people-roof' };

  let D = null;            // last payload of GET /api/users/me/application-summary
  let loading = null;
  let busy = false;        // one save / upload at a time

  // ── tiny helpers ──────────────────────────────────────────────────────────────────────────────
  const h = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const $ = (id) => document.getElementById(id);
  function toast(msg, type) { if (typeof window.toast === 'function') window.toast(msg, type || 'success'); else console.log('[MyApplication]', msg); }
  const phDate = (iso, withYear) => new Date(iso).toLocaleDateString('en-PH', { month: 'long', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'Asia/Manila' });
  function timeLeft(iso) {
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return 'ending now';
    const hrs = Math.floor(ms / 36e5);
    if (hrs < 24) return `${Math.max(hrs, 1)} hour${hrs > 1 ? 's' : ''} left`;
    const d = Math.floor(hrs / 24);
    return `${d} day${d > 1 ? 's' : ''} left`;
  }

  async function api(method, url, body) {
    try {
      const r = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store',
        headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
      let data = {}; try { data = await r.json(); } catch (_) { /* non-JSON error page */ }
      if (r.status === 401) toast('Your session expired. Please log in again.', 'error');
      return { ok: r.ok, status: r.status, data };
    } catch (e) {
      console.warn('[MyApplication] network error:', method, url, e.message);
      return { ok: false, status: 0, data: { error: 'No connection. Check your internet and try again.' } };
    }
  }

  // ── styles (injected once so feed.html stays small) ───────────────────────────────────────────
  function injectStyles() {
    if ($('ma-styles')) return;
    const s = document.createElement('style'); s.id = 'ma-styles';
    s.textContent = `
      .ma-inp{width:100%;min-height:46px;padding:10px 12px;font-size:16px;line-height:1.3;border:1px solid #cbd5e1;border-radius:12px;background:#fff;color:#0f172a;font-family:inherit}
      .ma-inp:focus{outline:2px solid #1a8cff;outline-offset:1px;border-color:#1a8cff}
      .ma-inp:disabled{opacity:.55}
      .ma-inp.ma-bad{border-color:#e5365a;outline-color:#e5365a}
      textarea.ma-inp{min-height:84px;resize:vertical}
      .dark .ma-inp{background:#0f172a;border-color:#334155;color:#e2e8f0}
      .ma-lbl{display:block;font-size:12px;font-weight:700;color:#475569;margin-bottom:4px}
      .dark .ma-lbl{color:#94a3b8}
      .ma-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:0 16px;border-radius:12px;font-size:14px;font-weight:700;cursor:pointer;border:1px solid transparent;font-family:inherit;transition:opacity .15s}
      .ma-btn:disabled{opacity:.55;cursor:not-allowed}
      .ma-btn-pri{background:#1a8cff;color:#fff}.ma-btn-pri:hover{background:#0070e0}
      .ma-btn-grn{background:#16a34a;color:#fff}.ma-btn-grn:hover{background:#15803d}
      .ma-btn-out{background:transparent;color:#334155;border-color:#cbd5e1}.dark .ma-btn-out{color:#e2e8f0;border-color:#475569}
      .ma-btn-out:hover{background:rgba(148,163,184,.12)}
      .ma-chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px}
      .ma-skel{background:linear-gradient(90deg,#e2e8f0 25%,#f1f5f9 50%,#e2e8f0 75%);background-size:200% 100%;animation:maSk 1.2s infinite;border-radius:12px}
      .dark .ma-skel{background:linear-gradient(90deg,#1e293b 25%,#334155 50%,#1e293b 75%);background-size:200% 100%}
      @keyframes maSk{to{background-position:-200% 0}}
      @media (prefers-reduced-motion:reduce){.ma-skel{animation:none}}
    `;
    document.head.appendChild(s);
  }

  // ── shell: the sheet + one modal host, created on first use ───────────────────────────────────
  function ensureShell() {
    if ($('ma-sheet')) return;
    injectStyles();
    const sheet = document.createElement('div');
    sheet.id = 'ma-sheet'; sheet.className = 'hidden fixed inset-0 z-[120]'; sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-labelledby', 'ma-title');
    sheet.innerHTML = `
      <div class="absolute inset-0 bg-slate-900/60" data-act="close-sheet"></div>
      <div class="absolute inset-x-0 bottom-0 top-6 sm:top-0 sm:left-auto sm:right-0 sm:w-[580px] bg-slate-50 dark:bg-slate-950 rounded-t-3xl sm:rounded-none flex flex-col shadow-2xl">
        <div class="flex items-center gap-3 px-4 sm:px-5 py-3 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 rounded-t-3xl sm:rounded-none">
          <div class="w-10 h-10 rounded-xl bg-brand-50 dark:bg-slate-800 text-brand-600 flex items-center justify-center shrink-0"><i class="fa-solid fa-file-lines"></i></div>
          <div class="min-w-0 flex-1"><h2 id="ma-title" class="font-display font-bold text-slate-900 dark:text-white leading-tight">My Application</h2><p id="ma-sub" class="text-xs text-slate-500 dark:text-slate-400 truncate"></p></div>
          <button type="button" data-act="close-sheet" aria-label="Close" class="w-11 h-11 rounded-full flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"><i class="fa-solid fa-xmark text-lg"></i></button>
        </div>
        <div id="ma-body" class="flex-1 overflow-y-auto overscroll-contain px-4 sm:px-5 py-4 space-y-4"></div>
        <div class="grid grid-cols-2 gap-2 px-4 sm:px-5 py-3 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800" style="padding-bottom:max(12px,env(safe-area-inset-bottom))">
          <button type="button" class="ma-btn ma-btn-out" data-act="pdf-view"><i class="fa-solid fa-eye text-xs"></i> View PDF</button>
          <button type="button" class="ma-btn ma-btn-out" data-act="pdf-download"><i class="fa-solid fa-download text-xs"></i> Download PDF</button>
        </div>
      </div>`;
    document.body.appendChild(sheet);
    sheet.addEventListener('click', onSheetClick);
    sheet.addEventListener('change', onSheetChange);
    sheet.addEventListener('error', function (e) {          // broken thumbnail -> file icon
      const t = e.target;
      if (t && t.tagName === 'IMG' && t.classList.contains('ma-thumb')) {
        const d = document.createElement('div');
        d.className = 'w-full h-full flex items-center justify-center text-slate-400 text-3xl';
        d.innerHTML = '<i class="fa-solid fa-file-image"></i>';
        t.replaceWith(d);
      }
    }, true);

    const host = document.createElement('div'); host.id = 'ma-modal-host'; document.body.appendChild(host);
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (host.firstElementChild) closeModal();
      else if (!sheet.classList.contains('hidden')) closeSheet();
    });
  }

  function sheetOpen() { const s = $('ma-sheet'); return !!s && !s.classList.contains('hidden'); }
  function closeSheet() {
    const s = $('ma-sheet'); if (s) s.classList.add('hidden');
    const dorm = $('dorm-panel');
    if (!dorm || dorm.classList.contains('hidden')) document.body.style.overflow = '';   // the dorm panel keeps its own scroll lock
  }

  // ── data ──────────────────────────────────────────────────────────────────────────────────────
  function load() {
    if (loading) return loading;
    loading = (async function () {
      const r = await api('GET', API + '/application-summary');
      loading = null;
      if (!r.ok) { if (sheetOpen()) renderError(r.data.error || 'Could not load your application.'); return false; }
      D = r.data; paintCard(); if (sheetOpen()) renderBody();
      return true;
    })();
    return loading;
  }
  window.loadMyApplicationCard = load;

  function paintCard() {
    const badge = $('app-card-badge'), sub = $('app-card-sub');
    if (!D || !badge) return;
    const rev = D.revision, last = D.lastDecision;
    let txt = '', cls = '';
    if (rev && rev.status === 'pending') { txt = 'Request sent'; cls = 'bg-amber-100 text-amber-700'; }
    else if (rev && rev.status === 'approved') { txt = 'Edit unlocked'; cls = 'bg-green-100 text-green-700'; }
    else if (rev && rev.status === 'submitted') { txt = 'In review'; cls = 'bg-amber-100 text-amber-700'; }
    else if (last && last.status === 'rejected') { txt = 'Declined'; cls = 'bg-red-100 text-red-700'; }
    badge.className = txt ? `ma-chip mt-1 ${cls}` : 'hidden';
    badge.textContent = txt;
    if (sub) sub.textContent = rev && rev.status === 'approved' ? `Edit until ${phDate(rev.expiresAt)}` : rev && rev.status === 'pending' ? 'Waiting for admin approval' : rev && rev.status === 'submitted' ? 'Your changes are being reviewed' : 'Review your details & documents';
  }

  // ── PDF buttons ───────────────────────────────────────────────────────────────────────────────
  // View: open a blank tab INSIDE the tap (phones block window.open after an await), then point it at the signed link.
  async function viewPdf(btn) {
    const w = window.open('', '_blank');
    if (btn) btn.disabled = true;
    try {
      const r = await fetch(API + '/application-form/link?view=1', { credentials: 'same-origin', cache: 'no-store' });
      if (r.status === 401) { if (w) w.close(); toast('Your session expired. Please log in again.', 'error'); return; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if (!d.url) throw new Error('no link returned');
      if (w && !w.closed) w.location.href = d.url; else window.location.assign(d.url);
    } catch (e) {
      if (w) w.close();
      console.warn('[MyApplication] view pdf failed:', e.message);
      toast('Could not open your application form. Check your connection and try again.', 'error');
    } finally { if (btn) btn.disabled = false; }
  }
  window.viewMyApplicationPdf = viewPdf;

  // ── rendering ─────────────────────────────────────────────────────────────────────────────────
  function openSheet() {
    ensureShell();
    $('ma-sheet').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    $('ma-body').innerHTML = '<div class="ma-skel h-24"></div><div class="ma-skel h-40"></div><div class="ma-skel h-40"></div>';
    const first = $('ma-sheet').querySelector('button[data-act="close-sheet"]'); if (first) first.focus();
    load().then(function (ok) { if (!ok && !D) renderError('Could not load your application. Please try again.'); });   // always re-fetch: it may have changed
    if (D) renderBody();   // show the cached copy instantly while the fresh one loads
  }
  window.openMyApplication = openSheet;

  function renderError(msg) {
    const b = $('ma-body'); if (!b) return;
    b.innerHTML = `<div class="text-center py-12"><div class="text-4xl mb-2">&#9888;&#65039;</div><p class="text-sm text-slate-600 dark:text-slate-300 mb-4">${h(msg)}</p><button type="button" class="ma-btn ma-btn-pri" data-act="retry">Try again</button></div>`;
  }

  function approvedKeys() { return D && D.revision && D.revision.status === 'approved' ? D.revision.approvedItems : []; }
  function requestedKeys() { return D && D.revision && D.revision.status === 'pending' ? D.revision.items.map((i) => i.key) : []; }

  function banner() {
    const rev = D.revision;
    const box = (tone, icon, title, inner, actions) => `
      <div class="rounded-2xl border p-4 ${tone}">
        <div class="flex items-start gap-3"><i class="fa-solid ${icon} mt-0.5"></i>
          <div class="min-w-0 flex-1 text-sm"><p class="font-bold">${title}</p>${inner}</div></div>
        ${actions ? `<div class="flex flex-wrap gap-2 mt-3">${actions}</div>` : ''}
      </div>`;
    const bullets = (arr) => `<ul class="mt-1 space-y-0.5">${arr.join('')}</ul>`;
    if (rev && rev.status === 'pending') {
      return box('border-amber-200 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:border-amber-900 dark:text-amber-200', 'fa-hourglass-half', 'Waiting for the admin',
        `<p class="mt-0.5">You asked to correct: <strong>${rev.items.map((i) => h(i.label)).join(', ')}</strong>. You will get a notification when the admin decides.</p>`,
        `<button type="button" class="ma-btn ma-btn-out" data-act="withdraw" data-id="${h(rev.id)}">Withdraw request</button>`);
    }
    if (rev && rev.status === 'approved') {
      const done = new Set(rev.doneItems);
      const returned = !!rev.reviewNote && !!rev.reviewedAt;          // the admin sent submitted changes back
      return box('border-green-200 bg-green-50 text-green-900 dark:bg-green-950/30 dark:border-green-900 dark:text-green-200', 'fa-lock-open', returned ? 'Changes returned for correction' : 'Edits unlocked',
        (returned ? `<p class="mt-0.5"><strong>Admin note:</strong> ${h(rev.reviewNote)}</p><p class="mt-1">Your saved drafts are still here. Fix them and submit again before <strong>${phDate(rev.expiresAt, true)}</strong> (${timeLeft(rev.expiresAt)}).</p>`
                    : `<p class="mt-0.5">You can change the items below until <strong>${phDate(rev.expiresAt, true)}</strong> (${timeLeft(rev.expiresAt)}).</p>`) +
        bullets(rev.approvedItems.map((k) => { const it = rev.items.find((i) => i.key === k); return `<li><i class="fa-solid ${done.has(k) ? 'fa-circle-check text-green-600' : 'fa-circle text-green-300'} text-xs mr-1.5"></i>${h(it ? it.label : k)}${done.has(k) ? ' <span class="text-xs opacity-70">&middot; draft saved</span>' : ''}</li>`; })) +
        (rev.adminNote && !returned ? `<p class="mt-2 text-xs"><strong>Admin note:</strong> ${h(rev.adminNote)}</p>` : '') +
        `<p class="mt-2 text-xs opacity-80">Tap <em>Edit</em> / <em>Replace</em> on the matching card. Your changes are saved as <strong>drafts</strong>: your application does not change until you tap <em>Submit for review</em> and the admin approves them.</p>`,
        `<button type="button" class="ma-btn ma-btn-grn" data-act="submit"><i class="fa-solid fa-paper-plane text-xs"></i> Submit for review</button>`);
    }
    if (rev && rev.status === 'submitted') {
      return box('border-amber-200 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:border-amber-900 dark:text-amber-200', 'fa-hourglass-half', 'Your changes are waiting for review',
        `<p class="mt-0.5">The admin will check your changes below. They are <strong>not saved to your application yet</strong>; you will get a notification when the admin decides.</p>`,
        `<button type="button" class="ma-btn ma-btn-out" data-act="withdraw" data-id="${h(rev.id)}" data-submitted="1">Withdraw changes</button>`);
    }
    const last = D.lastDecision; let out = '';
    if (last && last.status === 'completed') {
      out += box('border-green-200 bg-green-50 text-green-900 dark:bg-green-950/30 dark:border-green-900 dark:text-green-200', 'fa-circle-check', 'Your changes were approved', `<p class="mt-0.5">They are now saved in your application.${last.reviewNote ? ' <strong>Admin note:</strong> ' + h(last.reviewNote) : ''}</p>`, '');
    } else if (last && last.status === 'rejected') {
      const changesDeclined = !!last.submittedAt;
      out += box('border-red-200 bg-red-50 text-red-900 dark:bg-red-950/30 dark:border-red-900 dark:text-red-200', 'fa-circle-xmark', changesDeclined ? 'Your changes were not approved' : 'Your last request was declined',
        `<p class="mt-0.5">${h((changesDeclined ? last.reviewNote : last.adminNote) || 'No reason was given.')}</p>${changesDeclined ? '<p class="mt-1 text-xs">Your application was not changed.</p>' : ''}`, '');
    } else if (last && last.status === 'cancelled' && last.adminNote) {
      out += box('border-slate-200 bg-white text-slate-700 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200', 'fa-circle-info', 'Edit access was closed by the admin', `<p class="mt-0.5">${h(last.adminNote)}</p>`, '');
    } else if (last && last.status === 'expired') {
      out += box('border-slate-200 bg-white text-slate-700 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200', 'fa-clock', 'Your edit window ended', '<p class="mt-0.5">Send a new request if something still needs fixing.</p>', '');
    }
    if (D.canRequest) {
      out += `<div class="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 ${out ? 'mt-3' : ''}">
        <p class="text-sm font-bold text-slate-800 dark:text-slate-100">Something wrong in your application?</p>
        <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Wrong info or the wrong document? Ask for a correction. The admin must approve it before you can edit.</p>
        <button type="button" class="ma-btn ma-btn-pri mt-3" data-act="request"><i class="fa-solid fa-pen-to-square text-xs"></i> Request a correction</button></div>`;
    }
    return out;
  }

  function rowsHtml(rows) {
    return `<dl class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">${rows.map((r) => `
      <div class="${r.wide ? 'sm:col-span-2' : ''} min-w-0"><dt class="text-[11px] font-bold uppercase tracking-wide text-slate-400">${h(r.label)}</dt>
      <dd class="text-sm text-slate-800 dark:text-slate-100 break-words">${h(r.value) || '&mdash;'}</dd></div>`).join('')}</dl>`;
  }

  function sectionCard(sec) {
    const canEdit = approvedKeys().includes(sec.key), asked = requestedKeys().includes(sec.key);
    const draft = sec.staged ? '<span class="ma-chip bg-amber-100 text-amber-700"><i class="fa-solid fa-pen-ruler"></i> Draft</span>' : '';
    const action = canEdit ? `${draft}<button type="button" class="ma-btn ma-btn-pri !min-h-[40px] !px-3" data-act="edit" data-key="${sec.key}"><i class="fa-solid fa-pen text-xs"></i> Edit</button>`
      : sec.staged ? draft
      : asked ? '<span class="ma-chip bg-amber-100 text-amber-700"><i class="fa-solid fa-hourglass-half"></i> Requested</span>' : '';
    const body = sec.groups
      ? sec.groups.map((g) => `<div class="mb-4"><p class="text-xs font-bold text-brand-600 mb-2">${h(g.title)}</p>${rowsHtml(g.rows)}</div>`).join('') + rowsHtml(sec.rows)
      : rowsHtml(sec.rows);
    return `<section class="rounded-2xl bg-white dark:bg-slate-900 border ${canEdit ? 'border-green-300 dark:border-green-800' : 'border-slate-200 dark:border-slate-800'} p-4">
      <div class="flex items-center gap-2 mb-3"><i class="fa-solid ${GROUP_ICON[sec.key] || 'fa-file'} text-brand-600"></i>
        <h3 class="font-display font-bold text-slate-900 dark:text-white flex-1">${h(sec.title)}</h3>${action}</div>${body}</section>`;
  }

  function thumbUrl(url, kind) {
    if (!url) return '';
    if (/res\.cloudinary\.com/.test(url) && url.indexOf('/upload/') > -1) {
      let u = url.replace('/upload/', '/upload/c_limit,w_360,h_360,q_auto,f_jpg,pg_1/');   // small JPG of page 1: cheap on mobile data
      if (kind === 'pdf') u = u.replace(/\.pdf(\?.*)?$/i, '.jpg');
      return u;
    }
    return kind === 'image' ? url : '';
  }

  function docCard(d) {
    const isMed = d.key === 'doc_medical';          // uploads straight to its own endpoint, no approval needed
    const canReplace = isMed || (!!DOC_FIELD[d.key] && approvedKeys().includes(d.key));
    const asked = requestedKeys().includes(d.key);
    const t = d.onFile ? thumbUrl(d.url, d.kind) : '';
    const icon = d.kind === 'pdf' ? 'fa-file-pdf text-red-500' : d.kind === 'docx' ? 'fa-file-word text-blue-500' : 'fa-file-image text-slate-400';
    const media = t ? `<img class="ma-thumb w-full h-full object-cover" loading="lazy" alt="" src="${h(t)}">`
      : `<div class="w-full h-full flex items-center justify-center text-3xl"><i class="fa-solid ${d.onFile ? icon : 'fa-file-circle-question text-slate-300'}"></i></div>`;
    return `<div class="rounded-2xl bg-white dark:bg-slate-900 border ${canReplace ? 'border-green-300 dark:border-green-800' : 'border-slate-200 dark:border-slate-800'} overflow-hidden flex flex-col">
      <div class="aspect-[4/3] bg-slate-100 dark:bg-slate-800">${media}</div>
      <div class="p-3 flex-1 flex flex-col gap-2">
        <p class="text-[13px] font-semibold text-slate-800 dark:text-slate-100 leading-snug">${h(d.label)}</p>
        <div>${d.onFile ? '<span class="ma-chip bg-green-100 text-green-700"><i class="fa-solid fa-circle-check"></i> ' + (d.staged ? 'Draft' : 'On file') + '</span>' : '<span class="ma-chip bg-slate-200 text-slate-600"><i class="fa-solid fa-circle-minus"></i> Not on file</span>'}
          ${d.staged ? '<span class="ma-chip bg-amber-100 text-amber-700 ml-1"><i class="fa-solid fa-pen-ruler"></i> New file (draft)</span>' : asked ? '<span class="ma-chip bg-amber-100 text-amber-700 ml-1">Requested</span>' : ''}</div>
        <div id="ma-prog-${d.key}" class="hidden text-xs text-brand-600 font-semibold"></div>
        <div class="mt-auto flex flex-wrap gap-2">
          ${d.onFile ? `<a href="${h(d.url)}" target="_blank" rel="noopener" class="ma-btn ma-btn-out !min-h-[40px] !px-3 flex-1"><i class="fa-solid fa-eye text-xs"></i> View</a>` : ''}
          ${canReplace ? `<label class="ma-btn ma-btn-grn !min-h-[40px] !px-3 flex-1 cursor-pointer"><i class="fa-solid fa-cloud-arrow-up text-xs"></i> ${d.onFile ? 'Replace' : 'Upload'}
            <input type="file" class="hidden" accept="image/jpeg,image/png,image/webp,application/pdf,.pdf,.docx" ${isMed ? 'data-med="1"' : `data-doc="${d.key}"`}></label>` : ''}
        </div>
        ${d.note ? `<p class="text-[11px] text-slate-400">${h(d.note)}</p>` : ''}
      </div></div>`;
  }

  function renderBody() {
    const b = $('ma-body'); if (!b || !D) return;
    const S = D.summary, st = S.status;
    $('ma-sub').textContent = [S.applicant.name, st.room ? `Room ${st.room}${st.bed ? ' \u00b7 Bed ' + st.bed : ''}` : ''].filter(Boolean).join(' \u00b7 ');
    const scroll = b.scrollTop;
    b.innerHTML = banner() + S.sections.map(sectionCard).join('') +
      `<section><h3 class="font-display font-bold text-slate-900 dark:text-white mb-3 flex items-center gap-2"><i class="fa-solid fa-folder-open text-brand-600"></i> Documents</h3>
        <div class="grid grid-cols-2 lg:grid-cols-2 gap-3">${S.documents.map(docCard).join('')}</div></section>
       <p class="text-[11px] text-center text-slate-400 pb-2">Changes are saved as drafts and need admin approval before they replace your application. Your profile photo can be changed anytime from your profile.</p>`;
    b.scrollTop = scroll;
  }

  // ── events ────────────────────────────────────────────────────────────────────────────────────
  function onSheetClick(e) {
    const el = e.target.closest('[data-act]'); if (!el) return;
    const act = el.dataset.act;
    if (act === 'close-sheet') return closeSheet();
    if (act === 'retry') { $('ma-body').innerHTML = '<div class="ma-skel h-32"></div>'; return void load(); }
    if (act === 'pdf-view') return void viewPdf(el);
    if (act === 'pdf-download') return void (typeof window.downloadMyApplicationForm === 'function' ? window.downloadMyApplicationForm() : window.location.assign('/api/users/me/application-form'));
    if (act === 'request') return openRequestModal();
    if (act === 'edit') return openEditModal(el.dataset.key);
    if (act === 'withdraw') return void withdraw(el.dataset.id, el.dataset.submitted === '1');
    if (act === 'submit') return void submitForReview();
  }
  function onSheetChange(e) {
    const inp = e.target;
    if (inp && inp.matches && inp.matches('input[type=file][data-med]') && inp.files && inp.files[0]) { const f = inp.files[0]; inp.value = ''; uploadMedical(f); return; }
    if (inp && inp.matches && inp.matches('input[type=file][data-doc]') && inp.files && inp.files[0]) { const f = inp.files[0]; const k = inp.dataset.doc; inp.value = ''; uploadDoc(k, f); }
  }

  async function withdraw(id, submitted) {
    if (busy) return;
    if (!await damisConfirm(submitted ? 'They will be discarded and your application stays as it is.' : 'Withdraw this correction request?', { title: submitted ? 'Withdraw your changes?' : 'Withdraw request?', confirmText: submitted ? 'Withdraw changes' : 'Withdraw', tone: 'warning' })) return;
    busy = true;
    const r = await api('DELETE', API + '/revisions/' + encodeURIComponent(id));
    busy = false;
    if (!r.ok) return toast(r.data.error || 'Could not withdraw your request.', 'error');
    toast(submitted ? 'Changes withdrawn.' : 'Request withdrawn.', 'success'); load();
  }
  async function submitForReview() {
    if (busy) return;
    if (!await damisConfirm('The admin must approve them before they are saved to your application, and you will not be able to edit more unless the admin sends them back.', { title: 'Submit your changes for review?', confirmText: 'Submit for review' })) return;
    busy = true;
    const r = await api('POST', API + '/revisions/current/submit');
    busy = false;
    if (!r.ok) { toast(r.data.error || 'Could not submit. Please try again.', 'error'); return void load(); }
    toast(r.data.submitted ? 'Submitted. The admin will review your changes.' : 'Closed. You had not made any changes.', 'success'); load();
  }

  // ── Medical Certificate: uploads immediately via its own endpoint (not part of the draft/approval flow) ──
  function uploadMedical(file) {
    if (busy) return toast('Please wait for the current upload to finish.', 'error');
    const isDocx = /\.docx$/i.test(file.name);
    if (!(OK_MIME.includes(file.type) || isDocx)) return toast('Please choose a JPG, PNG, WebP, PDF or DOCX file.', 'error');
    if (file.size > MAX_BYTES) return toast(`That file is ${(file.size / 1048576).toFixed(1)} MB. The limit is 15 MB. Try a smaller photo or scan.`, 'error');
    const prog = $('ma-prog-doc_medical');
    const show = (t) => { if (prog) { prog.classList.remove('hidden'); prog.textContent = t; } };
    const fd = new FormData(); fd.append('cert_medical', file, file.name);
    busy = true; show('Uploading 0%');
    const x = new XMLHttpRequest();
    x.open('POST', '/api/users/me/medical-certificate'); x.withCredentials = true; x.timeout = 180000;
    x.upload.onprogress = (ev) => { if (ev.lengthComputable) { const p = Math.round(ev.loaded / ev.total * 100); show(p >= 100 ? 'Processing\u2026' : `Uploading ${p}%`); } };
    x.onload = function () {
      busy = false;
      let data = {}; try { data = JSON.parse(x.responseText); } catch (_) { /* HTML error page */ }
      if (x.status >= 200 && x.status < 300 && data.success) {
        toast(data.replaced ? 'Medical Certificate replaced.' : 'Medical Certificate submitted.', 'success');
        if (typeof window.loadMedicalCertificate === 'function') window.loadMedicalCertificate();
        load();
      } else { toast(data.error || `Upload failed (${x.status}). Please try again.`, 'error'); if (prog) prog.classList.add('hidden'); }
    };
    x.onerror = () => { busy = false; toast('Upload failed. Check your connection and try again.', 'error'); if (prog) prog.classList.add('hidden'); };
    x.ontimeout = () => { busy = false; toast('The upload took too long. Check your connection and try again.', 'error'); if (prog) prog.classList.add('hidden'); };
    x.send(fd);
  }

  // ── document upload (XHR so the resident sees progress on slow mobile data) ───────────────────
  function uploadDoc(key, file) {
    if (busy) return toast('Please wait for the current upload to finish.', 'error');
    const isDocx = /\.docx$/i.test(file.name);
    if (!(OK_MIME.includes(file.type) || isDocx)) return toast('Please choose a JPG, PNG, WebP, PDF or DOCX file.', 'error');
    if (file.size > MAX_BYTES) return toast(`That file is ${(file.size / 1048576).toFixed(1)} MB. The limit is 15 MB. Try a smaller photo or scan.`, 'error');
    const prog = $('ma-prog-' + key);
    const show = (t) => { if (prog) { prog.classList.remove('hidden'); prog.textContent = t; } };
    const fd = new FormData(); fd.append(DOC_FIELD[key], file);
    busy = true; show('Uploading 0%');
    const x = new XMLHttpRequest();
    x.open('POST', API + '/revisions/current/documents'); x.withCredentials = true; x.timeout = 180000;
    x.upload.onprogress = (ev) => { if (ev.lengthComputable) { const p = Math.round(ev.loaded / ev.total * 100); show(p >= 100 ? 'Processing\u2026' : `Uploading ${p}%`); } };
    x.onload = function () {
      let data = {}; try { data = JSON.parse(x.responseText); } catch (_) { /* HTML error page */ }
      if (x.status >= 200 && x.status < 300) { toast('New file saved as a draft. Submit for review when you are ready.', 'success'); load(); }
      else { toast(data.error || `Upload failed (${x.status}). Please try again.`, 'error'); if (prog) prog.classList.add('hidden'); if (x.status === 403 || x.status === 410) load(); }
    };
    x.onerror = () => { toast('Upload failed. Check your connection and try again.', 'error'); if (prog) prog.classList.add('hidden'); };
    x.ontimeout = () => { toast('Upload timed out. Try again on a better connection.', 'error'); if (prog) prog.classList.add('hidden'); };
    x.onloadend = () => { busy = false; };
    x.send(fd);
  }

  // ── modal host ────────────────────────────────────────────────────────────────────────────────
  function openModal(title, bodyHtml, footerHtml) {
    ensureShell(); closeModal();
    const m = document.createElement('div');
    m.className = 'fixed inset-0 z-[130] flex items-end sm:items-center justify-center';
    m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-label', title);
    m.innerHTML = `
      <div class="absolute inset-0 bg-slate-900/60" data-modal-close></div>
      <div class="relative w-full sm:max-w-lg max-h-[94dvh] flex flex-col bg-white dark:bg-slate-900 rounded-t-3xl sm:rounded-3xl shadow-2xl">
        <div class="flex items-center gap-2 px-5 py-3 border-b border-slate-200 dark:border-slate-800">
          <h3 class="font-display font-bold text-slate-900 dark:text-white flex-1">${h(title)}</h3>
          <button type="button" data-modal-close aria-label="Close" class="w-11 h-11 rounded-full flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"><i class="fa-solid fa-xmark text-lg"></i></button>
        </div>
        <form id="ma-form" novalidate class="flex flex-col min-h-0 flex-1">
          <div id="ma-form-body" class="flex-1 overflow-y-auto overscroll-contain px-5 py-4 space-y-4">${bodyHtml}</div>
          <div class="px-5 py-3 border-t border-slate-200 dark:border-slate-800 flex gap-2 justify-end" style="padding-bottom:max(12px,env(safe-area-inset-bottom))">${footerHtml}</div>
        </form>
      </div>`;
    m.addEventListener('click', (e) => { if (e.target.closest('[data-modal-close]')) closeModal(); });
    $('ma-modal-host').appendChild(m);
    const f = m.querySelector('button[data-modal-close]'); if (f) setTimeout(() => f.focus({ preventScroll: true }), 50);   // not a text field: that would pop the phone keyboard open
    return m;
  }
  function closeModal() { const host = $('ma-modal-host'); if (host) host.innerHTML = ''; }
  function formError(msg, fieldName) {
    const box = $('ma-form-err'); if (box) { box.textContent = msg; box.classList.remove('hidden'); }
    const f = fieldName && $('ma-form') ? $('ma-form').querySelector(`[name="${fieldName}"]`) : null;
    if (f) { f.classList.add('ma-bad'); f.scrollIntoView({ block: 'center', behavior: 'smooth' }); f.focus({ preventScroll: true }); }
    else if (box) box.scrollIntoView({ block: 'nearest' });
  }
  const errBox = '<p id="ma-form-err" role="alert" class="hidden text-sm font-semibold text-red-600 bg-red-50 dark:bg-red-950/30 rounded-xl px-3 py-2"></p>';
  const cancelBtn = '<button type="button" class="ma-btn ma-btn-out" data-modal-close>Cancel</button>';

  // ── Request a correction ──────────────────────────────────────────────────────────────────────
  function openRequestModal() {
    if (!D || !D.canRequest) return toast(D && D.blockedReason ? D.blockedReason : 'You cannot send a request right now.', 'error');
    const L = D.limits;
    const group = (g, title) => `<fieldset><legend class="text-xs font-bold uppercase tracking-wide text-slate-400 mb-2">${title}</legend><div class="space-y-2">` +
      D.requestable.filter((r) => r.group === g).map((r) => `
        <div class="rounded-xl border border-slate-200 dark:border-slate-700 px-3">
          <label class="flex items-center gap-3 min-h-[48px] cursor-pointer"><input type="checkbox" class="w-5 h-5 accent-blue-600 shrink-0" name="item" value="${r.key}">
            <span class="text-sm font-semibold text-slate-800 dark:text-slate-100">${h(r.label)}</span></label>
          <div class="hidden pb-3" data-note-for="${r.key}"><input class="ma-inp" name="note-${r.key}" maxlength="${L.noteMax}" placeholder="What is wrong? (optional)" aria-label="What is wrong with ${h(r.label)}"></div>
        </div>`).join('') + '</div></fieldset>';
    const m = openModal('Request a correction',
      `<p class="text-sm text-slate-500 dark:text-slate-400">Choose what needs to be corrected. The admin will review your request, and you can edit <strong>only the items they approve</strong>.</p>
       ${group('info', 'Information')}${group('doc', 'Documents')}
       <div><label class="ma-lbl" for="ma-reason">Why do you need this change? *</label>
         <textarea id="ma-reason" name="reason" class="ma-inp" maxlength="${L.reasonMax}" placeholder="Example: I typed my birthday wrong, and my enrollment certificate is from the previous semester."></textarea>
         <p class="text-[11px] text-slate-400 mt-1 text-right"><span id="ma-reason-count">0</span>/${L.reasonMax}</p></div>${errBox}`,
      `${cancelBtn}<button type="submit" id="ma-submit" class="ma-btn ma-btn-pri"><i class="fa-solid fa-paper-plane text-xs"></i> Send request</button>`);
    const form = m.querySelector('form');
    form.addEventListener('change', (e) => { if (e.target.name === 'item') { const n = form.querySelector(`[data-note-for="${e.target.value}"]`); if (n) n.classList.toggle('hidden', !e.target.checked); } });
    form.addEventListener('input', (e) => { if (e.target.id === 'ma-reason') $('ma-reason-count').textContent = e.target.value.length; });
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); if (busy) return;
      const items = [...form.querySelectorAll('input[name=item]:checked')].map((c) => ({ key: c.value, note: (form.querySelector(`[name="note-${c.value}"]`) || {}).value || '' }));
      const reasonEl = form.elements.namedItem('reason');
      const reason = reasonEl.value.trim();
      reasonEl.classList.remove('ma-bad');
      if (!items.length) return formError('Choose at least one thing you want to correct.');
      if (reason.length < L.reasonMin) return formError(`Please explain what is wrong (at least ${L.reasonMin} characters).`, 'reason');
      busy = true; const btn = $('ma-submit'); btn.disabled = true; btn.textContent = 'Sending\u2026';
      const r = await api('POST', API + '/revisions', { items, reason });
      busy = false;
      if (!r.ok) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane text-xs"></i> Send request'; formError(r.data.error || 'Could not send your request.', r.data.field); if (r.status === 409) load(); return; }
      closeModal(); toast('Request sent. The admin will review it.', 'success'); load();
    });
  }

  // ── Edit forms (only reachable for approved items) ────────────────────────────────────────────
  const fld = (name, label, val, o) => { o = o || {};
    return `<div class="${o.wide ? 'sm:col-span-2' : ''}"><label class="ma-lbl" for="f-${name}">${h(label)}${o.req ? ' *' : ''}</label>
      <input id="f-${name}" name="${name}" type="${o.type || 'text'}" value="${h(val)}" class="ma-inp" ${o.attrs || ''}${o.req ? ' required' : ''}></div>`; };
  const sel = (name, label, val, opts, o) => { o = o || {};
    const list = opts.map((x) => (typeof x === 'string' ? { v: x, t: x } : x));
    if (val && !list.some((x) => x.v === val)) list.unshift({ v: val, t: `${val} (current)` });
    return `<div class="${o.wide ? 'sm:col-span-2' : ''}"><label class="ma-lbl" for="f-${name}">${h(label)}${o.req ? ' *' : ''}</label>
      <select id="f-${name}" name="${name}" class="ma-inp"><option value="">Select\u2026</option>${list.map((x) => `<option value="${h(x.v)}"${x.v === val ? ' selected' : ''}>${h(x.t)}</option>`).join('')}</select></div>`; };
  const phone = (name, label, val, req) => `<div><label class="ma-lbl" for="f-${name}">${h(label)}${req ? ' *' : ''}</label>
    <div class="flex"><span class="inline-flex items-center px-3 rounded-l-xl border border-r-0 border-slate-300 dark:border-slate-600 bg-slate-100 dark:bg-slate-800 text-sm text-slate-500">+63</span>
    <input id="f-${name}" name="${name}" type="tel" inputmode="numeric" autocomplete="tel-national" maxlength="10" value="${h(val)}" placeholder="9XXXXXXXXX" data-phone class="ma-inp !rounded-l-none"></div></div>`;
  const grid = (inner) => `<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">${inner}</div>`;
  const ADDR_HINT = 'Format: Purok / Street, Barangay, City / Municipality, Province, Region, Philippines';

  function courseOptions(current) {
    const cat = window.ASCOT_COURSES;
    if (!Array.isArray(cat)) return current ? [{ v: current, t: current }] : [];
    const out = []; const seen = new Set();
    const bySchool = {};
    cat.forEach((c) => { (bySchool[c.school] = bySchool[c.school] || []).push(c); });
    let html = '';
    Object.keys(bySchool).forEach((school) => {
      html += `<optgroup label="${h(school)}">` + bySchool[school].map((c) => { seen.add(c.value);
        return `<option value="${h(c.value)}"${c.value === current ? ' selected' : ''}>${h(c.familyLabel + (c.major ? ' \u2014 ' + c.major : ''))}</option>`; }).join('') + '</optgroup>';
    });
    return { html, known: seen.has(current) };
  }

  function personBlock(p, title, v, o) {
    o = o || {}; v = v || {};
    const live = o.guardian
      ? fld(p + '.relationship', 'Relationship to you', v.relationship, { req: true, attrs: 'maxlength="40" placeholder="e.g. Aunt, Grandmother"' }) + phone(p + '.phone', 'Contact number', v.phone, true) + fld(p + '.employer', 'Employer / company (optional)', v.employer, { attrs: 'maxlength="120"' }) + `<div class="sm:col-span-2"><label class="ma-lbl" for="f-${p}.address">Address *</label><textarea id="f-${p}.address" name="${p}.address" class="ma-inp" maxlength="300">${h(v.address)}</textarea></div>`
      : phone(p + '.phone', 'Contact number', v.phone, true) + fld(p + '.employer', 'Employer / company', v.employer, { req: true, attrs: 'maxlength="120"' }) + `<div class="sm:col-span-2"><label class="ma-lbl" for="f-${p}.address">Address *</label><textarea id="f-${p}.address" name="${p}.address" class="ma-inp" maxlength="300">${h(v.address)}</textarea></div>`;
    return `<fieldset class="rounded-2xl border border-slate-200 dark:border-slate-700 p-3" data-person="${p}"${o.guardian ? ' data-guardian' : ''}>
      <legend class="px-2 text-sm font-bold text-brand-600">${title}</legend>
      ${grid(fld(p + '.firstName', 'First name', v.firstName, { req: true, attrs: 'maxlength="60" autocomplete="off"' }) + fld(p + '.middleName', 'Middle name', v.middleName, { attrs: 'maxlength="60"' }) +
             fld(p + '.lastName', 'Last name', v.lastName, { req: true, attrs: 'maxlength="60"' }) + fld(p + '.suffix', 'Suffix', v.suffix, { attrs: 'maxlength="10" placeholder="Jr., Sr., III"' }))}
      ${o.guardian ? '' : `<label class="flex items-center gap-3 min-h-[44px] mt-2 cursor-pointer"><input type="checkbox" class="w-5 h-5 accent-blue-600" name="${p}.deceased" value="true" ${v.deceased ? 'checked' : ''}><span class="text-sm text-slate-700 dark:text-slate-200">Deceased</span></label>`}
      <div class="mt-3" data-live>${grid(live)}</div></fieldset>`;
  }

  function editBody(group) {
    const val = D.summary.values[group] || {}, O = D.options;
    if (group === 'info_personal') return grid(
      fld('firstName', 'First name', val.firstName, { req: true, attrs: 'maxlength="60" autocomplete="given-name"' }) + fld('middleName', 'Middle name', val.middleName, { attrs: 'maxlength="60" autocomplete="additional-name"' }) +
      fld('lastName', 'Last name', val.lastName, { req: true, attrs: 'maxlength="60" autocomplete="family-name"' }) + fld('suffix', 'Suffix', val.suffix, { attrs: 'maxlength="10" placeholder="Jr., Sr., III"' }) +
      fld('birthday', 'Date of birth', val.birthday, { type: 'date', req: true, attrs: `max="${new Date().toISOString().slice(0, 10)}" autocomplete="bday"` }) +
      sel('sex', 'Sex', val.sex, O.sexes.map((s) => ({ v: s, t: s.charAt(0).toUpperCase() + s.slice(1) })), { req: true }) +
      sel('civilStatus', 'Civil status', val.civilStatus, O.civilStatus, { req: true }) + phone('phone', 'Mobile number', val.phone, true)) +
      '<p class="text-[11px] text-slate-400">Your email and username cannot be changed here. Contact the admin if they need to change.</p>';
    if (group === 'info_address') return `<p class="text-xs text-slate-500 dark:text-slate-400">${ADDR_HINT}. Example: <em>Purok 3, Zabali, Baler, Aurora, Region III (Central Luzon), Philippines</em></p>
      <div><label class="ma-lbl" for="f-permanentAddress">Permanent address *</label><textarea id="f-permanentAddress" name="permanentAddress" class="ma-inp" maxlength="300" autocomplete="street-address">${h(val.permanentAddress)}</textarea></div>
      <div><div class="flex items-center justify-between mb-1"><label class="ma-lbl !mb-0" for="f-presentAddress">Present address *</label>
        <button type="button" class="text-xs font-bold text-brand-600 min-h-[44px] px-2" data-same-addr>Same as permanent</button></div>
        <textarea id="f-presentAddress" name="presentAddress" class="ma-inp" maxlength="300">${h(val.presentAddress)}</textarea></div>`;
    if (group === 'info_school') {
      const co = courseOptions(val.course);
      const courseSel = Array.isArray(co) ? sel('course', 'Program / course', val.course, co, { req: true, wide: true })
        : `<div class="sm:col-span-2"><label class="ma-lbl" for="f-course">Program / course *</label><select id="f-course" name="course" class="ma-inp"><option value="">Select\u2026</option>${co.known || !val.course ? '' : `<option value="${h(val.course)}" selected>${h(val.course)} (current)</option>`}${co.html}</select></div>`;
      return grid(fld('schoolName', 'School name', val.schoolName, { req: true, wide: true, attrs: 'maxlength="120"' }) + fld('schoolAddress', 'School address', val.schoolAddress, { wide: true, attrs: 'maxlength="200"' }) +
        sel('yearLevel', 'Year level', val.yearLevel, O.yearLevels.map((y) => ({ v: y, t: 'Year ' + y })), { req: true }) + '<div class="hidden sm:block"></div>' + courseSel);
    }
    if (group === 'info_family') return personBlock('father', 'Father', val.father) + personBlock('mother', 'Mother', val.mother) +
      personBlock('guardian', 'Guardian (required when both parents are deceased)', val.guardian, { guardian: true }) +
      `<div><label class="ma-lbl" for="f-monthlyIncome">Combined monthly family income *</label><select id="f-monthlyIncome" name="monthlyIncome" class="ma-inp"><option value="">Select\u2026</option>${
        (val.monthlyIncome && !O.income.includes(val.monthlyIncome) ? [val.monthlyIncome].concat(O.income) : O.income).map((x) => `<option value="${h(x)}"${x === val.monthlyIncome ? ' selected' : ''}>${h(x)}</option>`).join('')}</select></div>`;
    return '';
  }

  function nest(form) {
    const out = {};
    [...form.elements].forEach((el) => {
      if (!el.name || el.disabled || el.name === 'reason') return;
      if (el.type === 'checkbox') { if (!el.checked) return; }
      const path = el.name.split('.'); let o = out;
      path.forEach((k, i) => { if (i === path.length - 1) o[k] = el.type === 'checkbox' ? 'true' : el.value; else o = (o[k] = o[k] || {}); });
    });
    return out;
  }

  function syncFamily(form) {      // live fields off for a deceased parent; guardian only when both are deceased
    const dead = (p) => !!form.querySelector(`[name="${p}.deceased"]`).checked;
    ['father', 'mother'].forEach((p) => { const fs = form.querySelector(`[data-person="${p}"] [data-live]`); const d = dead(p); fs.classList.toggle('hidden', d); fs.querySelectorAll('input,textarea,select').forEach((i) => { i.disabled = d; }); });
    const g = form.querySelector('[data-guardian]'); const need = dead('father') && dead('mother');
    g.classList.toggle('hidden', !need); g.querySelectorAll('input,textarea,select').forEach((i) => { i.disabled = !need; });
  }

  function openEditModal(group) {
    if (!D || !approvedKeys().includes(group)) return toast('That part is not unlocked for editing.', 'error');
    const title = (D.requestable.find((r) => r.key === group) || {}).label || 'Edit';
    const m = openModal(title, editBody(group) + errBox,
      `${cancelBtn}<button type="submit" id="ma-submit" class="ma-btn ma-btn-grn"><i class="fa-solid fa-floppy-disk text-xs"></i> Save draft</button>`);
    const form = m.querySelector('form');
    form.addEventListener('input', (e) => {
      e.target.classList.remove('ma-bad');
      if (e.target.matches && e.target.matches('[data-phone]')) {          // digits only; accept +63 / 0 prefixes pasted from contacts
        let d = e.target.value.replace(/\D/g, ''); if (d.startsWith('63') && d.length > 10) d = d.slice(2); if (d.startsWith('0')) d = d.slice(1); e.target.value = d.slice(0, 10);
      }
    });
    form.addEventListener('click', (e) => { if (e.target.closest('[data-same-addr]')) { form.elements.namedItem('presentAddress').value = form.elements.namedItem('permanentAddress').value; } });
    if (group === 'info_family') { syncFamily(form); form.addEventListener('change', (e) => { if (/\.deceased$/.test(e.target.name || '')) syncFamily(form); }); }
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); if (busy) return;
      const box = $('ma-form-err'); box.classList.add('hidden'); form.querySelectorAll('.ma-bad').forEach((x) => x.classList.remove('ma-bad'));
      busy = true; const btn = $('ma-submit'); btn.disabled = true; btn.textContent = 'Saving\u2026';
      const r = await api('PUT', API + '/revisions/current/info', { group, values: nest(form) });
      busy = false; btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-floppy-disk text-xs"></i> Save draft';
      if (!r.ok) {
        const f = r.data.field ? String(r.data.field).replace(/^./, (c) => c.toLowerCase()) : '';
        formError(r.data.error || 'Could not save your changes.', f);
        if (r.status === 403 || r.status === 410) load();
        return;
      }
      closeModal();
      toast(r.data.changed ? 'Saved as a draft. Submit for review when you are ready.' : r.data.cleared ? 'Same as your current application, so the draft was cleared.' : 'No changes to save.', r.data.changed ? 'success' : 'info');
      load();
    });
  }

  // refresh when the page is shown again (phone tab backgrounded while the admin was deciding)
  document.addEventListener('visibilitychange', function () { if (!document.hidden && D && sheetOpen()) load(); });
})();
