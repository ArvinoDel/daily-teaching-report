/**
 * scripts/initOnboarding.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Initializes onboarding for existing teachers as legacy users.
 *
 * Flags:
 *   --apply           Commit changes to MongoDB (default is DRY RUN)
 *   --before=<ISO>    Cutoff date (default: now). Only users created before this are marked legacy.
 *   --yes             Skip 5-second safety countdown in --apply mode
 *
 * Usage:
 *   node scripts/initOnboarding.js                           <- DRY RUN
 *   node scripts/initOnboarding.js --apply                   <- LIVE RUN with countdown
 *   node scripts/initOnboarding.js --apply --yes             <- LIVE RUN immediately
 *   node scripts/initOnboarding.js --before=2026-10-27T00:00:00Z
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const User = require('../models/User');

const uriArg = process.argv.find(a => a.startsWith('--uri='));
let MONGO_URI = uriArg ? uriArg.slice(6) : process.env.MONGO_URI;

// Strict URI validation: exit code 1 on missing, placeholder or invalid MONGO_URI. Never fall back to localhost.
if (
  !MONGO_URI ||
  MONGO_URI === '[SENSITIVE]' ||
  (!MONGO_URI.startsWith('mongodb://') && !MONGO_URI.startsWith('mongodb+srv://'))
) {
  console.error('❌ Error: Missing, placeholder, or invalid MONGO_URI. Refusing to connect.');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const YES = process.argv.includes('--yes');

const beforeArg = process.argv.find(a => a.startsWith('--before='));
let cutoffDate = new Date();
if (beforeArg) {
  const parsed = new Date(beforeArg.slice(9));
  if (isNaN(parsed.getTime())) {
    console.error('❌ Error: Invalid --before ISO date format.');
    process.exit(1);
  }
  cutoffDate = parsed;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('');
  console.log('═════════════════════════════════════════════════════════════════');
  console.log('  Init Onboarding for Existing Teachers');
  console.log(`  Mode:        ${APPLY ? 'LIVE RUN (--apply)' : 'DRY RUN (preview only, no writes)'}`);
  console.log(`  Cutoff Date: ${cutoffDate.toISOString()}`);
  console.log('═════════════════════════════════════════════════════════════════');

  await mongoose.connect(MONGO_URI);

  const connHost = mongoose.connection.host;
  const connDb = mongoose.connection.db.databaseName;
  console.log(`✓ Connected to MongoDB  host=${connHost}  db=${connDb}\n`);

  if (APPLY && !YES) {
    console.log('⚠️  LIVE RUN: Preparing to modify documents in 5 seconds...');
    console.log('    Press Ctrl+C immediately to cancel.');
    for (let i = 5; i > 0; i--) {
      process.stdout.write(`    Starting in ${i}...\r`);
      await sleep(1000);
    }
    console.log('\n    Proceeding with updates.\n');
  }

  // Find teachers created before cutoff without startedAt stamped
  const filter = {
    role: 'teacher',
    createdAt: { $lt: cutoffDate },
    $or: [
      { 'onboarding.startedAt': null },
      { 'onboarding.startedAt': { $exists: false } },
      { onboarding: { $exists: false } },
    ],
  };

  const candidateTeachers = await User.find(filter)
    .select('displayName username createdAt commission onboarding')
    .lean();

  console.log(`Found ${candidateTeachers.length} existing teacher(s) created before cutoff without onboarding.`);

  if (candidateTeachers.length === 0) {
    console.log('No teachers require onboarding backfill.\n');
    await mongoose.disconnect();
    return;
  }

  console.log('\nTeachers to initialize:');
  candidateTeachers.forEach((t, i) => {
    const comm = t.commission || {};
    const hasRewards = [comm.primeFull, comm.primeAssisted, comm.halfPrime, comm.assistant].some(
      v => (Number(v) || 0) > 0
    );
    console.log(`  ${i + 1}. ${t.displayName} (@${t.username}) - created: ${t.createdAt ? new Date(t.createdAt).toISOString().slice(0, 10) : 'unknown'}, rewards set: ${hasRewards ? 'Yes' : 'No'}`);
  });

  if (APPLY) {
    const result = await User.updateMany(filter, {
      $set: {
        'onboarding.version': 1,
        'onboarding.legacy': true,
        'onboarding.startedAt': cutoffDate,
        'onboarding.dismissedAt': null,
        'onboarding.completedAt': null,
      },
    });

    console.log(`\n✓ Successfully initialized ${result.modifiedCount} teacher(s) as legacy onboarding.`);
  } else {
    console.log(`\n[DRY RUN] Would set onboarding.legacy = true and startedAt for ${candidateTeachers.length} teacher(s).`);
    console.log('Run with `--apply` to commit these changes.');
  }

  console.log('═════════════════════════════════════════════════════════════════\n');
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('\nFatal error in initOnboarding:', err);
  process.exit(1);
});
