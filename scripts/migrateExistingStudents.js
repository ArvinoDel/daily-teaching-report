/**
 * scripts/migrateExistingStudents.js
 *
 * One-time migration script that:
 *  1. Reads all existing Group documents and Report.ac_students strings.
 *  2. Collects every unique student name (normalised for dedup).
 *  3. Creates a Student document for each, with a unique barcode + code.
 *  4. Back-fills Group.student_ids with the matching Student._id values.
 *
 * Usage:
 *   node scripts/migrateExistingStudents.js --dry-run   ← preview only
 *   node scripts/migrateExistingStudents.js              ← live migration
 *
 * Safe to re-run — already-migrated students are skipped (no duplicates).
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Group    = require('../models/Group');
const Report   = require('../models/Report');
const Student  = require('../models/Student');
const { normalizeName } = require('../models/Student');
const {
  generateBarcode,
  generateStudentCode,
} = require('../services/studentService');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/daily_teaching_report';
const DRY_RUN   = process.argv.includes('--dry-run');

/* ─────────────────────────────────────────────────────────────────
 *  Helpers
 * ───────────────────────────────────────────────────────────────── */

function extractFullName(raw) {
  if (!raw) return '';
  const cleaned = raw.trim()
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\*.*$/, '');
  const withoutAnnotation = cleaned
    .replace(/\s+\d{1,2}\s+[A-Z][A-Z0-9+\-]*(\s+[A-Z][A-Z0-9+\-]*)*\s*$/i, '')
    .trim();
  return withoutAnnotation || cleaned.trim();
}

function extractGradeSchool(raw) {
  if (!raw) return '';
  const cleaned = raw.trim()
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\*.*$/, '');
  const match = cleaned.match(/\s+(\d{1,2}\s+[A-Z][A-Z0-9+\-]*(?:\s+[A-Z][A-Z0-9+\-]*)*)\s*$/i);
  return match ? match[1].trim() : '';
}

/* ─────────────────────────────────────────────────────────────────
 *  Main
 * ───────────────────────────────────────────────────────────────── */
async function main() {
  console.log('');
  console.log('══════════════════════════════════════════════════════');
  console.log('  Student Migration Script');
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (no DB writes)' : 'LIVE RUN'}`);
  console.log('══════════════════════════════════════════════════════');

  await mongoose.connect(MONGO_URI);
  console.log('✓ Connected to MongoDB\n');

  // ── 1. Collect all raw student name strings ──────────────────────
  const [groups, acStudentDocs] = await Promise.all([
    Group.find({}).lean(),
    Report.distinct('ac_students'),
  ]);

  const rawNames = new Set();

  // From groups
  for (const g of groups) {
    for (const s of g.students || []) {
      const trimmed = (s || '').trim();
      if (trimmed) rawNames.add(trimmed);
    }
  }

  // From report ac_students (students who got AC even if not in a group anymore)
  for (const s of acStudentDocs) {
    const trimmed = (s || '').trim();
    if (trimmed) rawNames.add(trimmed);
  }

  console.log(`Found ${rawNames.size} unique raw student name strings across groups + reports.\n`);

  // ── 2. Dedup by normalized name — keep first raw name encountered ─
  // Map: normalizedName → best rawName
  const normalized2raw = new Map();
  for (const raw of rawNames) {
    const key = normalizeName(raw);
    if (key && !normalized2raw.has(key)) {
      normalized2raw.set(key, raw);
    }
  }

  console.log(`After normalization: ${normalized2raw.size} unique students to process.\n`);

  if (DRY_RUN) {
    console.log('── Sample (first 10) ──────────────────────────────────');
    let i = 0;
    for (const [key, raw] of normalized2raw) {
      if (i++ >= 10) break;
      console.log(`  "${raw}"  →  normalized: "${key}"  →  full_name: "${extractFullName(raw)}"`);
    }
    if (normalized2raw.size > 10) {
      console.log(`  ... and ${normalized2raw.size - 10} more`);
    }
    console.log('');
    console.log(`Would create up to ${normalized2raw.size} Student document(s).`);
    console.log(`Would update ${groups.length} Group document(s) with student_ids.`);
    await mongoose.disconnect();
    console.log('\nDry run complete. No changes were made.');
    return;
  }

  // ── 3. Create / skip Student documents ──────────────────────────
  let created   = 0;
  let skipped   = 0;
  const studentMap = new Map(); // normalizedName → Student._id

  for (const [normalizedKey, rawName] of normalized2raw) {
    // Check if already exists
    let student = await Student.findOne({ normalized_name: normalizedKey });

    if (student) {
      skipped++;
      studentMap.set(normalizedKey, student._id);
      process.stdout.write('.');
      continue;
    }

    // Create new student
    const [barcode, student_code] = await Promise.all([
      generateBarcode(),
      generateStudentCode(),
    ]);

    student = await Student.create({
      student_code,
      barcode,
      full_name:       extractFullName(rawName),
      raw_name:        rawName,
      normalized_name: normalizedKey,
      grade_school:    extractGradeSchool(rawName),
    });

    studentMap.set(normalizedKey, student._id);
    created++;
    process.stdout.write('+');
  }

  console.log('\n');
  console.log(`✓ Students created: ${created}`);
  console.log(`  Students skipped (already existed): ${skipped}`);

  // ── 4. Back-fill Group.student_ids ──────────────────────────────
  let groupsUpdated = 0;
  for (const g of groups) {
    const ids = [];
    for (const rawName of (g.students || [])) {
      const key = normalizeName(rawName);
      const id  = studentMap.get(key);
      if (id) ids.push(id);
    }

    if (ids.length > 0) {
      await Group.findByIdAndUpdate(g._id, {
        $addToSet: { student_ids: { $each: ids } },
      });
      groupsUpdated++;
    }
  }

  console.log(`✓ Groups back-filled: ${groupsUpdated} / ${groups.length}`);

  await mongoose.disconnect();
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  Migration complete!');
  console.log('══════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('\n✗ Migration failed:', err);
  process.exit(1);
});
