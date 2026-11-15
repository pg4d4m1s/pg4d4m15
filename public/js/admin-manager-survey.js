/**
 * public/js/admin-manager-survey.js — Dormitory Manager Questionnaire (admin side)
 *
 * Three jobs, all for the ISO/IEC 25010 evaluation by the dormitory manager:
 *   1. Dashboard card (#manager-survey-card) + questionnaire modal, so the manager answers
 *      from inside the admin dashboard.
 *   2. Research tab → "Dormitory Manager" panel (#manager-research-root): weighted means,
 *      item analysis, respondents, comments — kept apart from the Student Residents panel.
 *   3. Excel / PDF export of the manager results (separate files from the resident ones).
 *
 * Must load AFTER admin-research.js: it reuses window.DAMISResearchUI (esc, num, badge, …).
 * Also relies on the globals from admin.html: toast(), _pdfHeader() (optional), XLSX, jspdf.
 */

'use strict';

(function () {

  var UI = window.DAMISResearchUI;
  if (!UI) {
    console.error('[ManagerSurvey] window.DAMISResearchUI missing — admin-research.js must load first.');
    return;
  }
  var esc = UI.esc, num = UI.num, badge = UI.badge, when = UI.when, notify = UI.notify;

  var _q        = null;    // instrument spec
  var _mine     = null;    // this admin's own submission state
  var _stats    = null;    // manager stats for the Research panel
  var _anon     = true;
  var _loadedResults = false;
  var _loading  = false;

  function $id(id) { return document.getElementById(id); }

  async function getJSON(url, opts) {
    var res = await fetch(url, opts);
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  // ═══════════════════════════════════════════════════
  // 1. DASHBOARD CARD + MODAL
  // ═══════════════════════════════════════════════════

  async function loadCard() {
    var box = $id('manager-survey-card');
    if (!box) return;
    try {
      var r = await getJSON('/api/admin/research/manager/mine');
      _mine = r;
      // Survey switched OFF in Research → hide the dashboard card entirely.
      if (r.enabled === false) { box.innerHTML = ''; return; }
      renderCard();
    } catch (e) {
      // The card is a convenience — never let it break the dashboard.
      console.error('[ManagerSurvey] Card load failed:', e);
      box.innerHTML = '';
    }
  }

  function renderCard() {
    var box = $id('manager-survey-card');
    if (!box || !_mine) return;
    var done = _mine.answered && _mine.current;

    if (done) {
      box.innerHTML =
        '<div class="flex items-center gap-4 flex-wrap rounded-2xl border border-green-200 dark:border-green-900/50 bg-green-50 dark:bg-green-900/20 px-5 py-4">' +
          '<div class="w-10 h-10 rounded-xl bg-green-500 text-white flex items-center justify-center flex-shrink-0"><i class="fa-solid fa-check"></i></div>' +
          '<div class="flex-1 min-w-0">' +
            '<p class="font-semibold text-slate-800 dark:text-slate-100 text-sm">Dormitory Manager Questionnaire submitted</p>' +
            '<p class="text-xs text-slate-500 dark:text-slate-400">Thank you. Last saved ' + esc(when(_mine.updatedAt || _mine.submittedAt)) + '. You can still review or update your answers.</p>' +
          '</div>' +
          '<button id="mq-open" class="text-sm font-medium px-4 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 transition-colors">Review answers</button>' +
        '</div>';
    } else {
      box.innerHTML =
        '<div class="flex items-center gap-4 flex-wrap rounded-2xl bg-gradient-to-br from-brand-600 to-brand-700 px-5 py-4 text-white">' +
          '<div class="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center flex-shrink-0"><i class="fa-solid fa-clipboard-check"></i></div>' +
          '<div class="flex-1 min-w-0">' +
            '<p class="font-semibold text-sm">Evaluate PGA-DAMIS as Dormitory Manager</p>' +
            '<p class="text-xs opacity-80">ISO/IEC 25010 system evaluation · about 5 minutes · part of the capstone study</p>' +
          '</div>' +
          '<button id="mq-open" class="text-sm font-semibold px-4 py-2 rounded-xl bg-white text-brand-700 hover:bg-brand-50 transition-colors">Start questionnaire</button>' +
        '</div>';
    }
    var btn = $id('mq-open');
    if (btn) btn.addEventListener('click', openModal);
  }

  async function openModal() {
    try {
      if (!_q) _q = (await getJSON('/api/admin/research/manager/questionnaire')).questionnaire;
      var fresh = await getJSON('/api/admin/research/manager/mine');
      _mine = fresh;
      if (fresh.enabled === false) { closeModal(); loadCard(); notify('The survey is currently switched off.', 'error'); return; }
    } catch (e) {
      notify('Could not open the questionnaire: ' + e.message, 'error');
      return;
    }
    buildModal();
  }

  function closeModal() {
    var m = $id('mq-modal');
    if (m) m.remove();
    document.body.style.overflow = '';
  }

  function buildModal() {
    closeModal();
    var prefill  = (_mine && _mine.answered && _mine.current) ? (_mine.answers || {}) : {};
    var comments = (_mine && _mine.answered && _mine.current) ? (_mine.comments || '') : '';
    var scale    = _q.scale.slice().sort(function (a, b) { return b.value - a.value; });

    var sections = _q.characteristics.map(function (ch, ci) {
      var items = ch.items.map(function (it) {
        var opts = scale.map(function (s) {
          var checked = prefill[it.code] === s.value ? ' checked' : '';
          return '<label class="cursor-pointer">' +
            '<input type="radio" class="sr-only peer" name="mq-' + esc(it.code) + '" value="' + s.value + '"' + checked + '>' +
            '<span title="' + esc(s.label) + '" class="block px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-600 text-xs font-semibold text-slate-600 dark:text-slate-300 ' +
              'peer-checked:bg-brand-600 peer-checked:text-white peer-checked:border-brand-600 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">' +
              s.value + ' <span class="hidden sm:inline font-normal">' + esc(s.label) + '</span></span></label>';
        }).join('');
        return '<div class="mq-item py-3 border-t border-slate-100 dark:border-slate-800 rounded-lg px-2" data-item="' + esc(it.code) + '">' +
          '<p class="text-sm text-slate-700 dark:text-slate-200"><span class="text-xs font-bold text-brand-600 mr-1.5">' + esc(it.code) + '</span>' + esc(it.text) + '</p>' +
          '<div class="flex flex-wrap gap-1.5 mt-2">' + opts + '</div></div>';
      }).join('');
      return '<div class="mb-5">' +
        '<h3 class="font-semibold text-slate-800 dark:text-slate-100 text-sm">' + (ci + 1) + '. ' + esc(ch.name) + '</h3>' +
        '<p class="text-xs text-slate-400 mb-1">' + esc(ch.description) + '</p>' + items + '</div>';
    }).join('');

    var wrap = document.createElement('div');
    wrap.id = 'mq-modal';
    wrap.className = 'fixed inset-0 z-[200] bg-black/50 flex items-start sm:items-center justify-center p-0 sm:p-4';
    wrap.innerHTML =
      '<div class="bg-white dark:bg-slate-900 w-full sm:max-w-3xl max-h-screen sm:max-h-[92vh] sm:rounded-2xl flex flex-col shadow-2xl">' +
        '<div class="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-100 dark:border-slate-800">' +
          '<div><h2 class="font-display font-bold text-lg text-slate-900 dark:text-slate-100">' + esc(_q.title) + '</h2>' +
          '<p class="text-xs text-slate-400">' + esc(_q.subtitle) + ' · ' + _q.itemCount + ' statements</p></div>' +
          '<button id="mq-x" class="text-slate-400 hover:text-slate-600 text-xl leading-none" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div id="mq-body" class="flex-1 overflow-y-auto px-5 py-4">' +
          '<div class="rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-800 p-4 mb-4">' +
            '<p class="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">' + esc(_q.consentStatement) + '</p>' +
            '<label class="flex items-start gap-2 mt-3 cursor-pointer"><input id="mq-consent" type="checkbox" class="mt-0.5 accent-indigo-600"' + (_mine && _mine.answered ? ' checked' : '') + '>' +
            '<span class="text-sm font-medium text-slate-700 dark:text-slate-200">' + esc(_q.consentLabel) + '</span></label>' +
          '</div>' +
          '<p class="text-xs text-slate-500 mb-4">Rate each statement: ' + scale.map(function (s) { return '<b>' + s.value + '</b> ' + esc(s.label); }).join(' · ') + '.</p>' +
          sections +
          '<label class="block text-sm font-semibold text-slate-700 dark:text-slate-200 mb-1">' + esc(_q.commentPrompt) + '</label>' +
          '<textarea id="mq-comments" rows="4" maxlength="2000" class="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm text-slate-700 dark:text-slate-200">' + esc(comments) + '</textarea>' +
        '</div>' +
        '<div class="flex items-center justify-between gap-3 px-5 py-3 border-t border-slate-100 dark:border-slate-800">' +
          '<p id="mq-progress" class="text-xs text-slate-400"></p>' +
          '<div class="flex gap-2"><button id="mq-cancel" class="text-sm font-medium px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300">Cancel</button>' +
          '<button id="mq-submit" class="text-sm font-semibold px-5 py-2 rounded-xl bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-60">Submit</button></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    document.body.style.overflow = 'hidden';

    $id('mq-x').addEventListener('click', closeModal);
    $id('mq-cancel').addEventListener('click', closeModal);
    $id('mq-submit').addEventListener('click', submitModal);
    wrap.addEventListener('change', updateProgress);
    updateProgress();
  }

  function collectAnswers() {
    var answers = {};
    _q.characteristics.forEach(function (ch) {
      ch.items.forEach(function (it) {
        var el = document.querySelector('input[name="mq-' + it.code + '"]:checked');
        if (el) answers[it.code] = Number(el.value);
      });
    });
    return answers;
  }

  function updateProgress() {
    var p = $id('mq-progress');
    if (p) p.textContent = Object.keys(collectAnswers()).length + ' of ' + _q.itemCount + ' answered';
  }

  async function submitModal() {
    var btn = $id('mq-submit');
    var answers = collectAnswers();
    var missing = _q.characteristics.flatMap(function (ch) { return ch.items.map(function (i) { return i.code; }); })
      .filter(function (c) { return !(c in answers); });

    document.querySelectorAll('.mq-item').forEach(function (n) { n.classList.remove('bg-red-50', 'dark:bg-red-900/20'); });

    if (!$id('mq-consent').checked) {
      notify('Please tick the consent box before submitting.', 'error');
      $id('mq-consent').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (missing.length) {
      missing.forEach(function (c) {
        var n = document.querySelector('.mq-item[data-item="' + c + '"]');
        if (n) n.classList.add('bg-red-50', 'dark:bg-red-900/20');
      });
      var first = document.querySelector('.mq-item[data-item="' + missing[0] + '"]');
      if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      notify('Please answer all ' + _q.itemCount + ' statements (' + missing.length + ' left).', 'error');
      return;
    }

    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await getJSON('/api/admin/research/manager/survey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: answers, comments: $id('mq-comments').value, consentGiven: true }),
      });
      notify('Questionnaire saved. Thank you!');
      closeModal();
      await loadCard();
      if (_loadedResults) loadResults();
    } catch (e) {
      console.error('[ManagerSurvey] Submit failed:', e);
      notify('Could not save: ' + e.message, 'error');
      btn.disabled = false; btn.textContent = 'Submit';
    }
  }

  // ═══════════════════════════════════════════════════
  // 2. RESEARCH TAB — panel switch + results
  // ═══════════════════════════════════════════════════

  function setResearchPanel(which) {
    var res = $id('research-panel-residents'), man = $id('research-panel-manager');
    if (!res || !man) return;
    var isMan = which === 'manager';
    res.classList.toggle('hidden', isMan);
    man.classList.toggle('hidden', !isMan);

    ['residents', 'manager'].forEach(function (k) {
      var b = $id('research-seg-' + k);
      if (!b) return;
      var on = (k === 'manager') === isMan;
      b.classList.toggle('bg-brand-600', on);
      b.classList.toggle('text-white', on);
      b.classList.toggle('text-slate-600', !on);
      b.classList.toggle('dark:text-slate-300', !on);
    });
    if (isMan) loadResults();
  }

  async function loadResults() {
    var root = $id('manager-research-root');
    if (!root || _loading) return;
    _loading = true;
    if (!_loadedResults && typeof setLoading === 'function') setLoading(root);
    try {
      var r = await getJSON('/api/admin/research/manager/stats?anonymize=' + (_anon ? '1' : '0'));
      _stats = r.stats;
      _loadedResults = true;
      console.log('[ManagerSurvey] Loaded — ' + _stats.respondentCount + ' respondent(s), overall ' + _stats.overallMean + ' (' + _stats.overallInterpretation + ')');
      renderResults();
    } catch (e) {
      console.error('[ManagerSurvey] Results load failed:', e);
      root.innerHTML = '<div class="py-10 text-center text-sm text-red-500"><i class="fa-solid fa-circle-exclamation mr-1"></i>Failed to load: ' + esc(e.message) + '</div>';
    } finally {
      _loading = false;
    }
  }

  var BTN = 'flex items-center gap-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 text-sm font-medium px-4 py-2 rounded-xl hover:bg-slate-50 transition-colors';

  function renderResults() {
    var root = $id('manager-research-root');
    if (!root || !_stats) return;
    var st = _stats;

    var header =
      '<div class="flex items-center justify-between mb-6 flex-wrap gap-3">' +
        '<div><h1 class="font-display font-bold text-2xl text-slate-900 dark:text-slate-100">Dormitory Manager Questionnaire</h1>' +
        '<p class="text-sm text-slate-400 mt-0.5">ISO/IEC 25010 system evaluation by the dormitory manager <span class="text-slate-300">&middot;</span> <span class="font-mono text-xs">' + esc(st.instrumentVersion) + '</span></p></div>' +
        '<div class="flex items-center gap-3 flex-wrap">' +
          '<label class="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-4 py-2 cursor-pointer">' +
            '<input id="mr-anon" type="checkbox" class="accent-indigo-600"' + (_anon ? ' checked' : '') + '> Anonymize</label>' +
          '<button id="mr-excel" class="' + BTN + '"><i class="fa-solid fa-file-excel text-xs text-green-600"></i>Excel</button>' +
          '<button id="mr-pdf" class="' + BTN + '"><i class="fa-solid fa-file-pdf text-xs text-red-500"></i>PDF</button>' +
          '<button id="mr-refresh" class="' + BTN + '"><i class="fa-solid fa-rotate text-xs"></i>Refresh</button>' +
        '</div></div>';

    if (!st.respondentCount) {
      root.innerHTML = header +
        '<div class="py-16 text-center text-sm text-slate-400 bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800">' +
        '<i class="fa-solid fa-clipboard-question text-3xl mb-3 block opacity-40"></i>' +
        'The dormitory manager has not submitted the questionnaire yet. The card appears on the admin Dashboard.' +
        (st.legacyRespondentCount ? '<br><span class="text-xs">' + st.legacyRespondentCount + ' response(s) from an older instrument version are excluded.</span>' : '') +
        '</div>';
      bindHeader();
      return;
    }

    var warn = st.respondentCount > 1
      ? '<div class="mb-4 px-4 py-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900/50 text-sm text-amber-800 dark:text-amber-200">' +
        '<i class="fa-solid fa-triangle-exclamation mr-1"></i>' + st.respondentCount + ' submissions are counted, but the study has one dormitory manager. ' +
        'If another admin account was used for testing, delete that row below so it is not averaged in.</div>'
      : '';

    var cards = [
      { label: 'Respondents',            value: st.respondentCount,   sub: 'dormitory manager',                         tone: 'from-brand-600 to-brand-700',  icon: 'fa-user-tie' },
      { label: 'Overall Weighted Mean',  value: num(st.overallMean),  sub: st.overallInterpretation,                    tone: 'from-purple-600 to-purple-700', icon: 'fa-square-root-variable' },
      { label: 'Statements',             value: st.itemCount,         sub: st.characteristics.length + ' characteristics', tone: 'from-slate-600 to-slate-700',   icon: 'fa-list-check' },
      { label: 'With Comments',          value: st.comments.length,   sub: 'qualitative responses',                     tone: 'from-teal-600 to-teal-700',     icon: 'fa-comment-dots' },
    ].map(function (c) {
      return '<div class="bg-gradient-to-br ' + c.tone + ' rounded-2xl p-5 text-white"><div class="flex items-center justify-between mb-2">' +
        '<p class="text-xs font-semibold uppercase tracking-wider opacity-80">' + esc(c.label) + '</p><i class="fa-solid ' + c.icon + ' opacity-60"></i></div>' +
        '<p class="font-display font-bold text-3xl tabular-nums">' + esc(c.value) + '</p><p class="text-xs opacity-80 mt-0.5">' + esc(c.sub) + '</p></div>';
    }).join('');

    var chRows = st.characteristics.map(function (ch, i) {
      return '<tr class="border-t border-slate-100 dark:border-slate-800"><td class="px-4 py-3 text-slate-400 tabular-nums">' + (i + 1) + '</td>' +
        '<td class="px-4 py-3"><p class="font-semibold text-slate-700 dark:text-slate-200">' + esc(ch.name) + '</p><p class="text-xs text-slate-400">' + esc(ch.description) + '</p></td>' +
        '<td class="px-4 py-3 text-right font-bold tabular-nums text-slate-700 dark:text-slate-200">' + num(ch.mean) + '</td><td class="px-4 py-3">' + badge(ch.interpretation) + '</td></tr>';
    }).join('');

    var chTable =
      '<div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 overflow-hidden mb-6">' +
        '<div class="px-5 py-4 border-b border-slate-100 dark:border-slate-800"><h2 class="font-semibold text-slate-800 dark:text-slate-100">Level of Acceptability by Quality Characteristic</h2>' +
        '<p class="text-xs text-slate-400 mt-0.5">Weighted mean &Sigma;fx / N &middot; same interpretation scale as the resident questionnaire</p></div>' +
        '<div class="overflow-x-auto"><table class="w-full text-sm"><thead><tr class="text-left text-xs text-slate-500 uppercase tracking-wider"><th class="px-4 py-3 w-10">#</th><th class="px-4 py-3">ISO/IEC 25010 Characteristic</th><th class="px-4 py-3 text-right">Weighted Mean</th><th class="px-4 py-3">Interpretation</th></tr></thead><tbody>' + chRows + '</tbody>' +
        '<tfoot><tr class="border-t-2 border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60"><td></td><td class="px-4 py-3 font-extrabold text-slate-700 dark:text-slate-200">Overall</td>' +
        '<td class="px-4 py-3 text-right font-extrabold tabular-nums">' + num(st.overallMean) + '</td><td class="px-4 py-3">' + badge(st.overallInterpretation) + '</td></tr></tfoot></table></div></div>';

    var itemBlocks = st.characteristics.map(function (ch) {
      var rows = ch.items.map(function (it) {
        var f = it.frequency;
        return '<tr class="border-t border-slate-100 dark:border-slate-800"><td class="px-3 py-2.5 text-slate-700 dark:text-slate-300"><span class="text-xs font-bold text-purple-500 mr-1.5">' + esc(it.code) + '</span>' + esc(it.text) + '</td>' +
          [5, 4, 3, 2, 1].map(function (k) { return '<td class="px-2 py-2.5 text-center tabular-nums text-slate-500">' + f[k] + '</td>'; }).join('') +
          '<td class="px-3 py-2.5 text-right font-bold tabular-nums">' + num(it.mean) + '</td><td class="px-3 py-2.5">' + badge(it.interpretation) + '</td></tr>';
      }).join('');
      return '<div class="mb-6"><div class="flex items-center gap-2 mb-2"><span class="px-2 py-0.5 rounded-lg bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-300 text-xs font-extrabold">' + esc(ch.code) + '</span>' +
        '<h3 class="font-semibold text-slate-700 dark:text-slate-200 text-sm">' + esc(ch.name) + '</h3><span class="ml-auto text-xs text-slate-400">mean ' + num(ch.mean) + '</span></div>' +
        '<div class="overflow-x-auto rounded-xl border border-slate-100 dark:border-slate-800"><table class="w-full text-sm min-w-[720px]"><thead><tr class="text-xs text-slate-500 uppercase tracking-wider bg-slate-50 dark:bg-slate-800/60"><th class="px-3 py-2.5 text-left">Statement</th>' +
        ['5', '4', '3', '2', '1'].map(function (k) { return '<th class="px-2 py-2.5">' + k + '</th>'; }).join('') + '<th class="px-3 py-2.5 text-right">WM</th><th class="px-3 py-2.5 text-left">Interpretation</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
    }).join('');

    var items = '<div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 p-5 mb-6"><h2 class="font-semibold text-slate-800 dark:text-slate-100 mb-1">Item Analysis</h2>' +
      '<p class="text-xs text-slate-400 mb-4">Frequency of each rating per statement, with the weighted mean (WM).</p>' + itemBlocks + '</div>';

    var respRows = st.respondents.map(function (r) {
      var who = _anon
        ? '<p class="font-semibold text-slate-700 dark:text-slate-200">' + esc(r.respondentLabel) + '</p><p class="text-xs text-slate-400">anonymized</p>'
        : '<p class="font-semibold text-slate-700 dark:text-slate-200">' + esc(r.fullName || '—') + '</p><p class="text-xs text-slate-400">' + esc(r.email) + '</p>';
      return '<tr class="border-t border-slate-100 dark:border-slate-800 align-top"><td class="px-3 py-3">' + who + '</td>' +
        '<td class="px-3 py-3 text-xs text-slate-500">' + esc(r.accountRole || '—') + '</td>' +
        '<td class="px-3 py-3 text-xs">' + (r.current ? '<span class="text-green-600 font-semibold">current</span>' : '<span class="text-amber-600 font-semibold">older version (excluded)</span>') + '</td>' +
        st.characteristics.map(function (c) { return '<td class="px-2 py-3 text-center tabular-nums text-slate-500">' + num(r.means[c.code]) + '</td>'; }).join('') +
        '<td class="px-3 py-3 text-right font-bold tabular-nums">' + num(r.overallMean) + '</td>' +
        '<td class="px-3 py-3 text-xs text-slate-400 whitespace-nowrap">' + esc(when(r.updatedAt || r.submittedAt)) + '</td>' +
        '<td class="px-3 py-3"><button class="mr-del text-xs text-red-500 hover:text-red-700 font-semibold" data-id="' + esc(r.id) + '">Delete</button></td></tr>';
    }).join('');

    var resp = '<div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 overflow-hidden mb-6"><div class="px-5 py-4 border-b border-slate-100 dark:border-slate-800">' +
      '<h2 class="font-semibold text-slate-800 dark:text-slate-100">Submissions</h2><p class="text-xs text-slate-400 mt-0.5">One row per admin account that answered.</p></div>' +
      '<div class="overflow-x-auto"><table class="w-full text-sm min-w-[820px]"><thead><tr class="text-left text-xs text-slate-500 uppercase tracking-wider"><th class="px-3 py-3">Respondent</th><th class="px-3 py-3">Role</th><th class="px-3 py-3">Instrument</th>' +
      st.characteristics.map(function (c) { return '<th class="px-2 py-3 text-center">' + esc(c.code) + '</th>'; }).join('') +
      '<th class="px-3 py-3 text-right">Overall</th><th class="px-3 py-3">Saved</th><th></th></tr></thead><tbody>' + respRows + '</tbody></table></div></div>';

    var comments = '<div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 p-5"><h2 class="font-semibold text-slate-800 dark:text-slate-100 mb-3">Comments &amp; Suggestions</h2>' +
      (st.comments.length ? st.comments.map(function (c) {
        return '<div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-800 mb-2"><p class="text-sm text-slate-600 dark:text-slate-300 leading-relaxed whitespace-pre-wrap">' + esc(c.text) + '</p>' +
          '<p class="text-xs text-slate-400 mt-1.5">' + esc(c.authorName || c.respondentLabel) + ' &middot; ' + esc(when(c.submittedAt)) + '</p></div>';
      }).join('') : '<p class="text-sm text-slate-400 py-4 text-center">No written comments submitted.</p>') + '</div>';

    root.innerHTML = header + warn + '<div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">' + cards + '</div>' + chTable + items + resp + comments;
    bindHeader();
    root.querySelectorAll('.mr-del').forEach(function (b) { b.addEventListener('click', function () { deleteRow(b.getAttribute('data-id')); }); });
  }

  function bindHeader() {
    var a = $id('mr-anon'), x = $id('mr-excel'), p = $id('mr-pdf'), r = $id('mr-refresh');
    if (a) a.addEventListener('change', function () { _anon = a.checked; loadResults(); });
    if (x) x.addEventListener('click', exportExcel);
    if (p) p.addEventListener('click', exportPDF);
    if (r) r.addEventListener('click', loadResults);
  }

  async function deleteRow(id) {
    if (!await damisConfirm('This questionnaire submission will be deleted. This cannot be undone.', { title: 'Delete submission?', confirmText: 'Delete', tone: 'danger' })) return;
    try {
      await getJSON('/api/admin/research/manager/responses/' + encodeURIComponent(id), { method: 'DELETE' });
      notify('Submission deleted');
      await loadResults();
      loadCard();
    } catch (e) {
      notify('Could not delete: ' + e.message, 'error');
    }
  }

  // ═══════════════════════════════════════════════════
  // 3. EXPORT
  // ═══════════════════════════════════════════════════

  function sheet(rows, maxW) {
    var ws = XLSX.utils.json_to_sheet(rows), keys = Object.keys(rows[0] || {});
    ws['!cols'] = keys.map(function (k) {
      var w = k.length;
      rows.forEach(function (r) { var l = String(r[k] == null ? '' : r[k]).length; if (l > w) w = l; });
      return { wch: Math.min(Math.max(w + 2, 8), maxW || 60) };
    });
    return ws;
  }

  function exportExcel() {
    if (!_stats || !_stats.respondentCount) { notify('No data to export', 'error'); return; }
    var st = _stats, itemRows = [];
    st.characteristics.forEach(function (ch) {
      ch.items.forEach(function (it) {
        itemRows.push({ 'Characteristic': ch.name, 'Code': it.code, 'Statement': it.text,
          'SA (5)': it.frequency[5], 'A (4)': it.frequency[4], 'N (3)': it.frequency[3], 'D (2)': it.frequency[2], 'SD (1)': it.frequency[1],
          'N': it.responses, 'Sum fx': it.sumFx, 'Weighted Mean': it.mean, 'Interpretation': it.interpretation });
      });
      itemRows.push({ 'Characteristic': ch.name, 'Code': '', 'Statement': 'CHARACTERISTIC MEAN', 'SA (5)': '', 'A (4)': '', 'N (3)': '', 'D (2)': '', 'SD (1)': '',
        'N': ch.responses, 'Sum fx': '', 'Weighted Mean': ch.mean, 'Interpretation': ch.interpretation });
    });
    itemRows.push({ 'Characteristic': 'OVERALL', 'Code': '', 'Statement': 'OVERALL WEIGHTED MEAN', 'SA (5)': '', 'A (4)': '', 'N (3)': '', 'D (2)': '', 'SD (1)': '',
      'N': st.respondentCount, 'Sum fx': '', 'Weighted Mean': st.overallMean, 'Interpretation': st.overallInterpretation });

    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet(itemRows, 70), 'ISO25010 Results');

    var respRows = st.respondents.filter(function (r) { return r.current; }).map(function (r) {
      var row = { 'Respondent': r.respondentLabel };
      if (!_anon) { row['Name'] = r.fullName; row['Email'] = r.email; }
      row['Account Role'] = r.accountRole;
      st.characteristics.forEach(function (ch) { ch.items.forEach(function (it) { row[it.code] = r.answers[it.code] == null ? '' : r.answers[it.code]; }); });
      st.characteristics.forEach(function (ch) { row[ch.code + ' mean'] = r.means[ch.code] == null ? '' : r.means[ch.code]; });
      row['Overall'] = r.overallMean; row['Interpretation'] = r.interpretation; row['Saved'] = r.updatedAt || r.submittedAt;
      return row;
    });
    XLSX.utils.book_append_sheet(wb, sheet(respRows, 30), 'Responses');

    if (st.comments.length) {
      XLSX.utils.book_append_sheet(wb, sheet(st.comments.map(function (c) {
        return { 'Respondent': c.respondentLabel, 'Comment': c.text, 'Saved': c.submittedAt };
      }), 100), 'Comments');
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Report', 'Dormitory Manager Questionnaire — ISO/IEC 25010'],
      ['Instrument version', st.instrumentVersion],
      ['Respondents (n)', st.respondentCount],
      ['Identities', _anon ? 'Anonymized' : 'Visible'],
      ['Weighted mean', 'Σfx / N'],
      ['Generated', new Date().toLocaleString()],
    ]), 'Report Info');

    XLSX.writeFile(wb, 'DAMIS_Dormitory_Manager_Questionnaire.xlsx');
    notify('DAMIS_Dormitory_Manager_Questionnaire.xlsx downloaded');
  }

  function exportPDF() {
    if (!_stats || !_stats.respondentCount) { notify('No data to export', 'error'); return; }
    var jsPDF = window.jspdf && window.jspdf.jsPDF;
    if (!jsPDF) { notify('PDF library not loaded', 'error'); return; }
    var st = _stats;
    var doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    var pageW = doc.internal.pageSize.getWidth(), pageH = doc.internal.pageSize.getHeight();
    var title = 'Dormitory Manager Questionnaire — ISO/IEC 25010 Results';
    var sub = 'n = ' + st.respondentCount + '  ·  instrument ' + st.instrumentVersion + '  ·  ' + (_anon ? 'responses anonymized' : 'identity visible');

    if (typeof _pdfHeader === 'function') _pdfHeader(doc, title, sub);
    else { doc.setFontSize(14); doc.setFont('helvetica', 'bold'); doc.text(title, 14, 16); doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.text(sub, 14, 22); }

    var y = 60, HEAD = { fillColor: [99, 102, 241], textColor: 255, fontStyle: 'bold' };
    function section(h) { if (y > pageH - 40) { doc.addPage(); y = 18; } doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(30); doc.text(h, 14, y); y += 3; }
    function table(head, body, cols) {
      doc.autoTable({ startY: y, head: [head], body: body, styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak' }, headStyles: HEAD,
        alternateRowStyles: { fillColor: [248, 250, 252] }, columnStyles: cols || {}, margin: { left: 14, right: 14, bottom: 16 }, rowPageBreak: 'avoid' });
      y = doc.lastAutoTable.finalY + 9;
    }

    section('1. Level of Acceptability by Quality Characteristic');
    var crow = st.characteristics.map(function (c) { return [c.name, num(c.mean), c.interpretation]; });
    crow.push([{ content: 'OVERALL', styles: { fontStyle: 'bold' } }, { content: num(st.overallMean), styles: { fontStyle: 'bold' } }, { content: st.overallInterpretation, styles: { fontStyle: 'bold' } }]);
    table(['ISO/IEC 25010 Characteristic', 'Weighted Mean', 'Interpretation'], crow, { 1: { halign: 'center' } });

    section('2. Item Analysis');
    var irow = [];
    st.characteristics.forEach(function (ch) {
      irow.push([{ content: ch.name + '  —  mean ' + num(ch.mean) + ' (' + ch.interpretation + ')', colSpan: 10, styles: { fillColor: [224, 231, 255], fontStyle: 'bold', textColor: [49, 46, 129] } }]);
      ch.items.forEach(function (it) {
        var f = it.frequency;
        irow.push([it.code, it.text, String(f[5]), String(f[4]), String(f[3]), String(f[2]), String(f[1]), String(it.responses), num(it.mean), it.interpretation]);
      });
    });
    table(['Code', 'Statement', '5', '4', '3', '2', '1', 'N', 'WM', 'Interpretation'], irow, {
      0: { cellWidth: 12 }, 2: { cellWidth: 9, halign: 'center' }, 3: { cellWidth: 9, halign: 'center' }, 4: { cellWidth: 9, halign: 'center' },
      5: { cellWidth: 9, halign: 'center' }, 6: { cellWidth: 9, halign: 'center' }, 7: { cellWidth: 10, halign: 'center' }, 8: { cellWidth: 14, halign: 'center' }, 9: { cellWidth: 38 } });

    if (st.comments.length) {
      section('3. Comments and Suggestions');
      table(['Respondent', 'Comment'], st.comments.map(function (c) { return [c.authorName || c.respondentLabel, c.text]; }), { 0: { cellWidth: 45 } });
    }

    var pages = doc.internal.getNumberOfPages();
    for (var i = 1; i <= pages; i++) { doc.setPage(i); doc.setFontSize(8); doc.setTextColor(130); doc.text('Page ' + i + ' of ' + pages, pageW - 14, pageH - 8, { align: 'right' }); }
    doc.save('DAMIS_Dormitory_Manager_Questionnaire.pdf');
    notify('DAMIS_Dormitory_Manager_Questionnaire.pdf downloaded');
  }

  // ── Boot ─────────────────────────────────────────────────────────
  window.setResearchPanel = setResearchPanel;
  window.loadManagerCard  = loadCard;
  loadCard();

})();
