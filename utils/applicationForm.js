/**
 * utils/applicationForm.js -- Resident's Application Form (soft copy, PDF)
 *
 * Rebuilds the Step 3 "Resident's Application Form" of the registration as a printable A4 PDF with the
 * Provincial offices' logos in the header. Pure function of one database row -- nothing is stored; the PDF
 * is generated on request, so it always matches what the applicant submitted.
 *
 * Accepts EITHER shape so every caller can pass what it already has:
 *   - snake_case DB rows  (users / rejected_registrations / deleted_users: first_name, father_info ...)
 *   - camelCase user objects (dbRowToUser: firstName, fatherInfo ...)
 *
 * Fonts: PDFKit's built-in Helvetica only covers Windows-1252, so text is sanitised (PHP peso sign etc.)
 * instead of embedding a font file -- keeps the Docker image and the PDF small.
 */
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const PDFDocument = require('pdfkit');
const log  = require('./logger');

const LOGO_DIR = path.join(__dirname, '..', 'assets', 'logos');
// Header order, left -> right. Missing files are skipped (logged once), never fatal.
const LOGOS = ['pga-logo.jpeg', 'pydo-logo.png', 'pswdo-logo.jpeg', 'pgso-logo.jpeg', 'pto-logo.jpeg'];

const PAGE_W = 595.28, PAGE_H = 841.89, MARGIN = 36, CONTENT_W = PAGE_W - MARGIN * 2;
const C = { ink: '#0f172a', mute: '#64748b', line: '#cbd5e1', bar: '#14532d', barText: '#ffffff', soft: '#f1f5f9', amber: '#b45309' };

// -- course catalog (shared with the browser: public/js/course-catalog.js) -----------------------
let _catalog = null;
function catalog() {
  if (_catalog) return _catalog;
  _catalog = { courseFullName: () => null, courseMajorName: () => null };
  try {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'course-catalog.js'), 'utf8');
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(src, ctx, { timeout: 1000 });
    if (typeof ctx.courseFullName === 'function')  _catalog.courseFullName  = ctx.courseFullName;
    if (typeof ctx.courseMajorName === 'function') _catalog.courseMajorName = ctx.courseMajorName;
  } catch (e) { log.warn(`[applicationForm] course catalog not loaded (${e.message}) -- showing stored course codes`); }
  return _catalog;
}

// -- helpers -------------------------------------------------------------------------------------
function clean(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/\u20B1/g, 'PHP ')                       // peso sign is not in WinAnsi
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[^\u0020-\u007E\u00A0-\u00FF]/g, '?')   // anything WinAnsi cannot draw
    .replace(/\s+/g, ' ').trim();
}
const pick = (r, snake, camel) => (r[snake] !== undefined && r[snake] !== null && r[snake] !== '') ? r[snake] : (r[camel] ?? '');
function parseJson(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { const o = JSON.parse(v); return (o && typeof o === 'object') ? o : {}; } catch { return {}; }
}
const fullName = (o) => clean([o.firstName, o.middleName, o.lastName, o.suffix].filter(Boolean).join(' '));
function fmtDate(v) {
  if (!v) return '';
  const d = new Date(String(v).length <= 10 ? v + 'T00:00:00' : String(v).replace(' ', 'T') + (/[zZ+]/.test(String(v)) ? '' : 'Z'));
  if (isNaN(d)) return clean(v);
  return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Manila' });
}
function ageOf(bday) {
  const d = new Date(String(bday || '') + 'T00:00:00'); if (isNaN(d)) return '';
  const n = new Date(); let a = n.getFullYear() - d.getFullYear();
  if (n.getMonth() < d.getMonth() || (n.getMonth() === d.getMonth() && n.getDate() < d.getDate())) a--;
  return a >= 0 && a < 120 ? String(a) : '';
}
function fmtPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (!d) return '';
  const n = d.length === 10 ? d : d.replace(/^(63|0)/, '');
  return n.length === 10 ? `+63 ${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}` : clean(p);
}
const cap = (s) => { s = clean(s); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; };

/** Normalises either row shape into the flat object the layout reads. */
function normalise(row) {
  const r = row || {};
  const cat = catalog();
  const courseCode = clean(pick(r, 'course', 'course'));
  const specCode   = clean(pick(r, 'specialization', 'specialization'));
  const major = cat.courseMajorName(courseCode) || cat.courseMajorName(specCode) || (specCode && specCode !== courseCode ? specCode : '');
  return {
    id: clean(r.id || ''),
    firstName: clean(pick(r, 'first_name', 'firstName')), middleName: clean(pick(r, 'middle_name', 'middleName')),
    lastName: clean(pick(r, 'last_name', 'lastName')),    suffix: clean(r.suffix),
    birthday: pick(r, 'birthday', 'birthday'), sex: cap(r.sex), civil: clean(pick(r, 'civil_status', 'civilStatus')),
    phone: r.phone, email: clean(r.email),
    permanent: clean(pick(r, 'permanent_address', 'permanentAddress')), present: clean(pick(r, 'present_address', 'presentAddress')),
    school: clean(pick(r, 'school_name', 'schoolName')) || 'Aurora State College of Technology (ASCOT)',
    schoolAddr: clean(pick(r, 'school_address', 'schoolAddress')) || 'Zabali, Baler, Aurora',
    yearLevel: clean(pick(r, 'year_level', 'yearLevel')),
    course: cat.courseFullName(courseCode) || courseCode, major: clean(major),
    income: clean(pick(r, 'monthly_income', 'monthlyIncome')),
    father: parseJson(pick(r, 'father_info', 'fatherInfo')), mother: parseJson(pick(r, 'mother_info', 'motherInfo')),
    guardian: parseJson(pick(r, 'guardian_info', 'guardianInfo')),
    roommateNote: clean(pick(r, 'roommate_note', 'roommateNote')),
    admissionNo: clean(pick(r, 'admission_no', 'admissionNo')),
    room: r.assigned_room_number ? `Room ${clean(r.assigned_room_number)}${r.assigned_bed_number ? ' / Bed ' + clean(r.assigned_bed_number) : ''}` : '',
    submitted: pick(r, 'created_at', 'createdAt') || pick(r, 'original_created_at', 'originalCreatedAt'),
    docs: {
      id:         !!(pick(r, 'id_front_url', 'idFrontUrl')),
      residency:  !!(pick(r, 'cert_residency_url', 'certResidencyUrl')),
      lowIncome:  !!(pick(r, 'cert_low_income_url', 'certLowIncomeUrl')),
      enrollment: !!(pick(r, 'cert_enrollment_url', 'certEnrollmentUrl')),
      grades:     !!(pick(r, 'cert_grades_url', 'certGradesUrl')),
      medical:    !!(pick(r, 'cert_medical_url', 'certMedicalUrl')),
    },
  };
}

// -- layout primitives ---------------------------------------------------------------------------
const LABEL_H = 9, PAD = 3;
function ensureSpace(doc, h) { if (doc.y + h > PAGE_H - MARGIN - 18) doc.addPage(); }

function sectionBar(doc, text) {
  ensureSpace(doc, 40);
  doc.rect(MARGIN, doc.y, CONTENT_W, 16).fill(C.bar);
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.barText).text(text, MARGIN + 6, doc.y + 4.5, { lineBreak: false });
  doc.y += 16;
}

/** One bordered row of labelled cells on a 12-column grid. cells: [{label, value, span}] */
function cellRow(doc, cells) {
  const colW = CONTENT_W / 12;
  doc.font('Helvetica-Bold').fontSize(9);
  const heights = cells.map((c) => doc.heightOfString(clean(c.value) || ' ', { width: colW * c.span - PAD * 2 }));
  const h = Math.max(24, Math.max(...heights) + LABEL_H + PAD + 2);
  ensureSpace(doc, h + 4);
  const y = doc.y; let x = MARGIN;
  cells.forEach((c) => {
    const w = colW * c.span;
    doc.rect(x, y, w, h).lineWidth(0.5).strokeColor(C.line).stroke();
    doc.font('Helvetica').fontSize(6.5).fillColor(C.mute).text(String(c.label).toUpperCase(), x + PAD, y + 3, { width: w - PAD * 2, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.ink).text(clean(c.value) || '-', x + PAD, y + LABEL_H + 3, { width: w - PAD * 2 });
    x += w;
  });
  doc.y = y + h;
}

function header(doc) {
  const size = 46, gap = 8, count = LOGOS.length;
  const total = size * count + gap * (count - 1);
  let x = MARGIN; const y = MARGIN;
  // logos on the left, title block on the right of them
  LOGOS.forEach((f) => {
    const fp = path.join(LOGO_DIR, f);
    try {
      if (fs.existsSync(fp)) doc.image(fp, x, y, { fit: [size, size], align: 'center', valign: 'center' });
      else log.warn(`[applicationForm] logo missing: ${f}`);
    } catch (e) { log.warn(`[applicationForm] logo ${f} not drawn: ${e.message}`); }
    x += size + gap;
  });
  const tx = MARGIN + total + 12, tw = PAGE_W - MARGIN - tx;
  doc.font('Helvetica').fontSize(7.5).fillColor(C.mute).text('Republic of the Philippines  |  Province of Aurora', tx, y + 1, { width: tw, lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(11).fillColor(C.ink).text('PROVINCIAL GOVERNMENT OF AURORA', tx, y + 11, { width: tw, lineBreak: false });
  doc.font('Helvetica').fontSize(7.5).fillColor(C.ink).text('Dormitory Application and Management Information System (PGA-DAMIS)', tx, y + 25, { width: tw, lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(13).fillColor(C.bar).text("RESIDENT'S APPLICATION FORM", tx, y + 36, { width: tw, lineBreak: false });
  doc.moveTo(MARGIN, y + size + 8).lineTo(PAGE_W - MARGIN, y + size + 8).lineWidth(1.2).strokeColor(C.bar).stroke();
  doc.y = y + size + 14;
}

function parentRows(doc, title, info) {
  const o = info || {};
  const deceased = o.deceased === true || o.deceased === 'true';
  const name = fullName(o);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(C.bar).text(title + (deceased ? '  (Deceased)' : ''), MARGIN, doc.y + 4, { lineBreak: false });
  doc.y += 15;
  if (deceased || !name) {
    cellRow(doc, [{ label: 'Full name', value: name || (deceased ? 'Deceased' : ''), span: 12 }]);
    return;
  }
  cellRow(doc, [
    { label: 'Full name', value: name, span: 6 },
    { label: 'Contact number', value: fmtPhone(o.phone), span: 3 },
    { label: 'Employer / Company', value: o.employer, span: 3 },
  ]);
  cellRow(doc, [{ label: 'Address', value: o.address, span: 12 }]);
}

function documentsChecklist(doc, d) {
  const items = [
    ['School ID or Government ID', d.docs.id],
    ['Certificate of Residency', d.docs.residency],
    ['Certificate of Low Income', d.docs.lowIncome],
    ['Certificate of Registration / Enrollment', d.docs.enrollment],
    ['Report Card / Certificate of Grades (last semester)', d.docs.grades],
  ];
  const colW = CONTENT_W / 2, rowH = 15;
  ensureSpace(doc, rowH * 4 + 6);
  const y0 = doc.y + 3;
  const all = items.concat([['Medical Certificate (submit after approval, through your account)', d.docs.medical, true]]);
  all.forEach(([label, ok, later], i) => {
    const x = MARGIN + (i % 2) * colW, y = y0 + Math.floor(i / 2) * rowH;
    doc.rect(x + 2, y + 2, 8, 8).lineWidth(0.8).strokeColor(C.ink).stroke();
    if (ok) {   // drawn as a vector tick (Helvetica/WinAnsi has no check-mark glyph)
      doc.save().lineWidth(1.6).lineCap('round').lineJoin('round').strokeColor(C.bar)
         .moveTo(x + 3.6, y + 6.4).lineTo(x + 5.9, y + 9).lineTo(x + 10.6, y + 1.6).stroke().restore();
    }
    const note = (!ok && later) ? C.amber : C.ink;
    doc.font('Helvetica').fontSize(8).fillColor(note).text(label, x + 15, y + 2.5, { width: colW - 20, lineBreak: false, ellipsis: true });
  });
  doc.y = y0 + Math.ceil(all.length / 2) * rowH + 2;
}

function declaration(doc, d) {
  ensureSpace(doc, 128);
  doc.y += 8;
  doc.font('Helvetica').fontSize(8).fillColor(C.ink).text(
    'I hereby certify that the information given in this application is true and correct to the best of my knowledge. ' +
    'I understand that any false statement or misrepresentation may be a ground for the disapproval of this application ' +
    'or the termination of my dormitory privileges.', MARGIN, doc.y, { width: CONTENT_W, align: 'justify' });
  doc.y += 24;
  const y = doc.y, gap = 14;
  const w1 = CONTENT_W * 0.36, w2 = CONTENT_W * 0.36, w3 = CONTENT_W - w1 - w2 - gap * 2;
  const x1 = MARGIN, x2 = x1 + w1 + gap, x3 = x2 + w2 + gap;
  const sigLine = (x, w) => doc.moveTo(x, y + 14).lineTo(x + w, y + 14).lineWidth(0.7).strokeColor(C.ink).stroke();
  doc.font('Helvetica-Bold').fontSize(9).fillColor(C.ink)
     .text(clean([d.firstName, d.middleName, d.lastName, d.suffix].filter(Boolean).join(' ')).toUpperCase(), x1, y, { width: w1, align: 'center', lineBreak: false });
  sigLine(x1, w1); sigLine(x2, w2); sigLine(x3, w3);
  doc.font('Helvetica').fontSize(7).fillColor(C.mute)
     .text('Signature over printed name of applicant', x1, y + 17, { width: w1, align: 'center', lineBreak: false })
     .text('Signature over printed name of parent/guardian', x2, y + 17, { width: w2, align: 'center', lineBreak: false })
     .text('Date', x3, y + 17, { width: w3, align: 'center', lineBreak: false });
  doc.y = y + 32;

  // Office use -- "Reviewed by" is the widest cell: the reviewer writes a full name and signs there
  const oy = doc.y + 6, bh = 56;
  doc.rect(MARGIN, oy, CONTENT_W, bh).lineWidth(0.7).strokeColor(C.mute).dash(3, { space: 2 }).stroke().undash();
  doc.font('Helvetica-Bold').fontSize(7).fillColor(C.mute).text('FOR OFFICE USE ONLY', MARGIN + 6, oy + 4, { lineBreak: false });
  // Admission No. and Room / Bed are pre-filled when the admin has already issued/assigned them.
  const cells = [['Admission No.:', 0.20, d.admissionNo], ['Room / Bed:', 0.25, d.room], ['Reviewed by:', 0.36, ''], ['Date:', 0.19, '']];
  let cx = MARGIN;
  cells.forEach(([l, frac, val]) => {
    const cw = CONTENT_W * frac, lw = doc.font('Helvetica').fontSize(7.5).widthOfString(l);
    const x0 = cx + 10 + lw, avail = cx + cw - 8 - x0;
    doc.fillColor(C.ink).text(l, cx + 6, oy + 34, { lineBreak: false });
    doc.moveTo(x0, oy + 42).lineTo(x0 + avail, oy + 42).lineWidth(0.5).strokeColor(C.ink).stroke();
    if (val) {
      let fs = 8.5;                                   // shrink to fit on ONE line (never wrap onto the signature line)
      doc.font('Helvetica-Bold');
      while (fs > 5.5 && doc.fontSize(fs).widthOfString(val) > avail - 2) fs -= 0.5;
      doc.fontSize(fs).fillColor(C.ink).text(val, x0, oy + 41 - fs - 1, { width: avail + 20, lineBreak: false });
    }
    cx += cw;
  });
  doc.font('Helvetica').fontSize(6.5).fillColor(C.mute)
     .text('Signature over printed name of reviewer', MARGIN + CONTENT_W * 0.45, oy + 44, { width: CONTENT_W * 0.36 - 8, align: 'center', lineBreak: false });
  doc.y = oy + bh;
}

// -- public API ----------------------------------------------------------------------------------
/** @returns {Promise<Buffer>} the finished PDF */
function buildApplicationFormPdf(row) {
  return new Promise((resolve, reject) => {
    try {
      const d = normalise(row);
      const doc = new PDFDocument({
        size: 'A4', margin: MARGIN, bufferPages: true,
        info: { Title: "Resident's Application Form", Author: 'PGA-DAMIS', Subject: 'Provincial Government of Aurora - Dormitory Application' },
      });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      header(doc);

      sectionBar(doc, 'I.  PERSONAL INFORMATION');
      cellRow(doc, [
        { label: 'First name', value: d.firstName, span: 4 }, { label: 'Middle name', value: d.middleName, span: 3 },
        { label: 'Last name', value: d.lastName, span: 4 },  { label: 'Suffix', value: d.suffix, span: 1 },
      ]);
      cellRow(doc, [
        { label: 'Date of birth', value: fmtDate(d.birthday), span: 4 }, { label: 'Age', value: ageOf(d.birthday), span: 1 },
        { label: 'Sex', value: d.sex, span: 3 }, { label: 'Civil status', value: d.civil, span: 4 },
      ]);
      cellRow(doc, [{ label: 'Permanent address', value: d.permanent, span: 12 }]);
      cellRow(doc, [{ label: 'Present address', value: d.present, span: 12 }]);
      cellRow(doc, [{ label: 'Phone number', value: fmtPhone(d.phone), span: 5 }, { label: 'Email address', value: d.email, span: 7 }]);

      doc.y += 6; sectionBar(doc, 'II.  SCHOOL INFORMATION');
      cellRow(doc, [{ label: 'School name', value: d.school, span: 6 }, { label: 'School address', value: d.schoolAddr, span: 6 }]);
      cellRow(doc, [{ label: 'Year level', value: d.yearLevel, span: 3 }, { label: 'Course / Program', value: d.course, span: 9 }]);
      if (d.major) cellRow(doc, [{ label: 'Major / Specialization', value: d.major, span: 12 }]);

      doc.y += 6; sectionBar(doc, 'III.  FAMILY INFORMATION');
      parentRows(doc, "Father's information", d.father);
      parentRows(doc, "Mother's information", d.mother);
      const bothGone = (o) => o.deceased === true || o.deceased === 'true';
      if (fullName(d.guardian) || (bothGone(d.father) && bothGone(d.mother))) {
        doc.font('Helvetica-Bold').fontSize(8).fillColor(C.bar).text('Guardian (parents deceased)', MARGIN, doc.y + 4, { lineBreak: false });
        doc.y += 15;
        cellRow(doc, [
          { label: 'Full name', value: fullName(d.guardian), span: 5 }, { label: 'Relationship', value: d.guardian.relationship, span: 2 },
          { label: 'Contact number', value: fmtPhone(d.guardian.phone), span: 2 }, { label: 'Employer / Company', value: d.guardian.employer, span: 3 },
        ]);
        cellRow(doc, [{ label: 'Address', value: d.guardian.address, span: 12 }]);
      }
      doc.y += 4;
      cellRow(doc, [{ label: 'Combined monthly family income', value: d.income, span: 12 }]);
      if (d.roommateNote) cellRow(doc, [{ label: 'Note to the dormitory manager', value: d.roommateNote, span: 12 }]);

      doc.y += 6; sectionBar(doc, 'IV.  SUPPORTING DOCUMENTS  (checked = on file)');
      documentsChecklist(doc, d);

      declaration(doc, d);

      // footer + page numbers on every page (margin zeroed so PDFKit does not spill a new page)
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        doc.page.margins.bottom = 0;
        if (i > 0) doc.font('Helvetica-Bold').fontSize(8).fillColor(C.mute).text("Resident's Application Form (continued)", MARGIN, 18, { width: CONTENT_W, align: 'right', lineBreak: false });
        const ref = (d.id || '').slice(0, 8).toUpperCase();
        const submitted = fmtDate(d.submitted);
        doc.font('Helvetica').fontSize(7).fillColor(C.mute)
          .text(`Generated by PGA-DAMIS${ref ? '  |  Ref. ' + ref : ''}${submitted ? '  |  Submitted ' + submitted : ''}`, MARGIN, PAGE_H - 26, { width: CONTENT_W * 0.8, lineBreak: false })
          .text(`Page ${i + 1} of ${range.count}`, MARGIN, PAGE_H - 26, { width: CONTENT_W, align: 'right', lineBreak: false });
      }
      doc.end();
    } catch (e) { reject(e); }
  });
}

/** Safe download filename, e.g. Application-Form_Dela-Cruz_Juan-Miguel.pdf */
function applicationFormFilename(row) {
  const d = normalise(row);
  const slug = (s) => clean(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return ['Application-Form', slug(d.lastName), slug(d.firstName)].filter(Boolean).join('_') + '.pdf';
}

/**
 * Adds the resident's CURRENT bed assignment (room number / bed number) to a user row so the form's
 * "Room / Bed" box is pre-filled. Best-effort: no assignment, or an old snapshot without the table, just leaves it blank.
 */
function withBedAssignment(db, userId, row) {
  try {
    const a = db.prepare(
      'SELECT dr.room_number AS n, ba.bed_number AS b FROM bed_assignments ba JOIN dorm_rooms dr ON dr.id = ba.room_id WHERE ba.user_id = ? LIMIT 1'
    ).get(userId);
    return a ? { ...row, assigned_room_number: a.n, assigned_bed_number: a.b } : row;
  } catch (e) {
    log.warn(`[applicationForm] bed assignment lookup skipped: ${e.message}`);
    return row;
  }
}

/** Builds the PDF and writes it to an Express response. ?download=1 forces a download; default is inline view. */
async function sendApplicationFormPdf(req, res, row, who = '') {
  const t0 = Date.now();
  try {
    const buf = await buildApplicationFormPdf(row);
    const name = applicationFormFilename(row);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': buf.length,
      'Content-Disposition': `${req.query && req.query.download === '1' ? 'attachment' : 'inline'}; filename="${name}"`,
      'Cache-Control': 'private, no-store',          // contains personal data -- never cache in shared caches
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(buf);
    log.info(`[application-form] ${name} ${(buf.length / 1024).toFixed(0)}KB in ${Date.now() - t0}ms${who ? ' for ' + who : ''}`);
  } catch (e) {
    log.error(`[application-form] build failed${who ? ' for ' + who : ''}: ${e.stack || e.message}`);
    if (!res.headersSent) res.status(500).json({ error: 'Could not generate the application form.' });
  }
}

module.exports = { buildApplicationFormPdf, applicationFormFilename, sendApplicationFormPdf, withBedAssignment };
