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


