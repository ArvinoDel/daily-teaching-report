/**
 * scripts/resanitizeMaterialContent.js
 *
 * Re-sanitizes the body of every MaterialContent and MaterialContentRevision
 * using the whitelist-based sanitizer (xss).
 *
 * Mode:
 *   DRY RUN by default (preview changes without writing).
 *   Pass --apply to commit changes to MongoDB.
 *
 * Connection:
 *   Loads only .env or accepts --uri=<mongodb://...>.
 *   Validates URI format (no localhost fallback if invalid).
 *   Prints host and db name (no credentials) before proceeding.
 *
 * Usage:
 *   node scripts/resanitizeMaterialContent.js              <- DRY RUN
 *   node scripts/resanitizeMaterialContent.js --apply      <- LIVE RUN
 */

'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const MaterialContent = require('../models/MaterialContent');
const MaterialContentRevision = require('../models/MaterialContentRevision');
const { sanitizeMaterialHtml } = require('../services/materialContentService');

const uriArg = process.argv.find(a => a.startsWith('--uri='));
const MONGO_URI = uriArg ? uriArg.slice(6) : process.env.MONGO_URI;

if (!MONGO_URI || (!MONGO_URI.startsWith('mongodb://') && !MONGO_URI.startsWith('mongodb+srv://'))) {
  console.error('\nError: Invalid or missing MongoDB URI.');
  console.error('MONGO_URI must be provided in .env or via --uri=<mongo uri> and must start with "mongodb://" or "mongodb+srv://".\n');
  process.exit(1);
}

const APPLY   = process.argv.includes('--apply');
const DRY_RUN = !APPLY;

function truncateSnippet(str, maxLen = 80) {
  if (!str) return '""';
  const clean = str.replace(/\r?\n|\r/g, ' ');
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen) + '...';
}

async function main() {
  console.log('='.repeat(65));
  console.log('  RE-SANITIZE MATERIAL CONTENT & REVISIONS');
  console.log(`  Mode:           ${APPLY ? 'LIVE RUN (--apply)' : 'DRY RUN (preview only, no DB writes)'}`);
  console.log('='.repeat(65));

  await mongoose.connect(MONGO_URI);
  const connHost = mongoose.connection.host;
  const connDb   = mongoose.connection.db ? mongoose.connection.db.databaseName : mongoose.connection.name;
  console.log(`✓ Connected to MongoDB  host=${connHost}  db=${connDb}\n`);

  const changedSamples = [];

  // 1. Process MaterialContent
  const allContents = await MaterialContent.find({}).lean();
  let contentChangedCount = 0;

  for (const doc of allContents) {
    const rawBody = doc.body || '';
    const cleanBody = sanitizeMaterialHtml(rawBody);

    if (cleanBody !== rawBody) {
      contentChangedCount++;
      if (changedSamples.length < 10) {
        changedSamples.push({
          collection: 'MaterialContent',
          id: String(doc._id),
          materialId: String(doc.material),
          before: rawBody,
          after: cleanBody,
        });
      }

      if (APPLY) {
        // Update only the body field without mutating timestamps or version
        await MaterialContent.updateOne(
          { _id: doc._id },
          { $set: { body: cleanBody } },
          { timestamps: false }
        );
      }
    }
  }

  // 2. Process MaterialContentRevision
  const allRevisions = await MaterialContentRevision.find({}).lean();
  let revisionChangedCount = 0;

  for (const rev of allRevisions) {
    const rawBody = rev.body || '';
    const cleanBody = sanitizeMaterialHtml(rawBody);

    if (cleanBody !== rawBody) {
      revisionChangedCount++;
      if (changedSamples.length < 10) {
        changedSamples.push({
          collection: 'MaterialContentRevision',
          id: String(rev._id),
          materialId: String(rev.material),
          version: rev.version,
          before: rawBody,
          after: cleanBody,
        });
      }

      if (APPLY) {
        // Update only the body field
        await MaterialContentRevision.updateOne(
          { _id: rev._id },
          { $set: { body: cleanBody } }
        );
      }
    }
  }

  const totalChanged = contentChangedCount + revisionChangedCount;

  console.log('─────────────────────────────────────────────────────────────────');
  console.log('  SUMMARY:');
  console.log(`  MaterialContent:          ${contentChangedCount} changed (out of ${allContents.length} total)`);
  console.log(`  MaterialContentRevision:  ${revisionChangedCount} changed (out of ${allRevisions.length} total)`);
  console.log(`  Total bodies changed:     ${totalChanged}`);
  console.log(`  Changes committed:        ${APPLY ? 'YES' : 'NO (Dry Run)'}`);
  console.log('─────────────────────────────────────────────────────────────────\n');

  if (changedSamples.length > 0) {
    console.log(`Showing first ${changedSamples.length} changed sample(s):\n`);
    changedSamples.forEach((sample, i) => {
      console.log(`[#${i + 1}] ${sample.collection} id=${sample.id} material=${sample.materialId}${sample.version ? ` v${sample.version}` : ''}`);
      console.log(`  BEFORE: ${truncateSnippet(sample.before)}`);
      console.log(`  AFTER:  ${truncateSnippet(sample.after)}\n`);
    });
  } else {
    console.log('All material content bodies are already cleanly sanitized.\n');
  }

  await mongoose.disconnect();
  console.log('✓ Disconnected from MongoDB.');
}

main().catch(err => {
  console.error('\nFatal error during re-sanitization:', err);
  process.exit(1);
});
