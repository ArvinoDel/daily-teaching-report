const test = require('node:test');
const assert = require('node:assert/strict');
const {
  pairsToRoster,
  applyRosterAdd,
  applyRosterRemove,
  applyRosterMove,
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
});

test('Group Roster Service - DB Wrapper & Atomicity Tests', async (t) => {
  const mongoose = require('mongoose');
  const Student = require('../models/Student');
  const Group = require('../models/Group');
  const {
    removeStudentFromGroup,
    moveStudent,
  } = require('../services/groupRosterService');
  const {
    getGroupEditData,
    formatGroupCreatedAt,
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
});
