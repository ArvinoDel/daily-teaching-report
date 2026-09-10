'use strict';
/**
 * adminSalaryController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * CV Fond of English — Admin Payroll Controller
 *
 * Routes handled:
 *   GET  /admin/salaries                 → index (monthly overview)
 *   POST /admin/salaries/generate        → generate / sync all salaries for a period
 *   POST /admin/salaries/publish         → bulk publish (send to teachers)
 *   GET  /admin/salaries/:id/edit        → edit individual salary
 *   POST /admin/salaries/:id             → save individual salary edits
 *   GET  /admin/salaries/:id/slip        → printable payslip view
 *   GET  /admin/salaries/export          → Excel export
 * ─────────────────────────────────────────────────────────────────────────────
 */

const Salary      = require('../models/Salary');
const User        = require('../models/User');
const AuditLog    = require('../models/AuditLog');
const salaryService = require('../services/salaryService');
const ExcelJS     = require('exceljs');

/* ── Shared helpers ── */
function formatIDR(n) {
  if (!n || n === 0) return 'Rp\u00a00';
  return 'Rp\u00a0' + Number(n).toLocaleString('en-US');
}

function getMonthMeta(query) {
  const now   = new Date();
  const raw   = query.month; // "YYYY-MM"
  let year, month;

  if (raw && /^\d{4}-\d{2}$/.test(raw)) {
    [year, month] = raw.split('-').map(Number);
  } else {
    year  = now.getFullYear();
    month = now.getMonth() + 1;
  }

  const monthStart = new Date(year, month - 1, 1);
  const monthEnd   = new Date(year, month, 0, 23, 59, 59, 999);

  const pad    = (n) => String(n).padStart(2, '0');
  const label  = monthStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const prev   = month === 1  ? `${year - 1}-12` : `${year}-${pad(month - 1)}`;
  const next   = month === 12 ? `${year + 1}-01` : `${year}-${pad(month + 1)}`;
  const isCurrent = year === now.getFullYear() && month === now.getMonth() + 1;

  return { year, month, monthStart, monthEnd, monthLabel: label, prevMonth: prev, nextMonth: next, isCurrentMonth: isCurrent, selectedMonthStr: `${year}-${pad(month)}` };
}

/* ══════════════════════════════════════════════════════════════
   INDEX  GET /admin/salaries
══════════════════════════════════════════════════════════════ */
exports.salaryIndex = async (req, res) => {
  try {
    const meta = getMonthMeta(req.query);
    const { year, month, monthLabel, prevMonth, nextMonth, isCurrentMonth, selectedMonthStr } = meta;

    // Fetch all salary docs for this month, populated with teacher
    const salaries = await Salary.find({ year, month })
      .populate('teacher', 'displayName username joinDate')
      .sort({ 'teacher.displayName': 1 })
      .lean();

    // KPI totals
    let totalGross  = 0, totalDeductions = 0, totalNet = 0;
    let draftCount  = 0, publishedCount  = 0;

    const rows = salaries.map(s => {
      totalGross      += s.subtotalIncomes    || 0;
      totalDeductions += s.subtotalDeductions || 0;
      totalNet        += s.totalSalary        || 0;
      if (s.status === 'draft')     draftCount++;
      if (s.status !== 'draft')     publishedCount++;
      return {
        ...s,
        subtotalIncomesFormatted:    formatIDR(s.subtotalIncomes),
        subtotalDeductionsFormatted: formatIDR(s.subtotalDeductions),
        totalSalaryFormatted:        formatIDR(s.totalSalary),
      };
    });

    const flash = req.session.flash || null;
    delete req.session.flash;

    res.render('admin/salaries/index', {
      rows, year, month,
      monthLabel, prevMonth, nextMonth, isCurrentMonth, selectedMonthStr,
      totalGross:           formatIDR(totalGross),
      totalDeductions:      formatIDR(totalDeductions),
      totalNet:             formatIDR(totalNet),
      draftCount, publishedCount,
      totalTeachers:        rows.length,
      flash,
    });
  } catch (err) {
    console.error('[salary] index error:', err);
    res.render('error', { message: 'Failed to load salary data.' });
  }
};

/* ══════════════════════════════════════════════════════════════
   GENERATE  POST /admin/salaries/generate
══════════════════════════════════════════════════════════════ */
exports.salaryGenerate = async (req, res) => {
  try {
    const { month, year, periodStart, periodEnd, payDate, payDateLabel, periodLabel, preserveEdits } = req.body;

    const m   = parseInt(month, 10);
    const y   = parseInt(year,  10);
    const ps  = periodStart  ? new Date(periodStart)  : new Date(y, m - 1, 1);
    const pe  = periodEnd    ? new Date(periodEnd)    : new Date(y, m, 0, 23, 59, 59);
    const pd  = payDate      ? new Date(payDate)      : null;
    const pl  = periodLabel  || salaryService.buildPeriodLabel(ps, pe);
    const pdl = payDateLabel || '';

    const saved = await salaryService.generateSalariesForPeriod({
      month: m, year: y,
      periodStart: ps, periodEnd: pe,
      payDate: pd, payDateLabel: pdl,
      periodLabel: pl,
      preserveEdits: preserveEdits !== 'false',
    });

    await AuditLog.create({
      admin:     req.session.user?._id,
      adminName: req.session.user?.displayName || req.session.user?.username,
      action: 'salary_generate',
      targetType: 'Salary',
      targetLabel: `${m}/${y}`,
      meta: { month: m, year: y, count: saved.length },
    });

    req.session.flash = { type: 'success', msg: `Generated ${saved.length} salary drafts for ${pl}.` };
    res.redirect(`/admin/salaries?month=${y}-${String(m).padStart(2,'0')}`);
  } catch (err) {
    console.error('[salary] generate error:', err);
    req.session.flash = { type: 'error', msg: 'Failed to generate salaries: ' + err.message };
    res.redirect('/admin/salaries');
  }
};

/* ══════════════════════════════════════════════════════════════
   PUBLISH  POST /admin/salaries/publish
══════════════════════════════════════════════════════════════ */
exports.salaryPublish = async (req, res) => {
  try {
    const { month, year, teacherIds } = req.body;
    const m   = parseInt(month, 10);
    const y   = parseInt(year,  10);
    const ids = Array.isArray(teacherIds) ? teacherIds : (teacherIds ? [teacherIds] : null);

    const count = await salaryService.publishSalaries(m, y, ids);

    await AuditLog.create({
      admin:     req.session.user?._id,
      adminName: req.session.user?.displayName || req.session.user?.username,
      action: 'salary_publish',
      targetType: 'Salary',
      targetLabel: `${m}/${y}`,
      meta: { month: m, year: y, publishedCount: count },
    });

    req.session.flash = { type: 'success', msg: `Published ${count} salary slip${count !== 1 ? 's' : ''} to teachers.` };
    res.redirect(`/admin/salaries?month=${y}-${String(m).padStart(2,'0')}`);
  } catch (err) {
    console.error('[salary] publish error:', err);
    req.session.flash = { type: 'error', msg: 'Failed to publish salaries: ' + err.message };
    res.redirect('/admin/salaries');
  }
};

/* ══════════════════════════════════════════════════════════════
   EDIT FORM  GET /admin/salaries/:id/edit
══════════════════════════════════════════════════════════════ */
exports.salaryEditForm = async (req, res) => {
  try {
    const salary = await Salary.findById(req.params.id).populate('teacher');
    if (!salary) return res.render('error', { message: 'Salary record not found.' });

    res.render('admin/salaries/edit', {
      salary,
      teacher: salary.teacher,
      csrfToken: req.session.csrfToken || '',
      errors: [],
      success: req.session.flash?.type === 'success' ? req.session.flash.msg : null,
    });
    delete req.session.flash;
  } catch (err) {
    console.error('[salary] editForm error:', err);
    res.render('error', { message: 'Failed to load salary editor.' });
  }
};

/* ══════════════════════════════════════════════════════════════
   SAVE EDITS  POST /admin/salaries/:id
══════════════════════════════════════════════════════════════ */
exports.salaryUpdate = async (req, res) => {
  try {
    const salary = await Salary.findById(req.params.id);
    if (!salary) return res.render('error', { message: 'Salary record not found.' });

    const n = (v) => Math.max(0, parseFloat(v) || 0);

    /* ── Map body fields → salary doc ── */
    // Period meta
    if (req.body.periodLabel)  salary.periodLabel  = req.body.periodLabel.trim();
    if (req.body.periodStart)  salary.periodStart  = new Date(req.body.periodStart);
    if (req.body.periodEnd)    salary.periodEnd    = new Date(req.body.periodEnd);
    if (req.body.payDate)      salary.payDate      = new Date(req.body.payDate);
    if (req.body.payDateLabel) salary.payDateLabel = req.body.payDateLabel.trim();

    // Earnings
    salary.basicSalary          = n(req.body.basicSalary);
    salary.mealFullDays         = n(req.body.mealFullDays);
    salary.mealFullRate         = n(req.body.mealFullRate);
    salary.mealHalfDays         = n(req.body.mealHalfDays);
    salary.mealHalfRate         = n(req.body.mealHalfRate);
    salary.transportDays        = n(req.body.transportDays);
    salary.transportRate        = n(req.body.transportRate);
    salary.monthlyIncentive     = n(req.body.monthlyIncentive);
    salary.healthAllowance      = n(req.body.healthAllowance);
    salary.positionAllowance    = n(req.body.positionAllowance);
    salary.loyaltyAllowance     = n(req.body.loyaltyAllowance);
    salary.wifeChildAllowance   = n(req.body.wifeChildAllowance);
    salary.teachingReward       = n(req.body.teachingReward);
    salary.gameReward           = n(req.body.gameReward);
    salary.studentCommission    = n(req.body.studentCommission);
    salary.internetCompensation = n(req.body.internetCompensation);
    salary.overtime             = n(req.body.overtime);

    // Deductions
    salary.instalment             = n(req.body.instalment);
    salary.miscellaneousDeduction = n(req.body.miscellaneousDeduction);
    salary.bpjsKetenagakerjaan    = n(req.body.bpjsKetenagakerjaan);
    salary.tax                    = n(req.body.tax);

    // Other incomes (dynamic rows)
    const oiLabels  = [].concat(req.body['otherIncomeLabel[]']  || []);
    const oiAmounts = [].concat(req.body['otherIncomeAmount[]'] || []);
    salary.otherIncomes = oiLabels
      .map((label, i) => ({ label: label.trim(), amount: n(oiAmounts[i]) }))
      .filter(item => item.label || item.amount > 0);

    // Other deductions (dynamic rows)
    const odLabels  = [].concat(req.body['otherDeductionLabel[]']  || []);
    const odAmounts = [].concat(req.body['otherDeductionAmount[]'] || []);
    salary.otherDeductions = odLabels
      .map((label, i) => ({ label: label.trim(), amount: n(odAmounts[i]) }))
      .filter(item => item.label || item.amount > 0);

    salary.notes = (req.body.notes || '').trim().slice(0, 500);

    // Recompute totals
    salary.recompute();
    await salary.save();

    await AuditLog.create({
      admin:     req.session.user?._id,
      adminName: req.session.user?.displayName || req.session.user?.username,
      action: 'salary_update',
      targetType: 'Salary',
      targetId: salary._id,
      targetLabel: `${salary.month}/${salary.year}`,
      meta: { month: salary.month, year: salary.year },
    });

    req.session.flash = { type: 'success', msg: 'Salary updated successfully.' };
    res.redirect(`/admin/salaries/${salary._id}/edit`);
  } catch (err) {
    console.error('[salary] update error:', err);
    req.session.flash = { type: 'error', msg: 'Failed to save salary: ' + err.message };
    res.redirect(`/admin/salaries/${req.params.id}/edit`);
  }
};

/* ══════════════════════════════════════════════════════════════
   SLIP VIEW  GET /admin/salaries/:id/slip
══════════════════════════════════════════════════════════════ */
exports.salarySlip = async (req, res) => {
  try {
    const salary = await Salary.findById(req.params.id).populate('teacher');
    if (!salary) return res.render('error', { message: 'Salary record not found.' });

    // Pre-format all IDR values for the template
    const fmt = (v) => formatIDR(v);

    res.render('admin/salaries/slip', {
      salary, teacher: salary.teacher, fmt,
      printMode: req.query.print === '1',
    });
  } catch (err) {
    console.error('[salary] slip error:', err);
    res.render('error', { message: 'Failed to load payslip.' });
  }
};

/* ══════════════════════════════════════════════════════════════
   EXCEL EXPORT  GET /admin/salaries/export?month=YYYY-MM
══════════════════════════════════════════════════════════════ */
exports.salaryExport = async (req, res) => {
  try {
    const meta = getMonthMeta(req.query);
    const { year, month, monthLabel } = meta;

    const salaries = await Salary.find({ year, month })
      .populate('teacher', 'displayName username')
      .lean();

    const wb = new ExcelJS.Workbook();
    wb.creator = 'CV Fond of English';
    const ws = wb.addWorksheet(`Payroll ${monthLabel}`);

    // Header row
    ws.columns = [
      { header: 'No',              key: 'no',           width: 5  },
      { header: 'Name',            key: 'name',         width: 20 },
      { header: 'Basic Salary',    key: 'basicSalary',  width: 14 },
      { header: 'Meal (Full)',      key: 'mealFull',     width: 14 },
      { header: 'Meal (Half)',      key: 'mealHalf',     width: 14 },
      { header: 'Transport',       key: 'transport',    width: 14 },
      { header: 'Incentive',       key: 'incentive',    width: 14 },
      { header: 'Health',          key: 'health',       width: 13 },
      { header: 'Position',        key: 'position',     width: 13 },
      { header: 'Loyalty',         key: 'loyalty',      width: 13 },
      { header: 'Wife/Child',      key: 'wifeChild',    width: 13 },
      { header: 'Teaching Reward', key: 'reward',       width: 16 },
      { header: 'Game Reward',     key: 'game',         width: 13 },
      { header: 'Std Commission',  key: 'stdComm',      width: 14 },
      { header: 'Internet',        key: 'internet',     width: 12 },
      { header: 'Overtime',        key: 'overtime',     width: 12 },
      { header: 'Subtotal Income', key: 'subtotalInc',  width: 16 },
      { header: 'Instalment',      key: 'instalment',   width: 13 },
      { header: 'Misc Deduction',  key: 'misc',         width: 14 },
      { header: 'BPJS',            key: 'bpjs',         width: 12 },
      { header: 'Tax',             key: 'tax',          width: 12 },
      { header: 'Subtotal Deduct', key: 'subtotalDed',  width: 16 },
      { header: 'Net Salary',      key: 'netSalary',    width: 15 },
      { header: 'Status',          key: 'status',       width: 10 },
    ];

    // Style header
    ws.getRow(1).font = { bold: true, size: 11 };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    salaries.forEach((s, idx) => {
      ws.addRow({
        no:          idx + 1,
        name:        s.teacher?.displayName || '—',
        basicSalary: s.basicSalary        || 0,
        mealFull:    s.mealFullTotal       || 0,
        mealHalf:    s.mealHalfTotal       || 0,
        transport:   s.transportTotal      || 0,
        incentive:   s.monthlyIncentive    || 0,
        health:      s.healthAllowance     || 0,
        position:    s.positionAllowance   || 0,
        loyalty:     s.loyaltyAllowance    || 0,
        wifeChild:   s.wifeChildAllowance  || 0,
        reward:      s.teachingReward      || 0,
        game:        s.gameReward          || 0,
        stdComm:     s.studentCommission   || 0,
        internet:    s.internetCompensation|| 0,
        overtime:    s.overtime            || 0,
        subtotalInc: s.subtotalIncomes     || 0,
        instalment:  s.instalment          || 0,
        misc:        s.miscellaneousDeduction || 0,
        bpjs:        s.bpjsKetenagakerjaan || 0,
        tax:         s.tax                 || 0,
        subtotalDed: s.subtotalDeductions  || 0,
        netSalary:   s.totalSalary         || 0,
        status:      s.status,
      });
    });

    // Grand total row
    const totalRow = ws.addRow({
      no: '', name: 'GRAND TOTAL',
      basicSalary:  salaries.reduce((a, s) => a + (s.basicSalary || 0), 0),
      subtotalInc:  salaries.reduce((a, s) => a + (s.subtotalIncomes || 0), 0),
      subtotalDed:  salaries.reduce((a, s) => a + (s.subtotalDeductions || 0), 0),
      netSalary:    salaries.reduce((a, s) => a + (s.totalSalary || 0), 0),
    });
    totalRow.font = { bold: true };
    totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };

    const filename = `Payroll_FondOfEnglish_${year}-${String(month).padStart(2,'0')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[salary] export error:', err);
    res.render('error', { message: 'Failed to export salary data.' });
  }
};
