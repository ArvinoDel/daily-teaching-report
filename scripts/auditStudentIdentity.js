/**
 * scripts/auditStudentIdentity.js
 *
 * Read-only audit script for student identity integrity:
 *  (a) Student documents sharing a normalized_name (ids, barcodes, createdAt, groups, AcTransactions count)
 *  (b) Students whose roster strings across groups imply conflicting grades (max - min >= 3)
 *  (c) Students currently in two or more GROUP-type groups with different grades
 *
 * Usage:
 *   node scripts/auditStudentIdentity.js
 *   node scripts/auditStudentIdentity.js --uri=<MONGO_URI>
 */

'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const Student = require('../models/Student');
const Group = require('../models/Group');
const AcTransaction = require('../models/AcTransaction');
const {
  auditFindDuplicates,
  auditFindConflictingRosterGrades,
  auditFindDifferentGradesInGroupType,
} = require('../services/studentIdentityService');

const uriArg = process.argv.find(a => a.startsWith('--uri='));
let MONGO_URI = uriArg ? uriArg.slice(6) : process.env.MONGO_URI;

if (
  !MONGO_URI ||
  MONGO_URI === '[SENSITIVE]' ||
  (!MONGO_URI.startsWith('mongodb://') && !MONGO_URI.startsWith('mongodb+srv://'))
) {
  console.error('Error: Valid MONGO_URI is required via .env or --uri=<URI> (must start with mongodb:// or mongodb+srv://).');
  process.exit(1);
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('  Student Identity Audit Report (READ-ONLY)');
  console.log('═══════════════════════════════════════════════════════════════════════════════');

  try {
    await mongoose.connect(MONGO_URI);
  } catch (err) {
    console.error('Failed to connect to MongoDB:', err.message);
    process.exit(1);
  }

  const connHost = mongoose.connection.host;
  const connDb = mongoose.connection.db ? mongoose.connection.db.databaseName : mongoose.connection.name;
  console.log(`Connected to host: ${connHost}, database: ${connDb}\n`);

  // Load all students and groups in parallel
  console.log('Loading students, groups, and transaction metadata...');
  const [allStudents, allGroups, txAgg] = await Promise.all([
    Student.find({}).lean(),
    Group.find({}).lean(),
    AcTransaction.aggregate([
      { $match: { student: { $ne: null } } },
      { $group: { _id: '$student', count: { $sum: 1 } } },
    ]),
  ]);

  const txMap = new Map();
  for (const t of txAgg) {
    if (t._id) txMap.set(String(t._id), t.count);
  }

  console.log(`Loaded ${allStudents.length} students, ${allGroups.length} groups, ${txAgg.length} student transaction aggregations.\n`);

  // ─────────────────────────────────────────────────────────────────────────────
  // (a) Duplicate normalized_name documents
  // ─────────────────────────────────────────────────────────────────────────────
  const duplicates = auditFindDuplicates(allStudents, allGroups, txMap);
  console.log('─────────────────────────────────────────────────────────────────────────────');
  console.log(`(a) Student documents sharing a normalized_name`);
  console.log(`    Total duplicate name groups: ${duplicates.length}`);
  console.log('─────────────────────────────────────────────────────────────────────────────');

  if (duplicates.length === 0) {
    console.log('    ✓ No duplicate normalized_name student documents found.\n');
  } else {
    const top50 = duplicates.slice(0, 50);
    top50.forEach((dup, idx) => {
      console.log(`\n  [${idx + 1}] Normalized Name: "${dup.normalized_name}" (${dup.count} documents)`);
      dup.students.forEach(s => {
        const dateStr = s.createdAt ? new Date(s.createdAt).toISOString().slice(0, 10) : 'unknown';
        const grpStr = s.groupNames && s.groupNames.length ? s.groupNames.join(', ') : 'None';
        console.log(`      • ID: ${s.id} | Barcode: ${s.barcode} | Created: ${dateStr} | Grade/School: "${s.grade_school || ''}" | AC Tx: ${s.acTransactionsCount} | Groups: [${grpStr}]`);
      });
    });
    if (duplicates.length > 50) {
      console.log(`\n  ... and ${duplicates.length - 50} more duplicate groups not shown.`);
    }
    console.log('');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // (b) Roster strings across groups implying conflicting grades (diff >= 3)
  // ─────────────────────────────────────────────────────────────────────────────
  const conflictingGrades = auditFindConflictingRosterGrades(allGroups);
  console.log('─────────────────────────────────────────────────────────────────────────────');
  console.log(`(b) Students with conflicting grades across group rosters (max - min >= 3)`);
  console.log(`    Total conflicting students: ${conflictingGrades.length}`);
  console.log('─────────────────────────────────────────────────────────────────────────────');

  if (conflictingGrades.length === 0) {
    console.log('    ✓ No conflicting grade annotations found across groups.\n');
  } else {
    const top50 = conflictingGrades.slice(0, 50);
    top50.forEach((c, idx) => {
      console.log(`\n  [${idx + 1}] Student: "${c.normalized_name}" | Grade range: ${c.minGrade} to ${c.maxGrade} (Δ = ${c.delta})`);
      c.entries.forEach(e => {
        console.log(`      • Group: "${e.groupName}" -> Raw: "${e.raw}" (Parsed Grade: ${e.grade})`);
      });
    });
    if (conflictingGrades.length > 50) {
      console.log(`\n  ... and ${conflictingGrades.length - 50} more conflicting students not shown.`);
    }
    console.log('');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // (c) Students currently in 2+ GROUP-type groups with different grades
  // ─────────────────────────────────────────────────────────────────────────────
  const diffGroupTypeGrades = auditFindDifferentGradesInGroupType(allGroups);
  console.log('─────────────────────────────────────────────────────────────────────────────');
  console.log(`(c) Students in 2+ GROUP-type groups with differing grades`);
  console.log(`    Total students: ${diffGroupTypeGrades.length}`);
  console.log('─────────────────────────────────────────────────────────────────────────────');

  if (diffGroupTypeGrades.length === 0) {
    console.log('    ✓ No students in multiple GROUP-type groups with differing grades.\n');
  } else {
    const top50 = diffGroupTypeGrades.slice(0, 50);
    top50.forEach((d, idx) => {
      console.log(`\n  [${idx + 1}] Student: "${d.normalized_name}" | Distinct Grades: [${d.distinctGrades.join(', ')}] across ${d.groupCount} group-type classes`);
      d.entries.forEach(e => {
        console.log(`      • Group: "${e.groupName}" -> Raw: "${e.raw}" (Grade: ${e.grade})`);
      });
    });
    if (diffGroupTypeGrades.length > 50) {
      console.log(`\n  ... and ${diffGroupTypeGrades.length - 50} more students not shown.`);
    }
    console.log('');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Recommendation / Next Steps
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('  DATABASE UNIQUENESS RECOMMENDATION');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  if (duplicates.length === 0) {
    console.log('  ✓ Report (a) returned 0 rows! It is now safe to add `unique: true` to');
    console.log('    `normalized_name` in models/Student.js in a follow-up migration change.');
  } else {
    console.log(`  ⚠️ Report (a) found ${duplicates.length} duplicate normalized_name group(s).`);
    console.log('    Do NOT add a unique index yet.');
    console.log('    Resolve or merge duplicate Student documents first.');
    console.log('    After (a) returns zero rows, set unique: true on normalized_name in a follow-up change.');
  }
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(err => {
    console.error('Audit script error:', err);
    process.exit(1);
  });
}

module.exports = {
  main,
};

