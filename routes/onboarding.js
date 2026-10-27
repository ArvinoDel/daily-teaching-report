'use strict';

/**
 * routes/onboarding.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Teacher Onboarding Routes
 *
 * GET  /getting-started            → Full checklist page
 * POST /onboarding/steps/:key/done → Mark visit step as done
 * POST /onboarding/steps/:key/skip → Skip optional step
 * POST /onboarding/dismiss        → Hide onboarding card
 * POST /onboarding/restore        → Show onboarding card again
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');
const {
  computeOnboardingState,
  getFacts,
  persistDerivedSteps,
  markStepDone,
  skipStep,
  dismiss,
  restore,
} = require('../services/onboardingService');

router.use(requireAuth);

/**
 * GET /onboarding/state
 * Returns computed onboarding state as JSON (for real-time dashboard updates).
 */
router.get('/onboarding/state', async (req, res) => {
  try {
    const sessionUser = req.session.user;
    if (!sessionUser || sessionUser.role !== 'teacher') {
      return res.json({ ok: true, state: { visible: false, isComplete: true } });
    }

    const user = await User.findById(sessionUser._id);
    if (!user) {
      return res.json({ ok: true, state: { visible: false, isComplete: true } });
    }

    const facts = await getFacts(user);
    const state = computeOnboardingState(user, facts);
    await persistDerivedSteps(user, state);

    res.json({ ok: true, state });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /getting-started
 * Renders the onboarding checklist page. Only accessible by teachers.
 */
router.get('/getting-started', async (req, res) => {
  try {
    const sessionUser = req.session.user;
    if (!sessionUser || sessionUser.role !== 'teacher') {
      return res.redirect('/reports');
    }

    const user = await User.findById(sessionUser._id);
    if (!user) return res.redirect('/reports');

    const facts = await getFacts(user);
    const state = computeOnboardingState(user, facts);
    await persistDerivedSteps(user, state);

    res.render('onboarding/index', {
      title: 'Getting Started',
      state,
      user,
    });
  } catch (err) {
    console.error('[onboarding] /getting-started error:', err);
    res.status(500).render('error', { message: 'Failed to load getting started page.' });
  }
});

/**
 * POST /onboarding/steps/:key/done
 * Marks a visit step as completed.
 */
router.post('/onboarding/steps/:key/done', async (req, res) => {
  try {
    const sessionUser = req.session.user;
    if (!sessionUser || sessionUser.role !== 'teacher') {
      return res.status(403).json({ ok: false, error: 'Only teachers can update onboarding steps.' });
    }

    const { key } = req.params;
    await markStepDone(sessionUser._id, key);

    const user = await User.findById(sessionUser._id);
    const facts = await getFacts(user);
    const state = computeOnboardingState(user, facts);
    await persistDerivedSteps(user, state);

    res.json({ ok: true, state });
  } catch (err) {
    const statusCode = err.status || 500;
    res.status(statusCode).json({ ok: false, error: err.message || 'Failed to mark step done.' });
  }
});

/**
 * POST /onboarding/steps/:key/skip
 * Skips an optional step.
 */
router.post('/onboarding/steps/:key/skip', async (req, res) => {
  try {
    const sessionUser = req.session.user;
    if (!sessionUser || sessionUser.role !== 'teacher') {
      return res.status(403).json({ ok: false, error: 'Only teachers can update onboarding steps.' });
    }

    const { key } = req.params;
    await skipStep(sessionUser._id, key);

    const user = await User.findById(sessionUser._id);
    const facts = await getFacts(user);
    const state = computeOnboardingState(user, facts);
    await persistDerivedSteps(user, state);

    res.json({ ok: true, state });
  } catch (err) {
    const statusCode = err.status || 500;
    res.status(statusCode).json({ ok: false, error: err.message || 'Failed to skip step.' });
  }
});

/**
 * POST /onboarding/dismiss
 * Hides the card on the dashboard.
 */
router.post('/onboarding/dismiss', async (req, res) => {
  try {
    const sessionUser = req.session.user;
    if (!sessionUser || sessionUser.role !== 'teacher') {
      return res.status(403).json({ ok: false, error: 'Only teachers can dismiss onboarding.' });
    }

    await dismiss(sessionUser._id);

    const user = await User.findById(sessionUser._id);
    const facts = await getFacts(user);
    const state = computeOnboardingState(user, facts);

    res.json({ ok: true, state });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Failed to dismiss onboarding.' });
  }
});

/**
 * POST /onboarding/restore
 * Restores the card to appear on the dashboard again.
 */
router.post('/onboarding/restore', async (req, res) => {
  try {
    const sessionUser = req.session.user;
    if (!sessionUser || sessionUser.role !== 'teacher') {
      return res.status(403).json({ ok: false, error: 'Only teachers can restore onboarding.' });
    }

    await restore(sessionUser._id);

    const user = await User.findById(sessionUser._id);
    const facts = await getFacts(user);
    const state = computeOnboardingState(user, facts);

    res.json({ ok: true, state });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Failed to restore onboarding.' });
  }
});

module.exports = router;
