/**
 * scripts/renumberMaterialRevisions.js
 *
 * Renumbers revisions chronologically (editedAt, then _id) to 1..n for materials
 * that have duplicate revision versions, and sets MaterialContent.version to the highest.
 *
 * Flags:
 *   --apply    Commit changes to MongoDB (default is DRY RUN)
 *   --uri=...  Custom MongoDB connection URI
 *
 * Usage:
 *   node scripts/renumberMaterialRevisions.js         <- DRY RUN
 *   node scripts/renumberMaterialRevisions.js --apply <- LIVE RUN
 */

'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const MaterialContent = require('../models/MaterialContent');
const MaterialContentRevision = require('../models/MaterialContentRevision');

const uriArg = process.argv.find(a => a.startsWith('--uri='));
const MONGO_URI = uriArg ? uriArg.slice(6) : process.env.MONGO_URI;

if (!MONGO_URI || (!MONGO_URI.startsWith('mongodb://') && !MONGO_URI.startsWith('mongodb+srv://'))) {
  console.error('\nError: Invalid or missing MongoDB URI.');
  if (MONGO_URI === '[SENSITIVE]') {
    console.error('MONGO_URI is set to placeholder "[SENSITIVE]". Please provide a real MongoDB connection string.');
  }
  console.error('MONGO_URI must be provided in .env or via --uri=<mongo uri> and must start with "mongodb://" or "mongodb+srv://".\n');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');

async function main() {
  console.log('');
  console.log('═════════════════════════════════════════════════════════════════');
  console.log('  Renumber Material Revisions Script');
  console.log(`  Mode:           ${APPLY ? 'LIVE RUN (--apply)' : 'DRY RUN (preview only, no DB writes)'}`);
  console.log('═════════════════════════════════════════════════════════════════');

  await mongoose.connect(MONGO_URI);

  const connHost = mongoose.connection.host;
  const connDb   = mongoose.connection.db ? mongoose.connection.db.databaseName : mongoose.connection.name;
  console.log(`✓ Connected to MongoDB  host=${connHost}  db=${connDb}\n`);

  if (APPLY) {
    console.log(`⚠️  LIVE RUN: changes will be written to ${connDb} on ${connHost}\n`);
  }

  // 1. Find materials with duplicate revision versions
  const duplicateGroups = await MaterialContentRevision.aggregate([
    {
      $group: {
        _id: { material: '$material', version: '$version' },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
    {
      $group: {
        _id: '$_id.material',
        duplicateVersions: { $addToSet: '$_id.version' },
      },
    },
  ]);

  if (duplicateGroups.length === 0) {
    console.log('✓ No duplicate revision versions found across any materials. Database is clean.\n');
    await mongoose.disconnect();
    return;
  }

  console.log(`Found ${duplicateGroups.length} material(s) with duplicate revision versions.\n`);

  let totalRenumbered = 0;

  for (const group of duplicateGroups) {
    const matId = group._id;
    const revs = await MaterialContentRevision.find({ material: matId }).lean();

    // Sort chronologically (editedAt ascending, then _id ascending)
    revs.sort((a, b) => {
      const timeA = new Date(a.editedAt || 0).getTime();
      const timeB = new Date(b.editedAt || 0).getTime();
      if (timeA !== timeB) return timeA - timeB;
      return String(a._id || '').localeCompare(String(b._id || ''));
    });

    const highestVersion = revs.length;
    const renumberOps = revs.map((rev, idx) => ({
      _id: rev._id,
      oldVersion: rev.version,
      newVersion: idx + 1,
    }));

    console.log(`Material ${matId}: ${revs.length} revisions found (duplicate versions: ${group.duplicateVersions.join(', ')}).`);

    if (APPLY) {
      // Phase 1: temporary negative versions to prevent unique collisions
      await MaterialContentRevision.bulkWrite(
        renumberOps.map(op => ({
          updateOne: {
            filter: { _id: op._id },
            update: { $set: { version: -op.newVersion } },
          },
        }))
      );

      // Phase 2: final chronological versions 1..n
      await MaterialContentRevision.bulkWrite(
        renumberOps.map(op => ({
          updateOne: {
            filter: { _id: op._id },
            update: { $set: { version: op.newVersion } },
          },
        }))
      );

      // Set target MaterialContent.version to highest version
      await MaterialContent.updateOne(
        { material: matId },
        { $set: { version: highestVersion } }
      );

      console.log(`  -> Successfully renumbered to 1..${highestVersion} and updated MaterialContent.version to ${highestVersion}.`);
    } else {
      console.log(`  -> [DRY RUN] Would renumber to 1..${highestVersion} and set MaterialContent.version to ${highestVersion}.`);
    }

    totalRenumbered += revs.length;
  }

  console.log(`\nSummary: Processed ${duplicateGroups.length} material(s), ${totalRenumbered} revision(s).`);
  await mongoose.disconnect();
  console.log('Done.\n');
}

main().catch(err => {
  console.error('Fatal error in renumberMaterialRevisions:', err);
  process.exit(1);
});
