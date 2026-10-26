/**
 * scripts/cleanupBackups.js
 *
 * Prunes expired backups older than retention cutoff (default: 60 days) from MongoDB and Cloudinary.
 * Preserves pinned backups and at least the 2 newest successful backups.
 * Also performs an orphan sweep of Cloudinary raw assets older than 7 days.
 *
 * Flags:
 *   --apply                 Commit deletions to Cloudinary and MongoDB (default is DRY RUN)
 *   --retention-days=<N>    Override retention window (e.g. --retention-days=60)
 *   --uri=<MONGO_URI>       Target custom MongoDB URI
 *
 * Usage:
 *   node scripts/cleanupBackups.js                      <- DRY RUN
 *   node scripts/cleanupBackups.js --apply              <- LIVE RUN
 *   node scripts/cleanupBackups.js --retention-days=30  <- Dry run with 30-day retention
 */

'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const Backup   = require('../models/Backup');
const {
  planBackupExpiry,
  pruneExpiredBackups,
  DEFAULT_RETENTION_DAYS,
} = require('../services/backupService');

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + ' ' + sizes[i];
}

const uriArg = process.argv.find(a => a.startsWith('--uri='));
let MONGO_URI = uriArg ? uriArg.slice(6) : process.env.MONGO_URI;
if (!MONGO_URI || MONGO_URI === '[SENSITIVE]' || (!MONGO_URI.startsWith('mongodb://') && !MONGO_URI.startsWith('mongodb+srv://'))) {
  MONGO_URI = 'mongodb://localhost:27017/daily_teaching_report';
}

const APPLY = process.argv.includes('--apply');

const retentionDaysArg = process.argv.find(a => a.startsWith('--retention-days='));
const RETENTION_DAYS = retentionDaysArg
  ? parseInt(retentionDaysArg.slice(17), 10)
  : (parseInt(process.env.BACKUP_RETENTION_DAYS, 10) || DEFAULT_RETENTION_DAYS);

async function main() {
  console.log('');
  console.log('═════════════════════════════════════════════════════════════════');
  console.log('  Backup Cleanup & Retention Pruning');
  console.log(`  Mode:           ${APPLY ? 'LIVE RUN (--apply) - WILL DELETE ASSETS' : 'DRY RUN (preview only, no modifications)'}`);
  console.log(`  Retention:      ${RETENTION_DAYS} days`);
  console.log('═════════════════════════════════════════════════════════════════');

  await mongoose.connect(MONGO_URI);

  const connHost = mongoose.connection.host;
  const connDb   = mongoose.connection.db.databaseName;
  console.log(`✓ Connected to MongoDB  host=${connHost}  db=${connDb}\n`);

  const now = new Date();
  const allBackups = await Backup.find().sort({ createdAt: -1 });
  console.log(`Found ${allBackups.length} total backup record(s) in database.\n`);

  const { expired, protected: protectedList } = planBackupExpiry(allBackups, now, {
    retentionDays: RETENTION_DAYS,
  });

  console.log('── Protected Backups ───────────────────────────────────────────');
  for (const item of protectedList) {
    const b = allBackups.find(x => String(x._id) === item.id);
    const dateStr = b ? new Date(b.createdAt).toISOString().split('T')[0] : 'unknown';
    console.log(`  ✓ [PROTECTED: ${item.reason.padEnd(17)}] ID: ${item.id} (${dateStr}) - ${b ? b.status : 'n/a'}`);
  }

  console.log('\n── Expired Backups ─────────────────────────────────────────────');
  if (expired.length === 0) {
    console.log('  None. No backups qualify for expiration under current retention rules.');
  } else {
    for (const b of expired) {
      const dateStr = new Date(b.createdAt).toISOString().split('T')[0];
      const sizeStr = formatBytes(b.fileSizeBytes);
      console.log(`  🗑 [EXPIRED] ID: ${b._id} (${dateStr}) - ${sizeStr} - ${b.status} - CloudinaryId: ${b.cloudinaryId || 'none'}`);
    }
  }

  console.log('\n────────────────────────────────────────────────────────────────');

  if (!APPLY) {
    console.log('\n[DRY RUN COMPLETE] To delete expired backups and scan for orphaned files, re-run with --apply:');
    console.log(`  node scripts/cleanupBackups.js --apply --retention-days=${RETENTION_DAYS}\n`);
    await mongoose.disconnect();
    return;
  }

  console.log('\nExecuting pruning...\n');
  const summary = await pruneExpiredBackups({
    now,
    dryRun: false,
    retentionDays: RETENTION_DAYS,
  });

  console.log('\n═════════════════════════════════════════════════════════════════');
  console.log('  Pruning Summary');
  console.log(`  Deleted DB records:     ${summary.deletedCount}`);
  console.log(`  Freed Cloud Storage:    ${formatBytes(summary.freedBytes)}`);
  console.log(`  Failed deletions:       ${summary.failedCount}`);
  console.log(`  Orphan assets removed:  ${summary.orphanDeletedCount}`);
  console.log('═════════════════════════════════════════════════════════════════\n');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Fatal error during backup cleanup:', err);
  process.exit(1);
});
