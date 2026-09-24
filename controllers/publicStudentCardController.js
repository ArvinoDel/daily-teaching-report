/**
 * controllers/publicStudentCardController.js
 *
 * Public (unauthenticated), read-only student Achievement Card view.
 *
 * Routes:
 *   GET /student-card/:barcode  → Render the public read-only card page
 *   GET /c/:barcode             → Short alias (same handler)
 */

const Student = require('../models/Student');
const Group   = require('../models/Group');
const {
  getStudentAcTotal,
  getStudentAcHistory,
} = require('../services/studentService');

/* ═══════════════════════════════════════════════════════════════════
   Shared render handler — used by both /student-card/:barcode and /c/:barcode
════════════════════════════════════════════════════════════════════ */
exports.viewCard = async (req, res) => {
  try {
    const raw = (req.params.barcode || '').trim();
    if (!raw) {
      return res.status(404).render('error', { message: 'No barcode provided.' });
    }

    // Look up by barcode field OR student_code (so either works)
    const student = await Student.findOne({
      $or: [
        { barcode: raw },
        { student_code: raw },
      ],
    }).lean();

    if (!student) {
      return res.status(404).render('public/student-card-not-found', { barcode: raw });
    }

    const [acTotal, acHistory] = await Promise.all([
      getStudentAcTotal(student),
      getStudentAcHistory(student),
    ]);

    const groups = await Group.find({ student_ids: student._id })
      .select('group_name type level')
      .lean();

    return res.render('public/student-card', {
      student: {
        _id:          String(student._id),
        full_name:    student.full_name || student.raw_name || '—',
        grade_school: student.grade_school || '',
        student_code: student.student_code || student.barcode || '',
        barcode:      student.barcode || '',
        status:       student.status || 'active',
        groups:       groups.map(g => ({
          groupId:   String(g._id),
          groupName: g.group_name,
          type:      g.type,
          level:     g.level || '',
        })),
        acTotal,
        acHistory: acHistory.map(h => ({
          _id:        h._id ? String(h._id) : undefined,
          date:       h.date,
          class_name: h.class_name || 'Admin Adjustment',
          subject:    h.subject || '',
          count:      h.count || 1,
          type:       h.type,
          source:     h.source || '',
          teacher:    h.teacher || '',
          note:       h.note || '',
        })),
      },
    });
  } catch (err) {
    console.error('publicStudentCard error:', err);
    return res.status(500).render('error', { message: 'Something went wrong. Please try again.' });
  }
};
