'use strict';
/**
 * salaryService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * CV Fond of English — Payroll Calculation & Stage Intelligence Engine
 *
 * Responsibilities:
 *   1. Compute teacher tenure (months) relative to a cut-off date.
 *   2. Auto-detect distinct teaching days from Reports within a period.
 *   3. Auto-calculate teaching reward from Reports × commission rates.
 *   4. Apply stage-unlock rules (e.g. positionAllowance after N months).
 *   5. Generate / sync one or all salary draft records for a given period.
 *
 * IMPORTANT: Every generated value is merely a *pre-fill suggestion*.
 *            Admin can override any field before publishing.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const User   = require('../models/User');
const Report = require('../models/Report');
const Salary = require('../models/Salary');

/* ══════════════════════════════════════════════════════════════
   1. UTILITY HELPERS
══════════════════════════════════════════════════════════════ */

/**
 * Compute tenure in whole months between joinDate and a reference date.
 * Returns 0 if joinDate is missing.
 */
function tenureMonths(joinDate, referenceDate) {
  if (!joinDate) return 0;
  const jd  = new Date(joinDate);
  const ref = new Date(referenceDate);
  return Math.max(
    0,
    (ref.getFullYear() - jd.getFullYear()) * 12 + (ref.getMonth() - jd.getMonth())
  );
}

/**
 * Format tenure months as a human-readable string, e.g. "10 months" / "1yr 2mo".
 */
function formatTenure(months) {
  if (months <= 0) return '< 1 month';
  const yrs = Math.floor(months / 12);
  const mos = months % 12;
  if (yrs === 0) return `${mos} month${mos !== 1 ? 's' : ''}`;
  if (mos === 0) return `${yrs} year${yrs !== 1 ? 's' : ''}`;
  return `${yrs}yr ${mos}mo`;
}

/**
 * Build periodLabel string from start + end dates.
 * e.g. "26 Jul – 25 Aug 2026"
 */
function buildPeriodLabel(start, end) {
  const opts = { day: 'numeric', month: 'short' };
  const s = new Date(start).toLocaleDateString('en-GB', opts);
  const e = new Date(end).toLocaleDateString('en-GB', { ...opts, year: 'numeric' });
  return `${s} – ${e}`;
}

/* ══════════════════════════════════════════════════════════════
   2. REPORT-DATA HELPERS
══════════════════════════════════════════════════════════════ */

/**
 * Returns a map of { teacherId → { typeName → sessionCount } }
 * for all reports within [periodStart, periodEnd].
 */
async function buildSessionMap(periodStart, periodEnd) {
  const agg = await Report.aggregate([
    { $match: { date: { $gte: new Date(periodStart), $lte: new Date(periodEnd) } } },
    { $group: {
      _id:      { teacher: '$teacher', teaching_type: '$teaching_type' },
      sessions: { $sum: 1 },
    }},
  ]);

  const map = {};
  for (const row of agg) {
    const tid  = String(row._id.teacher);
    const type = row._id.teaching_type;
    if (!map[tid]) map[tid] = {};
    map[tid][type] = (map[tid][type] || 0) + row.sessions;
  }
  return map;
}

/**
 * Returns a map of { teacherId → distinctDays }
 * Counts the number of unique teaching dates in the period.
 */
async function buildDistinctDaysMap(periodStart, periodEnd) {
  const agg = await Report.aggregate([
    { $match: { date: { $gte: new Date(periodStart), $lte: new Date(periodEnd) } } },
    { $group: {
      _id: {
        teacher: '$teacher',
        // Normalise to YYYY-MM-DD so time zone shifts don't double-count
        date: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
      },
    }},
    { $group: {
      _id:          '$_id.teacher',
      distinctDays: { $sum: 1 },
    }},
  ]);

  const map = {};
  for (const row of agg) {
    map[String(row._id)] = row.distinctDays;
  }
  return map;
}

/**
 * Calculate total teaching reward for one teacher given their session counts
 * and their commission rates.
 * Returns 0 if no sessions or rates are 0.
 */
function calcTeachingReward(sessionMap, teacher) {
  const tid     = String(teacher._id);
  const sessions = sessionMap[tid] || {};
  const comm    = teacher.commission || {};

  const rateMap = {
    'Prime Teacher (Full)':     comm.primeFull     || 0,
    'Prime Teacher (Assisted)': comm.primeAssisted || 0,
    '1/2 Prime Teacher':        comm.halfPrime     || 0,
    'Assistant Teacher':        comm.assistant     || 0,
  };

  return Object.entries(sessions).reduce((total, [type, count]) => {
    return total + count * (rateMap[type] || 0);
  }, 0);
}

/* ══════════════════════════════════════════════════════════════
   3. CORE: generateSalariesForPeriod
      Creates or refreshes Salary drafts for all teachers.
      Existing draft fields set by admin are preserved.
══════════════════════════════════════════════════════════════ */

/**
 * @param {Object} opts
 * @param {number}      opts.month        1–12
 * @param {number}      opts.year         e.g. 2026
 * @param {Date|string} opts.periodStart  cut-off start
 * @param {Date|string} opts.periodEnd    cut-off end
 * @param {Date|string} [opts.payDate]    payout date (default = periodEnd)
 * @param {string}      [opts.payDateLabel] e.g. "26-Aug"
 * @param {string}      [opts.periodLabel]  custom label; auto-built if omitted
 * @param {boolean}     [opts.preserveEdits=true]
 *                      If true, admin-touched fields in existing drafts are kept.
 *                      If false, all fields are overwritten from defaults.
 * @returns {Promise<Salary[]>} array of saved salary documents
 */
async function generateSalariesForPeriod(opts) {
  const {
    month, year,
    periodStart, periodEnd,
    payDate,
    payDateLabel = '',
    periodLabel  = buildPeriodLabel(periodStart, periodEnd),
    preserveEdits = true,
  } = opts;

  const ps = new Date(periodStart);
  const pe = new Date(periodEnd);
  const pd = payDate ? new Date(payDate) : pe;

  // Fetch all teachers with their salary profile + commission rates
  const teachers = await User.find({ role: 'teacher' }).sort({ displayName: 1 });

  // Pre-compute shared report data with a single aggregation each
  const [sessionMap, daysMap] = await Promise.all([
    buildSessionMap(ps, pe),
    buildDistinctDaysMap(ps, pe),
  ]);

  const saved = [];

  for (const teacher of teachers) {
    const sp   = teacher.salaryProfile || {};
    const tid  = String(teacher._id);

    // Tenure at period end
    const tenure    = tenureMonths(teacher.joinDate, pe);
    const tenureStr = formatTenure(tenure);

    // Stage checks (soft suggestions — admin can always override)
    const positionMonthsRequired = sp.positionAllowanceMonthsRequired ?? 3;
    const rewardMonthsRequired   = sp.teachingRewardMonthsRequired    ?? 6;
    const positionEligible       = tenure >= positionMonthsRequired;
    const rewardEligible         = tenure >= rewardMonthsRequired;

    // Auto-values
    const distinctDays    = daysMap[tid] || 0;
    const teachingReward  = rewardEligible ? calcTeachingReward(sessionMap, teacher) : 0;
    const mealFullRate    = sp.mealRateFull  || 22500;
    const transportRate   = sp.transportRate || 22500;

    // Try to find an existing record
    let salary = await Salary.findOne({ teacher: teacher._id, year, month });

    if (salary && preserveEdits) {
      // Only refresh auto-calculated fields; don't overwrite admin edits.
      // We update: tenure snapshot, teachingReward, distinctDays suggestions
      // but we do NOT overwrite fields the admin may have manually adjusted.
      salary.teacherTenureAtPeriod = tenureStr;
      salary.periodLabel  = periodLabel;
      salary.periodStart  = ps;
      salary.periodEnd    = pe;
      salary.payDate      = pd;
      salary.payDateLabel = payDateLabel;

      // ── Sync attendance days from live report data ──
      // We refresh the day COUNTS from reports but keep whatever rate the admin set.
      const existingMealRate      = salary.mealFullRate  || mealFullRate;
      const existingTransportRate = salary.transportRate  || transportRate;
      salary.mealFullDays   = distinctDays;
      salary.mealFullRate   = existingMealRate;
      salary.mealFullTotal  = distinctDays * existingMealRate;
      salary.transportDays  = distinctDays;
      salary.transportRate  = existingTransportRate;
      salary.transportTotal = distinctDays * existingTransportRate;

      // ── Sync teaching reward ──
      if (!salary._adminOverriddenTeachingReward) {
        salary.teachingReward = teachingReward;
      }
    } else {
      // Create fresh draft from defaults
      const baseData = {
        teacher:       teacher._id,
        month, year,
        periodLabel, periodStart: ps, periodEnd: pe,
        payDate: pd, payDateLabel,
        teacherTenureAtPeriod: tenureStr,
        status: 'draft',

        // Earnings — from salaryProfile defaults
        basicSalary:        sp.basicSalary        || 0,
        monthlyIncentive:   sp.monthlyIncentive   || 0,
        healthAllowance:    sp.healthAllowance     || 0,
        positionAllowance:  positionEligible ? (sp.positionAllowance || 0) : 0,
        loyaltyAllowance:   sp.loyaltyAllowance    || 0,
        wifeChildAllowance: sp.wifeChildAllowance  || 0,

        // Attendance — auto from reports
        mealFullDays:  distinctDays, mealFullRate,  mealFullTotal:  distinctDays * mealFullRate,
        mealHalfDays:  0,            mealHalfRate:  sp.mealRateHalf || 0, mealHalfTotal: 0,
        transportDays: distinctDays, transportRate, transportTotal: distinctDays * transportRate,

        teachingReward,
        gameReward:           0,
        studentCommission:    0,
        internetCompensation: 0,
        overtime:             0,
        otherIncomes:         [],

        // Deductions — from salaryProfile defaults
        instalment:             0,
        miscellaneousDeduction: 0,
        bpjsKetenagakerjaan:    sp.bpjsKetenagakerjaan || 0,
        tax:                    sp.tax                  || 0,
        otherDeductions:        [],
      };

      if (salary) {
        // preserveEdits = false: full overwrite of existing draft
        Object.assign(salary, baseData);
      } else {
        salary = new Salary(baseData);
      }
    }

    // Recompute all totals
    salary.recompute();
    await salary.save();
    saved.push(salary);
  }

  return saved;
}

/* ══════════════════════════════════════════════════════════════
   4. BULK PUBLISH — mark multiple salary records as published
══════════════════════════════════════════════════════════════ */

/**
 * Publish (send to teachers) all or selected salary drafts for a period.
 * @param {number} month
 * @param {number} year
 * @param {string[]|null} teacherIds  If null/empty → publish all in period
 * @returns {Promise<number>} count of published records
 */
async function publishSalaries(month, year, teacherIds = null) {
  const filter = { month, year, status: { $in: ['draft'] } };
  if (teacherIds && teacherIds.length) {
    filter.teacher = { $in: teacherIds };
  }

  const result = await Salary.updateMany(filter, {
    $set: { status: 'published', publishedAt: new Date() },
  });
  return result.modifiedCount || 0;
}

/* ══════════════════════════════════════════════════════════════
   5. RECOMPUTE SINGLE SALARY — call after admin edits
══════════════════════════════════════════════════════════════ */

/**
 * Load a salary by ID, recompute totals, and save.
 * @param {string} salaryId
 * @returns {Promise<Salary>}
 */
async function recomputeAndSave(salaryId) {
  const salary = await Salary.findById(salaryId);
  if (!salary) throw new Error(`Salary ${salaryId} not found.`);
  salary.recompute();
  await salary.save();
  return salary;
}

/* ══════════════════════════════════════════════════════════════
   EXPORTS
══════════════════════════════════════════════════════════════ */
module.exports = {
  tenureMonths,
  formatTenure,
  buildPeriodLabel,
  generateSalariesForPeriod,
  publishSalaries,
  recomputeAndSave,
};
