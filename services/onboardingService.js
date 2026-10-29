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

  if (!user.onboarding && !user.createdAt) {
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
    // Legacy teachers: only get rewards step and only while rates are missing and not skipped
    const rewardsStep = evaluatedSteps.find(s => s.key === 'rewards');
    visible = !(rewardsStep?.status === 'done' || rewardsStep?.status === 'skipped');
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
    try {
      const Notification = require('../models/Notification');
      await Notification.updateMany(
        { recipient: user._id, type: 'onboarding_reminder', isRead: false },
        { $set: { isRead: true, readAt: now } }
      );
    } catch (notifErr) {
      console.error('[onboarding] mark unread reminders read error:', notifErr.message);
    }
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

const ALLOWED_TOURS = ['reportForm', 'materials', 'materialPage'];

const STEP_REMINDER_MESSAGES = {
  rewards: 'Your salary slip uses your reward amounts. Set them so it is correct.',
  first_report: 'Ready to write your first report? A one-minute tour walks you through the form.',
  profile: 'Add your photo so colleagues recognize you.',
  open_material: 'Your course materials are one tap away.',
  calculator: 'Try the score calculator when you grade tests.',
  my_salary: 'Your salary slips will appear here once published.',
};

/**
 * Pure function: plan whether an onboarding reminder should be sent.
 *
 * @param {Object} user
 * @param {Object} state
 * @param {Date} [now=new Date()]
 * @param {Object} [config={}]
 * @returns {{ send: boolean, reason: string, step: string|null, notification: { title: string, message: string, link: string } | null }}
 */
function planOnboardingReminder(user, state, now = new Date(), config = {}) {
  if (!user || (!user.onboarding && !user.createdAt)) {
    return { send: false, reason: 'incomplete_user', step: null, notification: null };
  }

  if (user.role !== 'teacher') {
    return { send: false, reason: 'not_teacher', step: null, notification: null };
  }

  if (!state || !state.visible || state.isComplete) {
    return { send: false, reason: 'checklist_complete_or_hidden', step: null, notification: null };
  }

  if (!state.nextStep || !state.nextStep.key) {
    return { send: false, reason: 'no_next_step', step: null, notification: null };
  }

  const isLegacy = Boolean(state.isLegacy);
  const firstAfterDays = config.firstAfterDays !== undefined
    ? Number(config.firstAfterDays)
    : Number(process.env.ONBOARDING_REMINDER_FIRST_AFTER_DAYS || 2);

  const intervalDays = config.intervalDays !== undefined
    ? Number(config.intervalDays)
    : (isLegacy
        ? Number(process.env.ONBOARDING_REMINDER_LEGACY_INTERVAL_DAYS || 7)
        : Number(process.env.ONBOARDING_REMINDER_INTERVAL_DAYS || 3));

  const max = config.maxReminders !== undefined
    ? Number(config.maxReminders)
    : (isLegacy
        ? Number(process.env.ONBOARDING_REMINDER_LEGACY_MAX || 2)
        : Number(process.env.ONBOARDING_REMINDER_MAX || 3));

  const count = Number(user.onboarding?.reminders?.count) || 0;
  if (count >= max) {
    return { send: false, reason: 'max_reached', step: null, notification: null };
  }

  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const lastSentAt = user.onboarding?.reminders?.lastSentAt
    ? new Date(user.onboarding.reminders.lastSentAt)
    : null;

  if (lastSentAt) {
    if (now.getTime() - lastSentAt.getTime() < intervalDays * MS_PER_DAY) {
      return { send: false, reason: 'interval_not_elapsed', step: null, notification: null };
    }
  } else {
    // First reminder: legacy teachers use interval after baseline (legacySince -> ONBOARDING_REMINDERS_START_DATE -> createdAt),
    // new teachers use firstAfterDays after startedAt/createdAt
    const baseline = isLegacy
      ? (user.onboarding?.legacySince
          || (process.env.ONBOARDING_REMINDERS_START_DATE ? new Date(process.env.ONBOARDING_REMINDERS_START_DATE) : null)
          || user.createdAt)
      : (user.onboarding?.startedAt || user.createdAt);

    if (!baseline) {
      return { send: false, reason: 'no_baseline_date', step: null, notification: null };
    }
    const requiredDays = isLegacy ? intervalDays : firstAfterDays;
    if (now.getTime() - new Date(baseline).getTime() < requiredDays * MS_PER_DAY) {
      return { send: false, reason: 'first_reminder_delay', step: null, notification: null };
    }
  }

  const stepKey = state.nextStep.key;
  const message = STEP_REMINDER_MESSAGES[stepKey] || 'Finish your setup to get the most out of your dashboard.';
  const link = (state.nextStep.cta && state.nextStep.cta.href) ? state.nextStep.cta.href : '/reports';

  return {
    send: true,
    reason: 'reminder_due',
    step: stepKey,
    notification: {
      title: 'Finish your setup',
      message,
      link,
    },
  };
}

/**
 * Pure function: build atomic MongoDB claim filter for automatic onboarding reminder.
 * Matches when count is missing, null, or < max AND lastSentAt is missing, null, or <= cutoff.
 *
 * @param {Object} params
 * @param {string|mongoose.Types.ObjectId} params.userId
 * @param {number} params.max
 * @param {Date} params.cutoff
 * @returns {Object} MongoDB query filter
 */
function buildReminderClaimFilter({ userId, max, cutoff }) {
  return {
    _id: userId,
    $and: [
      {
        $or: [
          { 'onboarding.reminders.count': { $exists: false } },
          { 'onboarding.reminders.count': null },
          { 'onboarding.reminders.count': { $lt: max } },
        ],
      },
      {
        $or: [
          { 'onboarding.reminders.lastSentAt': { $exists: false } },
          { 'onboarding.reminders.lastSentAt': null },
          { 'onboarding.reminders.lastSentAt': { $lte: cutoff } },
        ],
      },
    ],
  };
}

/**
 * Pure function: build atomic MongoDB claim filter for admin onboarding reminder (24h throttle).
 * Matches when lastAdminSentAt is missing, null, or <= cutoff.
 *
 * @param {Object} params
 * @param {string|mongoose.Types.ObjectId} params.userId
 * @param {Date} params.cutoff
 * @returns {Object} MongoDB query filter
 */
function buildAdminReminderClaimFilter({ userId, cutoff }) {
  return {
    _id: userId,
    $or: [
      { 'onboarding.reminders.lastAdminSentAt': { $exists: false } },
      { 'onboarding.reminders.lastAdminSentAt': null },
      { 'onboarding.reminders.lastAdminSentAt': { $lte: cutoff } },
    ],
  };
}

/**
 * Service function: maybe send an onboarding reminder.
 * Calls pure planOnboardingReminder first, verifies no unread reminder exists,
 * performs atomic claim on User, and creates Notification only upon claim success.
 *
 * @param {string|Object} userIdOrDoc
 * @param {Object} state
 * @param {Date} [now=new Date()]
 * @returns {Promise<{ sent: boolean, reason?: string, notification?: Object }>}
 */
async function maybeSendOnboardingReminder(userIdOrDoc, state, now = new Date()) {
  let userDoc = userIdOrDoc;
  if (!userDoc || typeof userDoc === 'string' || userDoc._bsontype === 'ObjectID' || (userDoc.constructor && userDoc.constructor.name === 'ObjectId')) {
    userDoc = await User.findById(userIdOrDoc);
  }
  if (!userDoc) {
    return { sent: false, reason: 'user_not_found' };
  }

  const plan = planOnboardingReminder(userDoc, state, now);
  if (!plan.send) {
    return { sent: false, reason: plan.reason };
  }

  // Skip without counting if teacher already has an unread onboarding_reminder
  const Notification = require('../models/Notification');
  const existingUnread = await Notification.findOne({
    recipient: userDoc._id,
    type: 'onboarding_reminder',
    isRead: false,
  });
  if (existingUnread) {
    return { sent: false, reason: 'existing_unread_reminder' };
  }

  const isLegacy = Boolean(state?.isLegacy);
  const intervalDays = isLegacy
    ? Number(process.env.ONBOARDING_REMINDER_LEGACY_INTERVAL_DAYS || 7)
    : Number(process.env.ONBOARDING_REMINDER_INTERVAL_DAYS || 3);
  const max = isLegacy
    ? Number(process.env.ONBOARDING_REMINDER_LEGACY_MAX || 2)
    : Number(process.env.ONBOARDING_REMINDER_MAX || 3);

  const cutoff = new Date(now.getTime() - intervalDays * 24 * 60 * 60 * 1000);
  const claimFilter = buildReminderClaimFilter({ userId: userDoc._id, max, cutoff });

  const updated = await User.findOneAndUpdate(
    claimFilter,
    {
      $set: { 'onboarding.reminders.lastSentAt': now },
      $inc: { 'onboarding.reminders.count': 1 },
    },
    { new: true }
  );

  if (!updated) {
    return { sent: false, reason: 'claim_failed' };
  }

  const count = updated.onboarding?.reminders?.count || 1;
  const notif = await Notification.create({
    recipient: userDoc._id,
    type: 'onboarding_reminder',
    category: 'system',
    title: plan.notification.title,
    message: plan.notification.message,
    link: plan.notification.link,
    metadata: {
      action: 'onboarding_reminder',
      step: plan.step,
      n: count,
    },
  });

  return { sent: true, notification: notif };
}

/**
 * Pure helper: check 24-hour admin reminder throttle.
 *
 * @param {Object} user
 * @param {Date} [now=new Date()]
 * @returns {{ allowed: boolean, reason?: string }}
 */
function canAdminSendReminder(user, now = new Date()) {
  if (!user || user.role !== 'teacher') {
    return { allowed: false, reason: 'not_teacher' };
  }
  const lastAdminSentAt = user.onboarding?.reminders?.lastAdminSentAt;
  if (lastAdminSentAt) {
    const diff = now.getTime() - new Date(lastAdminSentAt).getTime();
    if (diff < 24 * 60 * 60 * 1000) {
      return { allowed: false, reason: 'throttled_24h' };
    }
  }
  return { allowed: true };
}

/**
 * Pure decision logic for admin-triggered reminder.
 * Evaluates teacher, state (ensuring a pending step exists), and 24h throttle.
 *
 * @param {Object} user
 * @param {Object} state
 * @param {Date} [now=new Date()]
 * @returns {{ allowed: boolean, status?: number, reason?: string, error?: string, step?: string }}
 */
function decideAdminReminder(user, state, now = new Date()) {
  if (!user || user.role !== 'teacher') {
    return { allowed: false, status: 404, reason: 'not_teacher', error: 'Teacher not found.' };
  }
  if (!state || !state.nextStep || !state.nextStep.key) {
    return { allowed: false, status: 400, reason: 'no_pending_step', error: 'Teacher onboarding is complete or has no pending step.' };
  }
  const lastAdminSentAt = user.onboarding?.reminders?.lastAdminSentAt;
  if (lastAdminSentAt) {
    const diff = now.getTime() - new Date(lastAdminSentAt).getTime();
    if (diff < 24 * 60 * 60 * 1000) {
      return { allowed: false, status: 429, reason: 'throttled_24h', error: 'A reminder was already sent to this teacher in the last 24 hours.' };
    }
  }
  return { allowed: true, step: state.nextStep.key };
}

/**
 * Pure function: build the onboarding progress report for admins.
 *
 * @param {Array} teachers - Eligible teacher documents
 * @param {Object|Map} reportCounts - Report count per teacher ID
 * @param {Date} [now=new Date()]
 * @returns {{ summary: Object, funnel: Array, stuck: Array }}
 */
function buildOnboardingReport(teachers = [], reportCounts = {}, now = new Date()) {
  const eligible = teachers.filter(t => t?.onboarding?.startedAt && !t?.onboarding?.legacy && !isUserLegacy(t, now));

  const evaluatedTeachers = eligible.map(t => {
    const teacherIdStr = String(t._id);
    const count = reportCounts instanceof Map
      ? (reportCounts.get(teacherIdStr) || 0)
      : (reportCounts[teacherIdStr] || 0);

    const comm = t.commission || {};
    const hasComm = [comm.primeFull, comm.primeAssisted, comm.halfPrime, comm.assistant].some(
      v => (Number(v) || 0) > 0
    );

    const facts = {
      hasProfilePicture: Boolean(t.profilePicture),
      hasDisplayName: Boolean(t.displayName && String(t.displayName).trim().length > 0),
      hasCommission: hasComm,
      reportCount: count,
    };

    const state = computeOnboardingState(t, facts, now);
    return { teacher: t, state };
  });

  const total = evaluatedTeachers.length;
  let completed = 0;
  let notStarted = 0;

  evaluatedTeachers.forEach(({ state }) => {
    if (state.isComplete) {
      completed++;
    } else if (state.doneCount === 0) {
      notStarted++;
    }
  });

  const inProgress = total - completed - notStarted;
  const summary = { total, completed, inProgress, notStarted };

  // Funnel calculations
  const funnel = STEPS.map(stepDef => {
    let done = 0;
    let skipped = 0;
    let todo = 0;
    const daysToDoneArr = [];

    evaluatedTeachers.forEach(({ teacher, state }) => {
      const found = state.steps.find(s => s.key === stepDef.key);
      if (!found || found.status === 'todo') {
        todo++;
      } else if (found.status === 'skipped') {
        skipped++;
      } else if (found.status === 'done') {
        done++;
        if (found.doneAt && teacher.onboarding?.startedAt) {
          const diffDays = Math.max(
            0,
            (new Date(found.doneAt).getTime() - new Date(teacher.onboarding.startedAt).getTime()) / (24 * 60 * 60 * 1000)
          );
          daysToDoneArr.push(diffDays);
        }
      }
    });

    let medianDaysToDone = null;
    if (daysToDoneArr.length > 0) {
      daysToDoneArr.sort((a, b) => a - b);
      const n = daysToDoneArr.length;
      if (n % 2 === 1) {
        medianDaysToDone = daysToDoneArr[Math.floor(n / 2)];
      } else {
        medianDaysToDone = (daysToDoneArr[n / 2 - 1] + daysToDoneArr[n / 2]) / 2;
      }
      medianDaysToDone = Math.round(medianDaysToDone * 10) / 10;
    }

    return {
      key: stepDef.key,
      title: stepDef.title,
      done,
      skipped,
      todo,
      medianDaysToDone,
    };
  });

  // Stuck teachers (not complete and daysSince >= 3)
  const stuck = [];
  evaluatedTeachers.forEach(({ teacher, state }) => {
    if (!state.isComplete && teacher.onboarding?.startedAt) {
      const startedAt = new Date(teacher.onboarding.startedAt);
      const daysSince = Math.floor((now.getTime() - startedAt.getTime()) / (24 * 60 * 60 * 1000));
      if (daysSince >= 3) {
        const remainingSteps = state.steps
          .filter(s => s.status === 'todo')
          .map(s => s.title);
        stuck.push({
          id: String(teacher._id),
          name: teacher.displayName || teacher.username || 'Teacher',
          signedUpAt: startedAt,
          daysSince,
          remainingSteps,
          remindersCount: teacher.onboarding?.reminders?.count || 0,
          lastReminderAt: teacher.onboarding?.reminders?.lastSentAt || null,
          lastAdminSentAt: teacher.onboarding?.reminders?.lastAdminSentAt || null,
        });
      }
    }
  });

  stuck.sort((a, b) => b.daysSince - a.daysSince);

  return { summary, funnel, stuck };
}

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
  if (!user || (!user.onboarding && !user.createdAt)) return false;
  if (user.role !== 'teacher') return false;
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
  STEP_REMINDER_MESSAGES,
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
  planOnboardingReminder,
  maybeSendOnboardingReminder,
  buildReminderClaimFilter,
  buildAdminReminderClaimFilter,
  canAdminSendReminder,
  decideAdminReminder,
  buildOnboardingReport,
};
