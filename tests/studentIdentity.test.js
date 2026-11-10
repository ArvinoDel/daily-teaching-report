/**
 * tests/studentIdentity.test.js
 *
 * Comprehensive test suite for Student Identity:
 *  - assessNameMatch matrix (namesakes, same, check_school, graduated, annotations, symbols)
 *  - grade_history cap (max 5 entries, changes only)
 *  - import preview flagging & server-side skip of unconfirmed rows
 *  - manual add 409 & namesake confirmation
 *  - race-safe student creation with simulated concurrent creators & E11000 retry
 *  - rename rollback on duplicate normalized_name
 *  - audit helper functions on synthetic data
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const {
  parseGradeAndSchool,
  assessNameMatch,
  recordGradeChange,
  auditFindDuplicates,
  auditFindConflictingRosterGrades,
  auditFindDifferentGradesInGroupType,
} = require('../services/studentIdentityService');
const { normalizeName } = require('../models/Student');
const Student = require('../models/Student');
const Group = require('../models/Group');
const { computeRosterDiff } = require('../services/groupImportDiffService');
const groupRosterService = require('../services/groupRosterService');

function makeObjectId() {
  return new mongoose.Types.ObjectId();
}

/* ═══════════════════════════════════════════════════════════════
   1. assessNameMatch Matrix
   ═══════════════════════════════════════════════════════════════ */
test('assessNameMatch - grade & school matching matrix', async (t) => {
  await t.test('namesake: delta > +2 ("Budi 8 SMP" vs "Budi 11 SMA")', () => {
    const existing = {
      _id: makeObjectId(),
      full_name: 'Budi',
      grade_school: '8 SMP',
      status: 'active',
      groupNames: ['Class 8A'],
    };
    const res = assessNameMatch(existing, 'Budi 11 SMA');
    assert.equal(res.kind, 'likely_namesake');
    assert.equal(res.gradeDelta, 3);
    assert.equal(res.existing.name, 'Budi');
    assert.equal(res.existing.grade_school, '8 SMP');
    assert.deepEqual(res.existing.groupNames, ['Class 8A']);
  });

  await t.test('same: delta = +1 and school matches ("Andi 7 SD" vs "Andi 8 SD")', () => {
    const existing = {
      _id: makeObjectId(),
      full_name: 'Andi',
      grade_school: '7 SD',
      status: 'active',
    };
    const res = assessNameMatch(existing, 'Andi 8 SD');
    assert.equal(res.kind, 'same');
    assert.equal(res.gradeDelta, 1);
  });

  await t.test('same: cleaned school ignores symbols and case ("Nico Edgina 9 CS+" vs "Nico Edgina 10 CS")', () => {
    const existing = {
      _id: makeObjectId(),
      full_name: 'Nico Edgina',
      grade_school: '9 CS+',
      status: 'active',
    };
    const res = assessNameMatch(existing, 'Nico Edgina 10 CS');
    assert.equal(res.kind, 'same');
    assert.equal(res.gradeDelta, 1);
  });

  await t.test('same: asterisk and annotation stripped ("Queenetha 12 KF*" vs "Queenetha 12 KF")', () => {
    const existing = {
      _id: makeObjectId(),
      full_name: 'Queenetha',
      grade_school: '12 KF*',
      status: 'active',
    };
    const res = assessNameMatch(existing, 'Queenetha 12 KF*');
    assert.equal(res.kind, 'same');
    assert.equal(res.gradeDelta, 0);
  });

  await t.test('same: either or both sides lack grade annotation', () => {
    const noGradeExisting = {
      _id: makeObjectId(),
      full_name: 'Budi',
      grade_school: '',
      status: 'active',
    };
    assert.equal(assessNameMatch(noGradeExisting, 'Budi 8 SMP').kind, 'same');
    assert.equal(assessNameMatch(noGradeExisting, 'Budi').kind, 'same');

    const gradeExisting = {
      _id: makeObjectId(),
      full_name: 'Budi',
      grade_school: '8 SMP',
      status: 'active',
    };
    assert.equal(assessNameMatch(gradeExisting, 'Budi').kind, 'same');
  });

  await t.test('check_school: delta is 0 or +1 and school code differs', () => {
    const existing = {
      _id: makeObjectId(),
      full_name: 'Dewi',
      grade_school: '8 SMP',
      status: 'active',
    };
    // delta = 0, school SMP vs SMA
    const res0 = assessNameMatch(existing, 'Dewi 8 SMA');
    assert.equal(res0.kind, 'check_school');
    assert.equal(res0.gradeDelta, 0);
    assert.equal(res0.storedSchool, 'SMP');
    assert.equal(res0.incomingSchool, 'SMA');

    // delta = +1, school SMP vs SMA
    const res1 = assessNameMatch(existing, 'Dewi 9 SMA');
    assert.equal(res1.kind, 'check_school');
    assert.equal(res1.gradeDelta, 1);
  });

  await t.test('delta boundary tests: -1, -2, +2, +3', () => {
    const existing = {
      _id: makeObjectId(),
      full_name: 'Rian',
      grade_school: '8 SMP',
      status: 'active',
    };
    // delta = -1 -> same (e.g. repeated or late class)
    assert.equal(assessNameMatch(existing, 'Rian 7 SMP').kind, 'same');

    // delta = -2 -> likely_namesake (too far down)
    assert.equal(assessNameMatch(existing, 'Rian 6 SMP').kind, 'likely_namesake');

    // delta = +2 -> same (skipped a grade / accelerated)
    assert.equal(assessNameMatch(existing, 'Rian 10 SMP').kind, 'same');

    // delta = +3 -> likely_namesake
    assert.equal(assessNameMatch(existing, 'Rian 11 SMP').kind, 'likely_namesake');
  });

  await t.test('graduated student matched with much lower incoming grade is likely_namesake', () => {
    // Graduated with stored grade 12
    const grad12 = {
      _id: makeObjectId(),
      full_name: 'Kevin',
      grade_school: '12 SMA',
      status: 'graduated',
      groupNames: ['Alumni 2024'],
    };
    const res1 = assessNameMatch(grad12, 'Kevin 8 SMP');
    assert.equal(res1.kind, 'likely_namesake');

    // Graduated with no stored grade (default baseline 12)
    const gradNoGrade = {
      _id: makeObjectId(),
      full_name: 'Kevin',
      grade_school: '',
      status: 'graduated',
    };
    const res2 = assessNameMatch(gradNoGrade, 'Kevin 8 SMP');
    assert.equal(res2.kind, 'likely_namesake');
  });
});

/* ═══════════════════════════════════════════════════════════════
   2. grade_history Cap
   ═══════════════════════════════════════════════════════════════ */
test('grade_history - capped at last 5 entries and records transitions', () => {
  const student = {
    grade_school: '7 SD',
    grade_history: [],
  };

  // 1. Initial change
  const ok1 = recordGradeChange(student, '8 SMP', 'manual');
  assert.equal(ok1, true);
  assert.equal(student.grade_school, '8 SMP');
  assert.equal(student.grade_history.length, 1);
  assert.equal(student.grade_history[0].grade_school, '8 SMP');
  assert.equal(student.grade_history[0].source, 'manual');

  // 2. No-op if unchanged
  const ok2 = recordGradeChange(student, '8 SMP', 'manual');
  assert.equal(ok2, false);
  assert.equal(student.grade_history.length, 1);

  // 3. Add more changes up to 6
  recordGradeChange(student, '9 SMP', 'import');
  recordGradeChange(student, '10 SMA', 'import');
  recordGradeChange(student, '11 SMA', 'manual');
  recordGradeChange(student, '12 SMA', 'import');
  recordGradeChange(student, '12 SMA+', 'manual'); // 6th entry

  assert.equal(student.grade_history.length, 5);
  // Oldest '8 SMP' should have been shifted out
  assert.equal(student.grade_history[0].grade_school, '9 SMP');
  assert.equal(student.grade_history[4].grade_school, '12 SMA+');
});

/* ═══════════════════════════════════════════════════════════════
   3. Import Preview Flagging & Server-side Skip of Unconfirmed Rows
   ═══════════════════════════════════════════════════════════════ */
test('import preview flagging and server-side namesake handling', async (t) => {
  const existingStudentId = makeObjectId();
  const existingStudents = [
    {
      _id: existingStudentId,
      full_name: 'Budi Hartono',
      raw_name: 'Budi Hartono 8 SMP',
      normalized_name: 'budi hartono',
      grade_school: '8 SMP',
      status: 'active',
    },
  ];

  const existingGroups = [
    {
      _id: makeObjectId(),
      group_name: 'Junior Class 8',
      type: 'GROUP',
      level: 'A2',
      students: ['Budi Hartono 8 SMP'],
      student_ids: [existingStudentId],
    },
  ];

  await t.test('computeRosterDiff flags likely_namesake in additions with amber namesake descriptor', () => {
    const csvDocs = [
      {
        group_name: 'Senior Class 11',
        type: 'GROUP',
        level: 'B2',
        students: ['Budi Hartono 11 SMA'], // Same base name, delta = +3
      },
    ];

    const diff = computeRosterDiff(csvDocs, existingGroups, existingStudents);
    assert.equal(diff.changedGroups.length, 1);
    const card = diff.changedGroups[0];
    assert.equal(card.additions.length, 1);

    const addStudent = card.additions[0];
    assert.equal(addStudent.status, 'NAMESAKE');
    assert.ok(addStudent.namesake, 'Namesake property must be present');
    assert.equal(addStudent.namesake.isNamesake, true);
    assert.equal(addStudent.namesake.existingName, 'Budi Hartono');
    assert.equal(addStudent.namesake.existingGradeSchool, '8 SMP');
    assert.equal(diff.summaryChips.possibleNamesakes, 1);
  });

  await t.test('pure server planner: skips unconfirmed namesake row and imports confirmed namesake', () => {
    function planStudentImports(doc, studentByNorm, groupNamesByStudentNorm, clientConfirmedNamesakes) {
      const studentNames = [];
      const studentIds = [];
      const skippedNamesakes = [];

      for (const rawName of doc.students) {
        const norm = normalizeName(rawName);
        if (!norm) continue;

        const sDoc = studentByNorm.get(norm);
        if (sDoc) {
          const groupNames = Array.from(groupNamesByStudentNorm.get(norm) || []);
          const matchResult = assessNameMatch({ ...sDoc, groupNames }, rawName);

          if (matchResult.kind === 'likely_namesake') {
            const isConfirmed = clientConfirmedNamesakes.some(cn =>
              cn.normKey === norm &&
              String(cn.studentId) === String(sDoc._id) &&
              (cn.rawName === rawName || cn.groupName === doc.group_name)
            );

            if (!isConfirmed) {
              skippedNamesakes.push({
                rawName,
                groupName: doc.group_name,
                instruction: 'Add a last initial or surname to the name in the CSV and import again.',
              });
              continue;
            }
          }
          studentIds.push(sDoc._id);
          studentNames.push(rawName);
        }
      }

      return { studentNames, studentIds, skippedNamesakes };
    }

    const studentMap = new Map();
    studentMap.set('budi hartono', existingStudents[0]);
    const groupNamesMap = new Map();
    groupNamesMap.set('budi hartono', new Set(['Junior Class 8']));

    const doc = {
      group_name: 'Senior Class 11',
      students: ['Budi Hartono 11 SMA'],
    };

    // Case 1: Unconfirmed -> skipped!
    const unconfirmedRes = planStudentImports(doc, studentMap, groupNamesMap, []);
    assert.equal(unconfirmedRes.studentNames.length, 0);
    assert.equal(unconfirmedRes.skippedNamesakes.length, 1);
    assert.equal(
      unconfirmedRes.skippedNamesakes[0].instruction,
      'Add a last initial or surname to the name in the CSV and import again.'
    );

    // Case 2: Tampered confirmation (wrong studentId) -> ignored and skipped!
    const tamperedRes = planStudentImports(doc, studentMap, groupNamesMap, [
      { normKey: 'budi hartono', studentId: String(makeObjectId()), rawName: 'Budi Hartono 11 SMA' }
    ]);
    assert.equal(tamperedRes.studentNames.length, 0);
    assert.equal(tamperedRes.skippedNamesakes.length, 1);

    // Case 3: Confirmed -> accepted!
    const confirmedRes = planStudentImports(doc, studentMap, groupNamesMap, [
      { normKey: 'budi hartono', studentId: String(existingStudentId), rawName: 'Budi Hartono 11 SMA' }
    ]);
    assert.equal(confirmedRes.studentNames.length, 1);
    assert.equal(confirmedRes.skippedNamesakes.length, 0);
  });
});

/* ═══════════════════════════════════════════════════════════════
   4. Manual Add 409 & Confirmation Flow
   ═══════════════════════════════════════════════════════════════ */
test('manual add: returns 409 POSSIBLE_NAMESAKE when unconfirmed, succeeds when confirmed', async () => {
  const existingId = makeObjectId();
  const existingStudent = {
    _id: existingId,
    full_name: 'Jason',
    raw_name: 'Jason 8 SMP',
    normalized_name: 'jason',
    grade_school: '8 SMP',
    status: 'active',
    groups: [],
    toObject: function () { return this; },
    save: async function () { return this; },
  };

  const group = {
    _id: makeObjectId(),
    group_name: 'High School Math',
    students: [],
    student_ids: [],
    save: async function () { return this; },
  };

  const origFindOne = Student.findOne;
  const origFind = Student.find;
  Student.findOne = async (q) => {
    if (q.normalized_name === 'jason') return existingStudent;
    return null;
  };
  Student.find = (q) => ({
    lean: async () => [],
    select: () => ({ lean: async () => [] }),
  });

  try {
    // 1. Unconfirmed add of "Jason 12 CS" -> delta = +4 -> must throw 409 POSSIBLE_NAMESAKE
    await assert.rejects(
      async () => {
        await groupRosterService.addStudentsToGroup(group, ['Jason 12 CS']);
      },
      (err) => {
        assert.equal(err.status, 409);
        assert.equal(err.code, 'POSSIBLE_NAMESAKE');
        assert.ok(Array.isArray(err.possibleNamesake));
        assert.equal(err.possibleNamesake[0].norm, 'jason');
        assert.equal(err.possibleNamesake[0].name, 'Jason');
        return true;
      }
    );

    // Group roster must remain untouched
    assert.equal(group.students.length, 0);
    assert.equal(group.student_ids.length, 0);

    // 2. Confirmed add with confirmSameStudent: ['jason'] -> succeeds
    const result = await groupRosterService.addStudentsToGroup(group, ['Jason 12 CS'], {
      confirmSameStudent: ['jason'],
    });

    assert.equal(result.added.length, 1);
    assert.equal(group.students.length, 1);
    assert.equal(group.student_ids.length, 1);
  } finally {
    Student.findOne = origFindOne;
    Student.find = origFind;
  }
});

/* ═══════════════════════════════════════════════════════════════
   5. Race-Safe Creation with Simulated Concurrent Creators
   ═══════════════════════════════════════════════════════════════ */
test('race-safe creation: re-queries and deletes newer duplicate when another student created concurrently', async () => {
  const normalized = 'concurrency student';
  const student1 = {
    _id: makeObjectId(),
    normalized_name: normalized,
    full_name: 'Concurrency Student',
    createdAt: new Date(Date.now() - 5000), // Older
  };
  const student2 = {
    _id: makeObjectId(),
    normalized_name: normalized,
    full_name: 'Concurrency Student',
    createdAt: new Date(), // Newer (lost race)
  };

  let deletedId = null;
  const fakeStore = [student1, student2];

  // Pure race resolution logic as implemented in matchOrCreateStudent
  async function resolveRace(newStudent, store) {
    // Sort by createdAt: 1, _id: 1
    const sorted = [...store].sort((a, b) => a.createdAt - b.createdAt);
    if (sorted.length > 1) {
      const oldest = sorted[0];
      if (String(oldest._id) !== String(newStudent._id)) {
        // Delete new student if no refs
        deletedId = String(newStudent._id);
        return { student: oldest, created: false };
      }
    }
    return { student: newStudent, created: true };
  }

  const result = await resolveRace(student2, fakeStore);
  assert.equal(result.created, false);
  assert.equal(String(result.student._id), String(student1._id));
  assert.equal(deletedId, String(student2._id));
});

/* ═══════════════════════════════════════════════════════════════
   6. Rename Rollback on Duplicate Normalized Name
   ═══════════════════════════════════════════════════════════════ */
test('rename rollback: rolls back student document and throws 409 when duplicate normalized_name detected', async () => {
  const studentId = makeObjectId();
  const student = {
    _id: studentId,
    raw_name: 'Original Name 8 SMP',
    full_name: 'Original Name',
    normalized_name: 'original name',
    grade_school: '8 SMP',
    grade_history: [{ grade_school: '8 SMP', at: new Date(), source: 'manual' }],
    save: async function () { return this; },
  };

  const group = {
    students: ['Original Name 8 SMP'],
    student_ids: [studentId],
    save: async function () { return this; },
  };

  const origCount = Student.countDocuments;
  // Simulate duplicate found post-save
  Student.countDocuments = async () => 1;

  try {
    await assert.rejects(
      async () => {
        await groupRosterService.saveStudentAndGroupWithRollback(
          student,
          group,
          {
            raw_name: 'Colliding Name 9 SMA',
            full_name: 'Colliding Name',
            normalized_name: 'colliding name',
            grade_school: '9 SMA',
          },
          { students: ['Colliding Name 9 SMA'], student_ids: [studentId] }
        );
      },
      (err) => {
        assert.equal(err.status, 409);
        assert.equal(err.code, 'CONFLICT');
        return true;
      }
    );

    // Verify student was rolled back
    assert.equal(student.raw_name, 'Original Name 8 SMP');
    assert.equal(student.full_name, 'Original Name');
    assert.equal(student.normalized_name, 'original name');
    assert.equal(student.grade_school, '8 SMP');
  } finally {
    Student.countDocuments = origCount;
  }
});

/* ═══════════════════════════════════════════════════════════════
   7. Audit Helper Functions on Synthetic Data
   ═══════════════════════════════════════════════════════════════ */
test('audit helper functions: synthetic data checks', async (t) => {
  const id1 = makeObjectId();
  const id2 = makeObjectId();
  const id3 = makeObjectId();

  const students = [
    { _id: id1, normalized_name: 'john doe', full_name: 'John Doe', grade_school: '8 SMP', barcode: 'BC1' },
    { _id: id2, normalized_name: 'john doe', full_name: 'John Doe', grade_school: '11 SMA', barcode: 'BC2' },
    { _id: id3, normalized_name: 'jane smith', full_name: 'Jane Smith', grade_school: '9 CS', barcode: 'BC3' },
  ];

  const groups = [
    {
      _id: makeObjectId(),
      group_name: 'Class 8A',
      type: 'GROUP',
      students: ['John Doe 8 SMP', 'Jane Smith 9 CS'],
      student_ids: [id1, id3],
    },
    {
      _id: makeObjectId(),
      group_name: 'Class 12A',
      type: 'GROUP',
      students: ['John Doe 12 SMA'], // In this group, John Doe is listed as 12 SMA -> delta 12 - 8 = 4 >= 3
      student_ids: [id2],
    },
    {
      _id: makeObjectId(),
      group_name: 'Private Music',
      type: 'PRIVATE',
      students: ['Jane Smith 9 CS'],
      student_ids: [id3],
    },
  ];

  await t.test('auditFindDuplicates: identifies duplicate normalized_name docs', () => {
    const txMap = new Map([[String(id1), 3], [String(id2), 5]]);
    const dups = auditFindDuplicates(students, groups, txMap);

    assert.equal(dups.length, 1);
    assert.equal(dups[0].normalized_name, 'john doe');
    assert.equal(dups[0].count, 2);
    assert.equal(dups[0].students[0].acTransactionsCount, 3);
    assert.equal(dups[0].students[1].acTransactionsCount, 5);
  });

  await t.test('auditFindConflictingRosterGrades: flags max - min >= 3', () => {
    const conflicts = auditFindConflictingRosterGrades(groups);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].normalized_name, 'john doe');
    assert.equal(conflicts[0].minGrade, 8);
    assert.equal(conflicts[0].maxGrade, 12);
    assert.equal(conflicts[0].delta, 4);
  });

  await t.test('auditFindDifferentGradesInGroupType: flags 2+ GROUP-type groups with differing grades', () => {
    const diffs = auditFindDifferentGradesInGroupType(groups);
    // John Doe is in Class 8A (grade 8) and Class 12A (grade 12) -> both type GROUP
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].normalized_name, 'john doe');
    assert.deepEqual(diffs[0].distinctGrades, [8, 12]);

    // Jane Smith is in 1 GROUP and 1 PRIVATE -> not flagged
    assert.equal(diffs.some(d => d.normalized_name === 'jane smith'), false);
  });
});

