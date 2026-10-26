'use strict';

const zlib       = require('zlib');
const crypto     = require('crypto');
const { Readable, PassThrough } = require('stream');
const cloudinary = require('cloudinary').v2;
const cron       = require('node-cron');
const BSON       = require('bson');

const User                    = require('../models/User');
const Report                  = require('../models/Report');
const Group                   = require('../models/Group');
const AuditLog                = require('../models/AuditLog');
const Feedback                = require('../models/Feedback');
const Backup                  = require('../models/Backup');
const Material                = require('../models/Material');
const MaterialAlias           = require('../models/MaterialAlias');
const MaterialContent         = require('../models/MaterialContent');
const MaterialContentRevision = require('../models/MaterialContentRevision');
const Salary                  = require('../models/Salary');
const Student                 = require('../models/Student');
const AcTransaction           = require('../models/AcTransaction');
const Notification            = require('../models/Notification');

// Configure Cloudinary using env variables
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/* ───────────────────────────────────────────────
   Explicit Backup Registry & Excluded Models
   ─────────────────────────────────────────────── */
const BACKUP_COLLECTIONS = [
  { key: 'users',                    model: User,                    modelName: 'User' },
  { key: 'reports',                  model: Report,                  modelName: 'Report' },
  { key: 'groups',                   model: Group,                   modelName: 'Group' },
  { key: 'auditLogs',                model: AuditLog,                modelName: 'AuditLog' },
  { key: 'feedbacks',                model: Feedback,                modelName: 'Feedback' },
  { key: 'materials',                model: Material,                modelName: 'Material' },
  { key: 'materialAliases',          model: MaterialAlias,           modelName: 'MaterialAlias' },
  { key: 'materialContents',         model: MaterialContent,         modelName: 'MaterialContent' },
  { key: 'materialContentRevisions', model: MaterialContentRevision, modelName: 'MaterialContentRevision' },
  { key: 'salaries',                 model: Salary,                  modelName: 'Salary' },
  { key: 'students',                 model: Student,                 modelName: 'Student' },
  { key: 'acTransactions',           model: AcTransaction,           modelName: 'AcTransaction' },
  { key: 'notifications',            model: Notification,            modelName: 'Notification' },
];

const EXCLUDED_MODELS = {
  Backup: 'Backup stores metadata about the backup archives themselves; backing it up into backups would be circular and redundant.',
};

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
   Retention Configuration
   ─────────────────────────────────────────────── */
const DEFAULT_RETENTION_DAYS = 60; // 2 months

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
  return String(msg)
    .replace(/mongodb(\+srv)?:\/\/[^\s,]+/gi, '[REDACTED_URI]')
    .replace(/https?:\/\/[^\s,]+/gi, '[REDACTED_URL]')
    .replace(/[A-Z]:\\[^\s,]+/gi, '[REDACTED_PATH]')
    .replace(/\/(?:home|var|tmp|usr|etc|app)[^\s,]*/gi, '[REDACTED_PATH]')
    .substring(0, 200);
}

/**
 * Computes record counts for all registered collections without loading documents into memory.
 * @param {Array} registry
 * @returns {Promise<Object>}
 */
async function getRecordCounts(registry = BACKUP_COLLECTIONS) {
  const counts = {};
  await Promise.all(
    registry.map(async ({ key, model }) => {
      try {
        if (model && typeof model.countDocuments === 'function') {
          counts[key] = await model.countDocuments();
        } else if (Array.isArray(model)) {
          counts[key] = model.length;
        } else {
          counts[key] = 0;
        }
      } catch (err) {
        console.error(`Failed to count records for ${key}:`, err.message);
        counts[key] = 0;
      }
    })
  );
  return counts;
}

/**
 * Fetch all collections from MongoDB (legacy helper, backward compatible).
 * @param {Array} registry
 * @returns {Promise<{collections: Object, recordCounts: Object}>}
 */
async function fetchRawCollections(registry = BACKUP_COLLECTIONS) {
  const results = await Promise.all(
    registry.map(async ({ key, model }) => {
      let docs = [];
      if (model && typeof model.find === 'function') {
        docs = await model.find().lean();
      } else if (Array.isArray(model)) {
        docs = model;
      }
      return [key, docs];
    })
  );

  const collections = {};
  const recordCounts = {};
  for (const [key, docs] of results) {
    collections[key] = docs;
    recordCounts[key] = docs.length;
  }
  return { collections, recordCounts };
}

/**
 * Async generator that yields JSON chunks incrementally for memory-efficient streaming.
 */
async function* generateJsonChunks(registry, recordCounts, format, exportedAt) {
  const header = `{"exportedAt":${JSON.stringify(exportedAt)},"appName":"daily-teaching-report","format":${JSON.stringify(format)},"recordCounts":${JSON.stringify(recordCounts)},"collections":{`;
  yield Buffer.from(header, 'utf8');

  for (let cIdx = 0; cIdx < registry.length; cIdx++) {
    const { key, model } = registry[cIdx];
    const prefix = `${cIdx > 0 ? ',' : ''}${JSON.stringify(key)}:[`;
    yield Buffer.from(prefix, 'utf8');

    let isFirstDoc = true;
    if (Array.isArray(model)) {
      for (const doc of model) {
        const itemStr = (isFirstDoc ? '' : ',') + JSON.stringify(doc);
        yield Buffer.from(itemStr, 'utf8');
        isFirstDoc = false;
      }
    } else if (model && typeof model.find === 'function') {
      const cursor = model.find().lean().cursor();
      for await (const doc of cursor) {
        const itemStr = (isFirstDoc ? '' : ',') + JSON.stringify(doc);
        yield Buffer.from(itemStr, 'utf8');
        isFirstDoc = false;
      }
    }

    yield Buffer.from(']', 'utf8');
  }

  yield Buffer.from('}}', 'utf8');
}

/**
 * Async generator that yields BSON chunks incrementally.
 */
async function* generateBsonChunks(registry, recordCounts, exportedAt) {
  const meta = {
    exportedAt,
    appName:      'daily-teaching-report',
    format:       'bson_gz',
    recordCounts,
  };
  yield BSON.serialize(meta);

  for (const { key, model } of registry) {
    const docCount = recordCounts[key] || 0;
    yield BSON.serialize({ _collectionName: key, _docCount: docCount });

    if (Array.isArray(model)) {
      for (const doc of model) {
        try {
          yield BSON.serialize(doc);
        } catch (err) {
          const safe = JSON.parse(JSON.stringify(doc));
          yield BSON.serialize(safe);
        }
      }
    } else if (model && typeof model.find === 'function') {
      const cursor = model.find().lean().cursor();
      for await (const doc of cursor) {
        try {
          yield BSON.serialize(doc);
        } catch (err) {
          const safe = JSON.parse(JSON.stringify(doc));
          yield BSON.serialize(safe);
        }
      }
    }
  }
}

/**
 * Creates an incremental streaming pipeline for the specified format.
 * Calculates SHA-256 digest on-the-fly and tracks total output bytes.
 * @param {Object} options
 * @returns {{ stream: PassThrough, getChecksum: Function, getTotalBytes: Function }}
 */
function createBackupStream({
  format = 'json_gz',
  recordCounts = {},
  registry = BACKUP_COLLECTIONS,
  exportedAt = new Date().toISOString(),
} = {}) {
  let sourceStream;
  const hash = crypto.createHash('sha256');
  let checksum = null;
  let totalBytes = 0;

  if (format === 'bson_gz') {
    const rawStream = Readable.from(generateBsonChunks(registry, recordCounts, exportedAt));
    const gzip = zlib.createGzip();
    sourceStream = rawStream.pipe(gzip);
    rawStream.on('error', (err) => gzip.destroy(err));
  } else if (format === 'json_gz') {
    const rawStream = Readable.from(generateJsonChunks(registry, recordCounts, format, exportedAt));
    const gzip = zlib.createGzip();
    sourceStream = rawStream.pipe(gzip);
    rawStream.on('error', (err) => gzip.destroy(err));
  } else {
    sourceStream = Readable.from(generateJsonChunks(registry, recordCounts, 'json', exportedAt));
  }

  const passThrough = new PassThrough();
  sourceStream.on('error', (err) => passThrough.destroy(err));

  passThrough.on('data', (chunk) => {
    totalBytes += chunk.length;
    hash.update(chunk);
  });

  passThrough.on('end', () => {
    checksum = hash.digest('hex');
  });

  sourceStream.pipe(passThrough);

  return {
    stream: passThrough,
    getChecksum: () => checksum,
    getTotalBytes: () => totalBytes,
  };
}

/**
 * Legacy buffer serializer for backward compatibility.
 */
function serializeToFormat(format, collections, recordCounts) {
  // Build registry from collections map
  const mockRegistry = Object.entries(collections).map(([key, docs]) => ({
    key,
    model: docs,
  }));

  if (format === 'bson_gz') {
    const chunks = [];
    const meta = {
      exportedAt:   new Date().toISOString(),
      appName:      'daily-teaching-report',
      format:       'bson_gz',
      recordCounts,
    };
    chunks.push(BSON.serialize(meta));
    for (const [collName, docs] of Object.entries(collections)) {
      chunks.push(BSON.serialize({ _collectionName: collName, _docCount: (docs || []).length }));
      for (const doc of docs || []) {
        try {
          chunks.push(BSON.serialize(doc));
        } catch (e) {
          chunks.push(BSON.serialize(JSON.parse(JSON.stringify(doc))));
        }
      }
    }
    return zlib.gzipSync(Buffer.concat(chunks));
  }

  const compress = format === 'json_gz';
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
 * Performs a database backup in the chosen format, streams it with sha256 hashing,
 * and uploads it to Cloudinary as an authenticated (private) raw file.
 * @param {string|null} userId
 * @param {string} userName
 * @param {'json_gz'|'json'|'bson_gz'} format
 * @returns {Promise<Object>} The created Backup database record
 */
async function performBackup(userId = null, userName = 'System', format = 'json_gz') {
  if (_backupInProgress) {
    throw new Error('A backup is already in progress. Please wait and try again.');
  }

  const heapUsed = process.memoryUsage().heapUsed;
  if (heapUsed > HEAP_LIMIT_BYTES) {
    throw new Error(
      `Server memory usage is too high (${Math.round(heapUsed / 1024 / 1024)}MB). ` +
      'Backup aborted to prevent a crash. Please try again later.'
    );
  }

  if (!FORMAT_META[format]) format = 'json_gz';

  _backupInProgress = true;
  try {
    const recordCounts = await getRecordCounts(BACKUP_COLLECTIONS);
    const streamInfo = createBackupStream({ format, recordCounts, registry: BACKUP_COLLECTIONS });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const randomSuffix = crypto.randomBytes(8).toString('hex');
    const publicId = `daily-teaching-report/backups/backup-${timestamp}-${randomSuffix}`;

    const uploadResult = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'raw',
          type:          'authenticated', // Private file (Part C)
          public_id:     publicId,
          use_filename:  false,
        },
        (err, result) => (err ? reject(err) : resolve(result))
      );

      streamInfo.stream.on('error', (err) => uploadStream.destroy(err));
      uploadStream.on('error', (err) => streamInfo.stream.destroy(err));

      streamInfo.stream.pipe(uploadStream);
    });

    return await Backup.create({
      initiatedBy:     userId || null,
      initiatedByName: userName,
      status:          'success',
      format,
      fileUrl:         uploadResult.secure_url,
      cloudinaryId:    uploadResult.public_id,
      cloudinaryType:  'authenticated',
      checksum:        streamInfo.getChecksum(),
      fileSizeBytes:   uploadResult.bytes || streamInfo.getTotalBytes(),
      recordCounts,
    });
  } finally {
    _backupInProgress = false;
  }
}

/* ───────────────────────────────────────────────
   Retention Logic & Pure Expiry Planner (Part B)
   ─────────────────────────────────────────────── */

/**
 * Pure function to evaluate backup expiry according to retention rules.
 * Rules:
 *  1. Pinned backups are NEVER expired (reason: 'pinned').
 *  2. Keep at least the 2 newest successful backups regardless of age (reason: 'latest_successful').
 *  3. Backups within retentionDays (default 60) are preserved (reason: 'within_retention').
 *  4. All other backups (both success and failed) older than retentionDays are marked expired.
 *
 * @param {Array} backups - Array of Backup objects or documents
 * @param {Date} [now=new Date()]
 * @param {Object} [options]
 * @param {number} [options.retentionDays=60]
 * @param {number} [options.keepLatestSuccessful=2]
 * @returns {{ expired: Array, protected: Array<{ id: string, reason: string }> }}
 */
function planBackupExpiry(backups = [], now = new Date(), options = {}) {
  const retentionDays = options.retentionDays != null
    ? options.retentionDays
    : (parseInt(process.env.BACKUP_RETENTION_DAYS, 10) || DEFAULT_RETENTION_DAYS);
  const keepLatest = options.keepLatestSuccessful != null ? options.keepLatestSuccessful : 2;

  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  // Find IDs of top N newest successful backups
  const successfulBackups = backups
    .filter((b) => b.status === 'success')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const latestSuccessfulIds = new Set(
    successfulBackups.slice(0, keepLatest).map((b) => String(b._id))
  );

  const expired = [];
  const protectedList = [];

  for (const backup of backups) {
    const idStr = String(backup._id);
    const createdAtTime = new Date(backup.createdAt).getTime();

    if (backup.pinned) {
      protectedList.push({ id: idStr, reason: 'pinned' });
    } else if (latestSuccessfulIds.has(idStr)) {
      protectedList.push({ id: idStr, reason: 'latest_successful' });
    } else if (createdAtTime >= cutoff.getTime()) {
      protectedList.push({ id: idStr, reason: 'within_retention' });
    } else {
      expired.push(backup);
    }
  }

  return { expired, protected: protectedList };
}

/**
 * Deletes a backup's physical raw asset from Cloudinary.
 * Handles 'not found' / 404 gracefully as success.
 * @param {Object} backup
 * @returns {Promise<{ ok: boolean, result?: string, skipped?: boolean, error?: Error }>}
 */
async function deleteBackupFile(backup) {
  if (!backup || !backup.cloudinaryId) {
    return { ok: true, skipped: true };
  }

  const type = backup.cloudinaryType || 'upload';
  try {
    const res = await cloudinary.uploader.destroy(backup.cloudinaryId, {
      resource_type: 'raw',
      type,
      invalidate: true,
    });

    if (res && (res.result === 'ok' || res.result === 'not found')) {
      return { ok: true, result: res.result };
    }
    return { ok: false, error: new Error(`Cloudinary destroy returned: ${res ? res.result : 'empty'}`) };
  } catch (err) {
    if (err && (err.http_code === 404 || /not found/i.test(err.message))) {
      return { ok: true, result: 'not found' };
    }
    return { ok: false, error: err };
  }
}

/**
 * Prunes expired backups from both Cloudinary and MongoDB.
 * Also performs an orphan sweep to clean up orphaned Cloudinary assets older than 7 days.
 *
 * @param {Object} [options]
 * @param {Date} [options.now=new Date()]
 * @param {boolean} [options.dryRun=false]
 * @param {number} [options.retentionDays]
 * @param {number} [options.budgetMs]
 * @returns {Promise<Object>} Prune summary
 */
async function pruneExpiredBackups({
  now = new Date(),
  dryRun = false,
  retentionDays,
  budgetMs = 45000,
} = {}) {
  const startTime = Date.now();
  const backups = await Backup.find().sort({ createdAt: -1 });
  const { expired, protected: protectedList } = planBackupExpiry(backups, now, { retentionDays });

  const summary = {
    dryRun,
    totalEvaluated: backups.length,
    expiredCount: expired.length,
    protectedCount: protectedList.length,
    deletedCount: 0,
    freedBytes: 0,
    failedCount: 0,
    orphanDeletedCount: 0,
    errors: [],
  };

  if (dryRun) {
    summary.expiredBackups = expired.map((b) => ({
      _id: b._id,
      createdAt: b.createdAt,
      status: b.status,
      fileSizeBytes: b.fileSizeBytes,
      cloudinaryId: b.cloudinaryId,
    }));
    return summary;
  }

  // 1. Process expired backups
  for (const backup of expired) {
    if (budgetMs && (Date.now() - startTime > budgetMs)) {
      console.warn(`[retention] Time budget of ${budgetMs}ms reached. Remaining expired backups will be cleaned in next run.`);
      break;
    }

    const delResult = await deleteBackupFile(backup);
    if (!delResult.ok) {
      summary.failedCount++;
      const errMsg = delResult.error ? delResult.error.message : 'Unknown delete error';
      summary.errors.push({ backupId: backup._id, error: errMsg });
      console.error(`  ⚠ Failed to delete Cloudinary file for backup ${backup._id}:`, errMsg);

      // Record failure on record without deleting MongoDB document
      await Backup.findByIdAndUpdate(backup._id, {
        deletionFailedAt: new Date(),
        deletionError: sanitizeErrorMessage(errMsg),
      }).catch(() => {});
      continue;
    }

    summary.freedBytes += backup.fileSizeBytes || 0;
    await backup.deleteOne();
    summary.deletedCount++;
    console.log(`🗑️ Pruned expired backup ${backup._id} (${new Date(backup.createdAt).toISOString()})`);
  }

  // 2. Orphan sweep in Cloudinary for raw backups older than 7 days
  try {
    const orphanCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const knownCloudinaryIds = new Set(
      (await Backup.find({ cloudinaryId: { $ne: null } }, { cloudinaryId: 1 }).lean())
        .map((b) => b.cloudinaryId)
    );

    for (const storageType of ['authenticated', 'upload']) {
      let nextCursor = null;
      let page = 0;
      do {
        page++;
        if (budgetMs && (Date.now() - startTime > budgetMs)) break;

        const res = await cloudinary.api.resources({
          resource_type: 'raw',
          type:          storageType,
          prefix:        'daily-teaching-report/backups/',
          max_results:   100,
          next_cursor:   nextCursor,
        });

        const resources = res.resources || [];
        for (const resource of resources) {
          const createdAt = new Date(resource.created_at);
          if (createdAt.getTime() < orphanCutoff.getTime() && !knownCloudinaryIds.has(resource.public_id)) {
            console.log(`🗑️ Deleting orphan backup asset from Cloudinary: ${resource.public_id} (${storageType})`);
            try {
              await cloudinary.uploader.destroy(resource.public_id, {
                resource_type: 'raw',
                type:          storageType,
                invalidate:    true,
              });
              summary.orphanDeletedCount++;
            } catch (orphanErr) {
              console.error(`  ⚠ Failed to delete orphan asset ${resource.public_id}:`, orphanErr.message);
            }
          }
        }

        nextCursor = res.next_cursor;
      } while (nextCursor && page < 20);
    }
  } catch (orphanSweepErr) {
    console.warn('[retention] Orphan sweep encountered non-fatal error:', orphanSweepErr.message);
  }

  console.log(`✅ Retention prune complete: ${summary.deletedCount} deleted, ${summary.failedCount} failed, ${summary.orphanDeletedCount} orphans cleared.`);
  return summary;
}

/**
 * Initializes schedulers:
 * - Weekly backup: Sunday at 00:00 (midnight WIB).
 * - Daily retention cleanup: 01:30 WIB (18:30 UTC).
 */
function initScheduler() {
  // Weekly backup
  cron.schedule('0 0 * * 0', async () => {
    console.log('⏰ Starting automated weekly backup...');
    try {
      const backup = await performBackup(null, 'System (Automated)', 'json_gz');
      console.log(`✅ Automated weekly backup succeeded: ${backup.fileUrl}`);
    } catch (err) {
      console.error('❌ Automated weekly backup failed:', err);
      await Backup.create({
        initiatedBy:     null,
        initiatedByName: 'System (Automated)',
        status:          'failed',
        errorMessage:    sanitizeErrorMessage(err.message),
        recordCounts:    {},
      }).catch(() => {});
    } finally {
      try {
        await pruneExpiredBackups();
      } catch (e) {
        console.error('⚠ Retention cleanup error (non-fatal):', e.message);
      }
    }
  });

  // Daily cleanup
  cron.schedule('30 1 * * *', async () => {
    console.log('⏰ Starting daily scheduled backup retention cleanup...');
    try {
      await pruneExpiredBackups();
    } catch (err) {
      console.error('⚠ Scheduled backup retention cleanup error:', err.message);
    }
  });

  console.log('⏰ Backup schedulers initialized (Weekly: Sun 00:00, Daily Cleanup: 01:30).');
}

/**
 * Calculates the next backup run time (Saturday 17:00 UTC = Sunday 00:00 WIB).
 * @param {Date} [now=new Date()]
 * @returns {Date}
 */
function getNextBackupDate(now = new Date()) {
  const target = new Date(now.getTime());
  target.setUTCHours(17, 0, 0, 0);
  const currentUTCDay = now.getUTCDay();
  let daysUntilSaturday = (6 - currentUTCDay + 7) % 7;
  if (daysUntilSaturday === 0 && now.getTime() >= target.getTime()) {
    daysUntilSaturday = 7;
  }
  target.setUTCDate(target.getUTCDate() + daysUntilSaturday);
  return target;
}

module.exports = {
  BACKUP_COLLECTIONS,
  EXCLUDED_MODELS,
  FORMAT_META,
  DEFAULT_RETENTION_DAYS,
  sanitizeErrorMessage,
  getRecordCounts,
  fetchRawCollections,
  createBackupStream,
  serializeToFormat,
  performBackup,
  planBackupExpiry,
  deleteBackupFile,
  pruneExpiredBackups,
  pruneOldAutomatedBackups: pruneExpiredBackups, // Backward-compatible alias
  initScheduler,
  getNextBackupDate,
};
