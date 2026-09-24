/**
 * GET /admin/student-achievements/print-cards
 *
 * Renders a print-ready page of all student QR cards.
 * Each card shows:  QR code + student name + grade + class groups
 * (No AC totals or history — for distribution/printing only)
 */

const Student = require('../models/Student');
const Group   = require('../models/Group');
const { normalizeName } = require('../models/Student');

exports.printCards = async (req, res) => {
  try {
    // Load all Student docs that have a barcode
    const studentDocs = await Student.find({ barcode: { $exists: true, $ne: '' } }).lean();

    if (!studentDocs.length) {
      return res.render('admin/student-achievements/print-cards', {
        students: [],
        baseUrl: res.locals.baseUrl || (req.protocol + '://' + req.get('host')),
      });
    }

    // Build a map: student._id → groups
    const groupDocs = await Group.find({}).select('group_name type level student_ids').lean();
    const groupsByStudentId = {}; // studentId (string) → [{ groupName, type, level }]
    for (const g of groupDocs) {
      for (const sid of (g.student_ids || [])) {
        const key = String(sid);
        if (!groupsByStudentId[key]) groupsByStudentId[key] = [];
        groupsByStudentId[key].push({
          groupName: g.group_name,
          type:      g.type,
          level:     g.level || '',
        });
      }
    }

    const students = studentDocs.map(s => ({
      _id:          String(s._id),
      full_name:    s.full_name || s.raw_name || '—',
      grade_school: s.grade_school || '',
      student_code: s.student_code || s.barcode,
      barcode:      s.barcode,
      groups:       groupsByStudentId[String(s._id)] || [],
    }))
    // Sort alphabetically by name
    .sort((a, b) => a.full_name.localeCompare(b.full_name));

    return res.render('admin/student-achievements/print-cards', {
      students,
      baseUrl: res.locals.baseUrl || (req.protocol + '://' + req.get('host')),
    });
  } catch (err) {
    console.error('printCards error:', err);
    return res.status(500).render('error', { message: 'Failed to generate print cards.' });
  }
};
