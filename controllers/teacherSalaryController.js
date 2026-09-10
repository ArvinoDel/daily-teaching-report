'use strict';
/**
 * teacherSalaryController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * CV Fond of English — Teacher Read-Only Salary Portal
 *
 * Teachers can ONLY see their own salary slips that have been published by admin.
 * They cannot see drafts and they cannot modify any values.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const Salary = require('../models/Salary');

function formatIDR(n) {
  if (!n || n === 0) return 'Rp\u00a00';
  return 'Rp\u00a0' + Number(n).toLocaleString('en-US');
}

/* ══════════════════════════════════════════════════════════════
   MY SALARY INDEX  GET /reports/my-salary
   Shows list of published salary slips for the logged-in teacher
══════════════════════════════════════════════════════════════ */
exports.mySalaryIndex = async (req, res) => {
  try {
    const teacherId = req.session.user._id;

    const salaries = await Salary.find({
      teacher: teacherId,
      status: { $in: ['published', 'paid'] },   // Only show what has been sent
    })
      .sort({ year: -1, month: -1 })
      .lean();

    const rows = salaries.map(s => ({
      ...s,
      totalSalaryFormatted: formatIDR(s.totalSalary),
      monthLabel: new Date(s.year, s.month - 1, 1)
        .toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    }));

    res.render('reports/my-salary/index', {
      rows,
      totalSalaries: rows.length,
    });
  } catch (err) {
    console.error('[teacherSalary] index error:', err);
    res.render('error', { message: 'Failed to load your salary data.' });
  }
};

/* ══════════════════════════════════════════════════════════════
   MY SALARY SLIP  GET /reports/my-salary/:id/slip
   Read-only payslip view for the teacher who owns it
══════════════════════════════════════════════════════════════ */
exports.mySalarySlip = async (req, res) => {
  try {
    const teacherId = req.session.user._id;

    const salary = await Salary.findById(req.params.id).populate('teacher');
    if (!salary) {
      return res.render('error', { message: 'Salary slip not found.' });
    }

    // Security: teacher can only view their own published/paid slips
    if (String(salary.teacher._id) !== String(teacherId)) {
      return res.status(403).render('error', { message: 'Access denied.' });
    }
    if (!['published', 'paid'].includes(salary.status)) {
      return res.render('error', { message: 'This salary slip is not yet available.' });
    }

    res.render('reports/my-salary/slip', {
      salary,
      teacher: salary.teacher,
      fmt: formatIDR,
    });
  } catch (err) {
    console.error('[teacherSalary] slip error:', err);
    res.render('error', { message: 'Failed to load salary slip.' });
  }
};
