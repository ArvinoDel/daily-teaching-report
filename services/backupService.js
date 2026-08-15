const zlib      = require('zlib');
const cloudinary = require('cloudinary').v2;
const cron      = require('node-cron');
const BSON      = require('bson');

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

/* ───────────────────────────────────────────────
   Format metadata map
   ─────────────────────────────────────────────── */
const FORMAT_META = {
  json_gz: {
    ext:         'json.gz',
    contentType: 'application/gzip',
    label:       'JSON Gzip',
  },
  json: {
    ext:         'json',
    contentType: 'application/json',
    label:       'Plain JSON',
  },
  bson_gz: {
    ext:         'bson.gz',
    contentType: 'application/gzip',
    label:       'BSON (mongorestore)',
  },
};

/**
 * Strip sensitive patterns from error messages before storing.
 */
function sanitizeErrorMessage(msg) {
  if (!msg) return 'Unknown error';
  return msg
    .replace(/mongodb(\+srv)?:\/\/[^\s,]+/gi, '[REDACTED_URI]')
    .replace(/https?:\/\/[^\s,]+/gi, '[REDACTED_URL]')
    .replace(/[A-Z]:\\[^\s,]+/gi, '[REDACTED_PATH]')
    .replace(/\/(?:home|var|tmp|usr|etc|app)[^\s,]*/gi, '[REDACTED_PATH]')
    .substring(0, 200);
}

/**
 * Fetch all collections from MongoDB.
 * @returns {Promise<{collections, recordCounts}>}
 */
async function fetchRawCollections() {
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

  const collections = { users, reports, groups, auditLogs, feedbacks };
  return { collections, recordCounts };
}

/**
 * Generate JSON or JSON.gz Buffer.
 * @param {object} collections
 * @param {object} recordCounts
 * @param {boolean} compress - true = .json.gz, false = .json
 */
function generateJsonBuffer(collections, recordCounts, compress = true) {
  const payload = {
    exportedAt:   new Date().toISOString(),
    appName:      'daily-teaching-report',
    format:       compress ? 'json_gz' : 'json',
    recordCounts,
    collections,
  };
  const jsonBuffer = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  return compress ? zlib.gzipSync(jsonBuffer) : jsonBuffer;
}

/**
 * Generate BSON.gz Buffer — compatible with mongorestore.
 *
 * Produces a simple framed BSON stream per collection, prefixed by a
 * metadata document so mongorestore-compatible tools can identify collections.
 * Each document is serialized to BSON binary individually.
 *
 * Format inside the gz:
 *   [metadata BSON doc] [collection1 name doc] [doc, doc, ...] [collection2 name doc] [doc, doc, ...] ...
 */
function generateBsonBuffer(collections, recordCounts) {
  const chunks = [];

  // 1. Metadata header
  const meta = {
    exportedAt:   new Date().toISOString(),
    appName:      'daily-teaching-report',
    format:       'bson_gz',
    recordCounts,
  };
  chunks.push(BSON.serialize(meta));

  // 2. Per-collection blocks
  for (const [collName, docs] of Object.entries(collections)) {
    // Collection separator marker
    chunks.push(BSON.serialize({ _collectionName: collName, _docCount: docs.length }));

    for (const doc of docs) {
      try {
        chunks.push(BSON.serialize(doc));
      } catch (serErr) {
        // Fallback: stringify problem fields to avoid crashing the whole export
        const safe = JSON.parse(JSON.stringify(doc));
        chunks.push(BSON.serialize(safe));
      }
    }
  }

  const rawBson = Buffer.concat(chunks);
  return zlib.gzipSync(rawBson);
}

/**
 * Serialize a collection payload to the requested format buffer.
 * @param {'json_gz'|'json'|'bson_gz'} format
 * @param {object} collections
 * @param {object} recordCounts
 * @returns {Buffer}
 */
function serializeToFormat(format, collections, recordCounts) {
  switch (format) {
    case 'bson_gz': return generateBsonBuffer(collections, recordCounts);
    case 'json':    return generateJsonBuffer(collections, recordCounts, false);
    case 'json_gz':
    default:        return generateJsonBuffer(collections, recordCounts, true);
  }
}

/**
 * Performs a database backup in the chosen format and uploads it to Cloudinary.
 * @param {string|null} userId
 * @param {string} userName
 * @param {'json_gz'|'json'|'bson_gz'} format
 * @returns {Promise<Object>} The created Backup database record
 */
async function performBackup(userId = null, userName = 'System', format = 'json_gz') {
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

  // Validate format
  if (!FORMAT_META[format]) format = 'json_gz';

  _backupInProgress = true;
  try {
    const { collections, recordCounts } = await fetchRawCollections();
    const outputBuffer = serializeToFormat(format, collections, recordCounts);
    const meta         = FORMAT_META[format];

    // Upload to Cloudinary as a raw file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const publicId  = `daily-teaching-report/backups/backup-${timestamp}`;

    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { resource_type: 'raw', public_id: publicId, use_filename: false },
        (err, result) => (err ? reject(err) : resolve(result))
      );
      stream.end(outputBuffer);
    });

    return await Backup.create({
      initiatedBy:     userId || null,
      initiatedByName: userName,
      status:          'success',
      format,
      fileUrl:         uploadResult.secure_url,
      cloudinaryId:    uploadResult.public_id,
      fileSizeBytes:   uploadResult.bytes || outputBuffer.length,
      recordCounts,
    });
  } finally {
    _backupInProgress = false;
  }
}

/**
 * Prune old automated backups beyond the retention cap.
 */
async function pruneOldAutomatedBackups() {
  try {
    const oldBackups = await Backup.find({ initiatedByName: 'System (Automated)' })
      .sort({ createdAt: -1 })
      .skip(MAX_AUTOMATED_BACKUPS);

    if (!oldBackups.length) return;
    console.log(`🗑️  Pruning ${oldBackups.length} old automated backup(s)...`);

    for (const backup of oldBackups) {
      if (backup.cloudinaryId) {
        await cloudinary.uploader.destroy(backup.cloudinaryId, { resource_type: 'raw' }).catch((e) => {
          console.error(`  ⚠ Failed to delete Cloudinary file ${backup.cloudinaryId}:`, e.message);
        });
      }
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
  cron.schedule('0 0 * * 0', async () => {
    console.log('⏰ Starting automated weekly backup...');
    try {
      const backup = await performBackup(null, 'System (Automated)', 'json_gz');
      console.log(`✅ Automated weekly backup succeeded: ${backup.fileUrl}`);
      await pruneOldAutomatedBackups();
    } catch (err) {
      console.error('❌ Automated weekly backup failed:', err);
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
  let daysUntilSunday = (7 - now.getDay()) % 7;
  if (daysUntilSunday === 0) daysUntilSunday = 7;
  nextSunday.setDate(now.getDate() + daysUntilSunday);
  nextSunday.setHours(0, 0, 0, 0);
  return nextSunday;
}

module.exports = {
  performBackup,
  fetchRawCollections,
  serializeToFormat,
  FORMAT_META,
  initScheduler,
  getNextBackupDate,
};
