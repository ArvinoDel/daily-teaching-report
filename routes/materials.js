'use strict';

/**
 * routes/materials.js
 *
 * Router mounted at /materials with requireAuth.
 * Handles the materials library, material reader, editor, revisions,
 * lock toggles, signed uploads, and resource access.
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const ctrl = require('../controllers/materialContentController');
const { requireAuth } = require('../middleware/auth');
const { trackOnboardingVisit } = require('../services/onboardingService');

router.use(requireAuth);

const signLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 mins
  max: 60,
  message: { error: 'Too many upload requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Library
router.get('/', ctrl.materialsLibrary);

// History & Restore (admin only inside controller)
router.get('/:id/history', ctrl.getHistory);
router.post('/:id/history/:version/restore', ctrl.restoreRevision);

// Lock toggle (admin only inside controller)
router.post('/:id/lock', ctrl.toggleLock);

// Upload signature & resource management
router.post('/:id/uploads/sign', signLimiter, ctrl.signUpload);
router.post('/:id/resources', ctrl.addResource);
router.delete('/:id/resources/:rid', ctrl.removeResource);
router.get('/:id/resources/:rid/open', ctrl.openResource);

// Editor
router.get('/:id/edit', ctrl.editMaterial);

// Read page
router.get('/:id', trackOnboardingVisit('open_material'), ctrl.showMaterial);

// Save content (AJAX JSON)
router.post('/:id', ctrl.saveMaterial);

module.exports = router;
