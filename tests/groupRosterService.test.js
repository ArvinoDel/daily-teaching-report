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
