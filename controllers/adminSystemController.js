'use strict';

const cloudinary = require('cloudinary').v2;
const AuditLog = require('../models/AuditLog');
const backupService = require('../services/backupService');
const systemHealthService = require('../services/systemHealthService');

// Configure Cloudinary from environment
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const RATE_LIMIT_MS = 60 * 1000;
let lastCloudinaryTestAt = 0;
let lastCleanupPreviewAt = 0;

/**
 * Resets rate limits (used in unit tests)
 */
function _resetRateLimits() {
  lastCloudinaryTestAt = 0;
  lastCleanupPreviewAt = 0;
}

/**
 * GET /admin/system (superadmin only)
 * Renders the System Health diagnostic page.
 * Cache-Control: no-store
 */
exports.systemHealthIndex = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const data = await systemHealthService.getSystemHealthData();

    res.render('admin/system/index', {
      title: 'System Health',
      path: '/admin/system',
      health: data.health,
      backups: data.backups,
      cronStatus: data.cronStatus,
      envItems: data.envItems,
      runtime: data.runtime,
    });
  } catch (err) {
    console.error('systemHealthIndex error:', err);
    res.status(500).render('error', { message: 'Failed to retrieve system health diagnostics.' });
  }
};

/**
 * POST /admin/system/test-cloudinary (superadmin only)
 * Tests connectivity and credentials with Cloudinary via ping().
 * Rate limited to once per minute.
 */
exports.testCloudinary = async (req, res) => {
  const now = Date.now();
  if (now - lastCloudinaryTestAt < RATE_LIMIT_MS) {
    const remainingSec = Math.ceil((RATE_LIMIT_MS - (now - lastCloudinaryTestAt)) / 1000);
    return res.status(429).json({
      ok: false,
      message: `Please wait ${remainingSec}s before testing Cloudinary again.`,
    });
  }
  lastCloudinaryTestAt = now;

  const adminId = req.session?.user?._id;
  const adminName = req.session?.user?.displayName || req.session?.user?.username || 'Superadmin';

  try {
    const result = await cloudinary.api.ping();
    const isOk = result && (result.status === 'ok' || result.status === 200 || result.ok === true);

    try {
      await AuditLog.create({
        admin: adminId,
        adminName,
        action: 'system_test_cloudinary',
        targetType: 'system',
        targetId: null,
        targetLabel: 'Cloudinary API',
        meta: { ok: Boolean(isOk) },
      });
    } catch (auditErr) {
      console.error('AuditLog creation error for system_test_cloudinary:', auditErr);
    }

    if (isOk) {
      return res.json({
        ok: true,
        message: 'Cloudinary connection is healthy and responsive.',
      });
    }

    return res.status(502).json({
      ok: false,
      message: 'Cloudinary returned an unexpected status during test.',
    });
  } catch (err) {
    console.error('Cloudinary ping test failed:', err);

    try {
      await AuditLog.create({
        admin: adminId,
        adminName,
        action: 'system_test_cloudinary',
        targetType: 'system',
        targetId: null,
        targetLabel: 'Cloudinary API',
        meta: { ok: false },
      });
    } catch (auditErr) {
      console.error('AuditLog creation error for failed system_test_cloudinary:', auditErr);
    }

    return res.status(500).json({
      ok: false,
      message: 'Cloudinary connection test failed. Check cloud storage configuration.',
    });
  }
};

/**
 * POST /admin/system/cleanup-preview (superadmin only)
 * Runs backup cleanup in dry-run mode and returns summary counts.
 * Rate limited to once per minute.
 */
exports.cleanupPreview = async (req, res) => {
  const now = Date.now();
  if (now - lastCleanupPreviewAt < RATE_LIMIT_MS) {
    const remainingSec = Math.ceil((RATE_LIMIT_MS - (now - lastCleanupPreviewAt)) / 1000);
    return res.status(429).json({
      ok: false,
      message: `Please wait ${remainingSec}s before running cleanup preview again.`,
    });
  }
  lastCleanupPreviewAt = now;

  const adminId = req.session?.user?._id;
  const adminName = req.session?.user?.displayName || req.session?.user?.username || 'Superadmin';

  try {
    const result = await backupService.pruneExpiredBackups({ dryRun: true });

    const expiredCount = Number(result?.expiredCount || result?.deletedCount || 0);
    const orphanCount = Number(result?.orphanCount || 0);
    const wouldDeleteCount = expiredCount + orphanCount;

    try {
      await AuditLog.create({
        admin: adminId,
        adminName,
        action: 'system_cleanup_preview',
        targetType: 'system',
        targetId: null,
        targetLabel: 'Backup Cleanup Preview',
        meta: {
          expiredCount,
          orphanCount,
          wouldDeleteCount,
        },
      });
    } catch (auditErr) {
      console.error('AuditLog creation error for system_cleanup_preview:', auditErr);
    }

    return res.json({
      ok: true,
      message: 'Cleanup preview completed successfully.',
      summary: {
        expiredCount,
        orphanCount,
        wouldDeleteCount,
      },
    });
  } catch (err) {
    console.error('Cleanup preview failed:', err);

    return res.status(500).json({
      ok: false,
      message: 'Cleanup preview failed to complete.',
    });
  }
};

exports._resetRateLimits = _resetRateLimits;

