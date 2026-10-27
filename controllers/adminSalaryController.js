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

    // Entry-point IDs for the two new walkthrough buttons
    const draftSlips     = salaries.filter(s => s.status === 'draft');
    const firstDraftId   = draftSlips.length   > 0 ? draftSlips[0]._id.toString()  : null;
    const firstRowId     = salaries.length      > 0 ? salaries[0]._id.toString()    : null;

    const flash = req.session.flash || null;
    delete req.session.flash;

    const activeTeachers = await User.find({ role: 'teacher' }).select('displayName username commission').lean();
    const teachersWithoutRewards = getTeachersWithoutRewards(activeTeachers);

    res.render('admin/salaries/index', {
      rows, year, month,
      monthLabel, prevMonth, nextMonth, isCurrentMonth, selectedMonthStr,
      totalGross:      formatIDR(totalGross),
      totalDeductions: formatIDR(totalDeductions),
      totalNet:        formatIDR(totalNet),
      draftCount, publishedCount,
      totalTeachers:   rows.length,
      flash,
      firstDraftId,
      firstRowId,
      teachersWithoutRewards,
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

    const activeTeachers = await User.find({ role: 'teacher' }).select('displayName username commission').lean();
    const withoutRewards = getTeachersWithoutRewards(activeTeachers);

    let flashMsg = `Generated ${saved.length} salary drafts for ${pl}.`;
    if (withoutRewards.count > 0) {
      flashMsg += ` Note: ${withoutRewards.count} teacher${withoutRewards.count > 1 ? 's have' : ' has'} no reward amounts set.`;
    }

    req.session.flash = { type: 'success', msg: flashMsg };
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
    req.session.flash = { type: 'error', msg: 'Failed to publish salaries: ' + err.message };
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

    // Use the shared helper (identical parsing/clamping as before — behavior unchanged)
    applySalaryFields(salary, req.body);

    // Recompute totals
    salary.recompute();
    await salary.save();

    await AuditLog.create({
      admin:     req.session.user?._id,
      adminName: req.session.user?.displayName || req.session.user?.username,
      action: 'salary_update',
      targetType: 'salary',
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
    return res.status(500).json({ ok: false, message: 'Failed to save salaries: ' + err.message });
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

    const salary = await Salary.findById(req.params.id).populate('teacher', 'displayName');
    if (!salary) {
      req.session.flash = { type: 'error', msg: 'Salary record not found.' };
      return res.redirect('/admin/salaries');
    }

    if (salary.status === 'draft') {
      req.session.flash = { type: 'error', msg: 'This slip is already a draft — nothing to retract.' };
      return res.redirect(`/admin/salaries?month=${salary.year}-${String(salary.month).padStart(2,'0')}`);
    }

    const prevStatus = salary.status;
    salary.status      = 'draft';
    salary.publishedAt = null;
    salary.paidAt      = null;
    await salary.save();

    // Clean up published notification so teacher doesn't have broken link
    await notificationService.removeSalaryNotification(salary._id);

    await AuditLog.create({
      admin:      req.session.user?._id,
      adminName:  req.session.user?.displayName || req.session.user?.username,
      action:     'salary_update',
      targetType: 'salary',
      targetId:   salary._id,
      targetLabel: `${salary.month}/${salary.year}`,
      meta: { retracted: true, prevStatus, teacher: salary.teacher?.displayName },
    });

    const teacherName = salary.teacher?.displayName || 'Teacher';
    req.session.flash = {
      type: 'success',
      msg:  `${teacherName}'s slip has been retracted back to draft.`,
    };
    res.redirect(`/admin/salaries?month=${salary.year}-${String(salary.month).padStart(2,'0')}`);
  } catch (err) {
    console.error('[salary] retract error:', err);
    req.session.flash = { type: 'error', msg: 'Failed to retract salary: ' + err.message };
    res.redirect('/admin/salaries');
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
