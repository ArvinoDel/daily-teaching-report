/**
 * controllers/adminAcScanController.js
 *
 * Handles the dedicated AC barcode scanner page.
 *
 * Routes:
 *   GET  /admin/scan-ac           → render scanner page
 *   GET  /admin/scan-ac/lookup    → JSON: resolve barcode → student + AC total
 *   POST /admin/scan-ac/transact  → JSON: record +1 or -1 AC transaction
 *   DELETE /admin/scan-ac/transact/:id → JSON: undo a transaction
 */

const Student        = require('../models/Student');
const AcTransaction  = require('../models/AcTransaction');
const { recordAcTransaction, getStudentAcTotal } = require('../services/studentService');

/* ═══════════════════════════════════════════════════════════════════
   GET /admin/scan-ac
   Render the full-screen scanner page.
═════════════════════════════════════════════════════════════════════ */
exports.scanPage = (_req, res) => {
  res.render('admin/scan-ac/index');
};

/* ══════════════════════════════════════════════════════════════════
   GET /admin/scan-ac/mobile
   Mobile-first camera scanner page.
══════════════════════════════════════════════════════════════════ */
exports.mobileScanPage = (_req, res) => {
  res.render('admin/scan-ac/mobile');
};

/* ═══════════════════════════════════════════════════════════════════
   GET /admin/scan-ac/lookup?barcode=XXXXX
   Resolves a barcode to a student and returns their AC total.
   Called by the scanner page AJAX immediately after a scan.
═════════════════════════════════════════════════════════════════════ */
exports.lookup = async (req, res) => {
  try {
    const { barcode } = req.query;
    if (!barcode || !barcode.trim()) {
      return res.status(400).json({ ok: false, error: 'No barcode provided.' });
    }

    const student = await Student.findOne({ barcode: barcode.trim() }).lean();
    if (!student) {
      return res.status(404).json({ ok: false, error: 'Student not found. Check the barcode and try again.' });
    }

    const acTotal = await getStudentAcTotal(student);

    return res.json({
      ok: true,
      student: {
        _id:          String(student._id),
        full_name:    student.full_name || student.raw_name,
        grade_school: student.grade_school || '',
        student_code: student.student_code || '',
        barcode:      student.barcode,
        acTotal,
      },
    });
  } catch (err) {
    console.error('scan-ac/lookup error:', err);
    return res.status(500).json({ ok: false, error: 'Server error. Please try again.' });
  }
};

/* ═══════════════════════════════════════════════════════════════════
   POST /admin/scan-ac/transact
   Body: { barcode, type: 'add'|'reduce', subject, class_name, note }
   Records an AC transaction and returns the updated total.
═════════════════════════════════════════════════════════════════════ */
exports.transact = async (req, res) => {
  try {
    const { barcode, type, subject, class_name, note } = req.body;

    if (!barcode || !barcode.trim()) {
      return res.status(400).json({ ok: false, error: 'No barcode provided.' });
    }
    if (!['add', 'reduce'].includes(type)) {
      return res.status(400).json({ ok: false, error: 'Invalid type. Must be "add" or "reduce".' });
    }

    const student = await Student.findOne({ barcode: barcode.trim() }).lean();
    if (!student) {
      return res.status(404).json({ ok: false, error: 'Student not found.' });
    }

    // Guard: don't let total go below 0
    if (type === 'reduce') {
      const currentTotal = await getStudentAcTotal(student);
      if (currentTotal <= 0) {
        return res.status(400).json({
          ok: false,
          error: `${student.full_name || student.raw_name} has no AC cards to reduce.`,
        });
      }
    }

    // Record the transaction
    const user = req.session && req.session.user;
    const tx = await recordAcTransaction({
      student,
      type,
      subject:         (subject    || '').trim(),
      class_name:      (class_name || '').trim(),
      note:            (note       || '').trim(),
      scanned_by:      user ? user._id : null,
      scanned_by_name: user ? (user.displayName || user.username || '') : '',
    });

    // Return updated total
    const updatedTotal = await getStudentAcTotal(student);

    return res.json({
      ok: true,
      transaction: {
        _id:          String(tx._id),
        type:         tx.type,
        amount:       tx.amount,
        student_name: tx.student_name,
        student_code: tx.student_code,
        class_name:   tx.class_name,
        subject:      tx.subject,
        date:         tx.date,
      },
      acTotal: updatedTotal,
    });
  } catch (err) {
    console.error('scan-ac/transact error:', err);
    return res.status(500).json({ ok: false, error: 'Server error. Please try again.' });
  }
};

/* ═══════════════════════════════════════════════════════════════════
   DELETE /admin/scan-ac/transact/:id
   Undoes a single AcTransaction (removes it from the DB).
   Only allowed within the same session (no time restriction enforced
   here — UI only shows undo for current session).
═════════════════════════════════════════════════════════════════════ */
exports.undoTransact = async (req, res) => {
  try {
    const tx = await AcTransaction.findById(req.params.id);
    if (!tx) {
      return res.status(404).json({ ok: false, error: 'Transaction not found.' });
    }

    // Fetch the student to return updated total
    const student = await Student.findById(tx.student).lean();
    await tx.deleteOne();

    const updatedTotal = student ? await getStudentAcTotal(student) : 0;

    return res.json({ ok: true, acTotal: updatedTotal });
  } catch (err) {
    console.error('scan-ac/undoTransact error:', err);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
};
