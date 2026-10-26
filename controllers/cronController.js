'use strict';
/**
 * Cron Controller
 * ─────────────────────────────────────────────────────────────────────────────
 * Handlers for automated background tasks triggered by Vercel Cron.
 *
 * Requirements:
 *   - CRON_SECRET: Environment variable in Vercel. Vercel Cron automatically
 *     sends `Authorization: Bearer <CRON_SECRET>` when set.
 *   - Schedule: Defined in vercel.json in UTC.
 *     - Backup: Saturday 17:00 UTC = Sunday 00:00 WIB (UTC+7).
 *     - Cleanup: Daily 18:30 UTC = 01:30 WIB (UTC+7).
 *
 * Testing locally:
 *   curl -H "Authorization: Bearer <your_secret>" http://localhost:3000/api/cron/backup
 *   curl -H "Authorization: Bearer <your_secret>" http://localhost:3000/api/cron/backup-cleanup
 * ─────────────────────────────────────────────────────────────────────────────
 */

const crypto = require('crypto');
const Backup = require('../models/Backup');
const backupService = require('../services/backupService');

/**
 * Validates the Authorization header against CRON_SECRET using timing-safe comparison.
 * Returns true if valid, or writes error response and returns false.
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @returns {boolean}
 */
function verifyCronSecret(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || !cronSecret.trim()) {
    res.status(503).json({ ok: false, message: 'Cron not configured' });
    return false;
  }

  const authHeader = req.headers.authorization || (typeof req.get === 'function' ? req.get('authorization') : '') || '';
  if (!authHeader.startsWith('Bearer ')) {
    res.status(401).json({ ok: false, message: 'Unauthorized' });
    return false;
  }

  const token = authHeader.slice(7).trim();
  const secretBuf = Buffer.from(cronSecret);
  const tokenBuf  = Buffer.from(token);

  if (secretBuf.length !== tokenBuf.length || !crypto.timingSafeEqual(secretBuf, tokenBuf)) {
    res.status(401).json({ ok: false, message: 'Unauthorized' });
    return false;
  }

  return true;
}

/**
 * GET /api/cron/backup
 * Automated weekly backup triggered by Vercel Cron.
 * Runs retention cleanup in finally block to ensure retention even on single-cron plans.
 */
exports.cronBackup = async (req, res) => {
  if (!verifyCronSecret(req, res)) return;

  const startTime = Date.now();
  let backup = null;
  let backupErr = null;

  try {
    backup = await backupService.performBackup(null, 'System (Automated)', 'json_gz');
  } catch (err) {
    backupErr = err;
    console.error('[cron] Automated backup failed:', err.message);

    await Backup.create({
      initiatedBy:     null,
      initiatedByName: 'System (Automated)',
      status:          'failed',
      errorMessage:    backupService.sanitizeErrorMessage(err.message),
      recordCounts:    {},
    }).catch(() => {});
  } finally {
    try {
      await backupService.pruneExpiredBackups();
    } catch (e) {
      console.error('[cron] Retention cleanup error (non-fatal):', e.message);
    }
  }

  const durationMs = Date.now() - startTime;
  if (backupErr) {
    return res.status(500).json({ ok: false, message: 'Backup failed', durationMs });
  }

  console.log(`[cron] Automated backup completed in ${durationMs}ms (ID: ${backup._id})`);
  if (durationMs > 40000) {
    console.warn(`[cron] Warning: Backup took ${durationMs}ms, approaching 60s function limit.`);
  }

  return res.status(200).json({
    ok: true,
    backupId: backup._id,
    fileSizeBytes: backup.fileSizeBytes,
    checksum: backup.checksum,
    durationMs,
  });
};

/**
 * GET /api/cron/backup-cleanup
 * Automated daily backup cleanup triggered by Vercel Cron.
 */
exports.cronCleanup = async (req, res) => {
  if (!verifyCronSecret(req, res)) return;

  const startTime = Date.now();
  try {
    const result = await backupService.pruneExpiredBackups();
    const durationMs = Date.now() - startTime;
    console.log(`[cron] Scheduled cleanup completed in ${durationMs}ms`);

    return res.status(200).json({
      ok: true,
      result,
      durationMs,
    });
  } catch (err) {
    console.error('[cron] Scheduled cleanup failed:', err.message);
    return res.status(500).json({ ok: false, message: 'Cleanup failed' });
  }
};

exports.verifyCronSecret = verifyCronSecret;
