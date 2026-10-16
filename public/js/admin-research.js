/**
 * public/js/admin-research.js — Admin → Community → Research tab
 *
 * Renders the Student Residents Questionnaire results:
 *   1. Headline figures (respondent count, overall weighted mean, interpretation)
 *   2. Per-characteristic weighted means (the Chapter 4 summary table)
 *   3. Per-item frequency distribution + weighted mean (the Chapter 4 detail tables)
 *   4. Individual responses, with an anonymize toggle
 *   5. Open-ended comments, each with its author (follows the anonymize toggle)
 *   6. Residents who have not yet answered the current questionnaire
 *   7. Respondent profile (age, sex, year level, program, school, origin)
 *
 * Also hosts the survey ON/OFF switch (injected at the top of the tab, see loadSurveySwitch).
 * OFF hides the questionnaire from residents' feeds and from the admin dashboard; results stay.
 *
 * Exports: a multi-sheet Excel workbook (results, profile, per-respondent responses,
 * comments, report info) and a multi-section PDF (profile, acceptability, item analysis,
 * comments). The Dormitory Manager panel lives in admin-manager-survey.js and reuses
 * the helpers exposed on window.DAMISResearchUI at the bottom of this file.
 *
 * Loaded as a separate script from admin.html so the 400 KB inline script does
 * not have to grow. It relies on these globals already defined there:
 *   escHtml(), toast(), setLoading(), exportToExcel(), exportToPDF(), fmtDateExact()
 */

'use strict';

(function () {

  var _stats      = null;
  var _responses  = [];
  var _nonResp    = null;   // { eligibleCount, respondedCount, nonRespondents[] }
  var _nonRespQuery = '';
  var _anonymize  = true;   // default ON — the study reports responses anonymously
  var _loading    = false;
  var _profile    = null;   // { n, ageStats, tables{…}, respondents[] } from /api/admin/research/profile
  var _profById   = {};     // response id → enriched respondent row

  var _surveyEnabled = null;   // null = not loaded yet
  var _switchBusy    = false;

  function $id(id) { return document.getElementById(id); }

  function esc(s) {
    return (typeof escHtml === 'function')
      ? escHtml(s)
      : String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function notify(msg, type) {
    if (typeof toast === 'function') toast(msg, type || 'success');
    else console.log('[Research] ' + msg);
  }

  function when(d) {
    if (!d) return '—';
    if (typeof fmtDateExact === 'function') return fmtDateExact(d);
    return String(d);
  }

  function num(v, dash) {
    return (v === null || v === undefined || isNaN(v)) ? (dash || '—') : Number(v).toFixed(2);
  }

  /** Colour band matching the acceptability interpretation. */
  function badge(interpretation) {
    var map = {
      'Very Highly Acceptable': 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
      'Highly Acceptable':      'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
      'Moderately Acceptable':  'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
      'Slightly Acceptable':    'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
      'Not Acceptable':         'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
    };
    var cls = map[interpretation] || 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400';
    return '<span class="inline-block px-2 py-0.5 rounded-lg text-xs font-bold whitespace-nowrap ' + cls + '">' +
             esc(interpretation || '—') + '</span>';
  }

  function statusBadge(status) {
    var map = {
      approved:  'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
      pending:   'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
      rejected:  'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
      not_found: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
    };
    var label = status === 'not_found' ? 'no account' : (status || '—');
    var cls   = map[status] || map.not_found;
    return '<span class="inline-block px-2 py-0.5 rounded-lg text-xs font-semibold capitalize ' + cls + '">' +
             esc(label) + '</span>';
  }

  // ═══════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════

  function renderHeadline() {
    var box = $id('research-headline');
    if (!box || !_stats) return;

    var cards = [
      {
        label: 'Respondents',
        value: _stats.respondentCount,
        sub:   'student resident applicants',
        icon:  'fa-users',
        tone:  'from-brand-600 to-brand-700',
      },
      {
        label: 'Overall Weighted Mean',
        value: num(_stats.overallMean),
        sub:   _stats.overallInterpretation,
        icon:  'fa-square-root-variable',
        tone:  'from-purple-600 to-purple-700',
      },
      {
        label: 'Statements per Respondent',
        value: _stats.itemCount,
        sub:   _stats.characteristics.length + ' ISO/IEC 25010 characteristics',
        icon:  'fa-list-check',
        tone:  'from-slate-600 to-slate-700',
      },
      {
        label: 'With Comments',
        value: _stats.comments.length,
        sub:   'qualitative responses',
        icon:  'fa-comment-dots',
        tone:  'from-teal-600 to-teal-700',
      },
    ];

    box.innerHTML = cards.map(function (c) {
      return '' +
        '<div class="bg-gradient-to-br ' + c.tone + ' rounded-2xl p-5 text-white">' +
          '<div class="flex items-center justify-between mb-2">' +
            '<p class="text-xs font-semibold uppercase tracking-wider opacity-80">' + esc(c.label) + '</p>' +
            '<i class="fa-solid ' + c.icon + ' opacity-60"></i>' +
          '</div>' +
          '<p class="font-display font-bold text-3xl tabular-nums">' + esc(c.value) + '</p>' +
          '<p class="text-xs opacity-80 mt-0.5">' + esc(c.sub) + '</p>' +
        '</div>';
    }).join('');
  }

  function renderProfile() {
    var box = $id('research-profile');
    if (!box) return;
    if (!_profile) {
      box.innerHTML = '<p class="text-sm text-slate-400 py-6 text-center">Respondent profile is unavailable — see the browser console.</p>';
      return;
    }
    if (!_profile.n) {
      box.innerHTML = '<p class="text-sm text-slate-400 py-6 text-center">No respondents yet.</p>';
      return;
    }

    var t = _profile.tables, a = _profile.ageStats;
    var ageNote = a.n
      ? 'Mean ' + a.mean + ' · SD ' + (a.sd === null ? '—' : a.sd) + ' · range ' + a.min + '–' + a.max +
        (a.missing ? ' · ' + a.missing + ' without a usable birthday' : '')
      : 'No usable birthdays on record';

    var blocks = [
      ['Age',                  t.age,           ageNote],
      ['Sex',                  t.sex,           ''],
      ['Year Level',           t.yearLevel,     ''],
      ['School',               t.school,        ''],
      ['Program',              t.program,       ''],
      ['Origin',               t.origin,        ''],
      ['Municipality / City',  t.municipality,  ''],
      ['Application Status',   t.accountStatus, 'Respondents whose account is not “approved” may not belong in the resident sample.'],
    ];

    box.innerHTML = '<div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">' + blocks.map(function (b) {
      var rows = b[1].map(function (r) {
        return '<tr class="border-t border-slate-100 dark:border-slate-800">' +
          '<td class="px-3 py-1.5 text-slate-700 dark:text-slate-300">' + esc(r.label) + '</td>' +
          '<td class="px-3 py-1.5 text-right tabular-nums text-slate-500">' + r.count + '</td>' +
          '<td class="px-3 py-1.5 text-right tabular-nums text-slate-500">' + r.percent.toFixed(2) + '%</td></tr>';
      }).join('');
      return '<div class="rounded-xl border border-slate-100 dark:border-slate-800 overflow-hidden">' +
        '<div class="px-3 py-2 bg-slate-50 dark:bg-slate-800/60"><p class="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">' + esc(b[0]) + '</p>' +
        (b[2] ? '<p class="text-xs text-slate-400 mt-0.5">' + esc(b[2]) + '</p>' : '') + '</div>' +
        '<table class="w-full text-sm"><tbody>' + rows +
        '<tr class="border-t-2 border-slate-200 dark:border-slate-700 font-bold"><td class="px-3 py-1.5">Total</td>' +
        '<td class="px-3 py-1.5 text-right tabular-nums">' + _profile.n + '</td><td class="px-3 py-1.5 text-right tabular-nums">100.00%</td></tr>' +
        '</tbody></table></div>';
    }).join('') + '</div>';
  }

  function renderCharacteristics() {
    var box = $id('research-characteristics');
    if (!box || !_stats) return;

    if (!_stats.respondentCount) {
      box.innerHTML = '<div class="py-12 text-center text-sm text-slate-400">' +
        '<i class="fa-solid fa-clipboard-question text-3xl mb-3 block opacity-40"></i>' +
        'No questionnaire responses yet. Answers appear here as residents submit the questionnaire card on their feed.' +
        '</div>';
      return;
    }

    var rows = _stats.characteristics.map(function (ch, i) {
      return '' +
        '<tr class="border-t border-slate-100 dark:border-slate-800">' +
          '<td class="px-4 py-3 text-slate-400 tabular-nums">' + (i + 1) + '</td>' +
          '<td class="px-4 py-3">' +
            '<p class="font-semibold text-slate-700 dark:text-slate-200">' + esc(ch.name) + '</p>' +
            '<p class="text-xs text-slate-400">' + esc(ch.description) + '</p>' +
          '</td>' +
          '<td class="px-4 py-3 text-right font-bold tabular-nums text-slate-700 dark:text-slate-200">' + num(ch.mean) + '</td>' +
          '<td class="px-4 py-3">' + badge(ch.interpretation) + '</td>' +
        '</tr>';
    }).join('');

    box.innerHTML = '' +
      '<table class="w-full text-sm">' +
        '<thead><tr class="text-left text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider">' +
          '<th class="px-4 py-3 font-semibold w-10">#</th>' +
          '<th class="px-4 py-3 font-semibold">ISO/IEC 25010 Characteristic</th>' +
          '<th class="px-4 py-3 font-semibold text-right">Weighted Mean</th>' +
          '<th class="px-4 py-3 font-semibold">Interpretation</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '<tfoot><tr class="border-t-2 border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60">' +
          '<td></td>' +
          '<td class="px-4 py-3 font-extrabold text-slate-700 dark:text-slate-200">Overall</td>' +
          '<td class="px-4 py-3 text-right font-extrabold tabular-nums text-slate-900 dark:text-slate-100">' + num(_stats.overallMean) + '</td>' +
          '<td class="px-4 py-3">' + badge(_stats.overallInterpretation) + '</td>' +
        '</tr></tfoot>' +
      '</table>';
  }

  function renderItems() {
    var box = $id('research-items');
    if (!box || !_stats) return;

    if (!_stats.respondentCount) { box.innerHTML = ''; return; }

    var html = _stats.characteristics.map(function (ch) {
      var rows = ch.items.map(function (it) {
        var f = it.frequency;
        return '' +
          '<tr class="border-t border-slate-100 dark:border-slate-800">' +
            '<td class="px-3 py-2.5 text-slate-700 dark:text-slate-300">' +
              '<span class="text-xs font-bold text-purple-500 mr-1.5">' + esc(it.code) + '</span>' + esc(it.text) +
            '</td>' +
            '<td class="px-2 py-2.5 text-center tabular-nums text-slate-500">' + f[5] + '</td>' +
            '<td class="px-2 py-2.5 text-center tabular-nums text-slate-500">' + f[4] + '</td>' +
            '<td class="px-2 py-2.5 text-center tabular-nums text-slate-500">' + f[3] + '</td>' +
            '<td class="px-2 py-2.5 text-center tabular-nums text-slate-500">' + f[2] + '</td>' +
            '<td class="px-2 py-2.5 text-center tabular-nums text-slate-500">' + f[1] + '</td>' +
            '<td class="px-3 py-2.5 text-right font-bold tabular-nums text-slate-700 dark:text-slate-200">' + num(it.mean) + '</td>' +
            '<td class="px-3 py-2.5">' + badge(it.interpretation) + '</td>' +
          '</tr>';
      }).join('');

      return '' +
        '<div class="mb-6">' +
          '<div class="flex items-center gap-2 mb-2">' +
            '<span class="px-2 py-0.5 rounded-lg bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-300 text-xs font-extrabold">' + esc(ch.code) + '</span>' +
            '<h3 class="font-semibold text-slate-700 dark:text-slate-200 text-sm">' + esc(ch.name) + '</h3>' +
            '<span class="ml-auto text-xs text-slate-400">mean ' + num(ch.mean) + '</span>' +
          '</div>' +
          '<div class="overflow-x-auto rounded-xl border border-slate-100 dark:border-slate-800">' +
            '<table class="w-full text-sm min-w-[720px]">' +
              '<thead><tr class="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider bg-slate-50 dark:bg-slate-800/60">' +
                '<th class="px-3 py-2.5 font-semibold text-left">Statement</th>' +
                '<th class="px-2 py-2.5 font-semibold" title="Strongly Agree">5</th>' +
                '<th class="px-2 py-2.5 font-semibold" title="Agree">4</th>' +
                '<th class="px-2 py-2.5 font-semibold" title="Neutral">3</th>' +
                '<th class="px-2 py-2.5 font-semibold" title="Disagree">2</th>' +
                '<th class="px-2 py-2.5 font-semibold" title="Strongly Disagree">1</th>' +
                '<th class="px-3 py-2.5 font-semibold text-right">WM</th>' +
                '<th class="px-3 py-2.5 font-semibold text-left">Interpretation</th>' +
              '</tr></thead>' +
              '<tbody>' + rows + '</tbody>' +
            '</table>' +
          '</div>' +
        '</div>';
    }).join('');

    box.innerHTML = html;
  }

  function renderResponses() {
    var box = $id('research-responses');
    if (!box) return;

    if (!_responses.length) {
      box.innerHTML = '<div class="py-10 text-center text-sm text-slate-400">No individual responses yet.</div>';
      return;
    }

    var chCodes = (_stats ? _stats.characteristics : []).map(function (c) { return c.code; });

    var head = '' +
      '<tr class="text-left text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider">' +
        '<th class="px-3 py-3 font-semibold">Respondent</th>' +
        '<th class="px-3 py-3 font-semibold">Application</th>' +
        chCodes.map(function (c) {
          return '<th class="px-2 py-3 font-semibold text-center" title="' + esc(c) + '">' + esc(c) + '</th>';
        }).join('') +
        '<th class="px-3 py-3 font-semibold text-right">Overall</th>' +
        '<th class="px-3 py-3 font-semibold">Interpretation</th>' +
        '<th class="px-3 py-3 font-semibold">Submitted</th>' +
      '</tr>';

    var rows = _responses.map(function (r) {
      var identity = _anonymize
        ? '<p class="font-semibold text-slate-700 dark:text-slate-200">' + esc(r.respondentLabel) + '</p>' +
          '<p class="text-xs text-slate-400">anonymized</p>'
        : '<p class="font-semibold text-slate-700 dark:text-slate-200">' + esc(r.fullName || '—') + '</p>' +
          '<p class="text-xs text-slate-400">' + esc(r.email) + '</p>';

      var p = _profById[r.id] || {};
      var context = [
        r.yearLevel, r.course,
        (p.sex && p.sex !== 'Not specified') ? p.sex : '',
        (p.ageBand && p.ageBand !== 'Not specified') ? 'Age ' + p.ageBand : '',
      ].filter(Boolean).join(' · ');

      return '' +
        '<tr class="border-t border-slate-100 dark:border-slate-800 align-top">' +
          '<td class="px-3 py-3">' + identity + (r.corrupt ? '<p class="text-xs text-red-500 font-bold">⚠ unreadable answers</p>' : '') + '</td>' +
          '<td class="px-3 py-3">' + statusBadge(r.accountStatus) +
            (context ? '<p class="text-xs text-slate-400 mt-1">' + esc(context) + '</p>' : '') + '</td>' +
          chCodes.map(function (c) {
            return '<td class="px-2 py-3 text-center tabular-nums text-slate-500">' + num(r.means[c]) + '</td>';
          }).join('') +
          '<td class="px-3 py-3 text-right font-bold tabular-nums text-slate-700 dark:text-slate-200">' + num(r.overallMean) + '</td>' +
          '<td class="px-3 py-3">' + badge(r.interpretation) + '</td>' +
          '<td class="px-3 py-3 text-xs text-slate-400 whitespace-nowrap">' + esc(when(r.submittedAt)) + '</td>' +
        '</tr>';
    }).join('');

    box.innerHTML =
      '<table class="w-full text-sm min-w-[900px]">' +
        '<thead>' + head + '</thead><tbody>' + rows + '</tbody>' +
      '</table>';
  }

  function renderComments() {
    var box = $id('research-comments');
    if (!box || !_stats) return;

    if (!_stats.comments.length) {
      box.innerHTML = '<p class="text-sm text-slate-400 py-6 text-center">No written comments submitted yet.</p>';
      return;
    }

    box.innerHTML = _stats.comments.map(function (c) {
      // Server already blanks name/email when anonymized; authorName is then "Respondent N".
      var who = '<span class="font-semibold text-slate-600 dark:text-slate-300">' + esc(c.authorName || c.respondentLabel || '—') + '</span>' +
        (c.respondentLabel && !_anonymize ? ' <span class="text-slate-300 dark:text-slate-600">(' + esc(c.respondentLabel) + ')</span>' : '') +
        (!_anonymize && c.email ? ' &middot; ' + esc(c.email) : '');
      return '' +
        '<div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-800 mb-2">' +
          '<p class="text-sm text-slate-600 dark:text-slate-300 leading-relaxed whitespace-pre-wrap">' + esc(c.text) + '</p>' +
          '<p class="text-xs text-slate-400 mt-1.5">' + who + ' &middot; ' + esc(when(c.submittedAt)) + '</p>' +
        '</div>';
    }).join('');
  }

  function renderNonRespondents() {
    var box = $id('research-nonrespondents');
    var sum = $id('research-nonrespondents-summary');
    if (!box) return;
    if (!_nonResp) { box.innerHTML = ''; return; }

    var all = _nonResp.nonRespondents || [];
    if (sum) {
      sum.textContent = all.length + ' of ' + _nonResp.eligibleCount + ' approved resident' +
        (_nonResp.eligibleCount === 1 ? '' : 's') + ' have not answered yet (' + _nonResp.respondedCount + ' answered).';
    }
    if (!all.length) {
      box.innerHTML = '<p class="text-sm text-green-600 py-6 text-center"><i class="fa-solid fa-circle-check mr-1"></i>Every approved resident has answered.</p>';
      return;
    }

    var q = _nonRespQuery.trim().toLowerCase();
    var list = q ? all.filter(function (r) {
      return (r.fullName + ' ' + r.username + ' ' + r.email + ' ' + r.course).toLowerCase().indexOf(q) !== -1;
    }) : all;

    var rows = list.map(function (r, i) {
      var ctx  = [r.yearLevel, r.course].filter(Boolean).join(' · ');
      var room = r.roomNumber ? 'Room ' + esc(r.roomNumber) + (r.bedNumber ? ' · Bed ' + esc(r.bedNumber) : '') : '<span class="text-slate-300">unassigned</span>';
      return '' +
        '<tr class="border-t border-slate-100 dark:border-slate-800">' +
          '<td class="px-3 py-2.5 text-slate-400 tabular-nums">' + (i + 1) + '</td>' +
          '<td class="px-3 py-2.5"><p class="font-semibold text-slate-700 dark:text-slate-200">' + esc(r.lastName ? r.lastName + ', ' + r.firstName : r.fullName) + '</p>' +
            '<p class="text-xs text-slate-400">@' + esc(r.username) + ' &middot; ' + esc(r.email) + '</p></td>' +
          '<td class="px-3 py-2.5 text-xs text-slate-500">' + esc(ctx || '—') + '</td>' +
          '<td class="px-3 py-2.5 text-xs text-slate-500">' + room + '</td>' +
          '<td class="px-3 py-2.5 text-xs">' + (r.answeredOlderVersion
            ? '<span class="px-2 py-0.5 rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 font-semibold">answered older version</span>'
            : '<span class="text-slate-400">no response</span>') + '</td>' +
        '</tr>';
    }).join('');

    box.innerHTML = list.length
      ? '<table class="w-full text-sm min-w-[640px]"><thead><tr class="text-left text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider">' +
          '<th class="px-3 py-2.5 font-semibold w-10">#</th><th class="px-3 py-2.5 font-semibold">Resident</th>' +
          '<th class="px-3 py-2.5 font-semibold">Year · Course</th><th class="px-3 py-2.5 font-semibold">Room</th>' +
          '<th class="px-3 py-2.5 font-semibold">Status</th></tr></thead><tbody>' + rows + '</tbody></table>'
      : '<p class="text-sm text-slate-400 py-6 text-center">No matches.</p>';
  }

  function filterNonRespondents(q) {
    _nonRespQuery = q || '';
    renderNonRespondents();
  }

  function renderAnonToggle() {
    var btn   = $id('research-anon-toggle');
    var thumb = $id('research-anon-thumb');
    var desc  = $id('research-anon-desc');
    if (!btn || !thumb) return;

    btn.classList.toggle('bg-brand-600', _anonymize);
    btn.classList.toggle('bg-slate-200', !_anonymize);
    thumb.style.transform = _anonymize ? 'translateX(24px)' : 'translateX(0)';
    if (desc) {
      desc.textContent = _anonymize
        ? 'On — names and emails hidden (R1, R2 …)'
        : 'Off — identities visible';
    }
  }

  // ═══════════════════════════════════════════════════
  // LOAD
  // ═══════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════
  // SURVEY ON/OFF SWITCH (markup is injected so admin.html does not need to change)
  // ═══════════════════════════════════════════════════

  async function switchRequest(method, body) {
    var res  = await fetch('/api/admin/research/survey-switch', {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  function renderSurveySwitch(errMsg) {
    var tab = $id('tab-research');
    if (!tab) return;
    var host = $id('research-survey-switch');
    if (!host) {
      host = document.createElement('div');
      host.id = 'research-survey-switch';
      host.className = 'mb-6';
      tab.insertBefore(host, tab.firstChild);
    }

    var known = _surveyEnabled !== null;
    var on    = _surveyEnabled === true;
    var desc  = errMsg ? 'Could not load the survey setting: ' + errMsg
      : !known ? 'Loading…'
      : on  ? 'ON — residents see the survey card on their feed, and the Dormitory Manager card shows on the admin dashboard.'
            : 'OFF — the survey is hidden from residents and from the admin dashboard, and new submissions are blocked. Collected responses and the results below are kept.';

    host.innerHTML =
      '<div class="flex items-center justify-between gap-4 flex-wrap rounded-2xl border px-5 py-4 bg-white dark:bg-slate-800 ' +
        (on ? 'border-green-200 dark:border-green-900/50' : 'border-slate-200 dark:border-slate-700') + '">' +
        '<div class="flex items-center gap-3 min-w-0">' +
          '<div class="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ' +
            (on ? 'bg-green-500 text-white' : 'bg-slate-200 dark:bg-slate-700 text-slate-500') + '"><i class="fa-solid fa-clipboard-question"></i></div>' +
          '<div class="min-w-0">' +
            '<p class="text-sm font-semibold text-slate-700 dark:text-slate-200">Survey availability</p>' +
            '<p class="text-xs ' + (errMsg ? 'text-red-500' : 'text-slate-400') + '">' + esc(desc) + '</p>' +
          '</div>' +
        '</div>' +
        '<button id="research-survey-switch-btn" role="switch" aria-checked="' + on + '" ' +
          'class="relative w-12 h-6 rounded-full transition-colors duration-200 flex-shrink-0 ' +
          (on ? 'bg-brand-600' : 'bg-slate-200 dark:bg-slate-700') + (known && !_switchBusy ? '' : ' opacity-50 cursor-not-allowed') + '" ' +
          'title="' + (on ? 'Turn the survey off' : 'Turn the survey on') + '"' + (known && !_switchBusy ? '' : ' disabled') + '>' +
          '<span class="absolute left-1 top-1 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200" ' +
            'style="transform:' + (on ? 'translateX(24px)' : 'translateX(0)') + '"></span>' +
        '</button>' +
      '</div>';

    var btn = $id('research-survey-switch-btn');
    if (btn) btn.addEventListener('click', toggleSurveySwitch);
  }

  async function loadSurveySwitch() {
    try {
      var data = await switchRequest('GET');
      _surveyEnabled = !!data.enabled;
      renderSurveySwitch();
    } catch (e) {
      console.error('[Research] Survey switch load failed:', e);
      renderSurveySwitch(e.message);
    }
  }

  async function toggleSurveySwitch() {
    if (_switchBusy || _surveyEnabled === null) return;
    var next = !_surveyEnabled;
    _switchBusy = true;
    renderSurveySwitch();
    try {
      var data = await switchRequest('PUT', { enabled: next });
      _surveyEnabled = !!data.enabled;
      notify(_surveyEnabled ? 'Survey turned ON — it is visible again.' : 'Survey turned OFF — hidden from residents and admin.');
      console.log('[Research] Survey switch → ' + (_surveyEnabled ? 'ON' : 'OFF'));
      // Refresh the dashboard's Dormitory Manager card so it shows/hides immediately.
      if (typeof window.loadManagerCard === 'function') window.loadManagerCard();
    } catch (e) {
      console.error('[Research] Survey switch change failed:', e);
      notify('Could not change the survey setting: ' + e.message, 'error');
    } finally {
      _switchBusy = false;
      renderSurveySwitch();
    }
  }

  async function loadResearchTab() {
    loadSurveySwitch();   // independent of the results below; handles its own errors
    if (_loading) return;
    _loading = true;

    var chBox = $id('research-characteristics');
    if (chBox && typeof setLoading === 'function') setLoading(chBox);

    try {
      var results = await Promise.all([
        fetch('/api/admin/research/stats?anonymize=' + (_anonymize ? '1' : '0')).then(function (r) { return r.json(); }),
        fetch('/api/admin/research/responses?anonymize=' + (_anonymize ? '1' : '0')).then(function (r) { return r.json(); }),
        fetch('/api/admin/research/non-respondents').then(function (r) { return r.json(); }),
      ]);

      var statsRes = results[0], respRes = results[1], nonRes = results[2];
      if (statsRes.error) throw new Error(statsRes.error);
      if (respRes.error)  throw new Error(respRes.error);
      if (nonRes.error)   throw new Error(nonRes.error);

      _stats     = statsRes.stats;
      _responses = respRes.responses || [];
      _nonResp   = nonRes;

      // Profile is additive: if it fails, the rest of the tab (and the results exports) still work.
      try {
        var profRes = await fetch('/api/admin/research/profile?anonymize=' + (_anonymize ? '1' : '0')).then(function (r) { return r.json(); });
        if (profRes.error) throw new Error(profRes.error);
        _profile = profRes.profile;
        _profById = {};
        (_profile.respondents || []).forEach(function (r) { _profById[r.id] = r; });
      } catch (pe) {
        console.error('[Research] Profile load failed:', pe);
        _profile = null; _profById = {};
        notify('Respondent profile could not be loaded: ' + pe.message, 'error');
      }

      console.log('[Research] Loaded — ' + _stats.respondentCount + ' respondent(s), overall mean ' +
                  _stats.overallMean + ' (' + _stats.overallInterpretation + '), instrument ' +
                  _stats.instrumentVersion);

      renderAnonToggle();
      renderHeadline();
      renderProfile();
      renderCharacteristics();
      renderItems();
      renderResponses();
      renderComments();
      renderNonRespondents();

      var ver = $id('research-version');
      if (ver) ver.textContent = _stats.instrumentVersion;

    } catch (e) {
      console.error('[Research] Load failed:', e);
      notify('Could not load questionnaire results: ' + e.message, 'error');
      if (chBox) {
        chBox.innerHTML = '<div class="py-10 text-center text-sm text-red-500">' +
          '<i class="fa-solid fa-circle-exclamation mr-1"></i>Failed to load: ' + esc(e.message) + '</div>';
      }
    } finally {
      _loading = false;
    }
  }

  function toggleResearchAnonymize() {
    _anonymize = !_anonymize;
    renderAnonToggle();
    loadResearchTab();
  }

  // ═══════════════════════════════════════════════════
  // EXPORT
  // ═══════════════════════════════════════════════════

  /** Per-item table — the sheet that maps straight onto the Chapter 4 tables. */
  function researchItemRows() {
    if (!_stats) return [];
    var out = [];
    _stats.characteristics.forEach(function (ch) {
      ch.items.forEach(function (it) {
        out.push({
          'Characteristic': ch.name,
          'Code':           it.code,
          'Statement':      it.text,
          'SA (5)':         it.frequency[5],
          'A (4)':          it.frequency[4],
          'N (3)':          it.frequency[3],
          'D (2)':          it.frequency[2],
          'SD (1)':         it.frequency[1],
          'N':              it.responses,
          'Sum fx':         it.sumFx,
          'Weighted Mean':  it.mean,
          'Interpretation': it.interpretation,
        });
      });
      out.push({
        'Characteristic': ch.name,
        'Code':           '',
        'Statement':      'CHARACTERISTIC MEAN',
        'SA (5)': '', 'A (4)': '', 'N (3)': '', 'D (2)': '', 'SD (1)': '',
        'N':              ch.responses,
        'Sum fx':         '',
        'Weighted Mean':  ch.mean,
        'Interpretation': ch.interpretation,
      });
    });
    out.push({
      'Characteristic': 'OVERALL',
      'Code':           '',
      'Statement':      'OVERALL WEIGHTED MEAN',
      'SA (5)': '', 'A (4)': '', 'N (3)': '', 'D (2)': '', 'SD (1)': '',
      'N':              _stats.respondentCount,
      'Sum fx':         '',
      'Weighted Mean':  _stats.overallMean,
      'Interpretation': _stats.overallInterpretation,
    });
    return out;
  }

  /** json_to_sheet with column widths sized to content (capped so long statements don't explode the sheet). */
  function sheetFromRows(rows, maxWidth) {
    var ws = XLSX.utils.json_to_sheet(rows);
    var keys = Object.keys(rows[0] || {});
    ws['!cols'] = keys.map(function (k) {
      var w = k.length;
      rows.forEach(function (r) { var l = String(r[k] == null ? '' : r[k]).length; if (l > w) w = l; });
      return { wch: Math.min(Math.max(w + 2, 8), maxWidth || 60) };
    });
    return ws;
  }

  function profileSheetRows() {
    var t = _profile.tables, a = _profile.ageStats, out = [];
    function block(title, rows) {
      out.push([title, '', '', '']);
      rows.forEach(function (r) { out.push(['', r.label, r.count, r.percent]); });
      out.push(['', 'Total', _profile.n, 100]);
      out.push(['', '', '', '']);
    }
    out.push(['Dimension', 'Category', 'f', '%']);
    block('Age', t.age);
    out.push(['', 'Mean age', a.mean == null ? '' : a.mean, '']);
    out.push(['', 'Standard deviation', a.sd == null ? '' : a.sd, '']);
    out.push(['', 'Youngest – oldest', a.n ? a.min + ' – ' + a.max : '', '']);
    out.push(['', 'Respondents with a usable birthday', a.n, '']);
    out.push(['', '', '', '']);
    block('Sex', t.sex);
    block('Year Level', t.yearLevel);
    block('School', t.school);
    block('Program', t.program);
    block('Origin', t.origin);
    block('Municipality / City', t.municipality);
    block('Application Status', t.accountStatus);
    return out;
  }

  function responseSheetRows() {
    var chars = _stats.characteristics;
    return (_profile.respondents || []).slice().sort(function (a, b) { return a.respondentNo - b.respondentNo; }).map(function (r) {
      var row = { 'Respondent': r.respondentLabel };
      if (!_anonymize) { row['Name'] = r.fullName; row['Email'] = r.email; }
      row['Application Status'] = r.accountStatus === 'not_found' ? 'No account' : r.accountStatus;
      row['Sex']        = r.sex;
      row['Age Band']   = r.ageBand;
      if (!_anonymize) { row['Age'] = r.age == null ? '' : r.age; }
      row['Year Level'] = r.yearLevel;
      row['Program']    = r.program;
      row['School']     = r.school;
      row['Origin']     = r.origin;
      if (!_anonymize) { row['Municipality / City'] = r.municipality; }
      chars.forEach(function (ch) { ch.items.forEach(function (it) { row[it.code] = r.answers[it.code] == null ? '' : r.answers[it.code]; }); });
      chars.forEach(function (ch) { row[ch.code + ' mean'] = r.means[ch.code] == null ? '' : r.means[ch.code]; });
      row['Overall']        = r.overallMean == null ? '' : r.overallMean;
      row['Interpretation'] = r.interpretation;
      row['Submitted']      = r.submittedAt;
      return row;
    });
  }

  function exportResearchExcel() {
    var rows = researchItemRows();
    if (!rows.length || !_stats.respondentCount) { notify('No data to export', 'error'); return; }

    var wb = XLSX.utils.book_new();

    // Sheet 1 keeps the original name and columns — it is the sheet Chapter 3's item tables are built from.
    XLSX.utils.book_append_sheet(wb, sheetFromRows(rows, 70), 'ISO25010 Results');

    if (_profile && _profile.n) {
      var wsP = XLSX.utils.aoa_to_sheet(profileSheetRows());
      wsP['!cols'] = [{ wch: 22 }, { wch: 42 }, { wch: 8 }, { wch: 10 }];
      XLSX.utils.book_append_sheet(wb, wsP, 'Respondent Profile');

      var resp = responseSheetRows();
      if (resp.length) {
        var wsR = sheetFromRows(resp, 30);
        wsR['!autofilter'] = { ref: wsR['!ref'] };
        XLSX.utils.book_append_sheet(wb, wsR, 'Responses');
      }
    }

    if (_stats.comments.length) {
      XLSX.utils.book_append_sheet(wb, sheetFromRows(_stats.comments.map(function (c) {
        var row = { 'Respondent': c.respondentLabel };
        if (!_anonymize) { row['Name'] = c.authorName; row['Email'] = c.email; }
        row['Comment']   = c.text;
        row['Submitted'] = c.submittedAt;
        return row;
      }), 100), 'Comments');
    }

    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Report',              'Student Residents Questionnaire — ISO/IEC 25010'],
      ['Instrument version',  _stats.instrumentVersion],
      ['Respondents (n)',     _stats.respondentCount],
      ['Earlier-version responses excluded', _stats.legacyRespondentCount || 0],
      ['Identities',          _anonymize ? 'Anonymized (exact age and municipality omitted from per-respondent rows)' : 'Visible'],
      ['Weighted mean',       'Σfx / N'],
      ['Interpretation',      '4.21–5.00 Very Highly Acceptable · 3.41–4.20 Highly Acceptable · 2.61–3.40 Moderately Acceptable · 1.81–2.60 Slightly Acceptable · 1.00–1.80 Not Acceptable'],
      ['Generated',           new Date().toLocaleString()],
    ]), 'Report Info');

    XLSX.writeFile(wb, 'DAMIS_Student_Residents_Questionnaire.xlsx');
    notify('DAMIS_Student_Residents_Questionnaire.xlsx downloaded');
  }

  function exportResearchPDF() {
    if (!_stats || !_stats.respondentCount) { notify('No data to export', 'error'); return; }
    var jsPDF = window.jspdf && window.jspdf.jsPDF;
    if (!jsPDF) { notify('PDF library not loaded', 'error'); return; }

    var doc   = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    var pageW = doc.internal.pageSize.getWidth();
    var pageH = doc.internal.pageSize.getHeight();
    var title = 'Student Residents Questionnaire — ISO/IEC 25010 Results';
    var sub   = 'n = ' + _stats.respondentCount + '  ·  instrument ' + _stats.instrumentVersion + '  ·  ' +
                (_anonymize ? 'responses anonymized' : 'identities visible');

    if (typeof _pdfHeader === 'function') {
      _pdfHeader(doc, title, sub);
    } else {
      doc.setFontSize(14); doc.setFont('helvetica', 'bold'); doc.text(title, 14, 16);
      doc.setFontSize(9);  doc.setFont('helvetica', 'normal'); doc.text(sub, 14, 22);
    }

    var y = 60;
    var HEAD = { fillColor: [99, 102, 241], textColor: 255, fontStyle: 'bold' };

    function section(heading) {
      if (y > pageH - 40) { doc.addPage(); y = 18; }
      doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(30);
      doc.text(heading, 14, y);
      y += 3;
    }
    function table(head, body, columnStyles) {
      doc.autoTable({
        startY: y, head: [head], body: body,
        styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak' },
        headStyles: HEAD,
        alternateRowStyles: { fillColor: [248, 250, 252] },
        columnStyles: columnStyles || {},
        margin: { left: 14, right: 14, bottom: 16 },
        rowPageBreak: 'avoid',
      });
      y = doc.lastAutoTable.finalY + 9;
    }

    // 1. Profile
    if (_profile && _profile.n) {
      var a = _profile.ageStats, t = _profile.tables;
      section('1. Profile of the Respondents  (n = ' + _profile.n + ')');
      var prow = [];
      [['Age', t.age], ['Sex', t.sex], ['Year Level', t.yearLevel], ['School', t.school], ['Origin', t.origin]].forEach(function (b) {
        b[1].forEach(function (r, i) { prow.push([i === 0 ? b[0] : '', r.label, String(r.count), r.percent.toFixed(2) + '%']); });
      });
      table(['Dimension', 'Category', 'f', '%'], prow, { 2: { halign: 'right' }, 3: { halign: 'right' } });
      if (a.n) {
        doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(90);
        doc.text('Age: mean ' + a.mean + ', SD ' + (a.sd === null ? '—' : a.sd) + ', range ' + a.min + '–' + a.max +
                 (a.missing ? '  (' + a.missing + ' without a usable birthday)' : ''), 14, y - 4);
        doc.setTextColor(0); y += 4;
      }
    }

    // 2. Acceptability by characteristic
    section('2. Level of Acceptability by Quality Characteristic');
    var crow = _stats.characteristics.map(function (ch) { return [ch.name, num(ch.mean), ch.interpretation]; });
    crow.push([{ content: 'OVERALL', styles: { fontStyle: 'bold' } }, { content: num(_stats.overallMean), styles: { fontStyle: 'bold' } },
               { content: _stats.overallInterpretation, styles: { fontStyle: 'bold' } }]);
    table(['ISO/IEC 25010 Characteristic', 'Weighted Mean', 'Interpretation'], crow, { 1: { halign: 'center' } });

    // 3. Item analysis
    section('3. Item Analysis');
    var irow = [];
    _stats.characteristics.forEach(function (ch) {
      irow.push([{ content: ch.name + '  —  mean ' + num(ch.mean) + ' (' + ch.interpretation + ')', colSpan: 10,
                   styles: { fillColor: [224, 231, 255], fontStyle: 'bold', textColor: [49, 46, 129] } }]);
      ch.items.forEach(function (it) {
        var f = it.frequency;
        irow.push([it.code, it.text, String(f[5]), String(f[4]), String(f[3]), String(f[2]), String(f[1]), String(it.responses), num(it.mean), it.interpretation]);
      });
    });
    table(['Code', 'Statement', '5', '4', '3', '2', '1', 'N', 'WM', 'Interpretation'], irow, {
      0: { cellWidth: 12 }, 1: { cellWidth: 'auto' },
      2: { cellWidth: 9, halign: 'center' }, 3: { cellWidth: 9, halign: 'center' }, 4: { cellWidth: 9, halign: 'center' },
      5: { cellWidth: 9, halign: 'center' }, 6: { cellWidth: 9, halign: 'center' }, 7: { cellWidth: 10, halign: 'center' },
      8: { cellWidth: 14, halign: 'center' }, 9: { cellWidth: 38 },
    });

    // 4. Comments
    if (_stats.comments.length) {
      section('4. Comments and Suggestions');
      table(['Respondent', 'Comment'], _stats.comments.map(function (c) {
        return [_anonymize ? c.respondentLabel : (c.authorName || c.respondentLabel), c.text];
      }), { 0: { cellWidth: 38 } });
    }

    // footer
    var pages = doc.internal.getNumberOfPages();
    for (var i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setFontSize(8); doc.setTextColor(130);
      doc.text('Page ' + i + ' of ' + pages, pageW - 14, pageH - 8, { align: 'right' });
    }

    doc.save('DAMIS_Student_Residents_Questionnaire.pdf');
    notify('DAMIS_Student_Residents_Questionnaire.pdf downloaded');
  }

  /** Follow-up list for the researcher — names are intentionally included (see getNonRespondents). */
  function exportNonRespondentsExcel() {
    if (!_nonResp || !_nonResp.nonRespondents.length) { notify('No non-respondents to export', 'error'); return; }
    var rows = _nonResp.nonRespondents.map(function (r) {
      return {
        'Last Name':  r.lastName,
        'First Name': r.firstName,
        'Username':   r.username,
        'Email':      r.email,
        'Year Level': r.yearLevel,
        'Course':     r.course,
        'Room':       r.roomNumber ? r.roomNumber + (r.bedNumber ? '-' + r.bedNumber : '') : '',
        'Status':     r.answeredOlderVersion ? 'Answered older version' : 'No response',
      };
    });
    exportToExcel(rows, Object.keys(rows[0]), 'DAMIS_Questionnaire_NonRespondents.xlsx', 'Not yet answered');
  }

  // Shared with admin-manager-survey.js (loaded after this file).
  window.DAMISResearchUI = {
    esc: esc, num: num, badge: badge, when: when, notify: notify,
    isAnonymized: function () { return _anonymize; },
  };

  // Expose the handlers referenced from admin.html markup.
  window.loadResearchTab         = loadResearchTab;
  window.toggleResearchAnonymize = toggleResearchAnonymize;
  window.exportResearchExcel     = exportResearchExcel;
  window.exportResearchPDF       = exportResearchPDF;
  window.filterNonRespondents    = filterNonRespondents;
  window.exportNonRespondentsExcel = exportNonRespondentsExcel;
})();
