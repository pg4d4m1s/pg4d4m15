/**
 * utils/applicationRevision.js — "return application for correction" helpers
 *
 * When an admin rejects a registration, the applicant is NOT thrown away: they land back in the
 * registration wizard with every answer / document kept, the admin's comment on top, and a checklist
 * of exactly what must be corrected. This file is the single source of truth for that checklist:
 *
 *   - REVISION_ITEMS     every item an admin can flag (label shown to the applicant, wizard step, upload slot)
 *   - sanitizeFlags()    validates what the admin's browser sends (whitelist keys, trims notes)
 *   - parseFlags()       reads the JSON stored in rejected_registrations.rejection_flags
 *   - describeFlags()    plain-text lines for the rejection e-mail
 *   - sanitizeSnapshot() validates the wizard snapshot the browser sends on submit (stored so a returned
 *                        application can be restored EXACTLY, including address dropdowns)
 *
 * Pure functions, no database access — safe to require from routes, db helpers and the e-mail service.
 */
'use strict';

// key → { label, group, step, docKey?, urlCol?, field? }
//   group  'info' | 'photo' | 'doc'
//   step   wizard step the applicant must visit to fix it (3 = application, 4 = selfie, 5 = documents)
//   docKey slot id used by the wizard (doc-zone-<docKey>) · field = multipart field name · urlCol = column in rejected_registrations
const REVISION_ITEMS = Object.freeze({
  info_personal: { label: 'Personal details (name, birthday, sex, civil status, phone)', group: 'info',  step: 3 },
  info_address:  { label: 'Home address (permanent / present)',                         group: 'info',  step: 3 },
  info_school:   { label: 'School details (school, year level, course)',                group: 'info',  step: 3 },
  info_family:   { label: 'Family details (parents / guardian, monthly income)',        group: 'info',  step: 3 },
  selfie:        { label: 'Profile photo / face selfie',                                group: 'photo', step: 4, field: 'avatar' },
  doc_school_id: { label: 'School ID / Government ID',                group: 'doc', step: 5, docKey: 'school-id', field: 'id_front',        urlCol: 'id_front_url' },
  doc_residency: { label: 'Certificate of Residency',                 group: 'doc', step: 5, docKey: 'residency', field: 'cert_residency',  urlCol: 'cert_residency_url' },
  doc_low_income:{ label: 'Certificate of Low Income',                group: 'doc', step: 5, docKey: 'low-income', field: 'cert_low_income', urlCol: 'cert_low_income_url' },
  doc_enrollment:{ label: 'Certificate of Registration / Enrollment', group: 'doc', step: 5, docKey: 'enrollment', field: 'cert_enrollment', urlCol: 'cert_enrollment_url' },
  doc_grades:    { label: 'Report Card / Certificate of Grades',      group: 'doc', step: 5, docKey: 'grades',    field: 'cert_grades',     urlCol: 'cert_grades_url' },
});

const NOTE_MAX     = 200;
const REASON_MAX   = 1000;
const SNAPSHOT_MAX = 60 * 1024;   // bytes of JSON — the real snapshot is ~2-6 KB

function cleanText(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

/** Admin input → [{ key, note }] (unknown keys dropped, duplicates merged, notes trimmed). Accepts ["selfie"] or [{key,note}]. */
function sanitizeFlags(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    const key  = typeof raw === 'string' ? raw : raw && raw.key;
    const note = typeof raw === 'object' && raw ? raw.note : '';
    if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(REVISION_ITEMS, key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, note: cleanText(note, NOTE_MAX) });
  }
  return out;
}

/** Stored JSON string → [{ key, note }] (never throws; unknown keys are dropped). */
function parseFlags(json) {
  if (!json) return [];
  try { return sanitizeFlags(typeof json === 'string' ? JSON.parse(json) : json); }
  catch (_) { return []; }
}

/** [{key,note}] → [{key,note,label,group,step,docKey}] for the applicant's wizard / the admin UI. */
function decorateFlags(flags) {
  return (flags || [])
    .filter(f => REVISION_ITEMS[f.key])
    .map(f => ({ key: f.key, note: f.note || '', label: REVISION_ITEMS[f.key].label,
                 group: REVISION_ITEMS[f.key].group, step: REVISION_ITEMS[f.key].step,
                 docKey: REVISION_ITEMS[f.key].docKey || null }));
}

/** Plain-text lines for e-mails / logs: "• Certificate of Residency — blurry, retake the photo". */
function describeFlags(flags) {
  return decorateFlags(flags).map(f => `• ${f.label}${f.note ? ' — ' + f.note : ''}`);
}

/** Admin free-text comment → trimmed, control characters removed, capped. */
function cleanReason(v) { return cleanText(v, REASON_MAX); }

/**
 * Wizard snapshot (what the browser's RegResilience.captureDraft() produced) → JSON string safe to store, or ''.
 * Only the shape the restore code reads is kept: { v:1, step, fields:{id:string|number}, addr:{prefix:{region,province,city,brgy}} }.
 */
function sanitizeSnapshot(raw) {
  if (!raw) return '';
  let obj;
  try { obj = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return ''; }
  if (!obj || typeof obj !== 'object' || obj.v !== 1) return '';

  const ID_RE = /^[A-Za-z0-9:_.-]{1,80}$/;
  const fields = {};
  for (const [k, v] of Object.entries(obj.fields && typeof obj.fields === 'object' ? obj.fields : {})) {
    if (!ID_RE.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) fields[k] = v;
    else if (typeof v === 'string') fields[k] = v.slice(0, 2000);
  }
  const addr = {};
  for (const prefix of ['perm', 'pres', 'father', 'mother', 'guardian']) {
    const a = obj.addr && obj.addr[prefix];
    if (!a || typeof a !== 'object') continue;
    addr[prefix] = {};
    for (const part of ['region', 'province', 'city', 'brgy']) addr[prefix][part] = cleanText(a[part], 40);
  }
  const step = Number.isInteger(obj.step) ? Math.min(5, Math.max(3, obj.step)) : 3;
  const json = JSON.stringify({ v: 1, step, fields, addr });
  return Buffer.byteLength(json) > SNAPSHOT_MAX ? '' : json;
}

module.exports = {
  REVISION_ITEMS, NOTE_MAX, REASON_MAX,
  sanitizeFlags, parseFlags, decorateFlags, describeFlags, cleanReason, sanitizeSnapshot,
};
