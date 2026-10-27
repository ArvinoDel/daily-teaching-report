'use strict';

/**
 * routes/onboarding.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Teacher Onboarding Routes
 *
 * GET  /getting-started            → Full checklist page
 * GET  /onboarding/state           → Current computed onboarding state JSON
 * POST /onboarding/steps/:key/done → Mark visit step as done
 * POST /onboarding/steps/:key/skip → Skip optional step
 * POST /onboarding/dismiss        → Hide onboarding card
 * POST /onboarding/restore        → Show onboarding card again
 * POST /onboarding/tours/:key/seen → Record tour started / seen
 * POST /onboarding/tours/:key/done → Record tour completed
 * POST /onboarding/tours/:key/dismiss → Record tour dismissed (no thanks)
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
  ALLOWED_TOURS,
  recordTourSeen,
  recordTourCompleted,
  recordTourDismissed,
} = require('../services/onboardingService');

// Scope auth middleware only to onboarding paths so subsequent routes retain 404 behavior for anonymous users
router.use(['/getting-started', '/onboarding'], requireAuth);

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
    console.error('[onboarding] /onboarding/state error:', err);
    res.status(500).json({ ok: false, error: 'Failed to retrieve onboarding state.' });
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
    console.error('[onboarding] /onboarding/steps/:key/done error:', err);
    const statusCode = err.status || 500;
    const msg = statusCode < 500 ? (err.message || 'Client error') : 'Failed to mark step done.';
    res.status(statusCode).json({ ok: false, error: msg });
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
    console.error('[onboarding] /onboarding/steps/:key/skip error:', err);
    const statusCode = err.status || 500;
    const msg = statusCode < 500 ? (err.message || 'Client error') : 'Failed to skip step.';
    res.status(statusCode).json({ ok: false, error: msg });
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
    console.error('[onboarding] /onboarding/dismiss error:', err);
    res.status(500).json({ ok: false, error: 'Failed to dismiss onboarding.' });
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
    console.error('[onboarding] /onboarding/restore error:', err);
    res.status(500).json({ ok: false, error: 'Failed to restore onboarding.' });
  }
});

/**
 * POST /onboarding/tours/:key/seen
 * Records that a tour was seen or closed mid-tour.
 */
router.post('/onboarding/tours/:key/seen', async (req, res) => {
  try {
    const sessionUser = req.session.user;
    if (!sessionUser || sessionUser.role !== 'teacher') {
      return res.status(403).json({ ok: false, error: 'Only teachers can update tour progress.' });
    }

    const { key } = req.params;
    if (!ALLOWED_TOURS.includes(key)) {
      return res.status(400).json({ ok: false, error: 'Unknown tour key.' });
    }

    await recordTourSeen(sessionUser._id, key);
    res.json({ ok: true });
  } catch (err) {
    console.error('[onboarding] /onboarding/tours/:key/seen error:', err);
    res.status(500).json({ ok: false, error: 'Failed to record tour.' });
  }
});

/**
 * POST /onboarding/tours/:key/done
 * Records that a tour was completed.
 */
router.post('/onboarding/tours/:key/done', async (req, res) => {
  try {
    const sessionUser = req.session.user;
    if (!sessionUser || sessionUser.role !== 'teacher') {
      return res.status(403).json({ ok: false, error: 'Only teachers can update tour progress.' });
    }

    const { key } = req.params;
    if (!ALLOWED_TOURS.includes(key)) {
      return res.status(400).json({ ok: false, error: 'Unknown tour key.' });
    }

    await recordTourCompleted(sessionUser._id, key);
    res.json({ ok: true });
  } catch (err) {
    console.error('[onboarding] /onboarding/tours/:key/done error:', err);
    res.status(500).json({ ok: false, error: 'Failed to record tour completion.' });
  }
});

/**
 * POST /onboarding/tours/:key/dismiss
 * Records that a tour was declined on offer ("No thanks").
 */
router.post('/onboarding/tours/:key/dismiss', async (req, res) => {
  try {
    const sessionUser = req.session.user;
    if (!sessionUser || sessionUser.role !== 'teacher') {
      return res.status(403).json({ ok: false, error: 'Only teachers can update tour progress.' });
    }

    const { key } = req.params;
    if (!ALLOWED_TOURS.includes(key)) {
      return res.status(400).json({ ok: false, error: 'Unknown tour key.' });
    }

    await recordTourDismissed(sessionUser._id, key);
    res.json({ ok: true });
  } catch (err) {
    console.error('[onboarding] /onboarding/tours/:key/dismiss error:', err);
    res.status(500).json({ ok: false, error: 'Failed to dismiss tour.' });
  }
});

module.exports = router;
