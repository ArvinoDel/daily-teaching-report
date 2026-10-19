const test = require('node:test');
const assert = require('node:assert/strict');
const {
  pairsToRoster,
  applyRosterAdd,
  applyRosterRemove,
  applyRosterMove,
  applyRosterRename,
} = require('../services/groupRosterService');
const { normalizeName } = require('../models/Student');

test('Group Roster Service - Pure Helper Tests', async (t) => {
  await t.test('1. Add new student to roster', () => {
    const current = [
      { name: 'Alice Smith', norm: 'alice smith', id: 'id-1' },
    ];
    const incoming = [
      { name: 'Bob Jones', norm: 'bob jones', id: 'id-2' },
    ];

    const result = applyRosterAdd(current, incoming);
    assert.equal(result.pairs.length, 2);
    assert.equal(result.added.length, 1);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.added[0].name, 'Bob Jones');
    assert.equal(result.students.length, 2);
    assert.equal(result.student_ids.length, 2);
    assert.deepEqual(result.students, ['Alice Smith', 'Bob Jones']);
    assert.deepEqual(result.student_ids, ['id-1', 'id-2']);
  });

  await t.test('2. Add existing (no duplicate, keeps stored spelling)', () => {
    // Current group has "Alice Smith". Incoming tries to add "alice smith 11 SPB" (same norm).
    const current = [
      { name: 'Alice Smith', norm: 'alice smith', id: 'id-1' },
    ];
    const incoming = [
      { name: 'alice smith 11 SPB', norm: 'alice smith', id: 'id-1' },
    ];

    const result = applyRosterAdd(current, incoming);
    assert.equal(result.pairs.length, 1);
    assert.equal(result.added.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, 'Already in this group');
    // Stored spelling unchanged
    assert.equal(result.pairs[0].name, 'Alice Smith');
    assert.deepEqual(result.students, ['Alice Smith']);
    assert.deepEqual(result.student_ids, ['id-1']);
  });

  await t.test('3. Add duplicate within incoming batch', () => {
    const current = [];
    const incoming = [
      { name: 'Charlie Brown', norm: 'charlie brown', id: 'id-3' },
      { name: 'Charlie Brown 10 N1', norm: 'charlie brown', id: 'id-3' },
    ];

    const result = applyRosterAdd(current, incoming);
    assert.equal(result.pairs.length, 1);
    assert.equal(result.added.length, 1);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, 'Already in this group');
    assert.deepEqual(result.students, ['Charlie Brown']);
    assert.deepEqual(result.student_ids, ['id-3']);
  });

  await t.test('4. Remove by id and by norm', () => {
    const current = [
      { name: 'Student One', norm: 'student one', id: 'id-1' },
      { name: 'Student Two', norm: 'student two', id: 'id-2' },
      { name: 'Student Three', norm: 'student three', id: 'id-3' },
    ];

    // Remove by id
    const resId = applyRosterRemove(current, { studentId: 'id-2' });
    assert.equal(resId.pairs.length, 2);
    assert.equal(resId.removed.name, 'Student Two');
    assert.deepEqual(resId.students, ['Student One', 'Student Three']);
    assert.deepEqual(resId.student_ids, ['id-1', 'id-3']);
    assert.equal(resId.students.length, resId.student_ids.length);

    // Remove by norm
    const resNorm = applyRosterRemove(current, { normKey: 'student one' });
    assert.equal(resNorm.pairs.length, 2);
    assert.equal(resNorm.removed.name, 'Student One');
    assert.deepEqual(resNorm.students, ['Student Two', 'Student Three']);
    assert.deepEqual(resNorm.student_ids, ['id-2', 'id-3']);
    assert.equal(resNorm.students.length, resNorm.student_ids.length);
  });

  await t.test('5. Move keeps both groups consistent', () => {
    const fromPairs = [
      { name: 'Alice', norm: 'alice', id: 'id-a' },
      { name: 'Bob', norm: 'bob', id: 'id-b' },
    ];
    const toPairs = [
      { name: 'Charlie', norm: 'charlie', id: 'id-c' },
    ];

    const result = applyRosterMove(fromPairs, toPairs, { studentId: 'id-b' });

    assert.equal(result.fromPairs.length, 1);
    assert.deepEqual(result.fromPairs.map(p => p.name), ['Alice']);
    assert.deepEqual(result.fromRoster.students, ['Alice']);
    assert.deepEqual(result.fromRoster.student_ids, ['id-a']);

    assert.equal(result.toPairs.length, 2);
    assert.deepEqual(result.toPairs.map(p => p.name), ['Charlie', 'Bob']);
    assert.deepEqual(result.toRoster.students, ['Charlie', 'Bob']);
    assert.deepEqual(result.toRoster.student_ids, ['id-c', 'id-b']);

    assert.equal(result.fromRoster.students.length, result.fromRoster.student_ids.length);
    assert.equal(result.toRoster.students.length, result.toRoster.student_ids.length);
  });

  await t.test('6. students[] and student_ids[] never differ in length after any operation', () => {
    let pairs = [
      { name: 'Student 1', norm: 'student 1', id: 'id-1' },
      { name: 'Student 2', norm: 'student 2', id: 'id-2' },
    ];

    // Check initial
    let roster = pairsToRoster(pairs);
    assert.equal(roster.students.length, roster.student_ids.length);

    // Add
    const addRes = applyRosterAdd(pairs, [
      { name: 'Student 3', norm: 'student 3', id: 'id-3' },
      { name: 'Student 4', norm: 'student 4', id: 'id-4' },
    ]);
    assert.equal(addRes.students.length, addRes.student_ids.length);
    assert.equal(addRes.students.length, 4);

    // Remove
    const removeRes = applyRosterRemove(addRes.pairs, { studentId: 'id-1' });
    assert.equal(removeRes.students.length, removeRes.student_ids.length);
    assert.equal(removeRes.students.length, 3);

    // Move
    const moveRes = applyRosterMove(removeRes.pairs, [], { studentId: 'id-3' });
    assert.equal(moveRes.fromRoster.students.length, moveRes.fromRoster.student_ids.length);
    assert.equal(moveRes.toRoster.students.length, moveRes.toRoster.student_ids.length);
  });

  await t.test('7. Names with quotes/accents pass through unchanged', () => {
    const complexNames = [
      'O\'Connor "Special" 11 SPB',
      'Renée François 12 CS',
      'Haikal & Airra',
    ];

    const incoming = complexNames.map((name, i) => ({
      name,
      norm: normalizeName(name),
      id: `id-${i}`,
    }));

    const result = applyRosterAdd([], incoming);
    assert.equal(result.pairs.length, 3);
    assert.equal(result.pairs[0].name, 'O\'Connor "Special" 11 SPB');
    assert.equal(result.pairs[1].name, 'Renée François 12 CS');
    assert.equal(result.pairs[2].name, 'Haikal & Airra');

    assert.equal(result.students[0], 'O\'Connor "Special" 11 SPB');
    assert.equal(result.students[1], 'Renée François 12 CS');
    assert.equal(result.students[2], 'Haikal & Airra');
    assert.equal(result.students.length, result.student_ids.length);
  });

  await t.test('8. Move error conditions (not in source, already in target, max limit)', () => {
    const fromPairs = [{ name: 'Alice', norm: 'alice', id: 'id-1' }];
    const toPairs = [{ name: 'Bob', norm: 'bob', id: 'id-2' }];

    // Not in source
    assert.throws(() => {
      applyRosterMove(fromPairs, toPairs, { studentId: 'non-existent' });
    }, /Student not found in source group/);

    // Already in target
    assert.throws(() => {
      applyRosterMove(fromPairs, [{ name: 'Alice', norm: 'alice', id: 'id-1' }], { studentId: 'id-1' });
    }, /Student is already in target group/);

    // Target group max reached
    assert.throws(() => {
      applyRosterMove(fromPairs, toPairs, { studentId: 'id-1', maxStudents: 1 });
    }, /Target group has reached maximum/);
  });

  await t.test('9. Max 200 students limit in applyRosterAdd', () => {
    const current = [{ name: 'Existing', norm: 'existing', id: 'id-0' }];
    const incoming = [
      { name: 'Student A', norm: 'student a', id: 'id-a' },
      { name: 'Student B', norm: 'student b', id: 'id-b' },
    ];

    const result = applyRosterAdd(current, incoming, { maxStudents: 2 });
    assert.equal(result.added.length, 1);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /Max 2 students per group/);
    assert.equal(result.students.length, 2);
    assert.equal(result.students.length, result.student_ids.length);
  });

  await t.test('9b. applyRosterRename: successfully renames student and updates name and norm', () => {
    const current = [
      { name: 'Alice Smith', norm: 'alice smith', id: 'id-1' },
      { name: 'Bob Jones', norm: 'bob jones', id: 'id-2' },
    ];

    const result = applyRosterRename(current, { studentId: 'id-1', newName: 'Alice Johnson 11 CS' });
    assert.equal(result.pairs.length, 2);
    assert.equal(result.renamed.name, 'Alice Johnson 11 CS');
    assert.equal(result.renamed.norm, 'alice johnson');
    assert.equal(result.renamed.id, 'id-1');
    assert.equal(result.oldName, 'Alice Smith');
    assert.deepEqual(result.students, ['Alice Johnson 11 CS', 'Bob Jones']);
    assert.deepEqual(result.student_ids, ['id-1', 'id-2']);
  });

  await t.test('9c. applyRosterRename: rejects empty or whitespace name', () => {
    const current = [
      { name: 'Alice Smith', norm: 'alice smith', id: 'id-1' },
    ];

    assert.throws(
      () => applyRosterRename(current, { studentId: 'id-1', newName: '   ' }),
      /Student name is required/
    );
  });

  await t.test('9d. applyRosterRename: rejects name longer than 100 characters', () => {
    const current = [
      { name: 'Alice Smith', norm: 'alice smith', id: 'id-1' },
    ];

    assert.throws(
      () => applyRosterRename(current, { studentId: 'id-1', newName: 'A'.repeat(101) }),
      /Student name max 100 characters/
    );
  });

  await t.test('9e. applyRosterRename: rejects if studentId not found', () => {
    const current = [
      { name: 'Alice Smith', norm: 'alice smith', id: 'id-1' },
    ];

    assert.throws(
      () => applyRosterRename(current, { studentId: 'id-unknown', newName: 'Alice New' }),
      /Student not found in this group/
    );
  });

  await t.test('9f. applyRosterRename: rejects if new name collides with another student in group', () => {
    const current = [
      { name: 'Alice Smith', norm: 'alice smith', id: 'id-1' },
      { name: 'Bob Jones', norm: 'bob jones', id: 'id-2' },
    ];

    assert.throws(
      () => applyRosterRename(current, { studentId: 'id-1', newName: 'Bob Jones 10 N1' }),
      /A student with this name already exists in this group/
    );
  });

  await t.test('9g. applyRosterRename: allows rename if new name has same norm as target student', () => {
    const current = [
      { name: 'Alice Smith', norm: 'alice smith', id: 'id-1' },
      { name: 'Bob Jones', norm: 'bob jones', id: 'id-2' },
    ];

    // Same student, just adding a class annotation or fixing casing
    const result = applyRosterRename(current, { studentId: 'id-1', newName: 'Alice Smith 12 SPB' });
    assert.equal(result.renamed.name, 'Alice Smith 12 SPB');
    assert.equal(result.renamed.norm, 'alice smith');
    assert.equal(result.renamed.id, 'id-1');
    assert.deepEqual(result.students, ['Alice Smith 12 SPB', 'Bob Jones']);
  });
});

test('Group Roster Service - DB Wrapper & Atomicity Tests', async (t) => {
  const mongoose = require('mongoose');
  const Student = require('../models/Student');
  const Group = require('../models/Group');
  const {
    removeStudentFromGroup,
    moveStudent,
    renameStudentInGroup,
  } = require('../services/groupRosterService');
  const {
    getGroupEditData,
    formatGroupCreatedAt,
    groupRenameStudent,
  } = require('../controllers/adminGroupController');

  function makeObjectId() {
    return new mongoose.Types.ObjectId();
  }

  await t.test('10. removeStudentFromGroup with misaligned, shuffled, and longer student_ids (12 IDs, 6 names)', async () => {
    const studentsData = [
      { name: 'Alice Smith', id: makeObjectId() },
      { name: 'Bob Jones', id: makeObjectId() },
      { name: 'Charlie Brown', id: makeObjectId() },
      { name: 'David Lee', id: makeObjectId() },
      { name: 'Eva Green', id: makeObjectId() },
      { name: 'Frank White', id: makeObjectId() },
    ];

    const ghostIds = Array.from({ length: 6 }, () => makeObjectId());

    // 12 IDs, deliberately shuffled and longer than 6 names
    const misalignedIds = [
      ghostIds[0],
      studentsData[1].id, // Bob
      ghostIds[1],
      studentsData[0].id, // Alice
      ghostIds[2],
      studentsData[3].id, // David
      ghostIds[3],
      studentsData[2].id, // Charlie
      ghostIds[4],
      studentsData[4].id, // Eva
      ghostIds[5],
      studentsData[5].id, // Frank
    ];

    let saved = false;
    const group = {
      _id: makeObjectId(),
      group_name: 'Misaligned Class',
      students: studentsData.map(s => s.name), // 6 names
      student_ids: misalignedIds,               // 12 IDs
      save: async function () { saved = true; return this; },
    };

    const targetStudent = studentsData[2]; // Charlie

    // Mock Student.findById and Student.find
    const origFindById = Student.findById;
    const origFind = Student.find;

    Student.findById = async (id) => {
      const match = studentsData.find(s => String(s.id) === String(id));
      if (!match) return null;
      return {
        _id: match.id,
        full_name: match.name,
        normalized_name: normalizeName(match.name),
      };
    };

    Student.find = (query) => ({
      lean: async () => studentsData.map(s => ({
        _id: s.id,
        full_name: s.name,
        normalized_name: normalizeName(s.name),
      })),
    });

    try {
      const res = await removeStudentFromGroup(group, targetStudent.id);
      assert.equal(res.ok, true);
      assert.equal(res.removedName, 'Charlie Brown');
      assert.equal(saved, true);

      // Verify group state: exactly 5 students and 5 IDs, aligned, Charlie removed
      assert.equal(group.students.length, 5);
      assert.equal(group.student_ids.length, 5);
      assert.deepEqual(group.students, [
        'Alice Smith',
        'Bob Jones',
        'David Lee',
        'Eva Green',
        'Frank White',
      ]);
      assert.deepEqual(
        group.student_ids.map(id => String(id)),
        [
          String(studentsData[0].id),
          String(studentsData[1].id),
          String(studentsData[3].id),
          String(studentsData[4].id),
          String(studentsData[5].id),
        ]
      );
    } finally {
      Student.findById = origFindById;
      Student.find = origFind;
    }
  });

  await t.test('11. moveStudent with 12 IDs / 6 names leaves student in exactly one group', async () => {
    const fromStudents = [
      { name: 'Alice Smith', id: makeObjectId() },
      { name: 'Bob Jones', id: makeObjectId() },
      { name: 'Charlie Brown', id: makeObjectId() },
      { name: 'David Lee', id: makeObjectId() },
      { name: 'Eva Green', id: makeObjectId() },
      { name: 'Frank White', id: makeObjectId() },
    ];
    const ghostIds = Array.from({ length: 6 }, () => makeObjectId());
    const misalignedFromIds = [
      ghostIds[0], fromStudents[1].id, ghostIds[1], fromStudents[0].id,
      ghostIds[2], fromStudents[3].id, ghostIds[3], fromStudents[2].id,
      ghostIds[4], fromStudents[4].id, ghostIds[5], fromStudents[5].id,
    ];

    const toStudents = [
      { name: 'Grace Hopper', id: makeObjectId() },
      { name: 'Heidi Klum', id: makeObjectId() },
    ];

    const fromGroup = {
      _id: makeObjectId(),
      group_name: 'From Class',
      students: fromStudents.map(s => s.name),
      student_ids: misalignedFromIds,
      save: async function () { return this; },
    };

    const toGroup = {
      _id: makeObjectId(),
      group_name: 'To Class',
      students: toStudents.map(s => s.name),
      student_ids: toStudents.map(s => s.id),
      save: async function () { return this; },
    };

    const allStudents = [...fromStudents, ...toStudents];
    const targetStudent = fromStudents[2]; // Charlie

    const origFindById = Student.findById;
    const origFind = Student.find;
    const origStartSession = mongoose.startSession;

    Student.findById = async (id) => {
      const match = allStudents.find(s => String(s.id) === String(id));
      if (!match) return null;
      return {
        _id: match.id,
        full_name: match.name,
        normalized_name: normalizeName(match.name),
      };
    };

    Student.find = (query) => ({
      lean: async () => allStudents.map(s => ({
        _id: s.id,
        full_name: s.name,
        normalized_name: normalizeName(s.name),
      })),
    });

    // Mock transaction session
    mongoose.startSession = async () => ({
      startTransaction: () => {},
      commitTransaction: async () => {},
      abortTransaction: async () => {},
      endSession: () => {},
    });

    try {
      const res = await moveStudent(fromGroup, toGroup, targetStudent.id);
      assert.equal(res.ok, true);
      assert.equal(res.atomic, 'transaction');

      // Verify fromGroup: 5 students, 5 IDs, aligned, Charlie gone
      assert.equal(fromGroup.students.length, 5);
      assert.equal(fromGroup.student_ids.length, 5);
      assert.equal(fromGroup.students.includes('Charlie Brown'), false);

      // Verify toGroup: 3 students, 3 IDs, Charlie added
      assert.equal(toGroup.students.length, 3);
      assert.equal(toGroup.student_ids.length, 3);
      assert.equal(toGroup.students.includes('Charlie Brown'), true);

      // Student is in exactly one group
      const inFrom = fromGroup.students.filter(n => n === 'Charlie Brown').length;
      const inTo = toGroup.students.filter(n => n === 'Charlie Brown').length;
      assert.equal(inFrom + inTo, 1);
    } finally {
      Student.findById = origFindById;
      Student.find = origFind;
      mongoose.startSession = origStartSession;
    }
  });

  await t.test('12. moveStudent failed transaction (code: 20) falls back sequentially without duplicate additions', async () => {
    const studentCharlie = { name: 'Charlie Brown', id: makeObjectId() };
    const fromGroup = {
      _id: makeObjectId(),
      group_name: 'From Class',
      students: ['Alice Smith', 'Charlie Brown'],
      student_ids: [makeObjectId(), studentCharlie.id],
      save: async function (opts) {
        if (opts && opts.session) {
          const err = new Error('Transaction numbers are only allowed on a replica set member or mongos');
          err.code = 20;
          throw err;
        }
        return this;
      },
    };

    const toGroup = {
      _id: makeObjectId(),
      group_name: 'To Class',
      students: ['David Lee'],
      student_ids: [makeObjectId()],
      save: async function (opts) {
        if (opts && opts.session) {
          const err = new Error('Transaction numbers are only allowed on a replica set member or mongos');
          err.code = 20;
          throw err;
        }
        return this;
      },
    };

    const allStudents = [
      { name: 'Alice Smith', id: fromGroup.student_ids[0] },
      studentCharlie,
      { name: 'David Lee', id: toGroup.student_ids[0] },
    ];

    const origFindById = Student.findById;
    const origFind = Student.find;
    const origStartSession = mongoose.startSession;

    Student.findById = async (id) => ({
      _id: studentCharlie.id,
      full_name: studentCharlie.name,
      normalized_name: normalizeName(studentCharlie.name),
    });

    Student.find = (query) => ({
      lean: async () => allStudents.map(s => ({
        _id: s.id,
        full_name: s.name,
        normalized_name: normalizeName(s.name),
      })),
    });

    mongoose.startSession = async () => ({
      startTransaction: () => {},
      commitTransaction: async () => {},
      abortTransaction: async () => {},
      endSession: () => {},
    });

    try {
      const res = await moveStudent(fromGroup, toGroup, studentCharlie.id);
      assert.equal(res.ok, true);
      assert.equal(res.atomic, 'sequential-after-validation');

      // Assert final state: exactly one Charlie in toGroup, zero in fromGroup
      assert.deepEqual(fromGroup.students, ['Alice Smith']);
      assert.equal(fromGroup.students.length, fromGroup.student_ids.length);

      assert.deepEqual(toGroup.students, ['David Lee', 'Charlie Brown']);
      assert.equal(toGroup.students.length, toGroup.student_ids.length);

      // Verify no duplicates
      const charlieOccurrences = toGroup.students.filter(n => n === 'Charlie Brown').length;
      assert.equal(charlieOccurrences, 1);
    } finally {
      Student.findById = origFindById;
      Student.find = origFind;
      mongoose.startSession = origStartSession;
    }
  });

  await t.test('13. getGroupEditData is strictly read-only and never writes to DB', async () => {
    let saveCalled = false;
    const group = {
      _id: makeObjectId(),
      group_name: 'Test Class',
      students: ['Alice Smith', 'Ghost Student'],
      student_ids: [makeObjectId(), makeObjectId(), makeObjectId()], // 3 ids vs 2 names (inconsistent)
      save: async function () {
        saveCalled = true;
        throw new Error('getGroupEditData must never call save()!');
      },
    };

    const origStudentFind = Student.find;
    const origGroupFind = Group.find;

    Student.find = () => ({
      lean: async () => [
        {
          _id: group.student_ids[0],
          normalized_name: normalizeName('Alice Smith'),
          student_code: 'SC-1234',
          barcode: 'BC-1234',
          status: 'active',
        },
      ],
      select: () => ({
        lean: async () => [],
      }),
    });

    Group.find = () => ({
      select: () => ({
        lean: async () => [],
        sort: () => ({ lean: async () => [] }),
      }),
    });

    try {
      const data = await getGroupEditData(group);
      assert.equal(saveCalled, false);
      assert.equal(data.isInconsistent, true);
      assert.equal(data.hasLengthMismatch, true);
      assert.equal(data.hasNamesWithoutStudent, true);
      assert.equal(data.roster.length, 2);
      assert.equal(data.roster[0].name, 'Alice Smith');
      assert.equal(data.roster[0].student_code, 'SC-1234');
      assert.equal(data.roster[1].name, 'Ghost Student');
      assert.equal(data.roster[1].student_code, '');
    } finally {
      Student.find = origStudentFind;
      Group.find = origGroupFind;
    }
  });

  await t.test('14. formatGroupCreatedAt formats date in Asia/Jakarta with ObjectId timestamp fallback', () => {
    // 1. Group with createdAt
    const date = new Date('2026-10-13T04:57:17Z'); // 11:57 Jakarta time (UTC+7)
    const groupWithDate = {
      _id: makeObjectId(),
      createdAt: date,
    };
    const formattedWithDate = formatGroupCreatedAt(groupWithDate);
    assert.equal(formattedWithDate, '13 Oct 2026');

    // 2. Group without createdAt (fallback to _id.getTimestamp())
    const objectId = mongoose.Types.ObjectId.createFromTime(Math.floor(date.getTime() / 1000));
    const groupWithoutDate = {
      _id: objectId,
      createdAt: null,
    };
    const formattedFallback = formatGroupCreatedAt(groupWithoutDate);
    assert.equal(formattedFallback, '13 Oct 2026');
  });

  await t.test('15. pairsToRoster never outputs null in student_ids when pairs have null ids', () => {
    const pairs = [
      { name: 'Alice', norm: 'alice', id: makeObjectId() },
      { name: 'Unlinked Bob', norm: 'unlinked bob', id: null },
      { name: 'Charlie', norm: 'charlie', id: makeObjectId() },
      { name: 'Unlinked David', norm: 'unlinked david', id: undefined },
    ];
    const roster = pairsToRoster(pairs);
    assert.deepEqual(roster.students, ['Alice', 'Unlinked Bob', 'Charlie', 'Unlinked David']);
    assert.equal(roster.student_ids.length, 2);
    assert.equal(roster.student_ids.includes(null), false);
    assert.equal(roster.student_ids.includes(undefined), false);
  });

  await t.test('16. add/remove/move refuse to run on a group with unlinked names, returning needsRepair and writing nothing', async () => {
    const aliceId = makeObjectId();
    let saved = false;
    const groupWithUnlinked = {
      _id: makeObjectId(),
      group_name: 'Unlinked Group',
      students: ['Alice Smith', 'Unlinked Student'],
      student_ids: [aliceId],
      save: async function () { saved = true; return this; },
    };

    const targetGroup = {
      _id: makeObjectId(),
      group_name: 'Target Group',
      students: ['Existing Student'],
      student_ids: [makeObjectId()],
      save: async function () { saved = true; return this; },
    };

    const origFind = Student.find;
    const origFindById = Student.findById;

    // Student.find resolves Alice only, Unlinked Student has no doc
    Student.find = () => ({
      lean: async () => [{
        _id: aliceId,
        full_name: 'Alice Smith',
        normalized_name: normalizeName('Alice Smith'),
      }],
    });
    Student.findById = async (id) => ({
      _id: aliceId,
      full_name: 'Alice Smith',
      normalized_name: normalizeName('Alice Smith'),
    });

    try {
      const { addStudentsToGroup, removeStudentFromGroup } = require('../services/groupRosterService');

      // 1. addStudentsToGroup
      saved = false;
      await assert.rejects(async () => {
        await addStudentsToGroup(groupWithUnlinked, ['New Person']);
      }, (err) => {
        assert.equal(err.needsRepair, true);
        assert.equal(err.groupId, String(groupWithUnlinked._id));
        assert.equal(err.groupName, 'Unlinked Group');
        assert.match(err.message, /Repair this group's roster first/);
        return true;
      });
      assert.equal(saved, false);

      // 2. removeStudentFromGroup
      saved = false;
      await assert.rejects(async () => {
        await removeStudentFromGroup(groupWithUnlinked, aliceId);
      }, (err) => {
        assert.equal(err.needsRepair, true);
        assert.equal(err.groupId, String(groupWithUnlinked._id));
        return true;
      });
      assert.equal(saved, false);

      // 3. moveStudent where source has unlinked student
      saved = false;
      await assert.rejects(async () => {
        await moveStudent(groupWithUnlinked, targetGroup, aliceId);
      }, (err) => {
        assert.equal(err.needsRepair, true);
        assert.equal(err.groupId, String(groupWithUnlinked._id));
        return true;
      });
      assert.equal(saved, false);

      // 4. moveStudent where target has unlinked student
      const cleanSourceGroup = {
        _id: makeObjectId(),
        group_name: 'Clean Source Group',
        students: ['Alice Smith'],
        student_ids: [aliceId],
        save: async function () { saved = true; return this; },
      };
      await assert.rejects(async () => {
        await moveStudent(cleanSourceGroup, groupWithUnlinked, aliceId);
      }, (err) => {
        assert.equal(err.needsRepair, true);
        assert.equal(err.groupId, String(groupWithUnlinked._id));
        assert.match(err.message, /Repair target group "Unlinked Group"'s roster first/);
        return true;
      });
      assert.equal(saved, false);
    } finally {
      Student.find = origFind;
      Student.findById = origFindById;
    }
  });

  await t.test('17. after repair, add/remove/move succeed and no null ever appears in student_ids', async () => {
    const studentAlice = {
      _id: makeObjectId(),
      raw_name: 'Alice Smith',
      full_name: 'Alice Smith',
      normalized_name: normalizeName('Alice Smith'),
      status: 'active',
      student_code: 'SC-1',
      barcode: 'BC-1',
    };
    const studentBob = {
      _id: makeObjectId(),
      raw_name: 'Bob Jones',
      full_name: 'Bob Jones',
      normalized_name: normalizeName('Bob Jones'),
      status: 'active',
      student_code: 'SC-2',
      barcode: 'BC-2',
    };
    const studentCharlie = {
      _id: makeObjectId(),
      raw_name: 'Charlie Brown',
      full_name: 'Charlie Brown',
      normalized_name: normalizeName('Charlie Brown'),
      status: 'active',
      student_code: 'SC-3',
      barcode: 'BC-3',
    };

    let allStudents = [studentAlice, studentBob, studentCharlie];

    const group = {
      _id: makeObjectId(),
      group_name: 'Repaired Group',
      students: ['Alice Smith', 'Bob Jones', 'Charlie Brown'],
      student_ids: [studentAlice._id, studentBob._id, studentCharlie._id],
      save: async function () { return this; },
    };

    const targetGroup = {
      _id: makeObjectId(),
      group_name: 'Repaired Target Group',
      students: [],
      student_ids: [],
      save: async function () { return this; },
    };

    const origFind = Student.find;
    const origFindById = Student.findById;
    const origFindOne = Student.findOne;
    const origStartSession = mongoose.startSession;

    Student.find = (query) => ({
      lean: async () => allStudents,
    });
    Student.findById = async (id) => allStudents.find(s => String(s._id) === String(id)) || null;
    Student.findOne = async (query) => allStudents.find(s => s.normalized_name === query.normalized_name) || null;

    mongoose.startSession = async () => ({
      startTransaction: () => {},
      commitTransaction: async () => {},
      abortTransaction: async () => {},
      endSession: () => {},
    });

    try {
      const { addStudentsToGroup, removeStudentFromGroup } = require('../services/groupRosterService');

      // 1. Add students
      const studentDavid = {
        _id: makeObjectId(),
        raw_name: 'David Lee',
        full_name: 'David Lee',
        normalized_name: normalizeName('David Lee'),
        status: 'active',
        student_code: 'SC-4',
        barcode: 'BC-4',
      };
      allStudents.push(studentDavid);

      await addStudentsToGroup(group, ['David Lee']);
      assert.equal(group.students.includes('David Lee'), true);
      assert.equal(group.student_ids.includes(null), false);
      assert.equal(group.students.length, group.student_ids.length);

      // 2. Remove student
      await removeStudentFromGroup(group, studentDavid._id);
      assert.equal(group.students.includes('David Lee'), false);
      assert.equal(group.student_ids.includes(null), false);
      assert.equal(group.students.length, group.student_ids.length);

      // 3. Move student
      await moveStudent(group, targetGroup, studentAlice._id);
      assert.equal(group.students.includes('Alice Smith'), false);
      assert.equal(targetGroup.students.includes('Alice Smith'), true);
      assert.equal(group.student_ids.includes(null), false);
      assert.equal(targetGroup.student_ids.includes(null), false);
    } finally {
      Student.find = origFind;
      Student.findById = origFindById;
      Student.findOne = origFindOne;
      mongoose.startSession = origStartSession;
    }
  });

  await t.test('18. groupRepairRoster rejects with 422 needsManualFix when a name is >100 characters, saving nothing', async () => {
    let saved = false;
    const longName = 'A'.repeat(120);
    const group = {
      _id: makeObjectId(),
      group_name: 'Long Name Group',
      students: [longName, 'Valid Student'],
      student_ids: [],
      save: async function () { saved = true; return this; },
    };

    const origGroupFindById = Group.findById;
    Group.findById = async () => group;

    let statusCalled = null;
    let jsonCalled = null;
    const req = {
      params: { id: String(group._id) },
      user: { _id: makeObjectId(), username: 'admin' },
      session: { user: { _id: makeObjectId(), username: 'admin' } },
    };
    const res = {
      status: function (code) {
        statusCalled = code;
        return this;
      },
      json: function (payload) {
        jsonCalled = payload;
        return this;
      },
    };

    try {
      const { groupRepairRoster } = require('../controllers/adminGroupController');
      await groupRepairRoster(req, res);

      assert.equal(saved, false);
      assert.equal(statusCalled, 422);
      assert.equal(jsonCalled.ok, false);
      assert.equal(jsonCalled.needsManualFix, true);
      assert.equal(jsonCalled.skipped.length, 1);
      assert.equal(jsonCalled.skipped[0].name, longName);
    } finally {
      Group.findById = origGroupFindById;
    }
  });

  await t.test('19. groupRepairRoster merges exact duplicates by normalized name and lists them in success response', async () => {
    const AuditLog = require('../models/AuditLog');
    const origAuditCreate = AuditLog.create;
    AuditLog.create = async () => {};

    let saved = false;
    const studentAlice = {
      _id: makeObjectId(),
      raw_name: 'Alice Smith',
      full_name: 'Alice Smith',
      normalized_name: normalizeName('Alice Smith'),
      status: 'active',
      student_code: 'SC-1',
      barcode: 'BC-1',
    };

    const group = {
      _id: makeObjectId(),
      group_name: 'Duplicate Group',
      students: ['Alice Smith', 'Alice Smith 11 SPB'], // Same normalized name: alice smith
      student_ids: [studentAlice._id],
      save: async function () { saved = true; return this; },
    };

    const origGroupFindById = Group.findById;
    const origGroupFind = Group.find;
    const origStudentFind = Student.find;
    const origStudentFindOne = Student.findOne;

    Group.findById = async () => group;
    Group.find = () => ({
      select: () => ({
        sort: () => ({
          lean: async () => [],
        }),
        lean: async () => [],
      }),
    });
    Student.find = () => ({
      lean: async () => [studentAlice],
    });
    Student.findOne = async () => studentAlice;

    let statusCalled = null;
    let jsonCalled = null;
    const req = {
      params: { id: String(group._id) },
      user: { _id: makeObjectId(), username: 'admin' },
      session: { user: { _id: makeObjectId(), username: 'admin' } },
    };
    const res = {
      status: function (code) {
        statusCalled = code;
        return this;
      },
      json: function (payload) {
        jsonCalled = payload;
        return this;
      },
    };

    try {
      const { groupRepairRoster } = require('../controllers/adminGroupController');
      await groupRepairRoster(req, res);

      assert.equal(saved, true);
      assert.equal(jsonCalled.ok, true);
      assert.equal(jsonCalled.mergedDuplicates.length, 1);
      assert.match(jsonCalled.message, /merged duplicate/);
      assert.deepEqual(group.students, ['Alice Smith']);
    } finally {
      Group.findById = origGroupFindById;
      Group.find = origGroupFind;
      Student.find = origStudentFind;
      Student.findOne = origStudentFindOne;
      AuditLog.create = origAuditCreate;
    }
  });

  await t.test('20. getGroupEditData computes isOnlyGroup by names across other groups', async () => {
    const studentAlice = {
      _id: makeObjectId(),
      raw_name: 'Alice Smith',
      full_name: 'Alice Smith',
      normalized_name: normalizeName('Alice Smith'),
      status: 'active',
      student_code: 'SC-1',
      barcode: 'BC-1',
    };
    const studentBob = {
      _id: makeObjectId(),
      raw_name: 'Bob Jones',
      full_name: 'Bob Jones',
      normalized_name: normalizeName('Bob Jones'),
      status: 'active',
      student_code: 'SC-2',
      barcode: 'BC-2',
    };

    const currentGroup = {
      _id: makeObjectId(),
      group_name: 'Class A',
      students: ['Alice Smith', 'Bob Jones'],
      student_ids: [studentAlice._id, studentBob._id],
    };

    const otherGroup = {
      _id: makeObjectId(),
      group_name: 'Class B',
      students: ['Alice Smith 11 SPB'], // Also contains Alice by normalized name
      type: 'GROUP',
      level: 'PA',
    };

    const origStudentFind = Student.find;
    const origGroupFind = Group.find;

    Student.find = () => ({
      lean: async () => [studentAlice, studentBob],
    });
    Group.find = () => ({
      select: () => ({
        sort: () => ({
          lean: async () => [otherGroup],
        }),
      }),
    });

    try {
      const data = await getGroupEditData(currentGroup);
      const aliceEntry = data.roster.find(r => r.name === 'Alice Smith');
      const bobEntry = data.roster.find(r => r.name === 'Bob Jones');

      // Alice is in Class B by name, so isOnlyGroup is false
      assert.equal(aliceEntry.isOnlyGroup, false);
      // Bob is in no other group, so isOnlyGroup is true
      assert.equal(bobEntry.isOnlyGroup, true);
    } finally {
      Student.find = origStudentFind;
      Group.find = origGroupFind;
    }
  });

  await t.test('22. renameStudentInGroup: successfully updates group roster, Student document, other groups, and reports', async () => {
    const studentId = makeObjectId();
    const otherGroupId = makeObjectId();
    let studentDoc = {
      _id: studentId,
      raw_name: 'Alice Smith',
      full_name: 'Alice Smith',
      normalized_name: 'alice smith',
      grade_school: '',
      student_code: 'STD-2026-0001',
      barcode: 'AC12345678',
      save: async function () { return this; },
    };

    let groupSaved = false;
    const group = {
      _id: makeObjectId(),
      group_name: 'Class A',
      students: ['Alice Smith', 'Bob Jones'],
      student_ids: [studentId, makeObjectId()],
      save: async function () { groupSaved = true; return this; },
    };

    let otherGroupSaved = false;
    const otherGroup = {
      _id: otherGroupId,
      group_name: 'Class B',
      students: ['Alice Smith'],
      student_ids: [studentId],
      save: async function () { otherGroupSaved = true; return this; },
    };

    const origFindById = Student.findById;
    const origFindOne = Student.findOne;
    const origStudentFind = Student.find;
    const origGroupFind = Group.find;

    Student.findById = async (id) => (String(id) === String(studentId) ? studentDoc : null);
    Student.findOne = async () => null; // No duplicate in DB
    Student.find = (query) => ({
      lean: async () => [
        { _id: studentId, normalized_name: 'alice smith', full_name: 'Alice Smith' },
        { _id: group.student_ids[1], normalized_name: 'bob jones', full_name: 'Bob Jones' },
      ],
    });
    Group.find = async () => [otherGroup];

    try {
      const res = await renameStudentInGroup(group, studentId, 'Alice Smith-Williams 10 A');
      assert.equal(res.ok, true);
      assert.equal(res.name, 'Alice Smith-Williams 10 A');
      assert.equal(res.oldName, 'Alice Smith');
      assert.equal(groupSaved, true);
      assert.deepEqual(group.students, ['Alice Smith-Williams 10 A', 'Bob Jones']);
      assert.equal(studentDoc.raw_name, 'Alice Smith-Williams 10 A');
      assert.equal(studentDoc.full_name, 'Alice Smith-Williams');
      assert.equal(studentDoc.normalized_name, 'alice smith-williams');
      assert.equal(studentDoc.grade_school, '10 A');
      assert.equal(otherGroupSaved, true);
      assert.deepEqual(otherGroup.students, ['Alice Smith-Williams 10 A']);
    } finally {
      Student.findById = origFindById;
      Student.findOne = origFindOne;
      Student.find = origStudentFind;
      Group.find = origGroupFind;
    }
  });

  await t.test('23. renameStudentInGroup: throws conflict when new name collides with another student in DB', async () => {
    const studentId = makeObjectId();
    const otherStudentId = makeObjectId();
    const studentDoc = {
      _id: studentId,
      raw_name: 'Alice Smith',
      full_name: 'Alice Smith',
      normalized_name: 'alice smith',
      save: async function () { return this; },
    };

    const group = {
      _id: makeObjectId(),
      group_name: 'Class A',
      students: ['Alice Smith'],
      student_ids: [studentId],
      save: async function () { return this; },
    };

    const origFindById = Student.findById;
    const origFindOne = Student.findOne;
    const origStudentFind = Student.find;

    Student.findById = async () => studentDoc;
    Student.find = () => ({
      lean: async () => [{ _id: studentId, normalized_name: 'alice smith', full_name: 'Alice Smith' }],
    });
    Student.findOne = async () => ({
      _id: otherStudentId,
      full_name: 'Bob Jones',
      student_code: 'STD-2026-0002',
    });

    try {
      await assert.rejects(
        async () => renameStudentInGroup(group, studentId, 'Bob Jones'),
        /already exists in the system/
      );
    } finally {
      Student.findById = origFindById;
      Student.findOne = origFindOne;
      Student.find = origStudentFind;
    }
  });

  await t.test('24. groupRenameStudent controller: validates input and returns 400 on empty name', async () => {
    const groupId = makeObjectId();
    const studentId = makeObjectId();

    const req = {
      params: { id: String(groupId), studentId: String(studentId) },
      body: { newName: '   ' },
    };
    let responseStatus = null;
    let responseJson = null;
    const res = {
      status: (code) => { responseStatus = code; return res; },
      json: (data) => { responseJson = data; return res; },
    };

    await groupRenameStudent(req, res);
    assert.equal(responseStatus, 400);
    assert.equal(responseJson.ok, false);
    assert.match(responseJson.message, /Student name is required/);
  });
});
