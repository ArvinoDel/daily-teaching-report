/**
 * scripts/importGroups.js
 *
 * Full resync of the `groups` collection straight from the roster CSVs:
 *   scripts/data/csv/Groups_-_NEW_ACADEMIC_YEAR.csv
 *   scripts/data/csv/Private_-_NEW_PRIVATE.csv
 *
 * What it does:
 *   1. Parses both CSVs (scripts/lib/parseRoster.js) into Group-shaped records.
 *   2. Connects to MongoDB using MONGO_URI (same env var as app.js).
 *   3. Backs up every existing Group document to
 *      scripts/data/backup-groups-<timestamp>.json (so a resync is always undoable).
 *   4. Deletes ALL existing Group documents.
 *   5. Inserts the freshly parsed groups.
 *
 * Usage:
 *   node scripts/importGroups.js --dry-run     # preview only, no DB writes
 *   node scripts/importGroups.js               # actually run the resync
 *
 * Optional: point at different CSV files
 *   node scripts/importGroups.js --groups path/to/groups.csv --private path/to/private.csv
 */

require('dotenv').config();
const fs       = require('fs');
const path     = require('path');
const mongoose = require('mongoose');
const Group    = require('../models/Group');
const { parseGroupsCsv, parsePrivateCsv, buildGroupRecords } = require('./lib/parseRoster');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/daily_teaching_report';

const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

function argValue(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? path.resolve(args[idx + 1]) : fallback;
}

const GROUPS_CSV  = argValue('--groups', path.join(__dirname, 'data', 'csv', 'Groups_-_NEW_ACADEMIC_YEAR.csv'));
const PRIVATE_CSV = argValue('--private', path.join(__dirname, 'data', 'csv', 'Private_-_NEW_PRIVATE.csv'));

function loadAndValidate() {
  const groupRaw   = parseGroupsCsv(GROUPS_CSV);
  const privateRaw = parsePrivateCsv(PRIVATE_CSV);
  const records     = buildGroupRecords([...groupRaw, ...privateRaw]);

  const errors = [];
  const docs = records.map((r, i) => {
    const group_name = (r.group_name || '').trim();
    const type        = r.type === 'PRIVATE' ? 'PRIVATE' : 'GROUP';
    const level        = (r.level || '').trim();
    const students     = (r.students || []).map(s => s.trim()).filter(Boolean);

    if (!group_name) errors.push(`Record #${i}: missing group_name`);
    if (group_name.length > 100) errors.push(`Record #${i} ("${group_name}"): name exceeds 100 chars`);
    if (level.length > 50) errors.push(`Record #${i} ("${group_name}"): level exceeds 50 chars`);
    if (students.length === 0) errors.push(`Record #${i} ("${group_name}"): no students`);
    if (students.length > 200) errors.push(`Record #${i} ("${group_name}"): exceeds 200 students`);
    students.forEach(s => {
      if (s.length > 100) errors.push(`Record #${i} ("${group_name}"): student name "${s}" exceeds 100 chars`);
    });

    return { group_name, type, level, students };
  });

  if (errors.length) {
    console.error(`\n✗ Validation failed with ${errors.length} error(s):`);
    errors.forEach(e => console.error('  - ' + e));
    process.exit(1);
  }

  return docs;
}

async function main() {
  console.log(`Groups CSV:  ${GROUPS_CSV}`);
  console.log(`Private CSV: ${PRIVATE_CSV}`);
  console.log(DRY_RUN ? 'Mode: DRY RUN (no database changes will be made)\n' : 'Mode: LIVE RUN\n');

  const newDocs = loadAndValidate();
  console.log(`Parsed ${newDocs.length} groups `
    + `(${newDocs.filter(d => d.type === 'GROUP').length} GROUP, `
    + `${newDocs.filter(d => d.type === 'PRIVATE').length} PRIVATE, `
    + `${newDocs.reduce((sum, d) => sum + d.students.length, 0)} student slots).`);

  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB.');

  const existing = await Group.find({}).lean();
  console.log(`Existing groups in database: ${existing.length}`);

  if (DRY_RUN) {
    console.log('\nSample of what would be inserted:');
    newDocs.slice(0, 5).forEach(d => {
      console.log(`  [${d.type}] "${d.group_name}" (${d.level}) — ${d.students.length} student(s)`);
    });
    console.log(`  ... and ${Math.max(0, newDocs.length - 5)} more.`);
    console.log(`\nWould delete ${existing.length} existing group(s) and insert ${newDocs.length} new group(s).`);
    await mongoose.disconnect();
    return;
  }

  // 1. Backup existing data first — always, even if the collection is empty.
  const backupDir = path.join(__dirname, 'data');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `backup-groups-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(existing, null, 2));
  console.log(`Backed up ${existing.length} existing group(s) to ${backupPath}`);

  // 2. Delete all existing groups.
  const delResult = await Group.deleteMany({});
  console.log(`Deleted ${delResult.deletedCount} existing group(s).`);

  // 3. Insert the new groups.
  const insertResult = await Group.insertMany(newDocs, { ordered: true });
  console.log(`Inserted ${insertResult.length} new group(s).`);

  await mongoose.disconnect();
  console.log('\nDone. Restore from the backup file above if you need to undo this.');
}

main().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
