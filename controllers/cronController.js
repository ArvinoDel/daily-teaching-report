'use strict';
/**
 * Cron Controller
 * ─────────────────────────────────────────────────────────────────────────────
 * Handlers for automated background tasks triggered by Vercel Cron.
 *
 * Requirements:
 *   - CRON_SECRET: Environment variable in Vercel. Vercel Cron automatically
 *     sends `Authorization: Bearer <CRON_SECRET>` when set.
 *   - Schedule: Defined in vercel.json in UTC. Saturday 17:00 UTC = Sunday 00:00 WIB (UTC+7).
 *
 * Testing locally:
 *   curl -H "Authorization: Bearer <your_secret>" http://localhost:3000/api/cron/backup
 * ─────────────────────────────────────────────────────────────────────────────
 */

const crypto = require('crypto');
const Backup = require('../models/Backup');
const backupService = require('../services/backupService');

/**
 * GET /api/cron/backup
 * Automated weekly backup triggered by Vercel Cron.
 */
exports.cronBackup = async (req, res) => {
  // 1. Verify CRON_SECRET is configured
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || !cronSecret.trim()) {
    return res.status(503).json({ ok: false, message: 'Cron not configured' });
  }

  // 2. Validate Authorization: Bearer <token>
  const authHeader = req.headers.authorization || req.get('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' });
  }

  const token = authHeader.slice(7).trim();
  const secretBuf = Buffer.from(cronSecret);
  const tokenBuf  = Buffer.from(token);

  if (secretBuf.length !== tokenBuf.length || !crypto.timingSafeEqual(secretBuf, tokenBuf)) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' });
  }

  // 3. Execute backup and measure duration
  const startTime = Date.now();
  try {
    const backup = await backupService.performBackup(null, 'System (Automated)', 'json_gz');
    await backupService.pruneOldAutomatedBackups();

    const durationMs = Date.now() - startTime;
    console.log(`[cron] Automated backup completed in ${durationMs}ms (ID: ${backup._id})`);

    if (durationMs > 40000) {
      console.warn(`[cron] Warning: Backup took ${durationMs}ms, approaching 60s function limit.`);
    }

    return res.status(200).json({
      ok: true,
      backupId: backup._id,
      fileSizeBytes: backup.fileSizeBytes,
      durationMs,
    });
  } catch (err) {
    const durationMs = Date.now() - startTime;
    console.error('[cron] Automated backup failed:', err.message);

    await Backup.create({
      initiatedBy:     null,
      initiatedByName: 'System (Automated)',
      status:          'failed',
      errorMessage:    backupService.sanitizeErrorMessage(err.message),
      recordCounts:    {},
    }).catch(() => {});

    return res.status(500).json({ ok: false, message: 'Backup failed' });
  }
};
