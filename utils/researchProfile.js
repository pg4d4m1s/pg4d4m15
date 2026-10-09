/**
 * utils/researchProfile.js — Respondent profile for the Student Residents Questionnaire
 *
 * Adds the "Profile of the Respondents" data (Chapter 3, section 1) on top of
 * utils/researchSurvey.js WITHOUT modifying it: the resident instrument stays
 * frozen while data collection is running.
 *
 * What it produces
 *   - one enriched row per respondent (current instrument version only):
 *     age, age band, sex, year level, program, school, municipality, origin group,
 *     account status, plus everything getResponses() already returns
 *   - frequency tables (f, %) for each profile dimension, ready to paste into Chapter 3
 *   - age statistics (mean, SD, min, max)
 *
 * Privacy (RA 10173 / the manuscript's anonymity commitment)
 *   When anonymize is true the per-respondent rows carry the AGE BAND, not the exact
 *   age, and no municipality — only the origin group (DICADI / other Aurora / outside).
 *   Exact age + municipality + program on a 58-person sample is close to identifying.
 *   Aggregate tables always include municipality: they are counts, not individuals.
 *
 * Age is computed as of the submission date, not today, so a report regenerated
 * next month gives the same ages.
 */

'use strict';

const { db } = require('./db');
const log = require('./logger');
const { INSTRUMENT_VERSION, getResponses } = require('./researchSurvey');

/** Edit here to change the age table in Chapter 3. Order matters. */
const AGE_BANDS = [
  { label: 'Below 18',     min: 0,  max: 17  },
  { label: '18–19',        min: 18, max: 19  },
  { label: '20–21',        min: 20, max: 21  },
  { label: '22–23',        min: 22, max: 23  },
  { label: '24 and above', min: 24, max: 200 },
];

const NOT_SPECIFIED = 'Not specified';
const DICADI = ['dilasag', 'casiguran', 'dinalungan'];

/**
 * Program family code → school, mirrored from ASCOT_COURSES in public/js/auth.js.
 * If a program is added there, add it here too; anything unmapped (including
 * manually typed courses) falls back to "Other / not listed" instead of failing.
 */
const SCHOOL_BY_PROGRAM = {
  BSF: 'Forestry and Environmental Sciences', BSES: 'Forestry and Environmental Sciences', DFT: 'Forestry and Environmental Sciences',
  BEEd: 'Education', BPEd: 'Education', BSEd: 'Education', BTLE: 'Education',
  BSA: 'Agricultural Sciences', CAS: 'Agricultural Sciences',
  ABPolSci: 'Arts and Sciences',
  BSCE: 'Engineering', BSEE: 'Engineering', BSME: 'Engineering',
  BSFish: 'Fisheries and Ocean Sciences',
  BIT: 'Industrial Technology',
  DipAET: 'Industrial Technology', DipCET: 'Industrial Technology', DipEET: 'Industrial Technology', DipFT: 'Industrial Technology',
  AssocAET: 'Industrial Technology', AssocCET: 'Industrial Technology', AssocEET: 'Industrial Technology', AssocFT: 'Industrial Technology',
  CertAET: 'Industrial Technology', CertCET: 'Industrial Technology', CertEET: 'Industrial Technology', CertFT: 'Industrial Technology',
  BSIT: 'Information Technology', ACT: 'Information Technology',
  BSAcc: 'Accountancy and Business Management', BSHM: 'Accountancy and Business Management', BSTM: 'Accountancy and Business Management',
  JD: 'Law',
};

function round2(n) { return Math.round(n * 100) / 100; }

/** Whole years between a YYYY-MM-DD birthday and a reference date. null if unparseable. */
function ageAt(birthday, refDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(birthday || ''));
  if (!m) return null;
  const ref = new Date(String(refDate || '').replace(' ', 'T') + (String(refDate || '').includes('Z') ? '' : 'Z'));
  const r = Number.isNaN(ref.getTime()) ? new Date() : ref;
  let age = r.getUTCFullYear() - Number(m[1]);
  const beforeBirthday =
    (r.getUTCMonth() + 1) < Number(m[2]) ||
    ((r.getUTCMonth() + 1) === Number(m[2]) && r.getUTCDate() < Number(m[3]));
  if (beforeBirthday) age--;
  return (age >= 0 && age < 120) ? age : null;
}

function ageBand(age) {
  if (age === null) return NOT_SPECIFIED;
  const b = AGE_BANDS.find(x => age >= x.min && age <= x.max);
  return b ? b.label : NOT_SPECIFIED;
}

/**
 * permanent_address is built by the registration form as
 *   "Barangay, City/Municipality, Province, Region, Philippines"
 * (barangay / province omitted when N/A). Parsing is a heuristic: strip the country,
 * strip the region, then city = second-to-last, province = last. This is right for every
 * Aurora address; for NCR-style addresses (no province) it would pick the barangay —
 * not a case this dormitory sees.
 */
function parseAddress(addr) {
  const parts = String(addr || '').split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length && /^philippines$/i.test(parts[parts.length - 1])) parts.pop();
  if (parts.length >= 2) parts.pop();              // region
  if (!parts.length) return { municipality: '', province: '' };
  if (parts.length === 1) return { municipality: parts[0], province: '' };
  return { municipality: parts[parts.length - 2], province: parts[parts.length - 1] };
}

function originGroup({ municipality, province }) {
  if (!municipality) return NOT_SPECIFIED;
  if (DICADI.includes(municipality.toLowerCase().replace(/^(municipality|city) of\s+/i, ''))) return 'DICADI (Dilasag, Casiguran, Dinalungan)';
  if (/^aurora$/i.test(province)) return 'Other municipalities of Aurora';
  return province ? 'Outside Aurora' : NOT_SPECIFIED;
}

/** "BSIT-AP" → "BSIT". Unknown / manually typed values are kept as typed. */
function programFamily(course) {
  const raw = String(course || '').trim();
  if (!raw) return '';
  if (SCHOOL_BY_PROGRAM[raw]) return raw;
  const base = raw.replace(/-[A-Za-z]+$/, '');
  return SCHOOL_BY_PROGRAM[base] ? base : raw;
}

function tally(values, order) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  const total = values.length;
  let labels = [...counts.keys()];
  if (order) {
    labels.sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib) || a.localeCompare(b);
    });
  } else {
    labels.sort((a, b) => (counts.get(b) - counts.get(a)) || a.localeCompare(b));
  }
  // "Not specified" always last so it never reads like a real category
  labels = labels.filter(l => l !== NOT_SPECIFIED).concat(labels.includes(NOT_SPECIFIED) ? [NOT_SPECIFIED] : []);
  return labels.map(label => ({
    label,
    count: counts.get(label),
    percent: total ? round2(counts.get(label) / total * 100) : 0,
  }));
}

/**
 * @param {{ anonymize?: boolean }} opts defaults to TRUE (study-safe)
 */
function buildProfile({ anonymize = true } = {}) {
  const base = getResponses({ anonymize });

  const extras = new Map(db.prepare(`
    SELECT r.id AS rid, r.submitted_at, u.birthday, u.sex, u.school_name,
           u.permanent_address, u.role, u.is_active
      FROM research_survey_responses r
      LEFT JOIN users u ON lower(u.email) = r.email
  `).all().map(x => [x.rid, x]));

  const respondents = base
    .filter(r => r.instrumentVersion === INSTRUMENT_VERSION)
    .map(r => {
      const x = extras.get(r.id) || {};
      const age = ageAt(x.birthday, x.submitted_at);
      const addr = parseAddress(x.permanent_address);
      const family = programFamily(r.course);
      const sex = String(x.sex || '').trim();

      const row = {
        ...r,
        ageBand:      ageBand(age),
        sex:          sex || NOT_SPECIFIED,
        yearLevel:    String(r.yearLevel || '').trim() || NOT_SPECIFIED,
        program:      family || NOT_SPECIFIED,
        school:       family ? (SCHOOL_BY_PROGRAM[family] || 'Other / not listed') : NOT_SPECIFIED,
        origin:       originGroup(addr),
        accountRole:  x.role || '',
        accountActive: x.is_active === 0 ? false : true,
      };
      // Exact age + municipality only when identities are visible
      row.age          = anonymize ? null : age;
      row.municipality = anonymize ? '' : (addr.municipality || '');
      row._age         = age;                       // server-side only, stripped below
      row._municipality = addr.municipality || NOT_SPECIFIED;
      return row;
    });

  const ages = respondents.map(r => r._age).filter(a => a !== null);
  const mean = ages.length ? ages.reduce((a, b) => a + b, 0) / ages.length : null;
  const sd = ages.length > 1
    ? Math.sqrt(ages.reduce((s, a) => s + (a - mean) ** 2, 0) / (ages.length - 1))
    : null;

  const tables = {
    age:           tally(respondents.map(r => r.ageBand), AGE_BANDS.map(b => b.label)),
    sex:           tally(respondents.map(r => r.sex)),
    yearLevel:     tally(respondents.map(r => r.yearLevel), ['1st Year', '2nd Year', '3rd Year', '4th Year', '5th Year']),
    program:       tally(respondents.map(r => r.program)),
    school:        tally(respondents.map(r => r.school)),
    origin:        tally(respondents.map(r => r.origin)),
    municipality:  tally(respondents.map(r => r._municipality)),
    accountStatus: tally(respondents.map(r => r.accountStatus === 'not_found' ? 'No account' : r.accountStatus)),
  };

  const missingAge = respondents.length - ages.length;
  if (missingAge) log.warn(`[Research] ${missingAge} respondent(s) have no usable birthday — shown as "${NOT_SPECIFIED}" in the age table`);

  // Strip server-only helpers before the rows leave this module
  for (const r of respondents) { delete r._age; delete r._municipality; }

  return {
    n: respondents.length,
    anonymized: !!anonymize,
    ageStats: {
      n: ages.length,
      missing: missingAge,
      mean: mean === null ? null : round2(mean),
      sd:   sd   === null ? null : round2(sd),
      min:  ages.length ? Math.min(...ages) : null,
      max:  ages.length ? Math.max(...ages) : null,
    },
    ageBands: AGE_BANDS.map(b => b.label),
    tables,
    respondents,
  };
}

module.exports = { buildProfile, AGE_BANDS, ageAt, parseAddress };
