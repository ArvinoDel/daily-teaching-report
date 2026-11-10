const { activeUserFilter } = require('../services/userAccountService');
const reportGapService = require('../services/reportGapService');
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

const mongoose    = require('mongoose');
const Salary      = require('../models/Salary');
const User        = require('../models/User');
const AuditLog    = require('../models/AuditLog');
const salaryService = require('../services/salaryService');
const salaryStatusService = require('../services/salaryStatusService');
const {
  SALARY_STATUSES,
  canTransition,
  planMarkPaid,
  getJakartaDateString,
  getJakartaNoonDate,
  formatDisplayDate,
  validatePaidDate,
  buildPublishFilter,
  buildMarkPaidFilter,
  buildRetractFilter,
  buildReopenFilter,
  buildDraftEditFilter,
} = salaryStatusService;
const notificationService = require('../services/notificationService');
const { getTeachersWithoutRewards } = require('../services/onboardingService');
const ExcelJS     = require('exceljs');

/* ── Shared helpers ── */
function formatIDR(n) {
  if (!n || n === 0) return 'Rp\u00a00';
  return 'Rp\u00a0' + Number(n).toLocaleString('en-US');
}

/**
 * applySalaryFields(salary, body)
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared field-parsing helper used by both salaryUpdate (single edit) and
 * salaryBulkUpdate. Applies and clamps all numeric fields exactly the same way.
 * Does NOT call salary.save() — callers must do that.
 */
function applySalaryFields(salary, body) {
  const n = (v) => Math.max(0, parseFloat(String(v ?? '').replace(/,/g, '')) || 0);

  // Period meta
  if (body.periodLabel !== undefined)  salary.periodLabel  = body.periodLabel.trim();
  if (body.periodStart)                salary.periodStart  = new Date(body.periodStart);
  if (body.periodEnd)                  salary.periodEnd    = new Date(body.periodEnd);
  if (body.payDate)                    salary.payDate      = new Date(body.payDate);
  else if (body.payDate === '')        salary.payDate      = null;
  if (body.payDateLabel !== undefined) salary.payDateLabel = body.payDateLabel.trim();

  // Earnings
  salary.basicSalary          = n(body.basicSalary);
  salary.mealFullDays         = n(body.mealFullDays);
  salary.mealFullRate         = n(body.mealFullRate);
  salary.mealHalfDays         = n(body.mealHalfDays);
  salary.mealHalfRate         = n(body.mealHalfRate);
  salary.transportDays        = n(body.transportDays);
  salary.transportRate        = n(body.transportRate);
  salary.monthlyIncentive     = n(body.monthlyIncentive);
  salary.healthAllowance      = n(body.healthAllowance);
  salary.positionAllowance    = n(body.positionAllowance);
  salary.loyaltyAllowance     = n(body.loyaltyAllowance);
  salary.wifeChildAllowance   = n(body.wifeChildAllowance);
  salary.teachingReward       = n(body.teachingReward);
  salary.gameReward           = n(body.gameReward);
  salary.studentCommission    = n(body.studentCommission);
  salary.internetCompensation = n(body.internetCompensation);
  salary.overtime             = n(body.overtime);

  // Deductions
  salary.instalment             = n(body.instalment);
  salary.miscellaneousDeduction = n(body.miscellaneousDeduction);
  salary.bpjsKetenagakerjaan    = n(body.bpjsKetenagakerjaan);
  salary.tax                    = n(body.tax);

  // Other incomes (dynamic rows — supports qs array syntax or brackets)
  const rawOiLabels  = body.otherIncomeLabel ?? body['otherIncomeLabel[]'] ?? [];
  const rawOiAmounts = body.otherIncomeAmount ?? body['otherIncomeAmount[]'] ?? [];
  const oiLabels  = [].concat(rawOiLabels);
  const oiAmounts = [].concat(rawOiAmounts);
  salary.otherIncomes = oiLabels
    .map((label, i) => ({ label: (label || '').trim(), amount: n(oiAmounts[i]) }))
    .filter(item => item.label || item.amount > 0);

  // Other deductions (dynamic rows — supports qs array syntax or brackets)
  const rawOdLabels  = body.otherDeductionLabel ?? body['otherDeductionLabel[]'] ?? [];
  const rawOdAmounts = body.otherDeductionAmount ?? body['otherDeductionAmount[]'] ?? [];
  const odLabels  = [].concat(rawOdLabels);
  const odAmounts = [].concat(rawOdAmounts);
  salary.otherDeductions = odLabels
    .map((label, i) => ({ label: (label || '').trim(), amount: n(odAmounts[i]) }))
    .filter(item => item.label || item.amount > 0);

  if (body.notes !== undefined) {
    salary.notes = (body.notes || '').trim().slice(0, 500);
  }

  // NOTE: caller is responsible for calling salary.recompute() before saving.
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
      .lean();

    // Sort alphabetically by teacher display name in JS (since populate sort cannot be done at DB query level)
    salaries.sort((a, b) => (a.teacher?.displayName || '').localeCompare(b.teacher?.displayName || ''));

    // KPI totals
    let totalGross  = 0, totalDeductions = 0, totalNet = 0;
    let draftCount  = 0, publishedCount  = 0, paidCount = 0;

    const rows = salaries.map(s => {
      totalGross      += s.subtotalIncomes    || 0;
      totalDeductions += s.subtotalDeductions || 0;
      totalNet        += s.totalSalary        || 0;
      if (s.status === 'draft')          draftCount++;
      else if (s.status === 'published') publishedCount++;
      else if (s.status === 'paid')      paidCount++;

      return {
        ...s,
        subtotalIncomesFormatted:    formatIDR(s.subtotalIncomes),
        subtotalDeductionsFormatted: formatIDR(s.subtotalDeductions),
        totalSalaryFormatted:        formatIDR(s.totalSalary),
        publishedAtFormatted:        s.publishedAt ? formatDisplayDate(s.publishedAt) : null,
        paidAtFormatted:             s.paidAt ? formatDisplayDate(s.paidAt) : null,
      };
    });

    const statusFilter = ['draft', 'published', 'paid'].includes(req.query.status) ? req.query.status : 'all';
    const displayedRows = statusFilter === 'all'
      ? rows
      : rows.filter(r => r.status === statusFilter);

    // Entry-point IDs for the two new walkthrough buttons
    const draftSlips     = salaries.filter(s => s.status === 'draft');
    const firstDraftId   = draftSlips.length   > 0 ? draftSlips[0]._id.toString()  : null;
    const firstRowId     = salaries.length      > 0 ? salaries[0]._id.toString()    : null;

    const flash = req.session.flash || null;
    delete req.session.flash;

    const pStart = salaries.length > 0 && salaries[0].periodStart ? salaries[0].periodStart : new Date(year, month - 1, 1);
    const pEnd   = salaries.length > 0 && salaries[0].periodEnd   ? salaries[0].periodEnd   : new Date(year, month, 0, 23, 59, 59, 999);
    const missingReportsCount = await reportGapService.countMissingReportsInPeriod(pStart, pEnd);

    const activeTeachers = await User.find(activeUserFilter({ role: 'teacher' })).select('displayName username commission').lean();
    const teachersWithoutRewards = getTeachersWithoutRewards(activeTeachers);

    res.render('admin/salaries/index', {
      rows: displayedRows,
      allRowsCount: rows.length,
      statusFilter,
      year, month,
      monthLabel, prevMonth, nextMonth, isCurrentMonth, selectedMonthStr,
      totalGross:      formatIDR(totalGross),
      totalDeductions: formatIDR(totalDeductions),
      totalNet:        formatIDR(totalNet),
      draftCount, publishedCount, paidCount,
      totalTeachers:   rows.length,
      flash,
      firstDraftId,
      firstRowId,
      teachersWithoutRewards,
      missingReportsCount,
      todayJakarta: getJakartaDateString(new Date()),
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

    const m = parseInt(month, 10);
    const y = parseInt(year,  10);
    if (isNaN(m) || m < 1 || m > 12 || isNaN(y) || y < 2000 || y > 2100) {
      req.session.flash = { type: 'error', msg: 'Invalid month or year selected.' };
      return res.redirect('/admin/salaries');
    }

    // Set full-day bounds so reports on the start/end dates are never cut off by time zones or 00:00:00 hours
    let ps, pe;
    if (periodStart) {
      ps = new Date(periodStart);
      ps.setHours(0, 0, 0, 0);
    } else {
      ps = new Date(y, m - 1, 1, 0, 0, 0, 0);
    }

    if (periodEnd) {
      pe = new Date(periodEnd);
      pe.setHours(23, 59, 59, 999);
    } else {
      pe = new Date(y, m, 0, 23, 59, 59, 999);
    }

    const pd  = payDate      ? new Date(payDate)      : null;
    const pl  = periodLabel  || salaryService.buildPeriodLabel(ps, pe);
    const pdl = payDateLabel || '';

    // Checkbox unchecked in HTML sends undefined -> properly handle boolean
    const shouldPreserve = preserveEdits === 'true' || preserveEdits === 'on' || preserveEdits === true;

    const saved = await salaryService.generateSalariesForPeriod({
      month: m, year: y,
      periodStart: ps, periodEnd: pe,
      payDate: pd, payDateLabel: pdl,
      periodLabel: pl,
      preserveEdits: shouldPreserve,
    });

    await AuditLog.create({
      admin:     req.session.user?._id,
      adminName: req.session.user?.displayName || req.session.user?.username,
      action: 'salary_generate',
      targetType: 'salary',
      targetLabel: `${m}/${y}`,
      meta: { month: m, year: y, count: saved.length },
    });

    const activeTeachers = await User.find(activeUserFilter({ role: 'teacher' })).select('displayName username commission').lean();
    const withoutRewards = getTeachersWithoutRewards(activeTeachers);

    const createdN = saved.createdCount || 0;
    const updatedM = saved.updatedDraftsCount || 0;
    const skippedK = saved.skippedCount || 0;
    let flashMsg = `Generated ${createdN} slips, updated ${updatedM} drafts, skipped ${skippedK} (already published or paid).`;
    if (saved.skipped && saved.skipped.length > 0) {
      const names = saved.skipped.slice(0, 10).map(s => s.name).join(', ');
      flashMsg += ` Skipped: ${names}${saved.skipped.length > 10 ? ', and more' : ''}.`;
    }
    if (withoutRewards.count > 0) {
      flashMsg += ` Note: ${withoutRewards.count} teacher${withoutRewards.count > 1 ? 's have' : ' has'} no reward amounts set.`;
    }

    req.session.flash = { type: 'success', msg: flashMsg };
    res.redirect(`/admin/salaries?month=${y}-${String(m).padStart(2,'0')}`);
  } catch (err) {
    console.error('[salary] generate error:', err);
    req.session.flash = { type: 'error', msg: 'Failed to generate salaries.' };
    res.redirect('/admin/salaries');
  }
};

/* ══════════════════════════════════════════════════════════════
   PUBLISH  POST /admin/salaries/publish
══════════════════════════════════════════════════════════════ */
exports.salaryPublish = async (req, res) => {
  try {
    const { month, year, teacherIds } = req.body;
    const m = parseInt(month, 10);
    const y = parseInt(year,  10);
    if (isNaN(m) || m < 1 || m > 12 || isNaN(y)) {
      req.session.flash = { type: 'error', msg: 'Invalid month or year selected.' };
      return res.redirect('/admin/salaries');
    }

    let ids = null;
    if (teacherIds) {
      const rawIds = Array.isArray(teacherIds) ? teacherIds : [teacherIds];
      ids = rawIds.filter(id => mongoose.Types.ObjectId.isValid(id));
      if (ids.length === 0) ids = null;
    }

    const count = await salaryService.publishSalaries(m, y, ids);

    await AuditLog.create({
      admin:     req.session.user?._id,
      adminName: req.session.user?.displayName || req.session.user?.username,
      action: 'salary_publish',
      targetType: 'salary',
      targetLabel: `${m}/${y}`,
      meta: { month: m, year: y, publishedCount: count },
    });

    req.session.flash = { type: 'success', msg: `Published ${count} salary slip${count !== 1 ? 's' : ''} to teachers.` };
    res.redirect(`/admin/salaries?month=${y}-${String(m).padStart(2,'0')}`);
  } catch (err) {
    console.error('[salary] publish error:', err);
    req.session.flash = { type: 'error', msg: 'Failed to publish salaries.' };
    res.redirect('/admin/salaries');
  }
};

/* ══════════════════════════════════════════════════════════════
   EDIT FORM  GET /admin/salaries/:id/edit
   Supports optional ?flow=bulk&month=YYYY-MM for bulk walkthrough.
══════════════════════════════════════════════════════════════ */
exports.salaryEditForm = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).render('error', { message: 'Invalid salary record ID.' });
    }

    const salary = await Salary.findById(req.params.id).populate('teacher');
    if (!salary) return res.status(404).render('error', { message: 'Salary record not found.' });

    if (salary.status !== 'draft') {
      req.session.flash = {
        type: 'error',
        msg: 'Published and paid slips are locked. Retract the slip to draft to edit it.',
      };
      return res.redirect(`/admin/salaries/${salary._id}/slip`);
    }

    const success = req.session.flash?.type === 'success' ? req.session.flash.msg : null;
    delete req.session.flash;

    // ── Bulk-edit flow ──────────────────────────────────────────
    const isBulk = req.query.flow === 'bulk';
    if (isBulk) {
      const meta = getMonthMeta(req.query);
      const { year, month, selectedMonthStr } = meta;

      // Fetch ALL salaries for that month, sort by teacher name (same as index table)
      const allSalaries = await Salary.find({ year, month })
        .populate('teacher', 'displayName')
        .lean();
      allSalaries.sort((a, b) =>
        (a.teacher?.displayName || '').localeCompare(b.teacher?.displayName || ''));

      // Only draft slips are part of the bulk-edit flow
      const draftSalaries = allSalaries.filter(s => s.status === 'draft');

      if (draftSalaries.length === 0) {
        req.session.flash = { type: 'error', msg: 'No draft salary slips found for this month.' };
        return res.redirect(`/admin/salaries?month=${selectedMonthStr}`);
      }

      // Ordered list of draft IDs passed to the client for navigation + sessionStorage keying
      const bulkList = draftSalaries.map(s => ({
        id:          s._id.toString(),
        teacherName: s.teacher?.displayName || 'Unknown',
        updatedAt:   s.updatedAt instanceof Date ? s.updatedAt.toISOString() : new Date(s.updatedAt).toISOString(),
      }));

      const currentIndex = bulkList.findIndex(item => item.id === salary._id.toString());

      // If this salary is not a draft, redirect to the first draft in the list
      if (currentIndex === -1) {
        return res.redirect(
          `/admin/salaries/${bulkList[0].id}/edit?flow=bulk&month=${selectedMonthStr}`
        );
      }

      return res.render('admin/salaries/edit', {
        salary,
        teacher:      salary.teacher,
        csrfToken:    req.session.csrfToken || '',
        errors:       [],
        success,
        // Bulk-flow extras
        flow:         'bulk',
        bulkList,
        currentIndex,
        totalDrafts:  bulkList.length,
        monthStr:     selectedMonthStr,
      });
    }
    // ── Normal single-edit flow ──────────────────────────────────
    res.render('admin/salaries/edit', {
      salary,
      teacher:   salary.teacher,
      csrfToken: req.session.csrfToken || '',
      errors:    [],
      success,
      flow:      null,
      bulkList:  null,
    });
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
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      req.session.flash = { type: 'error', msg: 'Invalid salary record ID.' };
      return res.redirect('/admin/salaries');
    }

    const salary = await Salary.findById(req.params.id);
    if (!salary) {
      req.session.flash = { type: 'error', msg: 'Salary record not found.' };
      return res.redirect('/admin/salaries');
    }

    if (salary.status !== 'draft') {
      req.session.flash = {
        type: 'error',
        msg: 'Published and paid slips are locked. Retract the slip to draft to edit it.',
      };
      return res.redirect(`/admin/salaries/${salary._id}/slip`);
    }

    applySalaryFields(salary, req.body);
    salary.recompute();

    const updated = await Salary.findOneAndUpdate(
      buildDraftEditFilter(salary._id),
      {
        $set: {
          basicSalary: salary.basicSalary,
          mealFullDays: salary.mealFullDays,
          mealFullRate: salary.mealFullRate,
          mealFullTotal: salary.mealFullTotal,
          mealHalfDays: salary.mealHalfDays,
          mealHalfRate: salary.mealHalfRate,
          mealHalfTotal: salary.mealHalfTotal,
          transportDays: salary.transportDays,
          transportRate: salary.transportRate,
          transportTotal: salary.transportTotal,
          monthlyIncentive: salary.monthlyIncentive,
          healthAllowance: salary.healthAllowance,
          positionAllowance: salary.positionAllowance,
          loyaltyAllowance: salary.loyaltyAllowance,
          wifeChildAllowance: salary.wifeChildAllowance,
          teachingReward: salary.teachingReward,
          gameReward: salary.gameReward,
          studentCommission: salary.studentCommission,
          internetCompensation: salary.internetCompensation,
          overtime: salary.overtime,
          otherIncomes: salary.otherIncomes,
          subtotalIncomes: salary.subtotalIncomes,
          instalment: salary.instalment,
          miscellaneousDeduction: salary.miscellaneousDeduction,
          bpjsKetenagakerjaan: salary.bpjsKetenagakerjaan,
          tax: salary.tax,
          otherDeductions: salary.otherDeductions,
          subtotalDeductions: salary.subtotalDeductions,
          totalSalary: salary.totalSalary,
          notes: salary.notes,
        },
      },
      { new: true, runValidators: true }
    );

    if (!updated) {
      req.session.flash = {
        type: 'error',
        msg: 'Published and paid slips are locked. Retract the slip to draft to edit it.',
      };
      return res.redirect(`/admin/salaries/${salary._id}/slip`);
    }

    await AuditLog.create({
      admin:     req.session.user?._id,
      adminName: req.session.user?.displayName || req.session.user?.username,
      action: 'salary_update',
      targetType: 'salary',
      targetId: updated._id,
      targetLabel: `${updated.month}/${updated.year}`,
      meta: { month: updated.month, year: updated.year },
    });

    req.session.flash = { type: 'success', msg: 'Salary updated successfully.' };
    res.redirect(`/admin/salaries/${updated._id}/edit`);
  } catch (err) {
    console.error('[salary] update error:', err);
    req.session.flash = { type: 'error', msg: 'Failed to save salary.' };
    res.redirect(`/admin/salaries/${req.params.id}/edit`);
  }
};

/* ══════════════════════════════════════════════════════════════
   BULK UPDATE  POST /admin/salaries/bulk-update
   Atomically saves multiple draft salary slips from the bulk-edit
   walkthrough flow. Body: { month, year, items: [{id, updatedAt, fields}] }

   Atomicity strategy:
     1. Attempt a Mongoose session transaction (requires replica set).
     2. If the deployment is a standalone MongoDB instance, catch the
        unsupported-transaction error and fall back to sequential saves
        after full pre-validation (validation is always done first so
        no partial writes occur due to a validation failure).
══════════════════════════════════════════════════════════════ */
exports.salaryBulkUpdate = async (req, res) => {
  try {
    const { month: rawMonth, year: rawYear, items } = req.body;

    // ── 1. Basic input validation ──────────────────────────────
    const month = parseInt(rawMonth, 10);
    const year  = parseInt(rawYear,  10);
    if (isNaN(month) || month < 1 || month > 12 || isNaN(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ ok: false, message: 'Invalid month or year.' });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, message: 'No items provided.' });
    }

    // Validate every id is a proper ObjectId
    const invalidIds = items.filter(item => !mongoose.Types.ObjectId.isValid(item?.id));
    if (invalidIds.length > 0) {
      return res.status(400).json({ ok: false, message: `Invalid salary ID(s) in request.` });
    }

    // ── 2. Load all requested salaries in one query ────────────
    const requestedIds = items.map(item => item.id);
    const salaries = await Salary.find({ _id: { $in: requestedIds } }).populate('teacher', 'displayName');

    // Build a map for fast lookup
    const salaryMap = new Map(salaries.map(s => [s._id.toString(), s]));

    // ── 3. Pre-validate all slips before touching anything ─────
    const errors = [];
    const conflictIds = [];
    for (const item of items) {
      const salary = salaryMap.get(item.id);
      if (!salary) {
        errors.push(`Salary slip not found: ${item.id}`);
        conflictIds.push(item.id);
        continue;
      }
      let hasConflict = false;
      if (salary.month !== month || salary.year !== year) {
        errors.push(`Slip for ${salary.teacher?.displayName || item.id} does not belong to ${month}/${year}.`);
        hasConflict = true;
      }
      if (salary.status !== 'draft') {
        errors.push(`Slip for ${salary.teacher?.displayName || item.id} is no longer in draft status (status: ${salary.status}). Please refresh and check.`);
        hasConflict = true;
      }
      // Optimistic concurrency: compare updatedAt timestamps
      const dbUpdatedAt  = salary.updatedAt instanceof Date ? salary.updatedAt.toISOString() : new Date(salary.updatedAt).toISOString();
      const sentUpdatedAt = item.updatedAt;
      if (dbUpdatedAt !== sentUpdatedAt) {
        errors.push(`Slip for ${salary.teacher?.displayName || item.id} has been modified by another admin. Please refresh and review.`);
        hasConflict = true;
      }
      if (hasConflict) {
        conflictIds.push(item.id);
      }
    }

    if (errors.length > 0) {
      return res.status(409).json({ ok: false, message: errors.join(' | '), conflictIds });
    }

    // ── 4. Apply fields to all salary docs (in memory) ────────
    for (const item of items) {
      const salary = salaryMap.get(item.id);
      applySalaryFields(salary, item.fields || {});
      salary.recompute();
    }

    // ── 5. Save — attempt transaction, fall back to sequential ─
    const savedIds = requestedIds;
    let usedTransaction = false;

    try {
      const session = await mongoose.startSession();
      try {
        session.startTransaction();
        for (const item of items) {
          await salaryMap.get(item.id).save({ session });
        }
        await session.commitTransaction();
        usedTransaction = true;
      } catch (txErr) {
        await session.abortTransaction();
        throw txErr;
      } finally {
        session.endSession();
      }
    } catch (txErr) {
      // Check if the error is due to lack of replica set / transaction support
      const isTxUnsupported = /Transaction numbers are only allowed/.test(txErr.message) ||
                              /transactions are not supported/.test(txErr.message) ||
                              txErr.codeName === 'OperationNotSupportedInTransaction' ||
                              txErr.code === 20;
      if (isTxUnsupported) {
        // Fallback: sequential saves after full pre-validation (already done above)
        for (const item of items) {
          await salaryMap.get(item.id).save();
        }
        usedTransaction = false;
      } else {
        throw txErr; // Re-throw unexpected errors
      }
    }

    // ── 6. Single audit log entry ──────────────────────────────
    await AuditLog.create({
      admin:      req.session.user?._id,
      adminName:  req.session.user?.displayName || req.session.user?.username,
      action:     'salary_bulk_update',
      targetType: 'salary',
      targetLabel: `${month}/${year}`,
      meta: {
        month,
        year,
        count:     items.length,
        salaryIds: savedIds,
        atomic:    usedTransaction ? 'transaction' : 'sequential-after-validation',
      },
    });

    const pad = (n) => String(n).padStart(2, '0');
    const monthStr = `${year}-${pad(month)}`;
    req.session.flash = {
      type: 'success',
      msg:  `Saved ${items.length} salary slip${items.length !== 1 ? 's' : ''}.`,
      savedIds,
      monthStr,
    };

    return res.json({ ok: true, saved: items.length, savedIds, monthStr });
  } catch (err) {
    console.error('[salary] bulkUpdate error:', err);
    return res.status(500).json({ ok: false, message: 'Failed to save salaries.' });
  }
};

/* ══════════════════════════════════════════════════════════════
   RETRACT  POST /admin/salaries/:id/retract
   Moves a published / paid slip back to draft so the admin
   can correct it before re-sending.
══════════════════════════════════════════════════════════════ */
exports.salaryRetract = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      req.session.flash = { type: 'error', msg: 'Invalid salary record ID.' };
      return res.redirect('/admin/salaries');
    }

    // Atomic retraction: published -> draft only
    const updated = await Salary.findOneAndUpdate(
      buildRetractFilter(req.params.id),
      {
        $set: {
          status: 'draft',
          publishedAt: null,
          paidAt: null,
          paidBy: null,
          paymentNote: '',
        },
      },
      { new: true }
    ).populate('teacher', 'displayName username');

    if (!updated) {
      const existing = await Salary.findById(req.params.id);
      if (!existing) {
        req.session.flash = { type: 'error', msg: 'Salary record not found.' };
        return res.redirect('/admin/salaries');
      }

      if (existing.status === 'paid') {
        req.session.flash = {
          type: 'error',
          msg: 'Paid slips cannot be retracted. Reopen the payment first.',
        };
        return res.redirect(`/admin/salaries?month=${existing.year}-${String(existing.month).padStart(2,'0')}`);
      }

      if (existing.status === 'draft') {
        req.session.flash = {
          type: 'error',
          msg: 'This slip is already a draft — nothing to retract.',
        };
        return res.redirect(`/admin/salaries?month=${existing.year}-${String(existing.month).padStart(2,'0')}`);
      }

      req.session.flash = { type: 'error', msg: 'Failed to retract salary slip.' };
      return res.redirect('/admin/salaries');
    }

    // Clean up published notification so teacher doesn't have broken link
    await notificationService.removeSalaryNotification(updated._id);

    await AuditLog.create({
      admin:      req.session.user?._id,
      adminName:  req.session.user?.displayName || req.session.user?.username,
      action:     'salary_update',
      targetType: 'salary',
      targetId:   updated._id,
      targetLabel: `${updated.month}/${updated.year}`,
      meta: { retracted: true, prevStatus: 'published', teacher: updated.teacher?.displayName },
    });

    const teacherName = updated.teacher?.displayName || 'Teacher';
    req.session.flash = {
      type: 'success',
      msg:  `${teacherName}'s slip has been retracted back to draft.`,
    };
    res.redirect(`/admin/salaries?month=${updated.year}-${String(updated.month).padStart(2,'0')}`);
  } catch (err) {
    console.error('[salary] retract error:', err);
    req.session.flash = { type: 'error', msg: 'Failed to retract salary slip.' };
    res.redirect('/admin/salaries');
  }
};


/* ══════════════════════════════════════════════════════════════
   MARK AS PAID  POST /admin/salaries/mark-paid
   Atomically marks one or many published salary slips as paid.
══════════════════════════════════════════════════════════════ */
exports.salaryMarkPaid = async (req, res) => {
  try {
    const { ids: rawIds, paidAt, note, month, year } = req.body;
    let ids = rawIds;
    if (typeof ids === 'string') {
      ids = ids.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (!Array.isArray(ids) || ids.length === 0) {
      const msg = 'Please select at least one salary slip.';
      if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
        return res.status(400).json({ ok: false, error: msg });
      }
      req.session.flash = { type: 'error', msg };
      return res.redirect('/admin/salaries');
    }

    const validIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id)).slice(0, 200);
    if (validIds.length === 0) {
      const msg = 'No valid salary slip IDs provided.';
      if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
        return res.status(400).json({ ok: false, error: msg });
      }
      req.session.flash = { type: 'error', msg };
      return res.redirect('/admin/salaries');
    }

    const paidAtStr = paidAt && String(paidAt).trim() ? String(paidAt).trim() : getJakartaDateString(new Date());

    const slips = await Salary.find({ _id: { $in: validIds } }).populate('teacher', 'displayName username');
    const plan = planMarkPaid({ slips, paidAtStr, note, now: new Date() });

    if (!plan.validDate) {
      if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
        return res.status(400).json({ ok: false, error: plan.dateError });
      }
      req.session.flash = { type: 'error', msg: plan.dateError };
      return res.redirect('/admin/salaries');
    }

    const eligibleIds = plan.eligible.map(s => s._id);
    let markedCount = 0;

    if (eligibleIds.length > 0) {
      await Salary.updateMany(
        buildMarkPaidFilter(eligibleIds),
        {
          $set: {
            status: 'paid',
            paidAt: plan.paidAtNoonDate,
            paidBy: req.session.user?._id,
            paymentNote: (note || '').trim().slice(0, 200),
          },
        }
      );

      // Notify only the slips that were actually changed by the update
      const updatedSlips = await Salary.find({
        _id: { $in: eligibleIds },
        status: 'paid',
        paidAt: plan.paidAtNoonDate,
      }).populate('teacher', 'displayName username');

      markedCount = updatedSlips.length;

      for (const s of updatedSlips) {
        try {
          await notificationService.notifySalaryPaid(s, s.teacher);
        } catch (notifErr) {
          console.error('[salary] Failed to send salary paid notification:', notifErr);
        }
      }

      const sampleSlip = updatedSlips[0] || plan.eligible[0];
      await AuditLog.create({
        admin:     req.session.user?._id,
        adminName: req.session.user?.displayName || req.session.user?.username,
        action:    'salary_mark_paid',
        targetType: 'salary',
        targetLabel: sampleSlip ? `${sampleSlip.month}/${sampleSlip.year}` : '',
        meta: {
          month: sampleSlip ? sampleSlip.month : (month ? parseInt(month, 10) : null),
          year:  sampleSlip ? sampleSlip.year  : (year  ? parseInt(year, 10)  : null),
          count: markedCount,
          ids:   updatedSlips.map(s => s._id),
          paidAt: paidAtStr,
        },
      });
    }

    let msg = `Marked ${markedCount} salary slip${markedCount !== 1 ? 's' : ''} as paid.`;
    if (plan.skipped.length > 0) {
      const skippedSummary = plan.skipped.map(s => {
        let reasonLabel = s.reason;
        if (s.reason === 'already_paid') reasonLabel = 'already paid';
        else if (s.reason === 'not_published') reasonLabel = 'not published';
        else if (s.reason === 'before_published_date') reasonLabel = 'date before published';
        return `${s.name} (${reasonLabel})`;
      }).join(', ');
      msg += ` Skipped ${plan.skipped.length}: ${skippedSummary}.`;
    }

    if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.json({
        ok: true,
        markedCount,
        skippedCount: plan.skipped.length,
        skipped: plan.skipped,
        message: msg,
      });
    }

    const redirectMonth = month && year ? `?month=${year}-${String(month).padStart(2,'0')}` : '';
    req.session.flash = {
      type: markedCount > 0 ? 'success' : 'error',
      msg,
    };
    return res.redirect(`/admin/salaries${redirectMonth}`);
  } catch (err) {
    console.error('[salary] mark-paid error:', err);
    if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.status(500).json({ ok: false, error: 'Failed to mark salary as paid.' });
    }
    req.session.flash = { type: 'error', msg: 'Failed to mark salary as paid.' };
    return res.redirect('/admin/salaries');
  }
};

/* ══════════════════════════════════════════════════════════════
   REOPEN PAYMENT  POST /admin/salaries/:id/reopen
   Atomically reopens a paid slip back to published.
══════════════════════════════════════════════════════════════ */
exports.salaryReopen = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      const msg = 'Invalid salary record ID.';
      if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
        return res.status(400).json({ ok: false, error: msg });
      }
      req.session.flash = { type: 'error', msg };
      return res.redirect('/admin/salaries');
    }

    const { reason } = req.body;
    const cleanReason = (reason || '').trim();
    if (!cleanReason || cleanReason.length < 5 || cleanReason.length > 200) {
      const msg = 'Reopen reason is required (5-200 characters).';
      if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
        return res.status(400).json({ ok: false, error: msg });
      }
      req.session.flash = { type: 'error', msg };
      return res.redirect('/admin/salaries');
    }

    const reopenedAt = new Date();
    // Atomic status transition: paid -> published
    const updated = await Salary.findOneAndUpdate(
      buildReopenFilter(req.params.id),
      {
        $set: {
          status: 'published',
          paidAt: null,
          paidBy: null,
          paymentNote: '',
          reopenedAt,
          reopenedBy: req.session.user?._id,
          reopenReason: cleanReason,
        },
      },
      { new: true }
    ).populate('teacher', 'displayName username');

    if (!updated) {
      const existing = await Salary.findById(req.params.id);
      let msg = 'Salary record not found.';
      if (existing) {
        msg = existing.status === 'published'
          ? 'This slip is already published (not paid).'
          : 'Only paid slips can be reopened.';
      }
      if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
        return res.status(400).json({ ok: false, error: msg });
      }
      req.session.flash = { type: 'error', msg };
      return res.redirect('/admin/salaries');
    }

    // Remove the teacher's "paid" notification
    await notificationService.removeSalaryPaidNotification(updated._id);

    await AuditLog.create({
      admin:     req.session.user?._id,
      adminName: req.session.user?.displayName || req.session.user?.username,
      action:    'salary_reopen',
      targetType: 'salary',
      targetId:  updated._id,
      targetLabel: `${updated.month}/${updated.year}`,
      meta: {
        id: updated._id,
        reason: cleanReason,
        month: updated.month,
        year: updated.year,
      },
    });

    const teacherName = updated.teacher?.displayName || 'Teacher';
    const successMsg = `${teacherName}'s payment has been reopened to published.`;

    if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.json({ ok: true, message: successMsg });
    }

    req.session.flash = { type: 'success', msg: successMsg };
    return res.redirect(`/admin/salaries?month=${updated.year}-${String(updated.month).padStart(2,'0')}`);
  } catch (err) {
    console.error('[salary] reopen error:', err);
    if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.status(500).json({ ok: false, error: 'Failed to reopen salary.' });
    }
    req.session.flash = { type: 'error', msg: 'Failed to reopen salary.' };
    return res.redirect('/admin/salaries');
  }
};

/* ══════════════════════════════════════════════════════════════
   SLIP VIEW  GET /admin/salaries/:id/slip
══════════════════════════════════════════════════════════════ */
exports.salarySlip = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).render('error', { message: 'Invalid salary record ID.' });
    }

    const salary = await Salary.findById(req.params.id).populate('teacher');
    if (!salary) return res.status(404).render('error', { message: 'Salary record not found.' });

    // Pre-format all IDR values for the template
    const fmt = (v) => formatIDR(v);

    // ── Bulk-review flow ────────────────────────────────────────
    const isReview = req.query.flow === 'review';
    if (isReview) {
      const meta = getMonthMeta(req.query);
      const { year, month, selectedMonthStr } = meta;

      // All slips for the month, sorted by teacher name (table order)
      const allSalaries = await Salary.find({ year, month })
        .populate('teacher', 'displayName')
        .lean();
      allSalaries.sort((a, b) =>
        (a.teacher?.displayName || '').localeCompare(b.teacher?.displayName || ''));

      // Optional ?ids=a,b,c filter to limit review to specific slips
      let reviewList = allSalaries;
      const idsQuery = req.query.ids || '';
      if (idsQuery) {
        const allowedIds = idsQuery.split(',').map(s => s.trim()).filter(Boolean);
        reviewList = allSalaries.filter(s => allowedIds.includes(s._id.toString()));
      }

      const currentIndex = reviewList.findIndex(s => s._id.toString() === salary._id.toString());
      if (currentIndex === -1) {
        // Slip not in review scope — redirect to first in list or index
        const first = reviewList[0];
        if (first) {
          return res.redirect(
            `/admin/salaries/${first._id}/slip?flow=review&month=${selectedMonthStr}` +
            (idsQuery ? `&ids=${encodeURIComponent(idsQuery)}` : '')
          );
        }
        return res.redirect(`/admin/salaries?month=${selectedMonthStr}`);
      }

      return res.render('admin/salaries/slip', {
        salary,
        teacher:      salary.teacher,
        fmt,
        printMode:    req.query.print === '1',
        // Review-flow extras
        flow:         'review',
        reviewList:   reviewList.map(s => ({
          id:          s._id.toString(),
          teacherName: s.teacher?.displayName || 'Unknown',
        })),
        currentIndex,
        totalCount:   reviewList.length,
        monthStr:     selectedMonthStr,
        idsQuery,
      });
    }

    // ── Normal single-slip view ─────────────────────────────────
    res.render('admin/salaries/slip', {
      salary, teacher: salary.teacher, fmt,
      printMode: req.query.print === '1',
      flow:      null,
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

    // Sort alphabetically by teacher display name
    salaries.sort((a, b) => (a.teacher?.displayName || '').localeCompare(b.teacher?.displayName || ''));

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
      { header: 'Status',          key: 'status',       width: 12 },
      { header: 'Published at',    key: 'publishedAt',  width: 16 },
      { header: 'Paid at',         key: 'paidAt',       width: 16 },
      { header: 'Payment note',    key: 'paymentNote',  width: 24 },
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
        publishedAt: s.publishedAt ? formatDisplayDate(s.publishedAt) : '—',
        paidAt:      s.paidAt ? formatDisplayDate(s.paidAt) : '—',
        paymentNote: s.paymentNote || '—',
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
