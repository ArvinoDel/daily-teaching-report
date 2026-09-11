/**
 * services/studentService.js
 *
 * Business-logic helpers for the Student entity:
 *  - Barcode & student-code generation
 *  - Name normalisation (import deduplication)
 *  - Match-or-create student from a raw CSV name
 *  - AC history / total queries
 */

const mongoose      = require('mongoose');
const Student       = require('../models/Student');
const Report        = require('../models/Report');
const AcTransaction = require('../models/AcTransaction');
const {
  normalizeName,
  extractFullName,
  extractGradeSchool,
} = require('../models/Student');

/* ── Counter helper (atomic, no external deps) ──────────────────── */

let _codeSeq = null; // lazy-loaded from DB

/**
 * Get the next integer sequence number for student codes.
 * Uses the current Student count as a starting baseline so the
 * first generated code after migration doesn't collide.
 */
async function nextSequence() {
  const count = await Student.countDocuments();
  if (_codeSeq === null || _codeSeq <= count) {
    _codeSeq = count + 1;
  }
  return _codeSeq++;
}

/* ─────────────────────────────────────────────────────────────────
 *  generateStudentCode()
 *  Returns a padded human-readable code, e.g. "STD-2026-0042"
 * ───────────────────────────────────────────────────────────────── */
async function generateStudentCode() {
  const year = new Date().getFullYear();
  const seq  = await nextSequence();
  return `STD-${year}-${String(seq).padStart(4, '0')}`;
}

/* ─────────────────────────────────────────────────────────────────
 *  generateBarcode()
 *  Returns a unique alphanumeric barcode string.
 *  Format: "AC" + 6-char base36 timestamp segment + 3-char seq
 *  e.g.  "ACKZF1A007"  (10 chars, Code-128 compatible)
 *
 *  We verify uniqueness in DB before returning.
 * ───────────────────────────────────────────────────────────────── */
async function generateBarcode() {
  let barcode;
  let attempts = 0;
  do {
    const ts  = Date.now().toString(36).toUpperCase().slice(-6);
    const rnd = Math.floor(Math.random() * 46656).toString(36).toUpperCase().padStart(3, '0');
    barcode = `AC${ts}${rnd}`;
    attempts++;
    if (attempts > 20) throw new Error('generateBarcode: too many collisions');
  } while (await Student.findOne({ barcode }));
  return barcode;
}

/* ─────────────────────────────────────────────────────────────────
 *  matchOrCreateStudent(rawName)
 *
 *  Looks up an existing Student by normalized name.
 *  If found, returns { student, created: false }.
 *  If not found, creates a new Student with barcode + code.
 *  Returns { student, created: true }.
 *
 *  Safe to call concurrently — uses findOneAndUpdate with upsert
 *  logic to avoid race conditions on bulk imports.
 * ───────────────────────────────────────────────────────────────── */
async function matchOrCreateStudent(rawName) {
  const normalized = normalizeName(rawName);
  if (!normalized) return null;

  // Try to find existing
  let student = await Student.findOne({ normalized_name: normalized });
  if (student) {
    return { student, created: false };
  }

  // Create new
  const [barcode, student_code] = await Promise.all([
    generateBarcode(),
    generateStudentCode(),
  ]);

  student = await Student.create({
    student_code,
    barcode,
    full_name:       extractFullName(rawName),
    raw_name:        rawName.trim(),
    normalized_name: normalized,
    grade_school:    extractGradeSchool(rawName),
  });

  return { student, created: true };
}

/* ─────────────────────────────────────────────────────────────────
 *  getStudentAcTotal(student)
 *
 *  Returns the net AC count for a student across BOTH sources:
 *   - Report.ac_students (historical)
 *   - AcTransaction (scan-based, add minus reduce)
 * ───────────────────────────────────────────────────────────────── */
async function getStudentAcTotal(student) {
  const names = buildNameVariants(student);
  if (!names.length && !student._id) return 0;

  // 1. From legacy Reports
  let reportTotal = 0;
  if (names.length) {
    const result = await Report.aggregate([
      { $match:  { ac_students: { $in: names } } },
      { $unwind: '$ac_students' },
      { $match:  { ac_students: { $in: names } } },
      { $group:  { _id: null, total: { $sum: 1 } } },
    ]);
    reportTotal = result.length ? result[0].total : 0;
  }

  // 2. From AcTransaction (net: add - reduce)
  let txTotal = 0;
  if (student._id) {
    const result = await AcTransaction.aggregate([
      { $match: { student: student._id } },
      {
        $group: {
          _id: null,
          adds:    { $sum: { $cond: [{ $eq: ['$type', 'add']    }, '$amount', 0] } },
          reduces: { $sum: { $cond: [{ $eq: ['$type', 'reduce'] }, '$amount', 0] } },
        },
      },
    ]);
    if (result.length) txTotal = result[0].adds - result[0].reduces;
  }

  return Math.max(0, reportTotal + txTotal);
}

/* ─────────────────────────────────────────────────────────────────
 *  getStudentAcHistory(student)
 *
 *  Returns a merged, date-sorted array of AC events from both:
 *   - Report.ac_students (historical)
 *   - AcTransaction (scan-based)
 *  Each item: { source, date, class_name, subject, teacher, count, type }
 * ───────────────────────────────────────────────────────────────── */
async function getStudentAcHistory(student) {
  const names = buildNameVariants(student);

  // 1. Report-based history
  let reportHistory = [];
  if (names.length) {
    reportHistory = await Report.aggregate([
      { $match:  { ac_students: { $in: names } } },
      { $unwind: '$ac_students' },
      { $match:  { ac_students: { $in: names } } },
      {
        $group: {
          _id:        { reportId: '$_id', date: '$date', class_name: '$class_name', subject: '$subject', teacher: '$teacher' },
          count:      { $sum: 1 },
          date:       { $first: '$date' },
          class_name: { $first: '$class_name' },
          subject:    { $first: '$subject' },
          teacher:    { $first: '$teacher' },
        },
      },
      { $sort:  { date: -1 } },
      {
        $project: {
          _id:        '$_id.reportId',
          date:       1,
          class_name: 1,
          subject:    1,
          teacher:    1,
          count:      1,
          source:     { $literal: 'report' },
          type:       { $literal: 'add' },
        },
      },
    ]);
  }

  // 2. AcTransaction-based history
  let txHistory = [];
  if (student._id) {
    const txDocs = await AcTransaction.find({ student: student._id })
      .sort({ date: -1 })
      .lean();
    txHistory = txDocs.map(t => ({
      _id:        t._id,
      date:       t.date,
      class_name: t.class_name || '',
      subject:    t.subject    || '',
      teacher:    t.scanned_by_name || '',
      count:      t.type === 'add' ? t.amount : -t.amount,
      source:     'scan',
      type:       t.type,
      note:       t.note || '',
    }));
  }

  // Merge and sort by date descending
  const combined = [...reportHistory, ...txHistory];
  combined.sort((a, b) => new Date(b.date) - new Date(a.date));
  return combined;
}

/* ─────────────────────────────────────────────────────────────────
 *  recordAcTransaction({ student, type, subject, class_name, note, scanned_by })
 *
 *  Creates a new AcTransaction document.
 *  Returns the saved transaction.
 * ───────────────────────────────────────────────────────────────── */
async function recordAcTransaction({ student, type, subject, class_name, note, scanned_by, scanned_by_name }) {
  if (!student || !student._id) throw new Error('recordAcTransaction: student is required');
  if (!['add', 'reduce'].includes(type)) throw new Error('recordAcTransaction: type must be add or reduce');

  const tx = await AcTransaction.create({
    student:          student._id,
    student_name:     student.full_name || student.raw_name || '',
    student_code:     student.student_code || '',
    barcode:          student.barcode || '',
    type,
    amount:           1,
    subject:          (subject    || '').trim(),
    class_name:       (class_name || '').trim(),
    note:             (note       || '').trim(),
    date:             new Date(),
    scanned_by:       scanned_by      || null,
    scanned_by_name:  scanned_by_name || '',
  });

  return tx;
}

/* ── Internal helpers ─────────────────────────────────────────── */

/**
 * Build the list of name strings a student may appear as in reports.
 * A student may have changed grade (e.g. "Lionel 11 SPB" → "Lionel 12 SPB")
 * so we use the raw_name as primary plus the normalized full_name.
 */
function buildNameVariants(student) {
  if (!student) return [];
  const variants = new Set();
  if (student.raw_name)  variants.add(student.raw_name.trim());
  if (student.full_name) variants.add(student.full_name.trim());
  return [...variants];
}

module.exports = {
  generateStudentCode,
  generateBarcode,
  matchOrCreateStudent,
  getStudentAcTotal,
  getStudentAcHistory,
  recordAcTransaction,
};
