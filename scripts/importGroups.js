/**
 * scripts/importGroups.js
 *
 * Non-destructive resync of the `groups` collection from roster CSVs:
 *   scripts/data/csv/Groups_-_NEW_ACADEMIC_YEAR.csv
 *   scripts/data/csv/Private_-_NEW_PRIVATE.csv
 *
 * What it does (NON-DESTRUCTIVE — no data is ever deleted):
 *   1. Parses both CSVs into Group-shaped records.
 *   2. For each student in each group:
 *      - If the student already exists in the Student collection (matched
 *        by normalised name), their identity (barcode, student_code, AC
 *        history) is preserved unchanged.
 *      - If the student is new, a Student document is created with a
 *        fresh barcode and student_code.
 *   3. For each group:
 *      - If a Group with the same group_name exists, its student list is
 *        MERGED (new students added, existing ones kept).
 *      - If the group is new, it is created.
 *
 * Usage:
 *   node scripts/importGroups.js --dry-run     # preview only, no DB writes
 *   node scripts/importGroups.js               # run the non-destructive sync
 *
 * Optional: point at different CSV files
 *   node scripts/importGroups.js --groups path/to/groups.csv --private path/to/private.csv
 */

require('dotenv').config();
require('dotenv').config({ path: '.env.local', override: true });
const path     = require('path');
const mongoose = require('mongoose');
const Group    = require('../models/Group');
const Student  = require('../models/Student');
const { parseGroupsCsv, parsePrivateCsv, buildGroupRecords } = require('./lib/parseRoster');
const { matchOrCreateStudent } = require('../services/studentService');
const { normalizeName }        = require('../models/Student');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/daily_teaching_report';

const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

function argValue(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? path.resolve(args[idx + 1]) : fallback;
}

const GROUPS_CSV  = argValue('--groups',  path.join(__dirname, 'data', 'csv', 'Groups_-_NEW_ACADEMIC_YEAR.csv'));
const PRIVATE_CSV = argValue('--private', path.join(__dirname, 'data', 'csv', 'Private_-_NEW_PRIVATE.csv'));

function loadAndValidate() {
  const groupRaw   = parseGroupsCsv(GROUPS_CSV);
  const privateRaw = parsePrivateCsv(PRIVATE_CSV);
  const records    = buildGroupRecords([...groupRaw, ...privateRaw]);

  const errors = [];
  const docs = records.map((r, i) => {
    const group_name = (r.group_name || '').trim();
    const type       = r.type === 'PRIVATE' ? 'PRIVATE' : 'GROUP';
    const level      = (r.level || '').trim();
    const students   = (r.students || []).map(s => s.trim()).filter(Boolean);

    if (!group_name)            errors.push(`Record #${i}: missing group_name`);
    if (group_name.length > 100) errors.push(`Record #${i} ("${group_name}"): name exceeds 100 chars`);
    if (level.length > 50)       errors.push(`Record #${i} ("${group_name}"): level exceeds 50 chars`);
    if (students.length === 0)   errors.push(`Record #${i} ("${group_name}"): no students`);
    if (students.length > 200)   errors.push(`Record #${i} ("${group_name}"): exceeds 200 students`);
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
  console.log(DRY_RUN
    ? 'Mode: DRY RUN (no database changes will be made)\n'
    : 'Mode: NON-DESTRUCTIVE LIVE RUN\n');

  const newDocs = loadAndValidate();
  const totalStudentSlots = newDocs.reduce((sum, d) => sum + d.students.length, 0);
  console.log(
    `Parsed ${newDocs.length} group(s) — ` +
    `${newDocs.filter(d => d.type === 'GROUP').length} GROUP, ` +
    `${newDocs.filter(d => d.type === 'PRIVATE').length} PRIVATE, ` +
    `${totalStudentSlots} student slot(s).`
  );

  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB.\n');

  if (DRY_RUN) {
    // Preview: count how many students would be new vs existing
    let wouldCreate = 0;
    let wouldRetain = 0;
    const seen = new Set();
    for (const doc of newDocs) {
      for (const rawName of doc.students) {
        const key = normalizeName(rawName);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const exists = await Student.findOne({ normalized_name: key });
        if (exists) wouldRetain++;
        else        wouldCreate++;
      }
    }

    const existingGroups = await Group.countDocuments();
    console.log('─── Dry-run Preview ───────────────────────────────────');
    console.log(`  New students that would be created:   ${wouldCreate}`);
    console.log(`  Existing students that would be kept: ${wouldRetain}`);
    console.log(`  Groups currently in DB:               ${existingGroups}`);
    console.log('');
    console.log('Sample of what would be upserted:');
    newDocs.slice(0, 5).forEach(d => {
      console.log(`  [${d.type}] "${d.group_name}" (${d.level}) — ${d.students.length} student(s)`);
    });
    if (newDocs.length > 5) console.log(`  ... and ${newDocs.length - 5} more.`);
    await mongoose.disconnect();
    console.log('\nDry run complete. No changes were made.');
    return;
  }

  // ── Live non-destructive import ──────────────────────────────────
  let newStudentsAdded     = 0;
  let existingStudentsKept = 0;
  let groupsCreated        = 0;
  let groupsUpdated        = 0;

  for (const doc of newDocs) {
    const studentIds   = [];
    const studentNames = [];

    for (const rawName of doc.students) {
      const result = await matchOrCreateStudent(rawName);
      if (!result) continue;
      const { student, created } = result;
      if (created) {
        newStudentsAdded++;
        process.stdout.write('+');
      } else {
        existingStudentsKept++;
        process.stdout.write('.');
      }
      studentIds.push(student._id);
      studentNames.push(rawName);
    }

    // Upsert group by name
    const existingGroup = await Group.findOne({ group_name: doc.group_name });

    if (existingGroup) {
      const currentStrings = new Set(existingGroup.students.map(s => normalizeName(s)));
      const newStrings     = studentNames.filter(n => !currentStrings.has(normalizeName(n)));
      const currentIds     = new Set(existingGroup.student_ids.map(id => String(id)));
      const newIds         = studentIds.filter(id => !currentIds.has(String(id)));

      if (newStrings.length || newIds.length) {
        existingGroup.students    = [...existingGroup.students, ...newStrings];
        existingGroup.student_ids = [...existingGroup.student_ids, ...newIds];
        if (doc.level) existingGroup.level = doc.level;
        await existingGroup.save();
      }
      groupsUpdated++;
    } else {
      await Group.create({
        group_name:  doc.group_name,
        type:        doc.type,
        level:       doc.level || '',
        students:    studentNames,
        student_ids: studentIds,
      });
      groupsCreated++;
    }
  }

  console.log('\n');
  console.log('─── Import Summary ────────────────────────────────────');
  console.log(`  New students added (with barcodes):     ${newStudentsAdded}`);
  console.log(`  Existing students retained (unchanged): ${existingStudentsKept}`);
  console.log(`  Groups created:                         ${groupsCreated}`);
  console.log(`  Groups updated:                         ${groupsUpdated}`);
  console.log('───────────────────────────────────────────────────────');

  await mongoose.disconnect();
  console.log('\nDone. No existing student data was deleted.');
}

main().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
