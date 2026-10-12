/**
 * scripts/repairGroupStudentIds.js
 *
 * Rebuilds Group.student_ids from Group.students by normalized_name.
 *
 * - Never creates or deletes Student documents.
 * - Never changes Group.students[] names.
 * - Logs groups where a student name has no matching Student document.
 *
 * Usage:
 *   node scripts/repairGroupStudentIds.js          <- DRY RUN (only prints what would change)
 *   node scripts/repairGroupStudentIds.js --apply  <- Writes changes to database
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Group    = require('../models/Group');
const Student  = require('../models/Student');
const { normalizeName } = require('../models/Student');

const uriArg = process.argv.find(a => a.startsWith('--uri='));
let MONGO_URI = uriArg ? uriArg.slice(6) : process.env.MONGO_URI;
if (!MONGO_URI || MONGO_URI === '[SENSITIVE]' || (!MONGO_URI.startsWith('mongodb://') && !MONGO_URI.startsWith('mongodb+srv://'))) {
  MONGO_URI = 'mongodb://localhost:27017/daily_teaching_report';
}

const APPLY = process.argv.includes('--apply');

async function main() {
  console.log('');
  console.log('══════════════════════════════════════════════════════');
  console.log('  Repair Group student_ids Script');
  console.log(`  Mode: ${APPLY ? 'LIVE RUN (--apply)' : 'DRY RUN (no DB writes)'}`);
  console.log('══════════════════════════════════════════════════════');

  await mongoose.connect(MONGO_URI);
  console.log('✓ Connected to MongoDB\n');

  // 1. Load all students and index by normalized_name
  const students = await Student.find({}, '_id normalized_name full_name').lean();
  const studentByNorm = new Map();
  for (const s of students) {
    if (s.normalized_name && !studentByNorm.has(s.normalized_name)) {
      studentByNorm.set(s.normalized_name, s._id);
    }
  }
  console.log(`Indexed ${studentByNorm.size} unique normalized student names from DB.`);

  // 2. Load all groups
  const groups = await Group.find({}).lean();
  console.log(`Examining ${groups.length} group document(s)...\n`);

  let groupsExamined = 0;
  let groupsNeedingRepair = 0;
  let groupsWithUnmatchedNames = 0;
  let totalUnmatchedNames = 0;

  for (const g of groups) {
    groupsExamined++;
    const rawStudents = Array.isArray(g.students) ? g.students : [];
    const currentIds = (Array.isArray(g.student_ids) ? g.student_ids : []).map(id => String(id));

    const rebuiltIds = [];
    const seenIds = new Set();
    const unmatchedInGroup = [];

    for (const rawName of rawStudents) {
      const norm = normalizeName(rawName);
      const studentId = norm ? studentByNorm.get(norm) : null;

      if (studentId) {
        const idStr = String(studentId);
        if (!seenIds.has(idStr)) {
          seenIds.add(idStr);
          rebuiltIds.push(studentId);
        }
      } else {
        unmatchedInGroup.push(rawName);
      }
    }

    if (unmatchedInGroup.length > 0) {
      groupsWithUnmatchedNames++;
      totalUnmatchedNames += unmatchedInGroup.length;
      console.warn(`⚠️  Group "${g.group_name}" (${g.type}): ${unmatchedInGroup.length} student name(s) have no matching Student document:`);
      unmatchedInGroup.forEach(name => console.warn(`     - "${name}" (normalized: "${normalizeName(name)}")`));
    }

    // Check if currentIds and rebuiltIds differ
    const rebuiltIdStrs = rebuiltIds.map(id => String(id));
    const isDifferent = currentIds.length !== rebuiltIdStrs.length ||
      currentIds.some((id, idx) => id !== rebuiltIdStrs[idx]);

    if (isDifferent) {
      groupsNeedingRepair++;
      console.log(`\n🔧 Group: "${g.group_name}" [${g.type}] (ID: ${g._id})`);
      console.log(`   students count:     ${rawStudents.length}`);
      console.log(`   current student_ids: [${currentIds.join(', ')}] (count: ${currentIds.length})`);
      console.log(`   rebuilt student_ids: [${rebuiltIdStrs.join(', ')}] (count: ${rebuiltIdStrs.length})`);

      if (APPLY) {
        await Group.updateOne(
          { _id: g._id },
          { $set: { student_ids: rebuiltIds } }
        );
        console.log('   ✓ Updated in database.');
      }
    }
  }

  console.log('\n══════════════════════════════════════════════════════');
  console.log('  Summary');
  console.log('══════════════════════════════════════════════════════');
  console.log(`  Total groups examined:             ${groupsExamined}`);
  console.log(`  Groups needing student_ids repair: ${groupsNeedingRepair}`);
  console.log(`  Groups with unmatched student names: ${groupsWithUnmatchedNames} (${totalUnmatchedNames} total names)`);

  if (!APPLY) {
    if (groupsNeedingRepair > 0) {
      console.log('\n  [DRY RUN] No changes were written.');
      console.log('  To apply these changes, re-run with:');
      console.log('    node scripts/repairGroupStudentIds.js --apply\n');
    } else {
      console.log('\n  [DRY RUN] All group student_ids are already consistent.\n');
    }
  } else {
    console.log(`\n  ✓ Live repair complete. Updated ${groupsNeedingRepair} group(s).\n`);
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('\n✗ Repair script failed:', err);
  process.exit(1);
});
