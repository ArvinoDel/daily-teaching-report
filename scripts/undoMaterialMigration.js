/**
 * scripts/undoMaterialMigration.js
 *
 * Removes materials that were inserted by `scripts/migrate-materials.js`.
 *
 * Behavior:
 *   - Without `--since`: Prints a table of Material counts grouped by createdAt
 *     minute for the last 7 days (to identify the migration batch) and exits without changes.
 *   - With `--since=<ISO datetime>`:
 *     Identifies candidate Materials where:
 *       createdAt >= since AND (lastUsedAt < since OR lastUsedAt is null)
 *     (Flag `--include-recent` also includes candidates with lastUsedAt >= since).
 *   - DRY RUN by default (preview candidates, kept materials count, referenced reports count).
 *   - With `--apply` (requires `--since`):
 *       1. Sets Report.material = null for reports referencing candidate materials.
 *       2. Deletes MaterialAlias documents pointing to candidate materials.
 *       3. Deletes the candidate Material documents.
 *     Never modifies Report.subject.
 *     Never recounts or zeroes the usage count of kept materials.
 *     Safe to run repeatedly.
 *
 * Usage:
 *   node scripts/undoMaterialMigration.js                                  <- Inspect batches in last 7 days
 *   node scripts/undoMaterialMigration.js --since=2026-10-14T04:41:00Z      <- DRY RUN preview
 *   node scripts/undoMaterialMigration.js --since=2026-10-14T04:41:00Z --apply <- LIVE RUN removal
 */

'use strict';

require('dotenv').config();

const mongoose      = require('mongoose');
const Material      = require('../models/Material');
const MaterialAlias = require('../models/MaterialAlias');
const Report        = require('../models/Report');
const { invalidateMaterialsCache } = require('../services/materialService');

const uriArg = process.argv.find(a => a.startsWith('--uri='));
const MONGO_URI = uriArg ? uriArg.slice(6) : process.env.MONGO_URI;

if (!MONGO_URI || (!MONGO_URI.startsWith('mongodb://') && !MONGO_URI.startsWith('mongodb+srv://'))) {
  console.error('\nError: Invalid or missing MongoDB URI.');
  console.error('MONGO_URI must be provided in .env or via --uri=<mongo uri> and must start with "mongodb://" or "mongodb+srv://".\n');
  process.exit(1);
}

const APPLY          = process.argv.includes('--apply');
const DRY_RUN        = !APPLY;
const INCLUDE_RECENT = process.argv.includes('--include-recent');
const sinceArg       = process.argv.find(a => a.startsWith('--since='));
const sinceStr       = sinceArg ? sinceArg.slice(8).trim() : null;

async function main() {
  console.log('='.repeat(65));
  console.log('  UNDO MATERIAL MIGRATION');
  console.log(`  Mode:           ${APPLY ? 'LIVE RUN (--apply)' : 'DRY RUN (preview only, no DB writes)'}`);
  if (sinceStr) {
    console.log(`  Since:          ${sinceStr}`);
    console.log(`  Include Recent: ${INCLUDE_RECENT ? 'ON (all lastUsedAt)' : 'OFF (lastUsedAt < since only)'}`);
  }
  console.log('='.repeat(65));

  if (APPLY && !sinceStr) {
    console.error('\nError: --apply requires --since=<ISO datetime> to be specified.');
    console.error('Run without arguments first to inspect migration batches by minute.\n');
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);

  const connHost = mongoose.connection.host;
  const connDb   = mongoose.connection.db ? mongoose.connection.db.databaseName : mongoose.connection.name;
  console.log(`✓ Connected to MongoDB  host=${connHost}  db=${connDb}\n`);

  if (APPLY) {
    console.log(`⚠️  LIVE RUN: changes will be written to ${connDb} on ${connHost}\n`);
  }

  // If no --since provided: print table grouped by createdAt minute for last 7 days
  if (!sinceStr) {
    console.log('[1/1] Scanning Material creation batches in the last 7 days...\n');
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const batches = await Material.aggregate([
      {
        $match: {
          createdAt: { $gte: sevenDaysAgo },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%dT%H:%M:00.000Z', date: '$createdAt' },
          },
          count: { $sum: 1 },
          minCreatedAt: { $min: '$createdAt' },
          maxCreatedAt: { $max: '$createdAt' },
          sampleNames:  { $push: '$name' },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    if (batches.length === 0) {
      console.log('  No materials created in the last 7 days.');
    } else {
      console.log('Material creation activity in the last 7 days (grouped by minute):');
      console.table(
        batches.map(b => ({
          'Minute (UTC)':       b._id,
          'Materials Created':  b.count,
          'Earliest CreatedAt': b.minCreatedAt.toISOString(),
          'Latest CreatedAt':   b.maxCreatedAt.toISOString(),
          'Sample Names':       b.sampleNames.slice(0, 3).join(', '),
        }))
      );

      const latestBatch = batches[batches.length - 1];
      console.log('\nTo preview candidate materials for deletion, run:');
      console.log(`  node scripts/undoMaterialMigration.js --since=${latestBatch._id}`);
      console.log('To commit changes:');
      console.log(`  node scripts/undoMaterialMigration.js --since=${latestBatch._id} --apply`);
    }

    console.log('\n' + '='.repeat(65) + '\n');
    await mongoose.disconnect();
    return;
  }

  // Parse and validate --since
  const sinceDate = new Date(sinceStr);
  if (isNaN(sinceDate.getTime())) {
    console.error(`\nError: Invalid ISO datetime format for --since: "${sinceStr}".`);
    console.error('Expected format e.g. 2026-10-14T04:41:00Z\n');
    await mongoose.disconnect();
    process.exit(1);
  }

  // Build candidate query
  // Candidates = Materials with createdAt >= since AND lastUsedAt < since (or null)
  // Flag --include-recent includes candidates regardless of lastUsedAt
  const candidateFilter = {
    createdAt: { $gte: sinceDate },
  };

  if (!INCLUDE_RECENT) {
    candidateFilter.$or = [
      { lastUsedAt: { $lt: sinceDate } },
      { lastUsedAt: null },
      { lastUsedAt: { $exists: false } },
    ];
  }

  console.log('[1/3] Finding candidate materials...');
  const [candidates, totalMaterials] = await Promise.all([
    Material.find(candidateFilter)
      .select('_id name level usageCount createdAt lastUsedAt')
      .sort({ createdAt: 1 })
      .lean(),
    Material.countDocuments(),
  ]);

  const candidateIds = candidates.map(c => c._id);
  const keptMaterialsCount = totalMaterials - candidates.length;

  console.log('[2/3] Checking report references to candidates...');
  const referencedReportsCount = candidateIds.length > 0
    ? await Report.countDocuments({ material: { $in: candidateIds } })
    : 0;

  console.log('\nCandidate Analysis Summary:');
  console.log(`  - Total materials currently in DB:  ${totalMaterials}`);
  console.log(`  - Candidate materials to remove:    ${candidates.length}`);
  console.log(`  - Materials that will be KEPT:      ${keptMaterialsCount}`);
  console.log(`  - Reports referencing a candidate:  ${referencedReportsCount}`);

  if (candidates.length > 0) {
    console.log('\nCandidate Materials Preview:');
    console.table(
      candidates.map(m => ({
        Name:        m.name,
        Level:       m.level || '(No level)',
        Usage:       m.usageCount || 0,
        CreatedAt:   m.createdAt ? m.createdAt.toISOString() : '—',
        LastUsedAt:  m.lastUsedAt ? m.lastUsedAt.toISOString() : '—',
      }))
    );
  } else {
    console.log('\nNo materials match the specified criteria.');
  }

  // Commit or Preview
  console.log('\n[3/3] Execution...');
  if (DRY_RUN) {
    console.log('\n' + '='.repeat(65));
    console.log('  [DRY RUN COMPLETE]');
    console.log(`  Would remove ${candidates.length} materials.`);
    console.log(`  Would unlink ${referencedReportsCount} reports (set material = null).`);
    console.log(`  Would keep ${keptMaterialsCount} original materials untouched.`);
    console.log('  To apply these changes, re-run with:');
    console.log(`    node scripts/undoMaterialMigration.js --since=${sinceStr} --apply`);
    console.log('='.repeat(65));
  } else {
    let unlinkedReportsCount = 0;
    let deletedAliasesCount  = 0;
    let deletedMaterialsCount = 0;

    if (candidateIds.length > 0) {
      // 1. Set Report.material = null for reports referencing candidates
      const reportRes = await Report.updateMany(
        { material: { $in: candidateIds } },
        { $set: { material: null } }
      );
      unlinkedReportsCount = reportRes.modifiedCount;

      // 2. Delete MaterialAlias documents pointing to candidates
      const aliasRes = await MaterialAlias.deleteMany({
        material: { $in: candidateIds },
      });
      deletedAliasesCount = aliasRes.deletedCount;

      // 3. Delete the candidate Materials
      const matRes = await Material.deleteMany({
        _id: { $in: candidateIds },
      });
      deletedMaterialsCount = matRes.deletedCount;

      // Invalidate cache
      invalidateMaterialsCache();
    }

    console.log('\n' + '='.repeat(65));
    console.log('  [UNDO MIGRATION APPLIED SUCCESSFULLY]');
    console.log(`  - Candidate materials deleted: ${deletedMaterialsCount}`);
    console.log(`  - Material aliases deleted:    ${deletedAliasesCount}`);
    console.log(`  - Reports unlinked (material): ${unlinkedReportsCount}`);
    console.log(`  - Original materials kept:     ${totalMaterials - deletedMaterialsCount}`);
    console.log('  - Report subjects and usage counts of kept materials: UNTOUCHED');
    console.log('='.repeat(65));
  }

  console.log('');
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('\nFatal error in undoMaterialMigration:', err);
  process.exit(1);
});
