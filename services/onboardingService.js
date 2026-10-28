'use strict';

/**
 * services/onboardingService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 1 Teacher Onboarding Service
 *
 * Manages the "Getting started" checklist, automated step completion,
 * state evaluation, and visit tracking for teachers.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const User = require('../models/User');
const Report = require('../models/Report');

const STEPS = [
  {
    key: 'profile',
    title: 'Add your photo and check your name',
    why: 'Colleagues and admins see these on reports and salary slips.',
    cta: { label: 'Open profile', href: '/profile/edit' },
    kind: 'data',
    optional: true,
  },
  {
    key: 'rewards',
    title: 'Set your teaching reward amounts',
    why: "Your salary's teaching reward is calculated from these amounts. If they stay empty, your slip can be wrong.",
    cta: { label: 'Set amounts', href: '/profile/edit#commission-section' },
    kind: 'data',
    optional: false,
  },
  {
    key: 'first_report',
    title: 'Write your first report',
    why: 'Your reports decide your meal and transport days and your teaching reward.',
    cta: { label: 'New report', href: '/reports/new' },
    kind: 'data',
    optional: false,
  },
  {
    key: 'open_material',
    title: 'Open a lesson material',
    why: 'Find notes, worksheets and audio for each course level.',
    cta: { label: 'Browse materials', href: '/materials' },
    kind: 'visit',
    optional: true,
  },
  {
    key: 'calculator',
    title: 'Try the score calculator',
    why: 'Turn test scores into bands in seconds.',
    cta: { label: 'Open calculator', href: '/score-calculator' },
    kind: 'visit',
    optional: true,
  },
  {
    key: 'my_salary',
    title: 'Find your salary slips',
    why: 'Published slips appear here every month.',
    cta: { label: 'My salary', href: '/reports/my-salary' },
    kind: 'visit',
    optional: true,
  },
];

const STEP_MAP = new Map(STEPS.map(s => [s.key, s]));

/**
 * Pure function: determine if a teacher is considered legacy
 */
function isUserLegacy(user, now = new Date()) {
  if (user?.onboarding?.legacy === true) return true;
  if (user?.onboarding?.startedAt) return false;
  if (!user?.createdAt) return false;

  const launchDate = process.env.ONBOARDING_LAUNCH_DATE
    ? new Date(process.env.ONBOARDING_LAUNCH_DATE)
    : now;

  return new Date(user.createdAt) < launchDate;
}

/**
 * Pure function: compute the full onboarding state for a user.
 *
 * @param {Object} user
 * @param {Object} facts { hasProfilePicture, hasCommission, reportCount }
 * @param {Date} [now=new Date()]
 * @returns {Object} state
 */
function computeOnboardingState(user, facts = {}, now = new Date()) {
  if (!user || user.role !== 'teacher') {
    return {
      visible: false,
      isLegacy: false,
      steps: [],
      doneCount: 0,
      totalCount: 0,
      percent: 0,
      nextStep: null,
      isComplete: false,
    };
  }

  const legacy = isUserLegacy(user, now);
  const relevantStepConfigs = legacy
    ? STEPS.filter(s => s.key === 'rewards')
    : STEPS;

  const userSteps = user.onboarding?.steps;

  const evaluatedSteps = relevantStepConfigs.map(cfg => {
    let stored = null;
    if (userSteps instanceof Map) {
      stored = userSteps.get(cfg.key);
    } else if (userSteps && typeof userSteps === 'object') {
      stored = userSteps[cfg.key];
    }

    const doneAt = stored?.doneAt ? new Date(stored.doneAt) : null;
    const skippedAt = stored?.skippedAt ? new Date(stored.skippedAt) : null;

    let isDone = Boolean(doneAt);

    if (cfg.kind === 'data') {
      if (cfg.key === 'profile') {
        const hasPic = facts.hasProfilePicture !== undefined
          ? Boolean(facts.hasProfilePicture)
          : Boolean(user.profilePicture);
        const hasName = facts.hasDisplayName !== undefined
          ? Boolean(facts.hasDisplayName)
          : Boolean(user.displayName && String(user.displayName).trim().length > 0);
        if (hasPic && hasName) isDone = true;
      } else if (cfg.key === 'rewards') {
        const comm = user.commission || {};
        const hasComm = facts.hasCommission !== undefined
          ? Boolean(facts.hasCommission)
          : [comm.primeFull, comm.primeAssisted, comm.halfPrime, comm.assistant].some(v => (Number(v) || 0) > 0);
        if (hasComm) isDone = true;
      } else if (cfg.key === 'first_report') {
        const count = facts.reportCount !== undefined ? Number(facts.reportCount) : 0;
        if (count > 0) isDone = true;
      }
    }

    let status = 'todo';
    if (isDone) {
      status = 'done';
    } else if (skippedAt) {
      status = 'skipped';
    }

    return {
      key: cfg.key,
      title: cfg.title,
      why: cfg.why,
      cta: cfg.cta,
      optional: cfg.optional,
      kind: cfg.kind,
      status,
      doneAt: isDone ? (doneAt || now) : null,
      skippedAt: (!isDone && skippedAt) ? skippedAt : null,
    };
  });

  const totalCount = evaluatedSteps.length;
  const doneCount = evaluatedSteps.filter(s => s.status === 'done' || s.status === 'skipped').length;
  const percent = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
  const isComplete = totalCount > 0 && doneCount === totalCount;
  const nextStep = evaluatedSteps.find(s => s.status === 'todo') || null;

  const isDismissed = Boolean(user.onboarding?.dismissedAt);
  const completedAt = user.onboarding?.completedAt || null;

  let visible = false;
  if (legacy) {
    // Legacy teachers: only get rewards step and only while rates are missing
    const rewardsStep = evaluatedSteps.find(s => s.key === 'rewards');
    const rewardsDone = rewardsStep?.status === 'done';
    visible = !rewardsDone;
  } else {
    // Normal teachers: visible while incomplete, automatically gone when completed
    visible = !isComplete;
  }

  return {
    visible,
    isLegacy: legacy,
    isDismissed,
    steps: evaluatedSteps,
    doneCount,
    totalCount,
    percent,
    nextStep,
    isComplete,
  };
}

/**
 * Check facts from user object and DB when needed.
 * Only queries countDocuments on reports when first_report has no stored doneAt.
 */
async function getFacts(user) {
  if (!user || user.role !== 'teacher') {
    return { hasProfilePicture: false, hasDisplayName: false, hasCommission: false, reportCount: 0 };
  }

  const hasProfilePicture = Boolean(user.profilePicture);
  const hasDisplayName = Boolean(user.displayName && String(user.displayName).trim().length > 0);

  const comm = user.commission || {};
  const hasCommission = [comm.primeFull, comm.primeAssisted, comm.halfPrime, comm.assistant].some(
    v => (Number(v) || 0) > 0
  );

  let reportCount = 0;
  const dataSteps = STEPS.filter(s => s.kind === 'data');
  const getStoredDoneAt = (key) => {
    if (user.onboarding?.steps instanceof Map) {
      return user.onboarding.steps.get(key)?.doneAt;
    }
    return user.onboarding?.steps?.[key]?.doneAt;
  };

  const allDataStepsHaveStoredDone = dataSteps.every(s => Boolean(getStoredDoneAt(s.key)));
  const firstReportDoneAt = getStoredDoneAt('first_report');

  if (allDataStepsHaveStoredDone || firstReportDoneAt) {
    reportCount = 1; // already recorded, skip DB query
  } else if (user._id) {
    reportCount = await Report.countDocuments({
      teacher: user._id,
      is_auto_generated: { $ne: true },
    });
  }

  return {
    hasProfilePicture,
    hasDisplayName,
    hasCommission,
    reportCount,
  };
}

/**
 * Persist derived doneAt for data steps that are now satisfied but not yet stored,
 * and stamp completedAt the first time isComplete becomes true.
 */
async function persistDerivedSteps(user, state, now = new Date()) {
  if (!user?._id || user.role !== 'teacher' || !state) return;

  const updates = {};
  const userSteps = user.onboarding?.steps;

  state.steps.forEach(s => {
    if (s.kind === 'data' && s.status === 'done') {
      let storedDoneAt = null;
      if (userSteps instanceof Map) {
        storedDoneAt = userSteps.get(s.key)?.doneAt;
      } else if (userSteps) {
        storedDoneAt = userSteps[s.key]?.doneAt;
      }
      if (!storedDoneAt) {
        updates[`onboarding.steps.${s.key}.doneAt`] = s.doneAt || now;
      }
    }
  });

  if (state.isComplete && !user.onboarding?.completedAt) {
    updates['onboarding.completedAt'] = now;
  }

  if (Object.keys(updates).length > 0) {
    await User.updateOne({ _id: user._id }, { $set: updates });
  }
}

/**
 * Mark a visit step as done. Only visit steps are allowed.
 */
async function markStepDone(userId, key, now = new Date()) {
  const step = STEP_MAP.get(key);
  if (!step) {
    const err = new Error(`Unknown onboarding step: ${key}`);
    err.status = 400;
    throw err;
  }

  if (step.kind !== 'visit') {
    const err = new Error('This step completes automatically.');
    err.status = 400;
    throw err;
  }

  // Idempotent conditional update
  await User.updateOne(
    {
      _id: userId,
      $or: [
        { [`onboarding.steps.${key}.doneAt`]: null },
        { [`onboarding.steps.${key}.doneAt`]: { $exists: false } },
      ],
    },
    { $set: { [`onboarding.steps.${key}.doneAt`]: now } }
  );

  return true;
}

/**
 * Skip an optional step.
 */
async function skipStep(userId, key, now = new Date()) {
  const step = STEP_MAP.get(key);
  if (!step) {
    const err = new Error(`Unknown onboarding step: ${key}`);
    err.status = 400;
    throw err;
  }

  if (!step.optional && step.key !== 'rewards') {
    const err = new Error('This step cannot be skipped.');
    err.status = 400;
    throw err;
  }

  await User.updateOne(
    { _id: userId },
    { $set: { [`onboarding.steps.${key}.skippedAt`]: now } }
  );

  return true;
}

/**
 * Ensure onboarding is initialized for a newly registered teacher
 */
async function ensureOnboardingForNewUser(userId, now = new Date()) {
  await User.updateOne(
    { _id: userId, 'onboarding.startedAt': null },
    {
      $set: {
        'onboarding.version': 1,
        'onboarding.legacy': false,
        'onboarding.startedAt': now,
        'onboarding.dismissedAt': null,
        'onboarding.completedAt': null,
      },
    }
  );
  return true;
}

/**
 * Express middleware for tracking visit steps.
 * Hooks into res.on('finish') to trigger only when the response completes successfully (status < 400).
 * Non-blocking, only for teachers, swallows and logs errors safely.
 */
function trackOnboardingVisit(key) {
  return function (req, res, next) {
    const user = req.session?.user || req.user;
    if (user && user.role === 'teacher') {
      res.on('finish', () => {
        if (typeof res.statusCode === 'number' && res.statusCode < 400) {
          User.updateOne(
            {
              _id: user._id,
              $or: [
                { [`onboarding.steps.${key}.doneAt`]: null },
                { [`onboarding.steps.${key}.doneAt`]: { $exists: false } },
              ],
            },
            { $set: { [`onboarding.steps.${key}.doneAt`]: new Date() } }
          ).catch(err => {
            console.error(`[onboarding] track visit error for ${key}:`, err.message);
          });
        }
      });
    }
    next();
  };
}

/**
 * Admin helper: pure function listing teachers without reward rates.
 * Capped at 10 names.
 *
 * @param {Array} teachers
 * @returns {{ count: number, names: string[] }}
 */
function getTeachersWithoutRewards(teachers = []) {
  const missing = teachers.filter(t => {
    if (!t || t.role !== 'teacher') return false;
    const comm = t.commission || {};
    return !([comm.primeFull, comm.primeAssisted, comm.halfPrime, comm.assistant].some(
      v => (Number(v) || 0) > 0
    ));
  });

  return {
    count: missing.length,
    names: missing.slice(0, 10).map(t => t.displayName || t.username || 'Teacher'),
  };
}

/**
 * Quick pure helper for navbar remaining count (used by res.locals).
 * Returns null if completed or not a teacher, or a number (e.g. 3) if incomplete.
 *
 * @param {Object} user
 * @returns {number|null}
 */
function getNavOnboardingRemainingCount(user) {
  if (!user || user.role !== 'teacher') return null;
  if (user.onboarding?.completedAt) return null;

  const facts = {
    hasProfilePicture: Boolean(user.profilePicture),
    hasDisplayName: Boolean(user.displayName && String(user.displayName).trim().length > 0),
    hasCommission: Boolean(
      user.commission &&
      [user.commission.primeFull, user.commission.primeAssisted, user.commission.halfPrime, user.commission.assistant].some(
        v => (Number(v) || 0) > 0
      )
    ),
    // For navbar fast path without async query, check if first_report has doneAt
    reportCount: (() => {
      let done = null;
      if (user.onboarding?.steps instanceof Map) {
        done = user.onboarding.steps.get('first_report')?.doneAt;
      } else if (user.onboarding?.steps) {
        done = user.onboarding.steps.first_report?.doneAt;
      }
      return done ? 1 : 0;
    })(),
  };

  const state = computeOnboardingState(user, facts);
  if (state.isComplete) return null;
  return state.totalCount - state.doneCount;
}

const ALLOWED_TOURS = ['reportForm'];

/**
 * Pure helper: determine if a tour offer should be shown.
 * True only for non-legacy teachers with an active onboarding (not dismissed)
 * who have never seen/completed/dismissed this tour; false otherwise.
 *
 * @param {Object} user
 * @param {string} tourKey
 * @param {Date} [now]
 * @returns {boolean}
 */
function shouldOfferTour(user, tourKey, now = new Date()) {
  if (!user || user.role !== 'teacher') return false;
  if (!ALLOWED_TOURS.includes(tourKey)) return false;
  if (user.onboarding?.legacy) return false;
  if (user.onboarding?.dismissedAt) return false;

  let tourRecord = null;
  if (user.onboarding?.tours instanceof Map) {
    tourRecord = user.onboarding.tours.get(tourKey);
  } else if (user.onboarding?.tours) {
    tourRecord = user.onboarding.tours[tourKey];
  }

  if (!tourRecord) return true;
  if (tourRecord.seenAt || tourRecord.completedAt || tourRecord.dismissedAt) return false;
  return true;
}

/**
 * Record that a tour has been seen (mid-tour close or started).
 */
async function recordTourSeen(userId, tourKey, now = new Date()) {
  if (!ALLOWED_TOURS.includes(tourKey)) {
    const err = new Error('Invalid tour key');
    err.status = 400;
    throw err;
  }
  await User.updateOne(
    {
      _id: userId,
      $or: [
        { [`onboarding.tours.${tourKey}.seenAt`]: null },
        { [`onboarding.tours.${tourKey}.seenAt`]: { $exists: false } },
      ],
    },
    { $set: { [`onboarding.tours.${tourKey}.seenAt`]: now } }
  );
}

/**
 * Record that a tour has been completed.
 */
async function recordTourCompleted(userId, tourKey, now = new Date()) {
  if (!ALLOWED_TOURS.includes(tourKey)) {
    const err = new Error('Invalid tour key');
    err.status = 400;
    throw err;
  }
  await User.updateOne(
    { _id: userId },
    {
      $set: {
        [`onboarding.tours.${tourKey}.completedAt`]: now,
        [`onboarding.tours.${tourKey}.seenAt`]: now,
      },
    }
  );
}

/**
 * Record that a tour has been dismissed (declined via "No thanks").
 */
async function recordTourDismissed(userId, tourKey, now = new Date()) {
  if (!ALLOWED_TOURS.includes(tourKey)) {
    const err = new Error('Invalid tour key');
    err.status = 400;
    throw err;
  }
  await User.updateOne(
    { _id: userId },
    {
      $set: {
        [`onboarding.tours.${tourKey}.dismissedAt`]: now,
      },
    }
  );
}

module.exports = {
  STEPS,
  STEP_MAP,
  ALLOWED_TOURS,
  isUserLegacy,
  computeOnboardingState,
  getFacts,
  persistDerivedSteps,
  markStepDone,
  skipStep,
  ensureOnboardingForNewUser,
  trackOnboardingVisit,
  getTeachersWithoutRewards,
  getNavOnboardingRemainingCount,
  shouldOfferTour,
  recordTourSeen,
  recordTourCompleted,
  recordTourDismissed,
};
