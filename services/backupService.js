const zlib = require('zlib');
const cloudinary = require('cloudinary').v2;
const cron = require('node-cron');

const User     = require('../models/User');
const Report   = require('../models/Report');
const Group    = require('../models/Group');
const AuditLog = require('../models/AuditLog');
const Feedback = require('../models/Feedback');
const Backup   = require('../models/Backup');

// Configure Cloudinary using env variables
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/* ───────────────────────────────────────────────
   Concurrency lock — prevents parallel backups
   from doubling memory usage and crashing Node.
   ─────────────────────────────────────────────── */
let _backupInProgress = false;

/* ───────────────────────────────────────────────
   Memory guard — abort before OOM on large DBs.
   Default threshold: 512 MB heap used.
   ─────────────────────────────────────────────── */
const HEAP_LIMIT_BYTES = 512 * 1024 * 1024; // 512 MB

/* ───────────────────────────────────────────────
   Retention — keep at most N automated backups.
   Older ones are deleted from Cloudinary + DB.
   ─────────────────────────────────────────────── */
const MAX_AUTOMATED_BACKUPS = 12; // ~3 months of weekly backups

/**
 * Strip sensitive patterns from error messages before storing.
 * Removes URIs, connection strings, API keys, and file paths.
 * @param {string} msg
 * @returns {string}
 */
function sanitizeErrorMessage(msg) {
  if (!msg) return 'Unknown error';
  return msg
    // Strip MongoDB connection strings
    .replace(/mongodb(\+srv)?:\/\/[^\s,]+/gi, '[REDACTED_URI]')
    // Strip URLs with credentials
    .replace(/https?:\/\/[^\s,]+/gi, '[REDACTED_URL]')
    // Strip Windows/Unix file paths
    .replace(/[A-Z]:\\[^\s,]+/gi, '[REDACTED_PATH]')
    .replace(/\/(?:home|var|tmp|usr|etc|app)[^\s,]*/gi, '[REDACTED_PATH]')
    // Truncate to 200 chars max
    .substring(0, 200);
}

/**
 * Performs database backup and uploads it to Cloudinary as a gzip file.
 * @param {string|null} userId - The ID of the user who initiated the backup (null for System)
 * @param {string} userName - The name of the initiator (e.g. "System")
 * @returns {Promise<Object>} The created Backup database record
 * @throws {Error} If a backup is already in progress or memory usage is too high
 */
async function performBackup(userId = null, userName = 'System') {
  // ── Concurrency guard ──
  if (_backupInProgress) {
    throw new Error('A backup is already in progress. Please wait and try again.');
  }

  // ── Memory guard ──
  const heapUsed = process.memoryUsage().heapUsed;
  if (heapUsed > HEAP_LIMIT_BYTES) {
    throw new Error(
      `Server memory usage is too high (${Math.round(heapUsed / 1024 / 1024)}MB). ` +
      'Backup aborted to prevent a crash. Please try again later.'
    );
  }

  _backupInProgress = true;
  try {
    // Fetch all collections
    const [users, reports, groups, auditLogs, feedbacks] = await Promise.all([
      User.find().lean(),
      Report.find().lean(),
      Group.find().lean(),
      AuditLog.find().lean(),
      Feedback.find().lean(),
    ]);

    const recordCounts = {
      users:     users.length,
      reports:   reports.length,
      groups:    groups.length,
      auditLogs: auditLogs.length,
      feedbacks: feedbacks.length,
    };

    const backupPayload = {
      exportedAt: new Date().toISOString(),
      appName:    'daily-teaching-report',
      recordCounts,
      collections: { users, reports, groups, auditLogs, feedbacks },
    };

    // Compress payload to gzip
    const jsonBuffer = Buffer.from(JSON.stringify(backupPayload), 'utf8');
    const gzipped    = zlib.gzipSync(jsonBuffer);

    // Upload to Cloudinary as a raw file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const publicId  = `daily-teaching-report/backups/backup-${timestamp}`;

    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { resource_type: 'raw', public_id: publicId, use_filename: false },
        (err, result) => (err ? reject(err) : resolve(result))
      );
      stream.end(gzipped);
    });

    return await Backup.create({
      initiatedBy:     userId || null,
      initiatedByName: userName,
      status:          'success',
      fileUrl:         uploadResult.secure_url,
      cloudinaryId:    uploadResult.public_id,
      fileSizeBytes:   uploadResult.bytes || gzipped.length,
      recordCounts,
    });
  } finally {
    // Always release the lock, even on error
    _backupInProgress = false;
  }
}

/**
 * Prune old automated backups beyond the retention cap.
 * Deletes both the Cloudinary file and the DB record.
 */
async function pruneOldAutomatedBackups() {
  try {
    const oldBackups = await Backup.find({ initiatedByName: 'System (Automated)' })
      .sort({ createdAt: -1 })
      .skip(MAX_AUTOMATED_BACKUPS);

    if (!oldBackups.length) return;

    console.log(`🗑️  Pruning ${oldBackups.length} old automated backup(s)...`);

    for (const backup of oldBackups) {
      // Delete file from Cloudinary
      if (backup.cloudinaryId) {
        await cloudinary.uploader.destroy(backup.cloudinaryId, { resource_type: 'raw' }).catch((e) => {
          console.error(`  ⚠ Failed to delete Cloudinary file ${backup.cloudinaryId}:`, e.message);
        });
      }
      // Delete the DB record
      await backup.deleteOne();
    }

    console.log(`✅ Pruned ${oldBackups.length} old automated backup(s).`);
  } catch (err) {
    console.error('⚠ Retention cleanup error (non-fatal):', err.message);
  }
}

/**
 * Initializes the weekly backup cron scheduler.
 * Runs every Sunday at 00:00 (midnight).
 */
function initScheduler() {
  // '0 0 * * 0' represents Sunday at 00:00
  cron.schedule('0 0 * * 0', async () => {
    console.log('⏰ Starting automated weekly backup...');
    try {
      const backup = await performBackup(null, 'System (Automated)');
      console.log(`✅ Automated weekly backup succeeded: ${backup.fileUrl}`);

      // Clean up old automated backups beyond retention cap
      await pruneOldAutomatedBackups();
    } catch (err) {
      console.error('❌ Automated weekly backup failed:', err);
      // Record failed backup in database with sanitized error
      await Backup.create({
        initiatedBy:     null,
        initiatedByName: 'System (Automated)',
        status:          'failed',
        errorMessage:    sanitizeErrorMessage(err.message),
        recordCounts:    {},
      }).catch(() => {});
    }
  });
  console.log('⏰ Weekly backup scheduler initialized (Sunday at 00:00).');
}

/**
 * Calculates the next backup run time (next Sunday at 00:00).
 * @returns {Date}
 */
function getNextBackupDate() {
  const now = new Date();
  const nextSunday = new Date(now);
  // Calculate days until next Sunday
  // (7 - now.getDay()) % 7 calculates days until Sunday, but if today is Sunday, we want the next Sunday (+7 days)
  let daysUntilSunday = (7 - now.getDay()) % 7;
  if (daysUntilSunday === 0) {
    daysUntilSunday = 7;
  }
  nextSunday.setDate(now.getDate() + daysUntilSunday);
  nextSunday.setHours(0, 0, 0, 0);

  return nextSunday;
}

module.exports = {
  performBackup,
  initScheduler,
  getNextBackupDate,
};
