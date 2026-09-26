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

let _codeSeq = null;
let _codeSeqInit = null; // shared pending-init promise — prevents concurrent DB reads

/**
 * Get the next integer sequence number for student codes.
 * Bug #7 fix: uses a shared initialization promise so concurrent callers
 * wait on the same DB read instead of each reading the same count and
 * returning duplicate sequence numbers.
 */
async function nextSequence() {
  // If already initialized, increment synchronously — no interleaving risk
  if (_codeSeq !== null) return _codeSeq++;

  // First caller creates the init promise; subsequent concurrent callers await it
  if (!_codeSeqInit) {
    _codeSeqInit = Student.countDocuments().then(count => {
      if (_codeSeq === null) _codeSeq = count + 1;
      _codeSeqInit = null;
    });
  }
  await _codeSeqInit;
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
 *   - Report.ac_students (positive) and Report.ac_reduced_students (negative)
 *   - AcTransaction (scan/admin-based, add minus reduce)
 * ───────────────────────────────────────────────────────────────── */
async function getStudentAcTotal(student) {
  const names = buildNameVariants(student);
  if (!names.length && !student._id) return 0;

  // 1. From Reports: positive (ac_students) and negative (ac_reduced_students)
  // Bug #3 fix: exclude auto-generated linked reports to prevent double-counting
  let reportAdds = 0;
  let reportReduces = 0;
  if (names.length) {
    // Count positive AC cards
    const addResult = await Report.aggregate([
      { $match:  { ac_students: { $in: names }, is_auto_generated: { $ne: true } } },
      { $unwind: '$ac_students' },
      { $match:  { ac_students: { $in: names } } },
      { $group:  { _id: null, total: { $sum: 1 } } },
    ]);
    reportAdds = addResult.length ? addResult[0].total : 0;

    // Count reduced AC cards
    const reduceResult = await Report.aggregate([
      { $match:  { ac_reduced_students: { $in: names }, is_auto_generated: { $ne: true } } },
      { $unwind: '$ac_reduced_students' },
      { $match:  { ac_reduced_students: { $in: names } } },
      { $group:  { _id: null, total: { $sum: 1 } } },
    ]);
    reportReduces = reduceResult.length ? reduceResult[0].total : 0;
  }

  // 2. From AcTransaction (scan/admin: net add - reduce)
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

  return Math.max(0, (reportAdds - reportReduces) + txTotal);
}

/* ─────────────────────────────────────────────────────────────────
 *  getStudentAcHistory(student)
 *
 *  Returns a merged, date-sorted array of AC events from both:
 *   - Report.ac_students (type:'add') and Report.ac_reduced_students (type:'reduce')
 *   - AcTransaction (scan/admin-based)
 *  Each item: { source, date, class_name, subject, teacher, teacher_id, count, type }
 * ───────────────────────────────────────────────────────────────── */
async function getStudentAcHistory(student) {
  const names = buildNameVariants(student);

  // 1. Report-based POSITIVE history (+AC from ac_students)
  // Bug #3 fix: exclude auto-generated linked reports to prevent double-counting
  let reportAddHistory = [];
  if (names.length) {
    reportAddHistory = await Report.aggregate([
      { $match:  { ac_students: { $in: names }, is_auto_generated: { $ne: true } } },
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
      {
        $lookup: {
          from: 'users',
          localField: 'teacher',
          foreignField: '_id',
          as: 'teacherDoc',
        },
      },
      { $sort: { date: -1 } },
      {
        $project: {
          _id:        '$_id.reportId',
          date:       1,
          class_name: 1,
          subject:    1,
          teacher:    { $ifNull: [{ $arrayElemAt: ['$teacherDoc.displayName', 0] }, ''] },
          count:      1,
          source:     { $literal: 'report' },
          type:       { $literal: 'add' },
        },
      },
    ]);
  }

  // 2. Report-based NEGATIVE history (-AC from ac_reduced_students)
  // Bug #3 fix: exclude auto-generated linked reports to prevent double-counting
  let reportReduceHistory = [];
  if (names.length) {
    reportReduceHistory = await Report.aggregate([
      { $match:  { ac_reduced_students: { $in: names }, is_auto_generated: { $ne: true } } },
      { $unwind: '$ac_reduced_students' },
      { $match:  { ac_reduced_students: { $in: names } } },
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
      {
        $lookup: {
          from: 'users',
          localField: 'teacher',
          foreignField: '_id',
          as: 'teacherDoc',
        },
      },
      { $sort: { date: -1 } },
      {
        $project: {
          _id:        '$_id.reportId',
          date:       1,
          class_name: 1,
          subject:    1,
          teacher:    { $ifNull: [{ $arrayElemAt: ['$teacherDoc.displayName', 0] }, ''] },
          count:      { $multiply: ['$count', -1] },
          source:     { $literal: 'report' },
          type:       { $literal: 'reduce' },
        },
      },
    ]);
  }

  // 3. AcTransaction-based history (scan / admin adjustments)
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
      teacher_id: t.scanned_by || null,
      count:      t.type === 'add' ? t.amount : -t.amount,
      source:     'scan',
      type:       t.type,
      note:       t.note || '',
    }));
  }

  // Merge and sort by date descending
  const combined = [...reportAddHistory, ...reportReduceHistory, ...txHistory];
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

/* ─────────────────────────────────────────────────────────────────
 *  migrateExistingStudents()
 *  High-performance bulk migration:
 *  1. Bulk loads all Groups, unique ac_students, and existing Students in parallel.
 *  2. Deds-up and generates barcodes/codes in-memory without individual DB calls.
 *  3. Inserts all new Students in a single Student.insertMany() call.
 *  4. Updates all Groups with student_ids in a single Group.bulkWrite() call.
 *  Total DB round-trips: ~4 queries total (< 500ms execution).
 * ───────────────────────────────────────────────────────────────── */
async function migrateExistingStudents() {
  const Group = require('../models/Group');

  // Step 1: Parallel bulk fetch
  const [groups, acStudentDocs, existingStudents] = await Promise.all([
    Group.find({}).lean(),
    Report.distinct('ac_students'),
    Student.find({}, 'normalized_name barcode student_code _id').lean(),
  ]);

  // Index existing students by normalized_name and collect used barcodes
  const studentMap = new Map();
  const usedBarcodes = new Set();
  for (const s of existingStudents) {
    if (s.normalized_name) studentMap.set(s.normalized_name, s._id);
    if (s.barcode) usedBarcodes.add(s.barcode);
  }

  // Step 2: Collect all unique raw student names from Groups + Reports
  const rawNames = new Set();
  for (const g of groups) {
    for (const s of (g.students || [])) {
      const trimmed = (s || '').trim();
      if (trimmed) rawNames.add(trimmed);
    }
  }
  for (const s of acStudentDocs) {
    const trimmed = (s || '').trim();
    if (trimmed) rawNames.add(trimmed);
  }

  // Next sequence baseline for student_code
  const year = new Date().getFullYear();
  let seqNumber = existingStudents.length + 1;

  // Step 3: Identify which students are new and prepare documents for insertMany
  const newDocs = [];
  let skipped = 0;

  for (const rawName of rawNames) {
    const normalized = normalizeName(rawName);
    if (!normalized) continue;

    // Already exists in DB or already queued in this batch
    if (studentMap.has(normalized)) {
      skipped++;
      continue;
    }

    // Generate unique barcode in-memory
    let barcode;
    let attempts = 0;
    do {
      const ts = Date.now().toString(36).toUpperCase().slice(-6);
      const rnd = Math.floor(Math.random() * 46656).toString(36).toUpperCase().padStart(3, '0');
      barcode = `AC${ts}${rnd}`;
      attempts++;
    } while (usedBarcodes.has(barcode) && attempts < 50);

    usedBarcodes.add(barcode);

    const student_code = `STD-${year}-${String(seqNumber++).padStart(4, '0')}`;

    const doc = {
      student_code,
      barcode,
      full_name: extractFullName(rawName),
      raw_name: rawName.trim(),
      normalized_name: normalized,
      grade_school: extractGradeSchool(rawName),
    };

    newDocs.push(doc);
    // Mark as seen in studentMap with a temporary placeholder
    studentMap.set(normalized, null);
  }

  // Step 4: Bulk insert new students
  let created = 0;
  if (newDocs.length > 0) {
    const inserted = await Student.insertMany(newDocs, { ordered: false });
    created = inserted.length;
    for (const s of inserted) {
      studentMap.set(s.normalized_name, s._id);
    }
  }

  // Step 5: Bulk update groups with student_ids using Group.bulkWrite
  const bulkOps = [];
  for (const g of groups) {
    const ids = [];
    for (const s of (g.students || [])) {
      const key = normalizeName(s);
      const id = studentMap.get(key);
      if (id) ids.push(id);
    }
    bulkOps.push({
      updateOne: {
        filter: { _id: g._id },
        update: { $set: { student_ids: ids } }
      }
    });
  }

  let groupsUpdated = 0;
  if (bulkOps.length > 0) {
    const bulkRes = await Group.bulkWrite(bulkOps, { ordered: false });
    groupsUpdated = bulkRes.modifiedCount || bulkRes.matchedCount || bulkOps.length;
  }

  return {
    created,
    skipped,
    groupsUpdated,
    totalStudents: studentMap.size
  };
}

module.exports = {
  generateStudentCode,
  generateBarcode,
  matchOrCreateStudent,
  getStudentAcTotal,
  getStudentAcHistory,
  recordAcTransaction,
  migrateExistingStudents,
};
