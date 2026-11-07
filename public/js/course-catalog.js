// ═══════════════════════════════════════════════════════════════════
// PGA-DAMIS — ASCOT course catalog (single source of truth)
//
// Loaded by index.html (registration cascade, js/auth.js) AND admin.html (so the admin
// application views show the SAME full course / major names the applicant picked, instead
// of codes such as "BIT-AET"). To add or rename a program, edit ASCOT_COURSES below —
// nothing else needs to change.
//
// The database keeps storing the short `value` code (BIT-AET, BSIT-AP …); only the DISPLAY
// is expanded, via courseFullName() / courseMajorName() at the bottom of this file.
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════
// ASCOT COURSE CATALOG — Year-Level Cascade
// ─────────────────────────────────────────────────
// Each entry describes ONE enrollable program track.
//
// Fields:
//   value      — unique submission code (sent to the backend)
//   family     — groups programs sharing the same base title (for dedup in dropdown)
//   familyLabel— label shown in the course <select> (shared by all siblings)
//   type       — 'bachelor' | 'diploma' | 'associate' | 'certificate' | 'postgrad'
//   school     — <optgroup> label
//   minYear    — first year a student can be in this program (always 1)
//   maxYear    — last year a student can be in this program (program duration)
//   major      — optional: the Major / Specialization label for this track
//
// Year-level filtering rules
// ─────────────────────────
//   General  : show courses where  minYear ≤ selectedYear ≤ maxYear
//   1st-year : per school, if ANY non-degree programs (diploma/associate/certificate)
//              exist in that school → suppress ALL bachelor/postgrad entries for
//              that school (non-degree programs are the entry-level track).
//              Schools with ONLY bachelor programs show their bachelor entries normally.
//
// Deduplication
// ─────────────
//   The dropdown shows ONE option per `family`.
//   If members of a family have `major` fields, the Specialization dropdown appears
//   after the user picks that family.
// ═══════════════════════════════════════════════════
var ASCOT_COURSES = [

  // ── School of Forestry and Environmental Sciences ──────────────────────────
  // Non-degree (2 yr) → shown for yr 1-2; bachelor (4 yr) → shown for yr 1-4
  // 1st-year rule: DFT exists → suppress BSF/BSES for yr 1
  { value: 'BSF',  family: 'BSF',  familyLabel: 'Bachelor of Science in Forestry (BSF)',               type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Forestry and Environmental Sciences' },
  { value: 'BSES', family: 'BSES', familyLabel: 'Bachelor of Science in Environmental Science (BSES)', type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Forestry and Environmental Sciences' },
  { value: 'DFT',  family: 'DFT',  familyLabel: 'Diploma in Forest Technology (2 Years)',              type: 'diploma',  minYear: 1, maxYear: 2, school: 'School of Forestry and Environmental Sciences' },

  // ── School of Education ─────────────────────────────────────────────────────
  // No non-degree programs → bachelor's shown for all year levels (including 1st)
  { value: 'BEEd',      family: 'BEEd', familyLabel: 'Bachelor of Elementary Education (BEEd)',               type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Education' },
  { value: 'BPEd',      family: 'BPEd', familyLabel: 'Bachelor of Physical Education (BPEd)',                 type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Education' },
  // BSEd family — 5 majors share one dropdown entry
  { value: 'BSEd-EN',   family: 'BSEd', familyLabel: 'Bachelor of Secondary Education (BSEd)',                type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Education', major: 'Major in English' },
  { value: 'BSEd-FIL',  family: 'BSEd', familyLabel: 'Bachelor of Secondary Education (BSEd)',                type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Education', major: 'Major in Filipino' },
  { value: 'BSEd-MATH', family: 'BSEd', familyLabel: 'Bachelor of Secondary Education (BSEd)',                type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Education', major: 'Major in Mathematics' },
  { value: 'BSEd-SCI',  family: 'BSEd', familyLabel: 'Bachelor of Secondary Education (BSEd)',                type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Education', major: 'Major in Science' },
  { value: 'BSEd-SS',   family: 'BSEd', familyLabel: 'Bachelor of Secondary Education (BSEd)',                type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Education', major: 'Major in Social Studies' },
  // BTLE family — 2 majors
  { value: 'BTLE-HE',  family: 'BTLE', familyLabel: 'Bachelor of Technology and Livelihood Education (BTLE)', type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Education', major: 'Major in Home Economics' },
  { value: 'BTLE-ICT', family: 'BTLE', familyLabel: 'Bachelor of Technology and Livelihood Education (BTLE)', type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Education', major: 'Major in Information and Communication Technology' },

  // ── School of Agricultural Sciences ─────────────────────────────────────────
  // 1st-year rule: CAS (associate 2yr) exists → suppress BSA bachelor for yr 1
  { value: 'BSA-AS', family: 'BSA', familyLabel: 'Bachelor of Science in Agriculture (BSA)',                  type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Agricultural Sciences', major: 'Major in Animal Science' },
  { value: 'BSA-CS', family: 'BSA', familyLabel: 'Bachelor of Science in Agriculture (BSA)',                  type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Agricultural Sciences', major: 'Major in Crop Science (Agronomy/Horticulture)' },
  { value: 'CAS',    family: 'CAS', familyLabel: 'Certificate in Agricultural Science (2 Years)',             type: 'associate',minYear: 1, maxYear: 2, school: 'School of Agricultural Sciences' },

  // ── School of Arts and Sciences ──────────────────────────────────────────────
  // No non-degree programs → bachelor shown for all year levels
  { value: 'ABPolSci', family: 'ABPolSci', familyLabel: 'Bachelor of Arts in Political Science',              type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Arts and Sciences' },

  // ── School of Engineering ─────────────────────────────────────────────────────
  // No non-degree programs → bachelor shown for all year levels (5-year programs)
  { value: 'BSCE', family: 'BSCE', familyLabel: 'Bachelor of Science in Civil Engineering (BSCE)',            type: 'bachelor', minYear: 1, maxYear: 5, school: 'School of Engineering' },
  { value: 'BSEE', family: 'BSEE', familyLabel: 'Bachelor of Science in Electrical Engineering (BSEE)',      type: 'bachelor', minYear: 1, maxYear: 5, school: 'School of Engineering' },
  { value: 'BSME', family: 'BSME', familyLabel: 'Bachelor of Science in Mechanical Engineering (BSME)',      type: 'bachelor', minYear: 1, maxYear: 5, school: 'School of Engineering' },

  // ── School of Fisheries and Ocean Sciences ────────────────────────────────────
  // No non-degree programs → bachelor shown for all year levels
  { value: 'BSFish', family: 'BSFish', familyLabel: 'Bachelor of Science in Fisheries',                      type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Fisheries and Ocean Sciences' },

  // ── School of Industrial Technology ──────────────────────────────────────────
  // 1st-year rule: certificates/associates/diplomas exist → suppress BIT bachelor for yr 1
  // BIT family — 4 majors share one dropdown entry
  { value: 'BIT-AET', family: 'BIT', familyLabel: 'Bachelor in Industrial Technology (BIT)',                  type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Industrial Technology', major: 'Major in Automotive Engineering Technology' },
  { value: 'BIT-CET', family: 'BIT', familyLabel: 'Bachelor in Industrial Technology (BIT)',                  type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Industrial Technology', major: 'Major in Civil Engineering Technology' },
  { value: 'BIT-EET', family: 'BIT', familyLabel: 'Bachelor in Industrial Technology (BIT)',                  type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Industrial Technology', major: 'Major in Electrical Engineering Technology' },
  { value: 'BIT-FT',  family: 'BIT', familyLabel: 'Bachelor in Industrial Technology (BIT)',                  type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Industrial Technology', major: 'Major in Food Technology' },
  // 3-year diploma programs
  { value: 'DipAET', family: 'DipAET', familyLabel: 'Diploma in Automotive Engineering Technician (3 years)', type: 'diploma',     minYear: 1, maxYear: 3, school: 'School of Industrial Technology' },
  { value: 'DipCET', family: 'DipCET', familyLabel: 'Diploma in Civil Engineering Technician (3 years)',      type: 'diploma',     minYear: 1, maxYear: 3, school: 'School of Industrial Technology' },
  { value: 'DipEET', family: 'DipEET', familyLabel: 'Diploma in Electrical Engineering Technician (3 years)', type: 'diploma',     minYear: 1, maxYear: 3, school: 'School of Industrial Technology' },
  { value: 'DipFT',  family: 'DipFT',  familyLabel: 'Diploma in Food Technology (3 years)',                   type: 'diploma',     minYear: 1, maxYear: 3, school: 'School of Industrial Technology' },
  // 2-year associate programs
  { value: 'AssocAET', family: 'AssocAET', familyLabel: 'Associate in Automotive Engineering Technician (2 years)', type: 'associate', minYear: 1, maxYear: 2, school: 'School of Industrial Technology' },
  { value: 'AssocCET', family: 'AssocCET', familyLabel: 'Associate in Civil Engineering Technician (2 years)',       type: 'associate', minYear: 1, maxYear: 2, school: 'School of Industrial Technology' },
  { value: 'AssocEET', family: 'AssocEET', familyLabel: 'Associate in Electrical Engineering Technician (2 years)',  type: 'associate', minYear: 1, maxYear: 2, school: 'School of Industrial Technology' },
  { value: 'AssocFT',  family: 'AssocFT',  familyLabel: 'Associate in Food Technology (2 years)',                    type: 'associate', minYear: 1, maxYear: 2, school: 'School of Industrial Technology' },
  // 1-year certificate programs
  { value: 'CertAET', family: 'CertAET', familyLabel: 'Certificate in Automotive Engineering Technician (1 year)',  type: 'certificate', minYear: 1, maxYear: 1, school: 'School of Industrial Technology' },
  { value: 'CertCET', family: 'CertCET', familyLabel: 'Certificate in Civil Engineering Technician (1 year)',        type: 'certificate', minYear: 1, maxYear: 1, school: 'School of Industrial Technology' },
  { value: 'CertEET', family: 'CertEET', familyLabel: 'Certificate in Electrical Engineering Technician (1 year)',   type: 'certificate', minYear: 1, maxYear: 1, school: 'School of Industrial Technology' },
  { value: 'CertFT',  family: 'CertFT',  familyLabel: 'Certificate in Food Technology (1 year)',                     type: 'certificate', minYear: 1, maxYear: 1, school: 'School of Industrial Technology' },

  // ── School of Information Technology ─────────────────────────────────────────
  // 1st-year rule: ACT (associate, 2yr) exists → suppress BSIT bachelor for yr 1
  // BSIT family — 2 specializations share one dropdown entry
  { value: 'BSIT-AP', family: 'BSIT', familyLabel: 'Bachelor of Science in Information Technology (BSIT)',    type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Information Technology', major: 'Specialization in Application Programming' },
  { value: 'BSIT-DD', family: 'BSIT', familyLabel: 'Bachelor of Science in Information Technology (BSIT)',    type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Information Technology', major: 'Specialization in Digital Design' },
  { value: 'ACT',     family: 'ACT',  familyLabel: 'Associate in Computer Technology (2 Years)',               type: 'associate',minYear: 1, maxYear: 2, school: 'School of Information Technology' },

  // ── School of Accountancy and Business Management ─────────────────────────────
  // No non-degree programs → all shown for yr 1+
  { value: 'BSAcc', family: 'BSAcc', familyLabel: 'Bachelor of Science in Accountancy',                        type: 'bachelor', minYear: 1, maxYear: 5, school: 'School of Accountancy and Business Management' },
  { value: 'BSHM',  family: 'BSHM',  familyLabel: 'Bachelor of Science in Hospitality Management',            type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Accountancy and Business Management' },
  { value: 'BSTM',  family: 'BSTM',  familyLabel: 'Bachelor of Science in Tourism Management',                type: 'bachelor', minYear: 1, maxYear: 4, school: 'School of Accountancy and Business Management' },

  // ── College of Law ────────────────────────────────────────────────────────────
  // Postgraduate — shown for all year levels (no non-degree to suppress it)
  { value: 'JD', family: 'JD', familyLabel: 'Juris Doctor (Online)',                                           type: 'postgrad', minYear: 1, maxYear: 4, school: 'College of Law' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
/** Return the catalog entry matching a specific value code. */
function ascotByValue(val) {
  return ASCOT_COURSES.find(function(c) { return c.value === val; }) || null;
}
/** Return all catalog entries belonging to a family. */
function ascotFamily(familyKey) {
  return ASCOT_COURSES.filter(function(c) { return c.family === familyKey; });
}


// ── Display helpers (used by admin.html) ──────────────────────────────────────
/** Exact full course title for a stored code, e.g. 'BIT-AET' → 'Bachelor in Industrial Technology (BIT)'.
 *  Returns null when the value is not a catalog code (e.g. text typed via "Not listed"). */
function courseFullName(code) {
  var c = ascotByValue(String(code || '').trim());
  if (!c) {
    var low = String(code || '').trim().toLowerCase();
    c = low ? (ASCOT_COURSES.find(function(x) { return x.value.toLowerCase() === low; }) || null) : null;
  }
  return c ? c.familyLabel : null;
}
/** Major / specialization name for a stored code, e.g. 'BIT-AET' → 'Automotive Engineering Technology' (without the "Major in" / "Specialization in" prefix).
 *  Returns null for programs without majors or for non-catalog values. */
function courseMajorName(code) {
  var c = ascotByValue(String(code || '').trim());
  if (!c) {
    var low = String(code || '').trim().toLowerCase();
    c = low ? (ASCOT_COURSES.find(function(x) { return x.value.toLowerCase() === low; }) || null) : null;
  }
  // The dropdown labels read "Major in …" / "Specialization in …"; the admin views show only the program's own name.
  return (c && c.major) ? c.major.replace(/^(?:Major|Specialization)\s+in\s+/i, '') : null;
}
