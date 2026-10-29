'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ejs = require('ejs');

const { JSDOM } = require('jsdom');
const EventEmitter = require('events');
const User = require('../models/User');
const Report = require('../models/Report');

const {
  STEPS,
  STEP_MAP,
  isUserLegacy,
  computeOnboardingState,
  markStepDone,
  skipStep,
  getTeachersWithoutRewards,
  getNavOnboardingRemainingCount,
  shouldOfferTour,
  trackOnboardingVisit,
  ALLOWED_TOURS,
  STEP_REMINDER_MESSAGES,
  planOnboardingReminder,
  maybeSendOnboardingReminder,
  buildReminderClaimFilter,
  buildAdminReminderClaimFilter,
  canAdminSendReminder,
  decideAdminReminder,
  buildOnboardingReport,
} = require('../services/onboardingService');

test('Teacher Onboarding - computeOnboardingState pure function', async (t) => {
  await t.test('brand-new teacher: all steps todo, nextStep is profile, visible is true', () => {
    const user = {
      _id: '670000000000000000000001',
      role: 'teacher',
      displayName: '',
      profilePicture: null,
      commission: { primeFull: 0, primeAssisted: 0, halfPrime: 0, assistant: 0 },
      onboarding: {
        version: 1,
        legacy: false,
        startedAt: new Date(),
        dismissedAt: null,
        completedAt: null,
        steps: new Map(),
      },
    };
    const facts = { hasProfilePicture: false, hasDisplayName: false, hasCommission: false, reportCount: 0 };
    const state = computeOnboardingState(user, facts);

    assert.equal(state.visible, true);
    assert.equal(state.isLegacy, false);
    assert.equal(state.totalCount, 6);
    assert.equal(state.doneCount, 0);
    assert.equal(state.percent, 0);
    assert.equal(state.isComplete, false);
    assert.ok(state.nextStep);
    assert.equal(state.nextStep.key, 'profile');
    assert.equal(state.steps.every(s => s.status === 'todo'), true);
  });

  await t.test('profile step done when profilePicture and displayName are present', () => {
    const user = {
      _id: '670000000000000000000001',
      role: 'teacher',
      displayName: 'Teacher Jane',
      profilePicture: 'https://example.com/jane.jpg',
      commission: { primeFull: 0, primeAssisted: 0, halfPrime: 0, assistant: 0 },
      onboarding: { steps: new Map() },
    };
    const facts = { hasProfilePicture: true, hasDisplayName: true, hasCommission: false, reportCount: 0 };
    const state = computeOnboardingState(user, facts);

    const profileStep = state.steps.find(s => s.key === 'profile');
    assert.equal(profileStep.status, 'done');
    assert.equal(state.doneCount, 1);
    assert.equal(state.nextStep.key, 'rewards');
  });

  await t.test('rewards step done when any commission rate > 0', () => {
    const user = {
      _id: '670000000000000000000001',
      role: 'teacher',
      displayName: 'Teacher Jane',
      profilePicture: 'https://example.com/jane.jpg',
      commission: { primeFull: 50000, primeAssisted: 0, halfPrime: 0, assistant: 0 },
      onboarding: { steps: new Map() },
    };
    const facts = { hasProfilePicture: true, hasDisplayName: true, hasCommission: true, reportCount: 0 };
    const state = computeOnboardingState(user, facts);

    const rewardsStep = state.steps.find(s => s.key === 'rewards');
    assert.equal(rewardsStep.status, 'done');
    assert.equal(state.nextStep.key, 'first_report');
  });

  await t.test('first_report step done by reportCount > 0', () => {
    const user = {
      _id: '670000000000000000000001',
      role: 'teacher',
      displayName: 'Teacher Jane',
      profilePicture: 'https://example.com/jane.jpg',
      commission: { primeFull: 50000, primeAssisted: 0, halfPrime: 0, assistant: 0 },
      onboarding: { steps: new Map() },
    };
    const facts = { hasProfilePicture: true, hasDisplayName: true, hasCommission: true, reportCount: 1 };
    const state = computeOnboardingState(user, facts);

    const reportStep = state.steps.find(s => s.key === 'first_report');
    assert.equal(reportStep.status, 'done');
    assert.equal(state.nextStep.key, 'open_material');
  });

  await t.test('visit steps done by stored doneAt timestamp', () => {
    const doneTime = new Date('2026-10-27T10:00:00Z');
    const userSteps = new Map();
    userSteps.set('open_material', { doneAt: doneTime, skippedAt: null });

    const user = {
      _id: '670000000000000000000001',
      role: 'teacher',
      displayName: 'Teacher Jane',
      profilePicture: 'https://example.com/jane.jpg',
      commission: { primeFull: 50000, primeAssisted: 0, halfPrime: 0, assistant: 0 },
      onboarding: { steps: userSteps },
    };
    const facts = { hasProfilePicture: true, hasDisplayName: true, hasCommission: true, reportCount: 1 };
    const state = computeOnboardingState(user, facts);

    const materialStep = state.steps.find(s => s.key === 'open_material');
    assert.equal(materialStep.status, 'done');
    assert.equal(materialStep.doneAt.getTime(), doneTime.getTime());
    assert.equal(state.nextStep.key, 'calculator');
  });

  await t.test('optional step can be skipped', () => {
    const skippedTime = new Date('2026-10-27T10:00:00Z');
    const userSteps = new Map();
    userSteps.set('calculator', { doneAt: null, skippedAt: skippedTime });

    const user = {
      _id: '670000000000000000000001',
      role: 'teacher',
      onboarding: { steps: userSteps },
    };
    const facts = { hasProfilePicture: false, hasDisplayName: false, hasCommission: false, reportCount: 0 };
    const state = computeOnboardingState(user, facts);

    const calcStep = state.steps.find(s => s.key === 'calculator');
    assert.equal(calcStep.status, 'skipped');
    assert.equal(calcStep.skippedAt.getTime(), skippedTime.getTime());
  });

  await t.test('rewards step can be skipped, has status skipped, counts toward completion, and admin facts unchanged', () => {
    const userSteps = new Map();
    userSteps.set('rewards', { doneAt: null, skippedAt: new Date() });

    const user = {
      _id: '670000000000000000000001',
      displayName: 'Jane Doe',
      role: 'teacher',
      commission: { primeFull: 0, primeAssisted: 0, halfPrime: 0, assistant: 0 },
      onboarding: { steps: userSteps },
    };
    const facts = { hasCommission: false };
    const state = computeOnboardingState(user, facts);

    const rewardsStep = state.steps.find(s => s.key === 'rewards');
    assert.equal(rewardsStep.status, 'skipped');

    // Admin warning still flags teacher because real commission amounts are not set
    const adminReport = getTeachersWithoutRewards([user]);
    assert.equal(adminReport.count, 1);
    assert.equal(adminReport.names[0], 'Jane Doe');
  });

  await t.test('profile step is skippable and counts toward completion', () => {
    const userSteps = new Map();
    userSteps.set('profile', { doneAt: null, skippedAt: new Date() });

    const user = {
      _id: '670000000000000000000001',
      role: 'teacher',
      displayName: '',
      profilePicture: null,
      onboarding: { steps: userSteps },
    };
    const facts = { hasProfilePicture: false, hasDisplayName: false };
    const state = computeOnboardingState(user, facts);

    const profileStep = state.steps.find(s => s.key === 'profile');
    assert.equal(profileStep.optional, true);
    assert.equal(profileStep.status, 'skipped');
  });

  await t.test('isComplete true when every step is done or skipped', () => {
    const userSteps = new Map();
    userSteps.set('open_material', { doneAt: new Date(), skippedAt: null });
    userSteps.set('calculator', { doneAt: null, skippedAt: new Date() });
    userSteps.set('my_salary', { doneAt: new Date(), skippedAt: null });

    const user = {
      _id: '670000000000000000000001',
      role: 'teacher',
      displayName: 'Teacher Jane',
      profilePicture: 'pic.jpg',
      commission: { primeFull: 10000 },
      onboarding: { steps: userSteps, completedAt: null, dismissedAt: null },
    };
    const facts = { hasProfilePicture: true, hasDisplayName: true, hasCommission: true, reportCount: 5 };
    const state = computeOnboardingState(user, facts);

    assert.equal(state.isComplete, true);
    assert.equal(state.doneCount, 6);
    assert.equal(state.totalCount, 6);
    assert.equal(state.percent, 100);
    assert.equal(state.nextStep, null);
    // When completedAt is null and not dismissed, visible stays true so user sees celebration card once
    assert.equal(state.visible, false);
  });

  await t.test('complete teacher hides card (visible false) but /getting-started still computes all steps', () => {
    const userSteps = new Map();
    STEPS.forEach(s => userSteps.set(s.key, { doneAt: new Date() }));
    const user = {
      _id: '670000000000000000000001',
      role: 'teacher',
      displayName: 'Teacher Jane',
      profilePicture: 'pic.jpg',
      commission: { primeFull: 10000 },
      onboarding: {
        completedAt: new Date(),
        steps: userSteps,
      },
    };
    const facts = { hasProfilePicture: true, hasDisplayName: true, hasCommission: true, reportCount: 1 };
    const state = computeOnboardingState(user, facts);

    assert.equal(state.isComplete, true);
    assert.equal(state.visible, false);
    assert.equal(state.totalCount, 6);
    assert.equal(state.steps.length, 6);
  });

  await t.test('legacy teacher with rates missing: only rewards step shown, visible is true', () => {
    const user = {
      _id: '670000000000000000000001',
      displayName: 'Legacy Jane',
      role: 'teacher',
      commission: { primeFull: 0, primeAssisted: 0, halfPrime: 0, assistant: 0 },
      onboarding: {
        legacy: true,
        dismissedAt: null,
        steps: new Map(),
      },
    };
    const facts = { hasCommission: false };
    const state = computeOnboardingState(user, facts);

    assert.equal(state.isLegacy, true);
    assert.equal(state.visible, true);
    assert.equal(state.totalCount, 1);
    assert.equal(state.steps.length, 1);
    assert.equal(state.steps[0].key, 'rewards');
    assert.equal(state.steps[0].status, 'todo');
  });

  await t.test('legacy with rewards skipped: not visible, not shown on next render, admin helper still includes teacher', async () => {
    const skippedTime = new Date('2026-10-28T10:00:00Z');
    const userSteps = new Map();
    userSteps.set('rewards', { doneAt: null, skippedAt: skippedTime });

    const user = {
      _id: '670000000000000000000001',
      displayName: 'Legacy Jane',
      role: 'teacher',
      commission: { primeFull: 0, primeAssisted: 0, halfPrime: 0, assistant: 0 },
      onboarding: {
        legacy: true,
        dismissedAt: null,
        steps: userSteps,
      },
    };
    const facts = { hasCommission: false };
    const state = computeOnboardingState(user, facts);

    assert.equal(state.isLegacy, true);
    assert.equal(state.visible, false, 'Legacy teacher with skipped rewards must not have visible card');
    assert.equal(state.steps[0].key, 'rewards');
    assert.equal(state.steps[0].status, 'skipped');

    // Admin warning still includes teacher because real commission amounts are not set
    const adminReport = getTeachersWithoutRewards([user]);
    assert.equal(adminReport.count, 1);
    assert.equal(adminReport.names[0], 'Legacy Jane');

    // Server-rendered card renders empty string
    const cardTemplate = path.resolve('views/partials/onboarding/_card.ejs');
    const html = await ejs.renderFile(cardTemplate, { onboardingState: state });
    assert.equal(html.trim(), '', 'Card must not be rendered when state.visible is false');
  });

  await t.test('legacy teacher with rates set (done): visible is false', () => {
    const user = {
      _id: '670000000000000000000001',
      displayName: 'Legacy Jane',
      role: 'teacher',
      commission: { primeFull: 45000, primeAssisted: 0, halfPrime: 0, assistant: 0 },
      onboarding: {
        legacy: true,
        dismissedAt: null,
        steps: new Map(),
      },
    };
    const facts = { hasCommission: true };
    const state = computeOnboardingState(user, facts);

    assert.equal(state.isLegacy, true);
    assert.equal(state.visible, false);
    assert.equal(state.steps[0].status, 'done');
  });

  await t.test('legacy skipped then amounts set: visible is false, status is done', () => {
    const skippedTime = new Date('2026-10-20T10:00:00Z');
    const userSteps = new Map();
    userSteps.set('rewards', { doneAt: null, skippedAt: skippedTime });

    const user = {
      _id: '670000000000000000000001',
      displayName: 'Legacy Jane',
      role: 'teacher',
      commission: { primeFull: 50000, primeAssisted: 0, halfPrime: 0, assistant: 0 },
      onboarding: {
        legacy: true,
        dismissedAt: null,
        steps: userSteps,
      },
    };
    const facts = { hasCommission: true };
    const state = computeOnboardingState(user, facts);

    assert.equal(state.isLegacy, true);
    assert.equal(state.visible, false);
    assert.equal(state.steps[0].status, 'done', 'Setting amounts overrides skipped status');
  });

  await t.test('admin and superadmin: visible is false, empty steps', () => {
    const admin = { _id: '670000000000000000000002', role: 'admin' };
    const superadmin = { _id: '670000000000000000000003', role: 'superadmin' };

    const stateAdmin = computeOnboardingState(admin);
    const stateSuper = computeOnboardingState(superadmin);

    assert.equal(stateAdmin.visible, false);
    assert.equal(stateAdmin.steps.length, 0);
    assert.equal(stateSuper.visible, false);
    assert.equal(stateSuper.steps.length, 0);
  });
});

test('Teacher Onboarding - Key validation & step constraints', async (t) => {
  await t.test('STEPS contains exactly 6 ordered steps with expected keys', () => {
    assert.equal(STEPS.length, 6);
    const keys = STEPS.map(s => s.key);
    assert.deepEqual(keys, [
      'profile',
      'rewards',
      'first_report',
      'open_material',
      'calculator',
      'my_salary',
    ]);
  });

  await t.test('markStepDone rejects non-visit data steps', async () => {
    await assert.rejects(
      async () => {
        await markStepDone('fake-user-id', 'profile');
      },
      { message: 'This step completes automatically.' }
    );

    await assert.rejects(
      async () => {
        await markStepDone('fake-user-id', 'rewards');
      },
      { message: 'This step completes automatically.' }
    );

    await assert.rejects(
      async () => {
        await markStepDone('fake-user-id', 'first_report');
      },
      { message: 'This step completes automatically.' }
    );
  });

  await t.test('markStepDone rejects unknown key', async () => {
    await assert.rejects(
      async () => {
        await markStepDone('fake-user-id', 'invalid_step_key');
      },
      /Unknown onboarding step/
    );
  });

  await t.test('skipStep allows optional steps and rewards, but rejects first_report', async () => {
    let updateCalledWith = null;
    const origUpdateOne = User.updateOne;
    User.updateOne = async (filter, update) => {
      updateCalledWith = { filter, update };
      return { modifiedCount: 1 };
    };
    try {
      // profile is optional and can be skipped
      const profileRes = await skipStep('fake-user-id', 'profile');
      assert.equal(profileRes, true);
      assert.ok(updateCalledWith.update.$set['onboarding.steps.profile.skippedAt']);

      // rewards can be skipped
      const rewardsRes = await skipStep('fake-user-id', 'rewards');
      assert.equal(rewardsRes, true);
      assert.ok(updateCalledWith.update.$set['onboarding.steps.rewards.skippedAt']);

      // first_report is required and cannot be skipped
      await assert.rejects(
        async () => {
          await skipStep('fake-user-id', 'first_report');
        },
        { message: 'This step cannot be skipped.' }
      );
    } finally {
      User.updateOne = origUpdateOne;
    }
  });
});

test('Teacher Onboarding - Admin warning helper', async (t) => {
  await t.test('getTeachersWithoutRewards correctly filters teachers and caps at 10 names', () => {
    const mockUsers = [];
    for (let i = 1; i <= 15; i++) {
      mockUsers.push({
        _id: `t_${i}`,
        displayName: `Teacher ${i}`,
        role: 'teacher',
        commission: { primeFull: 0, primeAssisted: 0, halfPrime: 0, assistant: 0 },
      });
    }

    // 2 teachers with rates
    mockUsers.push({
      _id: 't_with_rate_1',
      displayName: 'Teacher With Rate 1',
      role: 'teacher',
      commission: { primeFull: 40000, primeAssisted: 0, halfPrime: 0, assistant: 0 },
    });
    // 1 admin
    mockUsers.push({
      _id: 'a_1',
      displayName: 'Admin User',
      role: 'admin',
      commission: { primeFull: 0, primeAssisted: 0, halfPrime: 0, assistant: 0 },
    });

    const res = getTeachersWithoutRewards(mockUsers);
    assert.equal(res.count, 15);
    assert.equal(res.names.length, 10);
    assert.equal(res.names[0], 'Teacher 1');
    assert.equal(res.names[9], 'Teacher 10');
  });
});

test('Teacher Onboarding - Navbar remaining count helper', async (t) => {
  await t.test('returns remaining count when incomplete, null when complete or admin', () => {
    const user = {
      _id: '670000000000000000000001',
      role: 'teacher',
      displayName: 'Jane',
      profilePicture: null,
      commission: { primeFull: 0 },
      onboarding: { steps: new Map() },
    };
    const remaining = getNavOnboardingRemainingCount(user);
    assert.equal(remaining, 6);

    const admin = { _id: '670000000000000000000002', role: 'admin' };
    assert.equal(getNavOnboardingRemainingCount(admin), null);
  });
});

test('Teacher Onboarding - EJS Template Rendering', async (t) => {
  const cardTemplate = path.resolve('views/partials/onboarding/_card.ejs');
  const indexTemplate = path.resolve('views/onboarding/index.ejs');

  const origLoader = ejs.fileLoader;
  t.after(() => {
    ejs.fileLoader = origLoader;
  });

  ejs.fileLoader = function (filePath) {
    if (filePath.includes('partials/header') || filePath.includes('partials\\header')) {
      return '<!-- STUBBED_HEADER -->';
    }
    if (filePath.includes('partials/footer') || filePath.includes('partials\\footer')) {
      return '<!-- STUBBED_FOOTER -->';
    }
    return origLoader(filePath);
  };

  await t.test('dashboard card renders nothing when state.visible is false', async () => {
    const html = await ejs.renderFile(cardTemplate, {
      onboardingState: { visible: false },
    });
    assert.equal(html.trim(), '');
  });

  await t.test('dashboard card renders progress, CTA hrefs, and aria attributes when visible', async () => {
    const state = {
      visible: true,
      doneCount: 2,
      totalCount: 6,
      percent: 33,
      isComplete: false,
      nextStep: {
        key: 'first_report',
        title: 'Write your first report',
        why: 'Your reports decide your meal and transport days and your teaching reward.',
        cta: { label: 'New report', href: '/reports/new' },
        optional: false,
      },
      steps: [
        { key: 'profile', title: 'Add your photo', why: 'Why 1', status: 'done', optional: false, cta: { label: 'Profile', href: '/profile/edit' } },
        { key: 'rewards', title: 'Set rewards', why: 'Why 2', status: 'done', optional: false, cta: { label: 'Set amounts', href: '/profile/edit#commission-section' } },
        { key: 'first_report', title: 'Write your first report', why: 'Why 3', status: 'todo', optional: false, cta: { label: 'New report', href: '/reports/new' } },
        { key: 'open_material', title: 'Open a lesson material', why: 'Why 4', status: 'todo', optional: true, cta: { label: 'Browse materials', href: '/materials' } },
        { key: 'calculator', title: 'Try calculator', why: 'Why 5', status: 'todo', optional: true, cta: { label: 'Open calculator', href: '/score-calculator' } },
        { key: 'my_salary', title: 'Find slips', why: 'Why 6', status: 'todo', optional: true, cta: { label: 'My salary', href: '/reports/my-salary' } },
      ],
    };

    const html = await ejs.renderFile(cardTemplate, { onboardingState: state });

    assert.ok(html.includes('Getting started'), 'Must render card title');
    assert.ok(html.includes('2 of 6 done'), 'Must render done count');
    assert.ok(html.includes('role="progressbar"'), 'Must have role=progressbar');
    assert.ok(html.includes('aria-valuenow="33"'), 'Must have aria-valuenow="33"');
    assert.ok(html.includes('aria-valuemin="0"'), 'Must have aria-valuemin="0"');
    assert.ok(html.includes('aria-valuemax="100"'), 'Must have aria-valuemax="100"');
    assert.ok(html.includes('/reports/new'), 'Must include next step CTA link');
    assert.ok(html.includes('id="onboarding-live-region"'), 'Must include live announcement region');
  });

  await t.test('dashboard card renders nothing when onboarding is complete (auto-gone)', async () => {
    const state = {
      visible: false,
      doneCount: 6,
      totalCount: 6,
      percent: 100,
      isComplete: true,
      nextStep: null,
      steps: [],
    };

    const html = await ejs.renderFile(cardTemplate, { onboardingState: state });
    assert.equal(html.trim(), '', 'Must render nothing when onboarding is complete');
  });

  await t.test('/getting-started view renders all steps and progress', async () => {
    const state = {
      doneCount: 1,
      totalCount: 6,
      percent: 17,
      isComplete: false,
      steps: STEPS.map(s => ({ ...s, status: s.key === 'profile' ? 'done' : 'todo' })),
    };
    const user = {
      _id: '670000000000000000000001',
      displayName: 'Jane Doe',
      onboarding: {},
    };

    const html = await ejs.renderFile(indexTemplate, {
      title: 'Getting Started',
      state,
      user,
    });

    assert.ok(html.includes('Getting started'), 'Must render page title');
    assert.ok(html.includes('1 of 6 steps completed'), 'Must render steps completed text');
    assert.ok(html.includes('/profile/edit#commission-section'), 'Must include CTA link to commission section');
  });

  await t.test('/getting-started view renders Skipped and Do it now for skipped required step', async () => {
    const state = {
      doneCount: 1,
      totalCount: 6,
      percent: 17,
      isComplete: false,
      steps: STEPS.map(s => ({
        ...s,
        status: s.key === 'rewards' ? 'skipped' : 'todo',
      })),
    };
    const user = {
      _id: '670000000000000000000001',
      displayName: 'Jane Doe',
      onboarding: {},
    };

    const html = await ejs.renderFile(indexTemplate, {
      title: 'Getting Started',
      state,
      user,
    });

    assert.ok(html.includes('Skipped'), 'Must render Skipped badge');
    assert.ok(html.includes('Do it now'), 'Must render Do it now link for skipped required step');
  });
});

test('Teacher Onboarding - auto-disappear when complete visibility rules', async (t) => {
  const allFacts = { hasProfilePicture: true, hasDisplayName: true, hasCommission: true, reportCount: 1 };
  const doneSteps = new Map();
  STEPS.forEach(s => doneSteps.set(s.key, { doneAt: new Date() }));

  await t.test('new teacher incomplete -> visible is true', () => {
    const user = {
      role: 'teacher',
      displayName: 'Jane',
      profilePicture: null,
      commission: {},
      onboarding: { legacy: false, steps: new Map() },
    };
    const incompleteFacts = { hasProfilePicture: false, hasDisplayName: false, hasCommission: false, reportCount: 0 };
    const state = computeOnboardingState(user, incompleteFacts);
    assert.equal(state.isComplete, false);
    assert.equal(state.visible, true);
  });

  await t.test('new teacher complete -> visible is false (auto-disappears from dashboard)', () => {
    const user = {
      role: 'teacher',
      displayName: 'Jane',
      profilePicture: 'pic.jpg',
      commission: { primeFull: 1000 },
      onboarding: {
        legacy: false,
        completedAt: new Date(),
        steps: doneSteps,
      },
    };
    const state = computeOnboardingState(user, allFacts);
    assert.equal(state.isComplete, true);
    assert.equal(state.visible, false);
  });

  await t.test('legacy teacher complete -> visible is false', () => {
    const user = {
      role: 'teacher',
      displayName: 'Legacy Jane',
      profilePicture: 'pic.jpg',
      commission: { primeFull: 1000 },
      onboarding: {
        legacy: true,
        steps: doneSteps,
      },
    };
    const state = computeOnboardingState(user, allFacts);
    assert.equal(state.isComplete, true);
    assert.equal(state.visible, false);
  });
});

test('Teacher Onboarding - trackOnboardingVisit with fake req/res', async (t) => {
  let updateCalledWith = null;
  const origUpdateOne = User.updateOne;
  t.after(() => {
    User.updateOne = origUpdateOne;
  });
  User.updateOne = async (filter, update) => {
    updateCalledWith = { filter, update };
    return { modifiedCount: 1 };
  };

  await t.test('calls User.updateOne on finish when statusCode < 400', () => {
    updateCalledWith = null;
    const req = {
      user: {
        _id: '507f1f77bcf86cd799439011',
        role: 'teacher',
      },
    };
    const res = new EventEmitter();
    res.statusCode = 200;
    let nextCalled = false;

    const mw = trackOnboardingVisit('open_material');
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);

    res.emit('finish');
    assert.ok(updateCalledWith);
    assert.equal(updateCalledWith.filter._id, req.user._id);
    assert.ok(updateCalledWith.update.$set['onboarding.steps.open_material.doneAt']);
  });

  await t.test('does not call User.updateOne when statusCode >= 400', () => {
    updateCalledWith = null;
    const req = {
      user: {
        _id: '507f1f77bcf86cd799439011',
        role: 'teacher',
      },
    };
    const res = new EventEmitter();
    res.statusCode = 500;
    const mw = trackOnboardingVisit('open_material');
    mw(req, res, () => {});
    res.emit('finish');
    assert.equal(updateCalledWith, null);
  });
});

test('Report Form Tour - shouldOfferTour rules', async (t) => {
  const baseTeacher = {
    role: 'teacher',
    onboarding: {
      legacy: false,
      dismissedAt: null,
      tours: new Map(),
    },
  };

  await t.test('new eligible teacher without seen/completed/dismissed -> true', () => {
    assert.equal(shouldOfferTour(baseTeacher, 'reportForm'), true);
  });

  await t.test('admin user -> false', () => {
    const admin = { ...baseTeacher, role: 'admin' };
    assert.equal(shouldOfferTour(admin, 'reportForm'), false);
  });

  await t.test('superadmin user -> false', () => {
    const superadmin = { ...baseTeacher, role: 'superadmin' };
    assert.equal(shouldOfferTour(superadmin, 'reportForm'), false);
  });

  await t.test('legacy teacher -> false', () => {
    const legacyTeacher = {
      ...baseTeacher,
      onboarding: { ...baseTeacher.onboarding, legacy: true },
    };
    assert.equal(shouldOfferTour(legacyTeacher, 'reportForm'), false);
  });

  await t.test('teacher with dismissed onboarding -> false', () => {
    const dismissedTeacher = {
      ...baseTeacher,
      onboarding: { ...baseTeacher.onboarding, dismissedAt: new Date() },
    };
    assert.equal(shouldOfferTour(dismissedTeacher, 'reportForm'), false);
  });

  await t.test('teacher who already saw tour -> false', () => {
    const tours = new Map();
    tours.set('reportForm', { seenAt: new Date() });
    const seenTeacher = {
      ...baseTeacher,
      onboarding: { ...baseTeacher.onboarding, tours },
    };
    assert.equal(shouldOfferTour(seenTeacher, 'reportForm'), false);
  });

  await t.test('teacher who completed tour -> false', () => {
    const tours = new Map();
    tours.set('reportForm', { completedAt: new Date() });
    const completedTeacher = {
      ...baseTeacher,
      onboarding: { ...baseTeacher.onboarding, tours },
    };
    assert.equal(shouldOfferTour(completedTeacher, 'reportForm'), false);
  });

  await t.test('teacher who dismissed tour -> false', () => {
    const tours = new Map();
    tours.set('reportForm', { dismissedAt: new Date() });
    const dismissedTourTeacher = {
      ...baseTeacher,
      onboarding: { ...baseTeacher.onboarding, tours },
    };
    assert.equal(shouldOfferTour(dismissedTourTeacher, 'reportForm'), false);
  });

  await t.test('unknown tourKey -> false', () => {
    assert.equal(shouldOfferTour(baseTeacher, 'unknownTour'), false);
  });
});

test('Report Form Tour - tour config validation', async (t) => {
  const steps = require('../public/js/tours/report-form-tour');
  assert.ok(Array.isArray(steps), 'Steps must be an array');
  assert.equal(steps.length, 9, 'Must have exactly 9 steps');

  for (const step of steps) {
    await t.test(`step "${step.id}" validation`, () => {
      assert.equal(typeof step.selector, 'string', 'step.selector must be a string');
      assert.ok(step.selector.startsWith('#'), 'step.selector must be an ID selector starting with #');
      assert.equal(typeof step.title, 'string', 'step.title must be a string');
      assert.ok(step.title.length > 0, 'step.title must not be empty');
      assert.equal(typeof step.description, 'string', 'step.description must be a string');
      assert.ok(step.description.length <= 160, `step description must be <= 160 chars, got ${step.description.length}`);
      assert.ok(!/<[^>]+>/.test(step.title), 'step.title must not contain HTML tags');
      assert.ok(!/<[^>]+>/.test(step.description), 'step.description must not contain HTML tags');
    });
  }
});

test('Report Form Tour - DOM selector regression test', async (t) => {
  const origLoader = ejs.fileLoader;
  t.after(() => {
    ejs.fileLoader = origLoader;
  });

  ejs.fileLoader = function (filePath) {
    if (filePath.includes('partials/header') || filePath.includes('partials\\header')) {
      return '<!-- STUBBED_HEADER -->';
    }
    if (filePath.includes('partials/footer') || filePath.includes('partials\\footer')) {
      return '<!-- STUBBED_FOOTER -->';
    }
    return origLoader(filePath);
  };

  const newReportPath = path.resolve('views/reports/new.ejs');
  const templateData = {
    csrfToken: 'test-token',
    currentUser: { _id: '507f1f77bcf86cd799439011', displayName: 'Teacher John', role: 'teacher' },
    errors: [],
    formData: {},
    groupsJson: '[]',
    materialsJson: '[]',
    teachingTypes: ['Regular Teaching', 'Assistant Teacher', '1/2 Prime Teacher'],
    teachers: [],
    teachersJson: '[]',
    shouldOfferTour: true,
  };

  const html = await ejs.renderFile(newReportPath, templateData);
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const steps = require('../public/js/tours/report-form-tour');
  for (const step of steps) {
    await t.test(`selector ${step.selector} exists in DOM or is declared conditional`, () => {
      const el = doc.querySelector(step.selector);
      if (!el) {
        assert.ok(step.conditional, `Selector "${step.selector}" missing from rendered form and NOT marked conditional`);
      } else {
        assert.ok(el, `Element for selector "${step.selector}" must exist`);
      }
    });
  }
});

test('Report Form Tour - Render tests in new.ejs', async (t) => {
  const origLoader = ejs.fileLoader;
  t.after(() => {
    ejs.fileLoader = origLoader;
  });

  ejs.fileLoader = function (filePath) {
    if (filePath.includes('partials/header') || filePath.includes('partials\\header')) {
      return '<!-- STUBBED_HEADER -->';
    }
    if (filePath.includes('partials/footer') || filePath.includes('partials\\footer')) {
      return '<!-- STUBBED_FOOTER -->';
    }
    return origLoader(filePath);
  };

  const newReportPath = path.resolve('views/reports/new.ejs');

  await t.test('teacher sees "?" button and tour scripts', async () => {
    const html = await ejs.renderFile(newReportPath, {
      csrfToken: 'token',
      currentUser: { role: 'teacher', displayName: 'Teacher' },
      errors: [],
      formData: {},
      groupsJson: '[]',
      materialsJson: '[]',
      teachingTypes: [],
      teachers: [],
      teachersJson: '[]',
      shouldOfferTour: true,
    });

    assert.ok(html.includes('id="tour-help-btn"'), 'Teacher must see ? button');
    assert.ok(html.includes('driver.js'), 'Teacher must load driver.js');
    assert.ok(html.includes('tour-runner.js'), 'Teacher must load tour-runner.js');
    assert.ok(html.includes('report-form-tour.js'), 'Teacher must load report-form-tour.js');
  });

  await t.test('admin does NOT see "?" button and tour scripts', async () => {
    const html = await ejs.renderFile(newReportPath, {
      csrfToken: 'token',
      currentUser: { role: 'admin', displayName: 'Admin' },
      errors: [],
      formData: {},
      groupsJson: '[]',
      materialsJson: '[]',
      teachingTypes: [],
      teachers: [],
      teachersJson: '[]',
      shouldOfferTour: false,
    });

    assert.ok(!html.includes('id="tour-help-btn"'), 'Admin must not see ? button');
    assert.ok(!html.includes('driver.js'), 'Admin must not load driver.js');
    assert.ok(!html.includes('tour-runner.js'), 'Admin must not load tour-runner.js');
  });
});

test('Navigation - Getting started link removed from navbar', async (t) => {
  const navLinksPath = path.resolve('views/partials/nav/nav-links.ejs');
  const mobileMenuPath = path.resolve('views/partials/nav/mobile-menu.ejs');

  await t.test('teacher does not see Getting started in nav-links or mobile-menu', async () => {
    const locals = {
      currentUser: { role: 'teacher', displayName: 'Teacher Jane' },
      onboardingRemainingCount: 3,
      csrfToken: 'test-token',
      title: 'Dashboard',
    };

    const navHtml = await ejs.renderFile(navLinksPath, locals);
    const mobileHtml = await ejs.renderFile(mobileMenuPath, {
      ...locals,
      _expStr: null,
      _isOnline: false,
      unreadNotificationCount: 0,
    });

    assert.ok(!navHtml.includes('Getting started'), 'nav-links must not show Getting started');
    assert.ok(!mobileHtml.includes('Getting started'), 'mobile-menu must not show Getting started');
  });

  await t.test('admin does not see Getting started in nav-links or mobile-menu', async () => {
    const locals = {
      currentUser: { role: 'admin', displayName: 'Admin User' },
      onboardingRemainingCount: 3,
      csrfToken: 'test-token',
      title: 'Dashboard',
    };

    const navHtml = await ejs.renderFile(navLinksPath, locals);
    const mobileHtml = await ejs.renderFile(mobileMenuPath, {
      ...locals,
      _expStr: null,
      _isOnline: false,
      unreadNotificationCount: 0,
    });

    assert.ok(!navHtml.includes('Getting started'), 'admin nav-links must not show Getting started');
    assert.ok(!mobileHtml.includes('Getting started'), 'admin mobile-menu must not show Getting started');
  });
});

test('Teacher Onboarding - getFacts cheap query optimization', async (t) => {
  const origCount = Report.countDocuments;
  let countCalled = false;
  Report.countDocuments = async () => {
    countCalled = true;
    return 5;
  };
  t.after(() => {
    Report.countDocuments = origCount;
  });

  await t.test('when every data step already has stored doneAt, answers without count query', async () => {
    countCalled = false;
    const user = {
      _id: '670000000000000000000001',
      role: 'teacher',
      onboarding: {
        steps: new Map([
          ['profile', { doneAt: new Date() }],
          ['rewards', { doneAt: new Date() }],
          ['first_report', { doneAt: new Date() }],
        ]),
      },
    };
    const { getFacts } = require('../services/onboardingService');
    const facts = await getFacts(user);
    assert.equal(countCalled, false, 'Report.countDocuments should not have been called');
    assert.equal(facts.reportCount, 1);
  });
});

test('Teacher Onboarding - Throttled State Checker', async (t) => {
  const { createThrottledChecker } = require('../public/js/onboarding');

  await t.test('20 focus events within 10 seconds produce at most one request', async () => {
    let callCount = 0;
    const fakeFetch = async () => {
      callCount++;
      return { ok: true, status: 200, json: async () => ({ state: { isComplete: false, visible: true } }) };
    };

    let currentTime = 1000;
    const checker = createThrottledChecker(fakeFetch, () => {}, () => currentTime);

    // 20 focus events fired over 10 seconds (500ms intervals)
    for (let i = 0; i < 20; i++) {
      currentTime += 500;
      await checker.check();
    }

    assert.equal(callCount, 1, 'Should produce at most 1 request for 20 events in 10s');
  });

  await t.test('sends second request only after 15 seconds have elapsed', async () => {
    let callCount = 0;
    const fakeFetch = async () => {
      callCount++;
      return { ok: true, status: 200, json: async () => ({ state: { isComplete: false, visible: true } }) };
    };

    let currentTime = 1000;
    const checker = createThrottledChecker(fakeFetch, () => {}, () => currentTime);

    await checker.check(); // at 1000ms -> request 1
    assert.equal(callCount, 1);

    currentTime += 14000; // at 15000ms (14s elapsed)
    await checker.check();
    assert.equal(callCount, 1, 'Should throttle calls under 15 seconds');

    currentTime += 2000; // at 17000ms (16s elapsed)
    await checker.check();
    assert.equal(callCount, 2, 'Should allow call after 15 seconds');
  });

  await t.test('stops all checking after 429 response', async () => {
    let callCount = 0;
    const fakeFetch = async () => {
      callCount++;
      return { ok: false, status: 429, json: async () => ({}) };
    };

    let currentTime = 1000;
    const checker = createThrottledChecker(fakeFetch, () => {}, () => currentTime);

    await checker.check();
    assert.equal(callCount, 1);
    assert.equal(checker.isStopped(), true);

    currentTime += 20000;
    await checker.check();
    assert.equal(callCount, 1, 'Should not send any more requests after 429');
  });

  await t.test('stops all checking after two consecutive failures', async () => {
    let callCount = 0;
    const fakeFetch = async () => {
      callCount++;
      return { ok: false, status: 500, json: async () => ({}) };
    };

    let currentTime = 1000;
    const checker = createThrottledChecker(fakeFetch, () => {}, () => currentTime);

    await checker.check(); // failure 1
    assert.equal(callCount, 1);
    assert.equal(checker.isStopped(), false);

    currentTime += 16000;
    await checker.check(); // failure 2
    assert.equal(callCount, 2);
    assert.equal(checker.isStopped(), true);

    currentTime += 16000;
    await checker.check();
    assert.equal(callCount, 2, 'Should not send any more requests after 2 consecutive failures');
  });

  await t.test('never sends while a request is in flight', async () => {
    let callCount = 0;
    let resolvePromise;
    const hangingPromise = new Promise(resolve => {
      resolvePromise = resolve;
    });

    const fakeFetch = async () => {
      callCount++;
      await hangingPromise;
      return { ok: true, status: 200, json: async () => ({ state: { isComplete: false, visible: true } }) };
    };

    let currentTime = 1000;
    const checker = createThrottledChecker(fakeFetch, () => {}, () => currentTime);

    const firstCheck = checker.check(); // starts and hangs
    assert.equal(callCount, 1);

    currentTime += 20000;
    await checker.check(); // attempted while in-flight
    assert.equal(callCount, 1, 'Must not send while in flight');

    resolvePromise();
    await firstCheck;
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * Phase 3 Tests: Reminders (Part A), Material Tours (Part B), Admin Report (Part C)
 * ───────────────────────────────────────────────────────────────────────────── */

test('Phase 3 Part A - planOnboardingReminder matrix and rules', async (t) => {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const t0 = new Date('2026-10-01T00:00:00.000Z');

  const baseTeacher = {
    _id: '670000000000000000000001',
    role: 'teacher',
    onboarding: {
      startedAt: t0,
      legacy: false,
      reminders: { count: 0, lastSentAt: null },
    },
  };

  const activeState = {
    visible: true,
    isComplete: false,
    isLegacy: false,
    nextStep: {
      key: 'rewards',
      title: 'Set your teaching reward amounts',
      cta: { label: 'Set amounts', href: '/profile/edit#commission-section' },
    },
  };

  await t.test('new teacher day 1 -> send is false (first_reminder_delay)', () => {
    const day1 = new Date(t0.getTime() + 1 * MS_PER_DAY);
    const plan = planOnboardingReminder(baseTeacher, activeState, day1);
    assert.equal(plan.send, false);
    assert.equal(plan.reason, 'first_reminder_delay');
  });

  await t.test('new teacher day 2 -> send is true (reminder_due)', () => {
    const day2 = new Date(t0.getTime() + 2 * MS_PER_DAY);
    const plan = planOnboardingReminder(baseTeacher, activeState, day2);
    assert.equal(plan.send, true);
    assert.equal(plan.reason, 'reminder_due');
    assert.equal(plan.step, 'rewards');
    assert.equal(plan.notification.title, 'Finish your setup');
    assert.equal(plan.notification.message, STEP_REMINDER_MESSAGES.rewards);
    assert.equal(plan.notification.link, '/profile/edit#commission-section');
    assert.ok(plan.notification.message.length <= 140, 'Message <= 140 chars');
  });

  await t.test('day 4 after a reminder on day 2 -> send is false (interval_not_elapsed)', () => {
    const day2 = new Date(t0.getTime() + 2 * MS_PER_DAY);
    const day4 = new Date(t0.getTime() + 4 * MS_PER_DAY);
    const teacher = {
      ...baseTeacher,
      onboarding: {
        ...baseTeacher.onboarding,
        reminders: { count: 1, lastSentAt: day2 },
      },
    };
    const plan = planOnboardingReminder(teacher, activeState, day4);
    assert.equal(plan.send, false);
    assert.equal(plan.reason, 'interval_not_elapsed');
  });

  await t.test('day 5 after a reminder on day 2 -> send is true (reminder_due)', () => {
    const day2 = new Date(t0.getTime() + 2 * MS_PER_DAY);
    const day5 = new Date(t0.getTime() + 5 * MS_PER_DAY);
    const teacher = {
      ...baseTeacher,
      onboarding: {
        ...baseTeacher.onboarding,
        reminders: { count: 1, lastSentAt: day2 },
      },
    };
    const plan = planOnboardingReminder(teacher, activeState, day5);
    assert.equal(plan.send, true);
    assert.equal(plan.reason, 'reminder_due');
  });

  await t.test('fourth attempt (count >= max 3) -> send is false (max_reached)', () => {
    const day15 = new Date(t0.getTime() + 15 * MS_PER_DAY);
    const day10 = new Date(t0.getTime() + 10 * MS_PER_DAY);
    const teacher = {
      ...baseTeacher,
      onboarding: {
        ...baseTeacher.onboarding,
        reminders: { count: 3, lastSentAt: day10 },
      },
    };
    const plan = planOnboardingReminder(teacher, activeState, day15);
    assert.equal(plan.send, false);
    assert.equal(plan.reason, 'max_reached');
  });

  await t.test('complete teacher -> send is false', () => {
    const day5 = new Date(t0.getTime() + 5 * MS_PER_DAY);
    const completeState = { ...activeState, visible: false, isComplete: true };
    const plan = planOnboardingReminder(baseTeacher, completeState, day5);
    assert.equal(plan.send, false);
  });

  await t.test('legacy teacher interval 7 days and max 2 with legacySince baseline', () => {
    const legacyTeacher = {
      _id: '670000000000000000000002',
      role: 'teacher',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      onboarding: {
        legacy: true,
        legacySince: t0,
        startedAt: null,
        reminders: { count: 0, lastSentAt: null },
      },
    };
    const legacyState = {
      visible: true,
      isComplete: false,
      isLegacy: true,
      nextStep: { key: 'rewards', cta: { href: '/profile/edit#commission-section' } },
    };

    // Right after init (day 0): not due
    assert.equal(planOnboardingReminder(legacyTeacher, legacyState, t0).send, false);

    // Day 6: 6 days < 7 days interval -> false
    const day6 = new Date(t0.getTime() + 6 * MS_PER_DAY);
    assert.equal(planOnboardingReminder(legacyTeacher, legacyState, day6).send, false);

    // Day 7: 7 days >= 7 days interval -> true
    const day7 = new Date(t0.getTime() + 7 * MS_PER_DAY);
    assert.equal(planOnboardingReminder(legacyTeacher, legacyState, day7).send, true);

    // After reminder on Day 7, Day 10 (3 days later) -> false (second reminder not before 7 more days)
    const teacherAfter1 = {
      ...legacyTeacher,
      onboarding: { ...legacyTeacher.onboarding, reminders: { count: 1, lastSentAt: day7 } },
    };
    const day10 = new Date(t0.getTime() + 10 * MS_PER_DAY);
    assert.equal(planOnboardingReminder(teacherAfter1, legacyState, day10).send, false);

    // Day 14 (7 days after day 7) -> true
    const day14 = new Date(t0.getTime() + 14 * MS_PER_DAY);
    assert.equal(planOnboardingReminder(teacherAfter1, legacyState, day14).send, true);

    // After 2 reminders (max 2) -> false
    const teacherAfter2 = {
      ...legacyTeacher,
      onboarding: { ...legacyTeacher.onboarding, reminders: { count: 2, lastSentAt: day14 } },
    };
    const day25 = new Date(t0.getTime() + 25 * MS_PER_DAY);
    assert.equal(planOnboardingReminder(teacherAfter2, legacyState, day25).send, false);

    // Baseline fallback to process.env.ONBOARDING_REMINDERS_START_DATE
    const prevEnv = process.env.ONBOARDING_REMINDERS_START_DATE;
    try {
      process.env.ONBOARDING_REMINDERS_START_DATE = t0.toISOString();
      const teacherWithEnv = {
        _id: '670000000000000000000003',
        role: 'teacher',
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
        onboarding: { legacy: true, reminders: { count: 0, lastSentAt: null } },
      };
      assert.equal(planOnboardingReminder(teacherWithEnv, legacyState, day6).send, false);
      assert.equal(planOnboardingReminder(teacherWithEnv, legacyState, day7).send, true);
    } finally {
      if (prevEnv === undefined) {
        delete process.env.ONBOARDING_REMINDERS_START_DATE;
      } else {
        process.env.ONBOARDING_REMINDERS_START_DATE = prevEnv;
      }
    }

    // Baseline fallback to createdAt when neither legacySince nor env date is set
    const teacherWithCreatedAt = {
      _id: '670000000000000000000004',
      role: 'teacher',
      createdAt: t0,
      onboarding: { legacy: true, reminders: { count: 0, lastSentAt: null } },
    };
    assert.equal(planOnboardingReminder(teacherWithCreatedAt, legacyState, day6).send, false);
    assert.equal(planOnboardingReminder(teacherWithCreatedAt, legacyState, day7).send, true);
  });

  await t.test('admin and superadmin -> send is false (not_teacher)', () => {
    const admin = { role: 'admin', onboarding: {} };
    const superadmin = { role: 'superadmin', onboarding: {} };
    assert.equal(planOnboardingReminder(admin, activeState).send, false);
    assert.equal(planOnboardingReminder(superadmin, activeState).send, false);
  });

  await t.test('message content across all steps is <= 140 chars, sentence case, plain text', () => {
    for (const [key, msg] of Object.entries(STEP_REMINDER_MESSAGES)) {
      assert.ok(msg.length <= 140, `Step ${key} message must be <= 140 chars, got ${msg.length}`);
      assert.ok(!/<[^>]+>/.test(msg), `Step ${key} message must not contain HTML tags`);
      assert.ok(msg[0] === msg[0].toUpperCase(), `Step ${key} message should start with uppercase`);
    }
  });
});

test('Phase 3 Part A - maybeSendOnboardingReminder claim and existing unread skip', async (t) => {
  const Notification = require('../models/Notification');
  const origNotificationFindOne = Notification.findOne;
  const origNotificationCreate = Notification.create;
  const origUserFindOneAndUpdate = User.findOneAndUpdate;

  t.after(() => {
    Notification.findOne = origNotificationFindOne;
    Notification.create = origNotificationCreate;
    User.findOneAndUpdate = origUserFindOneAndUpdate;
  });

  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const t0 = new Date('2026-10-01T00:00:00.000Z');
  const now = new Date(t0.getTime() + 3 * MS_PER_DAY);

  const teacher = {
    _id: '670000000000000000000010',
    role: 'teacher',
    onboarding: {
      startedAt: t0,
      legacy: false,
      reminders: { count: 0, lastSentAt: null },
    },
  };

  const activeState = {
    visible: true,
    isComplete: false,
    isLegacy: false,
    nextStep: {
      key: 'rewards',
      title: 'Set your teaching reward amounts',
      cta: { label: 'Set amounts', href: '/profile/edit#commission-section' },
    },
  };

  await t.test('skip without counting when teacher already has an unread onboarding_reminder', async () => {
    let updateCalled = false;
    Notification.findOne = async (query) => {
      if (query.type === 'onboarding_reminder' && query.isRead === false) {
        return { _id: 'notif-unread-1', isRead: false };
      }
      return null;
    };
    User.findOneAndUpdate = async () => {
      updateCalled = true;
      return null;
    };

    const res = await maybeSendOnboardingReminder(teacher, activeState, now);
    assert.equal(res.sent, false);
    assert.equal(res.reason, 'existing_unread_reminder');
    assert.equal(updateCalled, false, 'Must not claim or increment count when unread reminder exists');
  });

  await t.test('atomic claim: two concurrent calls result in only one notification created', async () => {
    let claimCount = 0;
    let notifCount = 0;

    Notification.findOne = async () => null; // no unread
    Notification.create = async (doc) => {
      notifCount++;
      return { _id: `notif-${notifCount}`, ...doc };
    };

    // Simulate atomic DB findOneAndUpdate: only the first call matches and returns updated doc; second returns null
    User.findOneAndUpdate = async () => {
      claimCount++;
      if (claimCount === 1) {
        return {
          _id: teacher._id,
          onboarding: {
            reminders: { count: 1, lastSentAt: now },
          },
        };
      }
      return null; // concurrent query matched 0 documents
    };

    const [res1, res2] = await Promise.all([
      maybeSendOnboardingReminder(teacher, activeState, now),
      maybeSendOnboardingReminder(teacher, activeState, now),
    ]);

    assert.equal(notifCount, 1, 'Exactly one notification created across two concurrent calls');
    const successful = [res1, res2].filter(r => r.sent === true);
    const failed = [res1, res2].filter(r => r.sent === false);
    assert.equal(successful.length, 1);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].reason, 'claim_failed');
  });
});

test('Phase 3 Part B - Material Tours config validation & shouldOfferTour', async (t) => {
  const materialsSteps = require('../public/js/tours/materials-tour');
  const materialPageSteps = require('../public/js/tours/material-page-tour');

  await t.test('materials-tour.js config validation', () => {
    assert.equal(materialsSteps.length, 4, 'Must have exactly 4 steps');
    for (const step of materialsSteps) {
      assert.ok(step.selector.startsWith('[data-tour="') && step.selector.endsWith('"]'), `Selector must be a data-tour attribute selector: ${step.selector}`);
      assert.ok(!step.selector.includes('#') && !step.selector.includes('.'), `Selector must not use IDs or classes: ${step.selector}`);
      assert.ok(step.title.length > 0 && step.title.length <= 60);
      assert.ok(step.description.length > 0 && step.description.length <= 160);
      assert.ok(!/<[^>]+>/.test(step.title), 'Title must not contain HTML');
      assert.ok(!/<[^>]+>/.test(step.description), 'Description must not contain HTML');
    }
    const statusStep = materialsSteps.find(s => s.id === 'status');
    assert.ok(statusStep, 'Status step exists');
    assert.ok(!/\btabs?\b/i.test(statusStep.description), 'Status step must not mention tabs');
    assert.ok(statusStep.description.includes('all materials') && statusStep.description.includes('materials with content') && statusStep.description.includes('still need notes or files'), 'Status step must accurately describe switching');
  });

  await t.test('material-page-tour.js config validation', () => {
    assert.equal(materialPageSteps.length, 5, 'Must have exactly 5 steps');
    for (const step of materialPageSteps) {
      assert.ok(step.selector.startsWith('[data-tour="') && step.selector.endsWith('"]'), `Selector must be a data-tour attribute selector: ${step.selector}`);
      assert.ok(!step.selector.includes('#') && !step.selector.includes('.'), `Selector must not use IDs or classes: ${step.selector}`);
      assert.ok(step.title.length > 0);
      assert.ok(step.description.length > 0 && step.description.length <= 160);
      assert.ok(!/<[^>]+>/.test(step.title), 'Title must not contain HTML');
      assert.ok(!/<[^>]+>/.test(step.description), 'Description must not contain HTML');
    }
    const slideshowStep = materialPageSteps.find(s => s.id === 'slideshow');
    assert.ok(slideshowStep, 'Slideshow step exists');
    assert.ok(!/flashcards?/i.test(slideshowStep.description), 'Slideshow must not mention flashcards');
    assert.equal(slideshowStep.description, 'Open the lesson images as full-screen slides to show your class.');
  });

  await t.test('ALLOWED_TOURS contains reportForm, materials, and materialPage', () => {
    assert.deepEqual(ALLOWED_TOURS, ['reportForm', 'materials', 'materialPage']);
  });

  await t.test('shouldOfferTour works for materials and materialPage', () => {
    const teacher = {
      role: 'teacher',
      onboarding: { startedAt: new Date(), legacy: false, tours: new Map() },
    };
    assert.equal(shouldOfferTour(teacher, 'materials'), true);
    assert.equal(shouldOfferTour(teacher, 'materialPage'), true);

    const seenTeacher = {
      role: 'teacher',
      onboarding: {
        startedAt: new Date(),
        legacy: false,
        tours: { materials: { seenAt: new Date() } },
      },
    };
    assert.equal(shouldOfferTour(seenTeacher, 'materials'), false);
    assert.equal(shouldOfferTour(seenTeacher, 'materialPage'), true);
  });
});

test('Phase 3 Part B - DOM selector regression test for material pages', async (t) => {
  const origLoader = ejs.fileLoader;
  t.after(() => {
    ejs.fileLoader = origLoader;
  });

  ejs.fileLoader = function (filePath) {
    if (filePath.includes('partials/header') || filePath.includes('partials\\header')) {
      return '<!-- STUBBED_HEADER -->';
    }
    if (filePath.includes('partials/footer') || filePath.includes('partials\\footer')) {
      return '<!-- STUBBED_FOOTER -->';
    }
    return origLoader(filePath);
  };

  await t.test('views/materials/index.ejs contains all non-conditional step selectors', async () => {
    const indexPath = path.resolve('views/materials/index.ejs');
    const data = {
      title: 'Materials Library',
      materials: [
        { _id: '670000000000000000000001', name: 'Math Level 1', level: 'PRIMARY', hasContent: true },
      ],
      contentMap: {},
      page: 1,
      totalPages: 1,
      totalMatching: 1,
      availableLevels: ['PRIMARY'],
      selectedLevel: '',
      searchQuery: '',
      status: 'all',
      countAll: 1,
      countWithContent: 1,
      countNoContent: 0,
      userIsAdmin: false,
      currentUser: { _id: '670000000000000000000001', role: 'teacher' },
      shouldOfferTour: true,
      renderMaterialBody: s => s,
      safeJson: o => JSON.stringify(o),
    };

    const html = await ejs.renderFile(indexPath, data);
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const materialsSteps = require('../public/js/tours/materials-tour');
    for (const step of materialsSteps) {
      if (!step.conditional) {
        const el = doc.querySelector(step.selector);
        assert.ok(el, `Expected selector "${step.selector}" to exist in views/materials/index.ejs`);
      }
    }

    assert.ok(doc.querySelector('[data-tour="help"]'), 'Teacher sees "?" help button');
    assert.ok(doc.querySelector('script[data-tour-key="materials"]'), 'Teacher loads materials tour script');
  });

  await t.test('views/materials/show.ejs contains all non-conditional step selectors', async () => {
    const showPath = path.resolve('views/materials/show.ejs');
    const data = {
      title: 'Math Level 1 — Material',
      material: {
        _id: '670000000000000000000001',
        name: 'Math Level 1',
        level: 'PRIMARY',
        hasContent: true,
      },
      content: {
        version: 1,
        body: '<p>Guide notes for Math Level 1</p>',
        resources: [
          { _id: 'res-1', kind: 'file', label: 'Slide 1', file: { format: 'png', bytes: 1024 } },
          { _id: 'res-2', kind: 'file', label: 'Slide 2', file: { format: 'png', bytes: 2048 } },
        ],
        locked: false,
      },
      userCanEdit: true,
      userIsAdmin: false,
      currentUser: { _id: '670000000000000000000001', role: 'teacher' },
      shouldOfferTour: true,
      renderMaterialBody: s => s,
      safeJson: o => JSON.stringify(o),
      csrfToken: 'test-token',
    };

    const html = await ejs.renderFile(showPath, data);
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const pageSteps = require('../public/js/tours/material-page-tour');
    for (const step of pageSteps) {
      const el = doc.querySelector(step.selector);
      assert.ok(el, `Expected selector "${step.selector}" to exist in views/materials/show.ejs`);
    }

    assert.ok(doc.querySelector('[data-tour="help"]'), 'Teacher sees "?" help button');
    assert.ok(doc.querySelector('script[data-tour-key="materialPage"]'), 'Teacher loads materialPage tour script');
  });
});

test('Phase 3 Part C - buildOnboardingReport and admin throttle', async (t) => {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const now = new Date('2026-10-20T12:00:00.000Z');

  await t.test('empty teachers returns zeroed report', () => {
    const report = buildOnboardingReport([], {}, now);
    assert.deepEqual(report.summary, { total: 0, completed: 0, inProgress: 0, notStarted: 0 });
    assert.equal(report.funnel.length, STEPS.length);
    assert.deepEqual(report.stuck, []);
  });

  await t.test('mixed states, skipped steps, legacy excluded, and stuck ordering', () => {
    const completedTeacher = {
      _id: '670000000000000000000021',
      role: 'teacher',
      displayName: 'Teacher Completed',
      profilePicture: 'pic.jpg',
      commission: { primeFull: 100000 },
      onboarding: {
        startedAt: new Date(now.getTime() - 10 * MS_PER_DAY),
        legacy: false,
        steps: {
          profile: { doneAt: new Date(now.getTime() - 9 * MS_PER_DAY) },
          rewards: { doneAt: new Date(now.getTime() - 8 * MS_PER_DAY) },
          first_report: { doneAt: new Date(now.getTime() - 7 * MS_PER_DAY) },
          open_material: { doneAt: new Date(now.getTime() - 6 * MS_PER_DAY) },
          calculator: { doneAt: new Date(now.getTime() - 5 * MS_PER_DAY) },
          my_salary: { doneAt: new Date(now.getTime() - 4 * MS_PER_DAY) },
        },
      },
    };

    const inProgressTeacher = {
      _id: '670000000000000000000022',
      displayName: 'Teacher InProgress',
      role: 'teacher',
      profilePicture: null,
      commission: { primeFull: 0 },
      onboarding: {
        startedAt: new Date(now.getTime() - 5 * MS_PER_DAY),
        legacy: false,
        reminders: { count: 1, lastSentAt: new Date(now.getTime() - 2 * MS_PER_DAY) },
        steps: {
          profile: { skippedAt: new Date(now.getTime() - 4 * MS_PER_DAY) }, // skipped
        },
      },
    };

    const notStartedTeacher = {
      _id: '670000000000000000000023',
      displayName: 'Teacher NotStarted',
      role: 'teacher',
      profilePicture: null,
      commission: { primeFull: 0 },
      onboarding: {
        startedAt: new Date(now.getTime() - 4 * MS_PER_DAY),
        legacy: false,
        reminders: { count: 0, lastSentAt: null },
        steps: {},
      },
    };

    const legacyTeacher = {
      _id: '670000000000000000000024',
      displayName: 'Teacher Legacy',
      role: 'teacher',
      onboarding: {
        startedAt: new Date(now.getTime() - 20 * MS_PER_DAY),
        legacy: true,
      },
    };

    const teachers = [completedTeacher, inProgressTeacher, notStartedTeacher, legacyTeacher];
    const reportCounts = {
      '670000000000000000000021': 5,
      '670000000000000000000022': 0,
      '670000000000000000000023': 0,
    };

    const report = buildOnboardingReport(teachers, reportCounts, now);

    // Legacy excluded -> total is 3
    assert.equal(report.summary.total, 3);
    assert.equal(report.summary.completed, 1);
    assert.equal(report.summary.inProgress, 1);
    assert.equal(report.summary.notStarted, 1);

    // Profile step: 1 done, 1 skipped, 1 todo
    const profileFunnel = report.funnel.find(f => f.key === 'profile');
    assert.equal(profileFunnel.done, 1);
    assert.equal(profileFunnel.skipped, 1);
    assert.equal(profileFunnel.todo, 1);

    // Stuck teachers: inProgress (5 days >= 3) and notStarted (4 days >= 3)
    assert.equal(report.stuck.length, 2);
    // Ordered by daysSince descending: 5 days before 4 days
    assert.equal(report.stuck[0].name, 'Teacher InProgress');
    assert.equal(report.stuck[0].daysSince, 5);
    assert.equal(report.stuck[1].name, 'Teacher NotStarted');
    assert.equal(report.stuck[1].daysSince, 4);
  });

  await t.test('medianDaysToDone with odd and even counts', () => {
    const makeTeacherWithDoneDays = (id, stepKey, daysFromStart) => ({
      _id: `67000000000000000000003${id}`,
      role: 'teacher',
      profilePicture: 'pic.jpg',
      displayName: `Teacher ${id}`,
      commission: {},
      onboarding: {
        startedAt: new Date('2026-10-01T00:00:00.000Z'),
        legacy: false,
        steps: {
          [stepKey]: { doneAt: new Date(new Date('2026-10-01T00:00:00.000Z').getTime() + daysFromStart * MS_PER_DAY) },
        },
      },
    });

    const oddTeachers = [
      makeTeacherWithDoneDays('1', 'open_material', 1),
      makeTeacherWithDoneDays('2', 'open_material', 3),
      makeTeacherWithDoneDays('3', 'open_material', 5),
    ];
    const oddReport = buildOnboardingReport(oddTeachers, {}, now);
    const oddStep = oddReport.funnel.find(f => f.key === 'open_material');
    assert.equal(oddStep.medianDaysToDone, 3);

    const evenTeachers = [
      makeTeacherWithDoneDays('1', 'calculator', 2),
      makeTeacherWithDoneDays('2', 'calculator', 4),
    ];
    const evenReport = buildOnboardingReport(evenTeachers, {}, now);
    const evenStep = evenReport.funnel.find(f => f.key === 'calculator');
    assert.equal(evenStep.medianDaysToDone, 3);
  });

  await t.test('canAdminSendReminder 24h throttle logic', () => {
    const teacherClean = { role: 'teacher', onboarding: { reminders: {} } };
    assert.equal(canAdminSendReminder(teacherClean, now).allowed, true);

    const teacherRecentlySent = {
      role: 'teacher',
      onboarding: {
        reminders: { lastAdminSentAt: new Date(now.getTime() - 2 * 60 * 60 * 1000) }, // 2h ago
      },
    };
    const resThrottled = canAdminSendReminder(teacherRecentlySent, now);
    assert.equal(resThrottled.allowed, false);
    assert.equal(resThrottled.reason, 'throttled_24h');

    const teacherDayAgo = {
      role: 'teacher',
      onboarding: {
        reminders: { lastAdminSentAt: new Date(now.getTime() - 25 * 60 * 60 * 1000) }, // 25h ago
      },
    };
    assert.equal(canAdminSendReminder(teacherDayAgo, now).allowed, true);
  });
});

test('Phase 3 Part C - Admin onboarding report page render with XSS escaping', async (t) => {
  const origLoader = ejs.fileLoader;
  t.after(() => {
    ejs.fileLoader = origLoader;
  });

  ejs.fileLoader = function (filePath) {
    if (filePath.includes('partials/header') || filePath.includes('partials\\header')) {
      return '<!-- STUBBED_HEADER -->';
    }
    if (filePath.includes('partials/footer') || filePath.includes('partials\\footer')) {
      return '<!-- STUBBED_FOOTER -->';
    }
    return origLoader(filePath);
  };

  const templatePath = path.resolve('views/admin/onboarding/index.ejs');
  const mockReport = {
    summary: { total: 5, completed: 2, inProgress: 2, notStarted: 1 },
    funnel: [
      { key: 'profile', title: 'Add your photo and check your name', done: 4, skipped: 1, todo: 0, medianDaysToDone: 1.5 },
      { key: 'rewards', title: 'Set your teaching reward amounts', done: 3, skipped: 0, todo: 2, medianDaysToDone: 2.0 },
    ],
    stuck: [
      {
        id: '670000000000000000000099',
        name: '<script>alert("xss")</script> & "Dangerous"',
        signedUpAt: new Date('2026-10-10T00:00:00.000Z'),
        daysSince: 8,
        remainingSteps: ['Write your first report', 'Open a lesson material'],
        remindersCount: 2,
        lastReminderAt: new Date('2026-10-15T00:00:00.000Z'),
        lastAdminSentAt: null,
      },
    ],
  };

  const html = await ejs.renderFile(templatePath, {
    title: 'Admin — Onboarding Progress',
    report: mockReport,
    csrfToken: 'test-csrf-token',
  });

  assert.ok(!html.includes('<script>alert("xss")</script>'), 'Unescaped script must not exist in rendered HTML');
  assert.ok(html.includes('&lt;script&gt;alert(&#34;xss&#34;)&lt;/script&gt;') || html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'), 'Name must be properly HTML-escaped');
  assert.ok(html.includes('Onboarding progress'), 'Header title rendered');
  assert.ok(html.includes('Stuck for more than 7 days'), '7 days filter button rendered');
  assert.ok(html.includes('btn-send-reminder'), 'Send reminder button rendered');
});

test('Phase 3 Fix - buildReminderClaimFilter mingo evaluation', async (t) => {
  const { Query } = require('mingo');
  const now = new Date('2026-10-10T00:00:00.000Z');
  const intervalDays = 3;
  const max = 3;
  const cutoff = new Date(now.getTime() - intervalDays * 24 * 60 * 60 * 1000); // 2026-10-07T00:00:00.000Z
  const userId = '670000000000000000000001';

  const filter = buildReminderClaimFilter({ userId, max, cutoff });
  const query = new Query(filter);

  // 1. no onboarding at all -> should receive reminder
  const docNoOnboarding = { _id: userId };
  assert.equal(query.test(docNoOnboarding), true, 'no onboarding at all should receive reminder');

  // 2. onboarding without reminders -> should receive reminder
  const docNoReminders = { _id: userId, onboarding: {} };
  assert.equal(query.test(docNoReminders), true, 'onboarding without reminders should receive reminder');

  // 3. reminders with stored defaults (count 0, lastSentAt null) -> should receive reminder
  const docDefaults = {
    _id: userId,
    onboarding: { reminders: { count: 0, lastSentAt: null } },
  };
  assert.equal(query.test(docDefaults), true, 'reminders with stored defaults should receive reminder');

  // 4. count equal to max -> should NOT receive reminder
  const docMaxCount = {
    _id: userId,
    onboarding: { reminders: { count: max, lastSentAt: new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000) } },
  };
  assert.equal(query.test(docMaxCount), false, 'count equal to max should NOT receive reminder');

  // 5. sent yesterday -> should NOT receive reminder
  const docSentYesterday = {
    _id: userId,
    onboarding: { reminders: { count: 1, lastSentAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000) } },
  };
  assert.equal(query.test(docSentYesterday), false, 'sent yesterday should NOT receive reminder');

  // 6. sent 4 days ago -> should receive reminder
  const docSent4DaysAgo = {
    _id: userId,
    onboarding: { reminders: { count: 1, lastSentAt: new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000) } },
  };
  assert.equal(query.test(docSent4DaysAgo), true, 'sent 4 days ago should receive reminder');

  // Admin claim filter evaluation
  const adminCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const adminFilter = buildAdminReminderClaimFilter({ userId, cutoff: adminCutoff });
  const adminQuery = new Query(adminFilter);

  assert.equal(adminQuery.test({ _id: userId }), true, 'admin: no reminders should match');
  assert.equal(adminQuery.test({ _id: userId, onboarding: { reminders: { lastAdminSentAt: null } } }), true, 'admin: null lastAdminSentAt should match');
  assert.equal(adminQuery.test({ _id: userId, onboarding: { reminders: { lastAdminSentAt: new Date(now.getTime() - 2 * 60 * 60 * 1000) } } }), false, 'admin: sent 2h ago should NOT match');
  assert.equal(adminQuery.test({ _id: userId, onboarding: { reminders: { lastAdminSentAt: new Date(now.getTime() - 25 * 60 * 60 * 1000) } } }), true, 'admin: sent 25h ago should match');
});

test('Phase 3 Fix - never decide from session snapshot and defensive checks', async (t) => {
  const fs = require('fs');
  const sessionSnapshot = {
    _id: '670000000000000000000001',
    username: 'testteacher',
    displayName: 'Test Teacher',
    role: 'teacher',
    profilePicture: null,
  };

  const activeState = {
    visible: true,
    isComplete: false,
    nextStep: { key: 'rewards', cta: { href: '/profile/edit' } },
  };

  // 1. shouldOfferTour returns false for every tour key with session snapshot
  for (const tourKey of ALLOWED_TOURS) {
    assert.equal(shouldOfferTour(sessionSnapshot, tourKey), false, `shouldOfferTour false for ${tourKey}`);
  }

  // 2. planOnboardingReminder returns send: false, reason: 'incomplete_user'
  const plan = planOnboardingReminder(sessionSnapshot, activeState);
  assert.equal(plan.send, false);
  assert.equal(plan.reason, 'incomplete_user');

  // 3. computeOnboardingState returns not-visible
  const computed = computeOnboardingState(sessionSnapshot, {});
  assert.equal(computed.visible, false);

  // 4. Real behavior with full documents is unchanged
  const fullTeacher = {
    _id: '670000000000000000000001',
    role: 'teacher',
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    onboarding: {
      startedAt: new Date('2026-10-01T00:00:00.000Z'),
      legacy: false,
      tours: new Map(),
      reminders: { count: 0, lastSentAt: null },
    },
  };
  for (const tourKey of ALLOWED_TOURS) {
    assert.equal(shouldOfferTour(fullTeacher, tourKey), true, `shouldOfferTour true for full user ${tourKey}`);
  }

  // 5. Source-level test: scan controllers/ and routes/ for onboardingService.<fn>(req.session.user)
  function scanDir(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        scanDir(fullPath);
      } else if (file.endsWith('.js')) {
        const content = fs.readFileSync(fullPath, 'utf8');
        const match = content.match(/onboardingService\.[a-zA-Z0-9_]+\s*\([^)]*req\.session\.user/);
        assert.equal(
          match,
          null,
          `File ${fullPath} passes req.session.user directly to onboardingService: ${match ? match[0] : ''}`
        );
      }
    }
  }

  scanDir(path.resolve('controllers'));
  scanDir(path.resolve('routes'));
});

test('Phase 3 Fix - admin reminder decision logic pure function and order', async (t) => {
  const teacher = {
    _id: '670000000000000000000001',
    role: 'teacher',
    onboarding: { reminders: { lastAdminSentAt: null } },
  };

  // Pure decision logic test:
  // 1. Complete teacher or no next step -> 400 "Teacher onboarding is complete or has no pending step."
  const completeState = { visible: false, isComplete: true, nextStep: null };
  const d1 = decideAdminReminder(teacher, completeState);
  assert.equal(d1.allowed, false);
  assert.equal(d1.status, 400);
  assert.equal(d1.error, 'Teacher onboarding is complete or has no pending step.');

  // 2. State with pending step and no previous admin reminder -> allowed: true
  const pendingState = { visible: true, isComplete: false, nextStep: { key: 'rewards' } };
  const d2 = decideAdminReminder(teacher, pendingState);
  assert.equal(d2.allowed, true);
  assert.equal(d2.step, 'rewards');

  // 3. Throttled teacher (sent 2 hours ago) -> allowed: false, 429
  const now = new Date('2026-10-10T12:00:00.000Z');
  const throttledTeacher = {
    ...teacher,
    onboarding: { reminders: { lastAdminSentAt: new Date(now.getTime() - 2 * 60 * 60 * 1000) } },
  };
  const d3 = decideAdminReminder(throttledTeacher, pendingState, now);
  assert.equal(d3.allowed, false);
  assert.equal(d3.status, 429);
  assert.equal(d3.reason, 'throttled_24h');

  // 4. Non-teacher -> 404
  const d4 = decideAdminReminder({ role: 'admin' }, pendingState, now);
  assert.equal(d4.allowed, false);
  assert.equal(d4.status, 404);
});

test('Phase 3 Fix - onboardingSendReminder controller order and rollback', async (t) => {
  const adminController = require('../controllers/adminController');
  const Notification = require('../models/Notification');
  const AuditLog = require('../models/AuditLog');

  const origFindById = User.findById;
  const origFindOneAndUpdate = User.findOneAndUpdate;
  const origUpdateOne = User.updateOne;
  const origNotifCreate = Notification.create;
  const origAuditCreate = AuditLog.create;
  const origReportCountDocuments = Report.countDocuments;

  t.after(() => {
    User.findById = origFindById;
    User.findOneAndUpdate = origFindOneAndUpdate;
    User.updateOne = origUpdateOne;
    Notification.create = origNotifCreate;
    AuditLog.create = origAuditCreate;
    Report.countDocuments = origReportCountDocuments;
  });

  Report.countDocuments = async () => 0;

  const teacherId = '670000000000000000000010';

  // Test 1: Completed teacher (no next step) -> 400 without claiming slot
  let findOneAndUpdateCalled = false;
  User.findById = async () => ({
    _id: teacherId,
    role: 'teacher',
    onboarding: {
      version: 1,
      startedAt: new Date('2026-10-01'),
      steps: new Map([
        ['profile', { doneAt: new Date() }],
        ['rewards', { doneAt: new Date() }],
        ['first_report', { doneAt: new Date() }],
        ['open_material', { doneAt: new Date() }],
        ['calculator', { doneAt: new Date() }],
        ['my_salary', { doneAt: new Date() }],
      ]),
      reminders: { lastAdminSentAt: null },
    },
  });
  User.findOneAndUpdate = async () => {
    findOneAndUpdateCalled = true;
    return {};
  };

  let statusCode = 200;
  let jsonResponse = null;
  const mockRes = {
    status(code) { statusCode = code; return this; },
    json(data) { jsonResponse = data; return this; },
  };
  const mockReq = {
    params: { userId: teacherId },
    session: { user: { _id: '670000000000000000000099', role: 'admin' } },
  };

  await adminController.onboardingSendReminder(mockReq, mockRes);
  assert.equal(statusCode, 400);
  assert.equal(jsonResponse.error, 'Teacher onboarding is complete or has no pending step.');
  assert.equal(findOneAndUpdateCalled, false, 'User.findOneAndUpdate must NOT be called when no pending step');

  // Test 2: Notification.create throws -> restores previous lastAdminSentAt and returns 500
  const prevDate = new Date('2026-10-01T00:00:00.000Z');
  let restoredValue = undefined;
  User.findById = async () => ({
    _id: teacherId,
    role: 'teacher',
    onboarding: {
      version: 1,
      startedAt: new Date('2026-10-01'),
      steps: new Map(),
      reminders: { lastAdminSentAt: prevDate },
    },
  });
  User.findOneAndUpdate = async () => ({
    _id: teacherId,
    onboarding: { reminders: { lastAdminSentAt: new Date() } },
  });
  User.updateOne = async (filter, update) => {
    restoredValue = update?.$set?.['onboarding.reminders.lastAdminSentAt'];
    return { acknowledged: true };
  };
  Notification.create = async () => {
    throw new Error('Database connection failed');
  };

  statusCode = 200;
  jsonResponse = null;
  await adminController.onboardingSendReminder(mockReq, mockRes);
  assert.equal(statusCode, 500);
  assert.equal(jsonResponse.error, 'Failed to send reminder.');
  assert.equal(restoredValue, prevDate, 'Previous lastAdminSentAt must be restored');
});



