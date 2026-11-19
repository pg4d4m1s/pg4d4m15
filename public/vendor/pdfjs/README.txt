PDF.js (Mozilla) v3.11.174 - UMD build, Apache-2.0 (see LICENSE).
Self-hosted so the phone document preview in the registration form (step 5) works under the site's
Content-Security-Policy. Used only on phones, loaded on demand by public/js/auth.js (loadPdfJs).
Source: npm package pdfjs-dist@3.11.174 -> build/pdf.min.js, build/pdf.worker.min.js
standard_fonts/ = PDF.js standard font data (Foxit + Liberation licences included), needed to draw PDFs that do not embed Helvetica/Times/Courier.
