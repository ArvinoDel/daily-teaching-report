'use strict';
/**
 * reportGapService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detection service for "possible missing reports" (heuristic alerts for admins).
 *
 * NOTE: There is no teaching schedule in the system, so all detection is heuristic
 * and must always be worded as "possible".
 *
 * Detectors:
 *   1. teacher_day: usual weekday missed inside lookback window up to yesterday
 *   2. teacher_silent: >= 8 reports in last 8 weeks, 0 in last 10 days
 *   3. group_silent: >= 3 reports in last 8 weeks, 0 in last 10 days (competitions excluded)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const User = require('../models/User');
const Report = require('../models/Report');
const ReportGapAck = require('../models/ReportGapAck');
const NoClassDate = require('../models/NoClassDate');

/* ══════════════════════════════════════════════════════════════
   1. THRESHOLDS & CONFIGURATION
══════════════════════════════════════════════════════════════ */

const DEFAULT_CONFIG = Object.freeze({
  PATTERN_WEEKS: 8,
  PATTERN_MIN_WEEKS: 4,
  LOOKBACK_DAYS: 14,
  SILENT_DAYS: 10,
  SILENT_TEACHER_MIN_REPORTS: 8,
  SILENT_GROUP_MIN_REPORTS: 3,
});

function getConfig(overrides = {}) {
  return {
    PATTERN_WEEKS: Number(process.env.REPORT_GAP_PATTERN_WEEKS || overrides.PATTERN_WEEKS || DEFAULT_CONFIG.PATTERN_WEEKS),
    PATTERN_MIN_WEEKS: Number(process.env.REPORT_GAP_PATTERN_MIN_WEEKS || overrides.PATTERN_MIN_WEEKS || DEFAULT_CONFIG.PATTERN_MIN_WEEKS),
    LOOKBACK_DAYS: Number(process.env.REPORT_GAP_LOOKBACK_DAYS || overrides.LOOKBACK_DAYS || DEFAULT_CONFIG.LOOKBACK_DAYS),
    SILENT_DAYS: Number(process.env.REPORT_GAP_SILENT_DAYS || overrides.SILENT_DAYS || DEFAULT_CONFIG.SILENT_DAYS),
    SILENT_TEACHER_MIN_REPORTS: Number(process.env.REPORT_GAP_SILENT_TEACHER_MIN_REPORTS || overrides.SILENT_TEACHER_MIN_REPORTS || DEFAULT_CONFIG.SILENT_TEACHER_MIN_REPORTS),
    SILENT_GROUP_MIN_REPORTS: Number(process.env.REPORT_GAP_SILENT_GROUP_MIN_REPORTS || overrides.SILENT_GROUP_MIN_REPORTS || DEFAULT_CONFIG.SILENT_GROUP_MIN_REPORTS),
  };
}

/* ══════════════════════════════════════════════════════════════
   2. DATE & TIMEZONE HELPERS (Asia/Jakarta)
══════════════════════════════════════════════════════════════ */

const APP_TIMEZONE = 'Asia/Jakarta';

/**
 * Format a Date object into YYYY-MM-DD in Asia/Jakarta.
 */
function toLocalDateStr(date) {
  if (!date) return '';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * Get weekday name in Asia/Jakarta (e.g. "Monday", "Wednesday").
 */
function getLocalWeekday(date) {
  const d = new Date(date);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIMEZONE,
    weekday: 'long',
  }).format(d);
}

/**
 * Calendar day arithmetic on YYYY-MM-DD strings.
 */
function addDays(dateStr, days) {
  if (!dateStr || typeof dateStr !== 'string') return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days, 12, 0, 0));
  const yStr = dt.getUTCFullYear();
  const mStr = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dStr = String(dt.getUTCDate()).padStart(2, '0');
  return `${yStr}-${mStr}-${dStr}`;
}

/**
 * Difference in calendar days between dateStrA and dateStrB (A - B).
 */
function diffDays(dateStrA, dateStrB) {
  const [y1, m1, d1] = dateStrA.split('-').map(Number);
  const [y2, m2, d2] = dateStrB.split('-').map(Number);
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.round((t1 - t2) / (24 * 60 * 60 * 1000));
}

/**
 * Get English weekday name for a YYYY-MM-DD string.
 */
function getWeekdayName(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(dt);
}

/**
 * Pure helper to build the atomic claim filter for a 24-hour reminder throttle.
 */
function buildReportGapReminderClaimFilter({ userId, cutoff }) {
  return {
    _id: userId,
    $or: [
      { 'reportGapReminders.lastSentAt': { $exists: false } },
      { 'reportGapReminders.lastSentAt': null },
      { 'reportGapReminders.lastSentAt': { $lte: cutoff } },
    ],
  };
}

/**
 * Build the single MongoDB aggregation pipeline for reports.
 */
function buildAggregationPipeline(minDate) {
  return [
    {
      $match: {
        date: { $gte: minDate },
      },
    },
    {
      $facet: {
        teacherReports: [
          {
            $project: {
              teacher: 1,
              localDate: {
                $dateToString: {
                  format: '%Y-%m-%d',
                  date: '$date',
                  timezone: APP_TIMEZONE,
                },
              },
            },
          },
          {
            $group: {
              _id: {
                teacher: '$teacher',
                localDate: '$localDate',
              },
              count: { $sum: 1 },
            },
          },
        ],
        classReports: [
          {
            $match: {
              session_type: { $ne: 'competition' },
              class_name: { $exists: true, $ne: '' },
            },
          },
          {
            $project: {
              class_name: 1,
              localDate: {
                $dateToString: {
                  format: '%Y-%m-%d',
                  date: '$date',
                  timezone: APP_TIMEZONE,
                },
              },
            },
          },
          {
            $group: {
              _id: '$class_name',
              count: { $sum: 1 },
              lastDate: { $max: '$localDate' },
            },
          },
        ],
      },
    },
  ];
}

/* ══════════════════════════════════════════════════════════════
   3. PURE DETECTOR FUNCTION
══════════════════════════════════════════════════════════════ */

/**
 * Pure function: detect report gaps across all three detectors.
 *
 * @param {Object} params
 * @param {Array} params.teacherReports - Aggregated items: [{ teacher, localDate, count }, ...]
 * @param {Array} params.classReports - Aggregated items: [{ _id: className, count, lastDate }, ...]
 * @param {Array} params.teachers - Array of teacher docs / objects: [{ _id, displayName, username }, ...]
 * @param {Array} [params.noClassDates=[]] - Array of NoClassDate objects: [{ from, to, label }, ...]
 * @param {Array} [params.acks=[]] - Array of ReportGapAck objects: [{ kind, teacher, group, date }, ...]
 * @param {Object} [params.config={}] - Optional threshold overrides
 * @param {Date} [params.now=new Date()] - Evaluation reference time
 * @param {Date|string} [params.periodStart] - Optional restriction start date
 * @param {Date|string} [params.periodEnd] - Optional restriction end date
 * @returns {Object} Detected gaps and counts
 */
function detectReportGaps({
  teacherReports = [],
  classReports = [],
  teachers = [],
  noClassDates = [],
  acks = [],
  config: configOverrides = {},
  now = new Date(),
  periodStart = null,
  periodEnd = null,
}) {
  const cfg = getConfig(configOverrides);
  const todayStr = toLocalDateStr(now);

  // Teacher lookup map
  const teacherMap = new Map();
  teachers.forEach(t => {
    const id = String(t._id || t.id);
    teacherMap.set(id, t.displayName || t.username || 'Teacher');
  });

  // Acknowledgement lookup set
  const ackSet = new Set();
  acks.forEach(a => {
    const kind = a.kind || '';
    const teacherId = a.teacher ? String(a.teacher._id || a.teacher) : '';
    const group = a.group || '';
    const date = a.date || '';
    ackSet.add(`${kind}:${teacherId}:${group}:${date}`);
  });

  // Global no-class date checker
  function isNoClassDate(dateStr) {
    return noClassDates.some(n => {
      if (!n || !n.from || !n.to) return false;
      return dateStr >= n.from && dateStr <= n.to;
    });
  }

  // Pre-process teacher report data
  // teacherId -> { reportedDates: Set<dateStr>, totalReportsIn8Weeks: number, lastReportDate: string, reportedWeeksByWeekday: Map<weekday, Set<weekIndex>> }
  const teacherDataMap = new Map();

  function getOrCreateTeacherData(tid) {
    if (!teacherDataMap.has(tid)) {
      teacherDataMap.set(tid, {
        reportedDates: new Set(),
        totalReportsIn8Weeks: 0,
        lastReportDate: null,
        reportedWeeksByWeekday: new Map(),
      });
    }
    return teacherDataMap.get(tid);
  }

  // Ensure all registered teachers are in the map
  for (const tid of teacherMap.keys()) {
    getOrCreateTeacherData(tid);
  }

  // Populate from teacherReports aggregation
  for (const item of teacherReports) {
    const tid = String(item.teacher || item._id?.teacher || '');
    const d = item.localDate || item._id?.localDate || '';
    const cnt = Number(item.count || 1);
    if (!tid || !d) continue;

    const tData = getOrCreateTeacherData(tid);
    tData.reportedDates.add(d);

    // Update lastReportDate (most recent report date)
    if (!tData.lastReportDate || d > tData.lastReportDate) {
      tData.lastReportDate = d;
    }

    const daysAgo = diffDays(todayStr, d);

    // Check if within the 8 full weeks preceding today (daysAgo 1..56)
    if (daysAgo >= 1 && daysAgo <= cfg.PATTERN_WEEKS * 7) {
      tData.totalReportsIn8Weeks += cnt;
      const weekIdx = Math.floor((daysAgo - 1) / 7); // 0 to 7
      const weekday = getWeekdayName(d);

      if (!tData.reportedWeeksByWeekday.has(weekday)) {
        tData.reportedWeeksByWeekday.set(weekday, new Set());
      }
      tData.reportedWeeksByWeekday.get(weekday).add(weekIdx);
    }
  }

  /* ─────────────────────────────────────────────────────────────
     DETECTOR 1: teacher_day
     Lookback window: daysAgo 1 up to LOOKBACK_DAYS (never today).
  ───────────────────────────────────────────────────────────── */
  const teacherDayGaps = [];

  // Build lookback dates
  const lookbackDates = [];
  const pStartStr = periodStart ? (typeof periodStart === 'string' ? periodStart : toLocalDateStr(periodStart)) : null;
  const pEndStr   = periodEnd   ? (typeof periodEnd === 'string'   ? periodEnd   : toLocalDateStr(periodEnd))   : null;

  for (let i = 1; i <= cfg.LOOKBACK_DAYS; i++) {
    const checkDate = addDays(todayStr, -i);
    if (pStartStr && checkDate < pStartStr) continue;
    if (pEndStr && checkDate > pEndStr) continue;
    lookbackDates.push(checkDate);
  }

  for (const [tid, tData] of teacherDataMap.entries()) {
    const teacherName = teacherMap.get(tid) || 'Unknown';

    // Determine usual weekdays for this teacher
    const usualWeekdays = new Map(); // weekday -> weeksCount
    for (const [weekday, weekIndices] of tData.reportedWeeksByWeekday.entries()) {
      if (weekIndices.size >= cfg.PATTERN_MIN_WEEKS) {
        usualWeekdays.set(weekday, weekIndices.size);
      }
    }

    if (usualWeekdays.size === 0) continue;

    for (const checkDate of lookbackDates) {
      const weekday = getWeekdayName(checkDate);
      if (!usualWeekdays.has(weekday)) continue;

      // Did teacher report on this date?
      if (tData.reportedDates.has(checkDate)) continue;

      // Suppressed by global no-class date?
      if (isNoClassDate(checkDate)) continue;

      // Suppressed by acknowledgement?
      const ackKey = `teacher_day:${tid}::${checkDate}`;
      if (ackSet.has(ackKey)) continue;

      const weeksCount = usualWeekdays.get(weekday);
      teacherDayGaps.push({
        kind: 'teacher_day',
        teacherId: tid,
        teacherName,
        date: checkDate,
        weekday,
        evidence: `Usually reports on ${weekday}: ${weeksCount} of the last ${cfg.PATTERN_WEEKS} weeks`,
      });
    }
  }

  // Sort teacherDayGaps: most recent date first, then teacher name
  teacherDayGaps.sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return a.teacherName.localeCompare(b.teacherName);
  });

  /* ─────────────────────────────────────────────────────────────
     DETECTOR 2: teacher_silent
     Teachers with >= SILENT_TEACHER_MIN_REPORTS (8) in 8 weeks
     and zero in last SILENT_DAYS (10).
  ───────────────────────────────────────────────────────────── */
  const teacherSilentGaps = [];

  for (const [tid, tData] of teacherDataMap.entries()) {
    if (tData.totalReportsIn8Weeks < cfg.SILENT_TEACHER_MIN_REPORTS) continue;

    const teacherName = teacherMap.get(tid) || 'Unknown';
    let silenceDays = cfg.PATTERN_WEEKS * 7;
    let silent = false;

    if (!tData.lastReportDate) {
      silent = true;
    } else {
      const daysSinceLast = diffDays(todayStr, tData.lastReportDate);
      if (daysSinceLast >= cfg.SILENT_DAYS) {
        silent = true;
        silenceDays = daysSinceLast;
      }
    }

    if (silent) {
      // Check acknowledgement
      const ackKey = `teacher_silent:${tid}::`;
      if (!ackSet.has(ackKey)) {
        teacherSilentGaps.push({
          kind: 'teacher_silent',
          teacherId: tid,
          teacherName,
          lastReportDate: tData.lastReportDate,
          silenceDays,
          totalReports: tData.totalReportsIn8Weeks,
          evidence: `${tData.totalReportsIn8Weeks} reports in previous ${cfg.PATTERN_WEEKS} weeks, 0 in last ${silenceDays} days`,
        });
      }
    }
  }

  // Sort teacherSilentGaps: longest silence first, then teacher name
  teacherSilentGaps.sort((a, b) => {
    if (a.silenceDays !== b.silenceDays) return b.silenceDays - a.silenceDays;
    return a.teacherName.localeCompare(b.teacherName);
  });

  /* ─────────────────────────────────────────────────────────────
     DETECTOR 3: group_silent
     Groups (group & private; competitions excluded) with >= 3
     reports in previous 8 weeks and none in last SILENT_DAYS (10).
  ───────────────────────────────────────────────────────────── */
  const groupSilentGaps = [];

  for (const item of classReports) {
    const className = String(item.class_name || item._id || '').trim();
    if (!className) continue;

    const count = Number(item.count || 0);
    const lastDate = item.lastDate;

    if (count < cfg.SILENT_GROUP_MIN_REPORTS) continue;

    let silenceDays = cfg.PATTERN_WEEKS * 7;
    let silent = false;

    if (!lastDate) {
      silent = true;
    } else {
      const daysSinceLast = diffDays(todayStr, lastDate);
      if (daysSinceLast >= cfg.SILENT_DAYS) {
        silent = true;
        silenceDays = daysSinceLast;
      }
    }

    if (silent) {
      // Check acknowledgement
      const ackKey = `group_silent::${className}:`;
      if (!ackSet.has(ackKey)) {
        groupSilentGaps.push({
          kind: 'group_silent',
          groupName: className,
          lastDate,
          silenceDays,
          totalReports: count,
          evidence: `${count} reports in previous ${cfg.PATTERN_WEEKS} weeks, none in last ${silenceDays} days`,
        });
      }
    }
  }

  // Sort groupSilentGaps: longest silence first, then group name
  groupSilentGaps.sort((a, b) => {
    if (a.silenceDays !== b.silenceDays) return b.silenceDays - a.silenceDays;
    return a.groupName.localeCompare(b.groupName);
  });

  const summary = {
    total: teacherDayGaps.length + teacherSilentGaps.length + groupSilentGaps.length,
    teacherDayCount: teacherDayGaps.length,
    teacherSilentCount: teacherSilentGaps.length,
    groupSilentCount: groupSilentGaps.length,
  };

  return {
    summary,
    teacherDayGaps,
    teacherSilentGaps,
    groupSilentGaps,
    config: cfg,
  };
}

/* ══════════════════════════════════════════════════════════════
   4. DATA ACCESS SERVICE METHOD (Single DB Aggregation)
══════════════════════════════════════════════════════════════ */

/**
 * Fetch DB data using ONE aggregation over reports, plus teachers,
 * noClassDates and acks, then run the pure detector function.
 */
async function getReportGapsData({ lookbackDays = 14, now = new Date(), periodStart = null, periodEnd = null } = {}) {
  const cfg = getConfig({ LOOKBACK_DAYS: lookbackDays });
  const todayStr = toLocalDateStr(now);

  // Earliest date needed: max(PATTERN_WEEKS * 7, lookbackDays) + 2 days margin
  const maxDays = Math.max(cfg.PATTERN_WEEKS * 7, cfg.LOOKBACK_DAYS, 60) + 2;
  const minDateStr = addDays(todayStr, -maxDays);
  // Construct UTC start of date with +07:00 offset
  const minDate = new Date(`${minDateStr}T00:00:00.000+07:00`);

  const [teachers, aggResults, noClassDates, acks] = await Promise.all([
    User.find({ role: 'teacher' }).select('displayName username reportGapReminders').lean(),
    Report.aggregate(buildAggregationPipeline(minDate)),
    NoClassDate.find().sort({ from: 1 }).lean(),
    ReportGapAck.find().lean(),
  ]);

  const teacherReports = aggResults[0]?.teacherReports || [];
  const classReports = aggResults[0]?.classReports || [];

  const gapsResult = detectReportGaps({
    teacherReports,
    classReports,
    teachers,
    noClassDates,
    acks,
    config: cfg,
    now,
    periodStart,
    periodEnd,
  });

  return {
    ...gapsResult,
    noClassDates,
  };
}

/**
 * Count missing reports in a specific period (used on salaries page).
 */
async function countMissingReportsInPeriod(periodStart, periodEnd) {
  if (!periodStart || !periodEnd) return 0;
  try {
    const pStartStr = typeof periodStart === 'string' ? periodStart : toLocalDateStr(periodStart);
    const pEndStr   = typeof periodEnd === 'string'   ? periodEnd   : toLocalDateStr(periodEnd);

    // Lookback needs to reach the beginning of the period
    const todayStr = toLocalDateStr(new Date());
    const daysBack = Math.max(14, diffDays(todayStr, pStartStr) + 1);

    const result = await getReportGapsData({
      lookbackDays: daysBack,
      periodStart: pStartStr,
      periodEnd: pEndStr,
    });

    return result.teacherDayGaps.length;
  } catch (err) {
    console.error('countMissingReportsInPeriod error:', err);
    return 0;
  }
}

module.exports = {
  DEFAULT_CONFIG,
  getConfig,
  APP_TIMEZONE,
  toLocalDateStr,
  getLocalWeekday,
  addDays,
  diffDays,
  getWeekdayName,
  buildReportGapReminderClaimFilter,
  buildAggregationPipeline,
  detectReportGaps,
  getReportGapsData,
  countMissingReportsInPeriod,
};

