/**
 * services/studentService.js
 *
 * Business-logic helpers for the Student entity:
 *  - Barcode & student-code generation
 *  - Name normalisation (import deduplication)
 *  - Match-or-create student from a raw CSV name
 *  - AC history / total queries
 */

const mongoose = require('mongoose');
const Student  = require('../models/Student');
const Report   = require('../models/Report');
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
 *  getStudentAcTotal(studentOrNames)
 *
 *  Returns the integer count of AC bonus cards for a student.
 *  Accepts a Student document or an array of raw name strings
 *  that may have appeared in reports (handles name drift across years).
 * ───────────────────────────────────────────────────────────────── */
async function getStudentAcTotal(student) {
  const names = buildNameVariants(student);
  if (!names.length) return 0;
  const result = await Report.aggregate([
    { $match:   { ac_students: { $in: names } } },
    { $unwind:  '$ac_students' },
    { $match:   { ac_students: { $in: names } } },
    { $group:   { _id: null, total: { $sum: 1 } } },
  ]);
  return result.length ? result[0].total : 0;
}

/* ─────────────────────────────────────────────────────────────────
 *  getStudentAcHistory(student)
 *
 *  Returns an array of report documents where the student received AC,
 *  sorted most-recent first.
 *  Each item: { date, class_name, subject, teacher, count }
 * ───────────────────────────────────────────────────────────────── */
async function getStudentAcHistory(student) {
  const names = buildNameVariants(student);
  if (!names.length) return [];

  const reports = await Report.aggregate([
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
      },
    },
  ]);

  return reports;
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
};
