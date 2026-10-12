/**
 * tests/groupImportDiff.test.js
 *
 * Unit tests for computeRosterDiff using Node's built-in test runner.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { computeRosterDiff, resolveDbGroupStudents, countGhostIds } = require('../services/groupImportDiffService');
const { normalizeName } = require('../models/Student');

function makeObjectId() {
  return new mongoose.Types.ObjectId();
}

function makeStudent(fullName) {
  return {
    _id: makeObjectId(),
    full_name: fullName,
    normalized_name: normalizeName(fullName),
    barcode: 'BC-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    student_code: 'SC-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
  };
}

test('1. Student moved between two CSV groups', () => {
  const alice = makeStudent('Alice Smith');
  const bob   = makeStudent('Bob Jones');

  const groupAId = makeObjectId();
  const groupBId = makeObjectId();

  const existingGroups = [
    {
      _id: groupAId,
      group_name: 'Class A',
      type: 'GROUP',
      level: 'Beginner',
      students: ['Alice Smith'],
      student_ids: [alice._id],
    },
    {
      _id: groupBId,
      group_name: 'Class B',
      type: 'GROUP',
      level: 'Intermediate',
      students: ['Bob Jones'],
      student_ids: [bob._id],
    },
  ];

  const existingStudents = [alice, bob];

  // CSV has Class A (empty) and Class B (with Alice and Bob)
  const csvDocs = [
    {
      group_name: 'Class A',
      type: 'GROUP',
      level: 'Beginner',
      students: [],
    },
    {
      group_name: 'Class B',
      type: 'GROUP',
      level: 'Intermediate',
      students: ['Bob Jones', 'Alice Smith'],
    },
  ];

  const result = computeRosterDiff(csvDocs, existingGroups, existingStudents);

  // Total moved tally counts distinct student moves (MOVED_IN only, not double-counting MOVED_OUT)
  assert.equal(result.summaryChips.movedStudents, 1);

  // Class A removal should be MOVED_OUT
  const cardA = result.changedGroups.find(g => g.name === 'Class A');
  assert.ok(cardA, 'Class A should be in changedGroups');
  assert.equal(cardA.removals.length, 1);
  assert.equal(cardA.removals[0].status, 'MOVED_OUT');
  assert.equal(cardA.removals[0].toGroup, 'Class B');
  assert.equal(cardA.removals[0].defaultChecked, true);

  // Class B addition should be MOVED_IN
  const cardB = result.changedGroups.find(g => g.name === 'Class B');
  assert.ok(cardB, 'Class B should be in changedGroups');
  const aliceAdd = cardB.additions.find(a => a.rawName === 'Alice Smith');
  assert.ok(aliceAdd, 'Alice should be an addition in Class B');
  assert.equal(aliceAdd.status, 'MOVED_IN');
  assert.equal(aliceAdd.fromGroup, 'Class A');
});

test('2. Student moved from a group that is NOT in the CSV (must be EXISTING, not MOVED_IN)', () => {
  const charlie = makeStudent('Charlie Brown');
  const bob     = makeStudent('Bob Jones');

  const groupAId = makeObjectId();
  const groupBId = makeObjectId();

  // Group A has Charlie, but Group A is NOT in CSV
  const existingGroups = [
    {
      _id: groupAId,
      group_name: 'Old Class A',
      type: 'GROUP',
      level: 'Beginner',
      students: ['Charlie Brown'],
      student_ids: [charlie._id],
    },
    {
      _id: groupBId,
      group_name: 'Class B',
      type: 'GROUP',
      level: 'Intermediate',
      students: ['Bob Jones'],
      student_ids: [bob._id],
    },
  ];

  const existingStudents = [charlie, bob];

  // CSV ONLY contains Class B with Bob and Charlie; Old Class A is completely absent
  const csvDocs = [
    {
      group_name: 'Class B',
      type: 'GROUP',
      level: 'Intermediate',
      students: ['Bob Jones', 'Charlie Brown'],
    },
  ];

  const result = computeRosterDiff(csvDocs, existingGroups, existingStudents);

  // Charlie should NOT be counted as movedStudents
  assert.equal(result.summaryChips.movedStudents, 0);

  const cardB = result.changedGroups.find(g => g.name === 'Class B');
  assert.ok(cardB, 'Class B should be in changedGroups');
  const charlieAdd = cardB.additions.find(a => a.rawName === 'Charlie Brown');
  assert.ok(charlieAdd, 'Charlie should be added in Class B');
  assert.equal(charlieAdd.status, 'EXISTING');
  assert.equal(charlieAdd.note, 'Also in Old Class A (not in this CSV, stays there)');

  // No removal checkbox should exist for Old Class A because it is untouched
  const cardOldA = result.changedGroups.find(g => g.name === 'Old Class A');
  assert.equal(cardOldA, undefined, 'Old Class A should not be in changedGroups');
});

test('3. Student not in any CSV group (NOT_IN_CSV)', () => {
  const david = makeStudent('David Miller');

  const existingGroups = [
    {
      _id: makeObjectId(),
      group_name: 'Class A',
      type: 'GROUP',
      level: 'Beginner',
      students: ['David Miller'],
      student_ids: [david._id],
    },
  ];

  const existingStudents = [david];

  // CSV has Class A with no students, and David is in no other CSV group
  const csvDocs = [
    {
      group_name: 'Class A',
      type: 'GROUP',
      level: 'Beginner',
      students: [],
    },
  ];

  const result = computeRosterDiff(csvDocs, existingGroups, existingStudents);

  assert.equal(result.summaryChips.notInCsvStudents, 1);
  const cardA = result.changedGroups.find(g => g.name === 'Class A');
  assert.ok(cardA);
  assert.equal(cardA.removals.length, 1);
  assert.equal(cardA.removals[0].status, 'NOT_IN_CSV');
  assert.equal(cardA.removals[0].defaultChecked, false);
});

test('4. New student', () => {
  const existingGroups = [
    {
      _id: makeObjectId(),
      group_name: 'Class A',
      type: 'GROUP',
      level: 'Beginner',
      students: [],
      student_ids: [],
    },
  ];

  const existingStudents = []; // Eve does not exist anywhere

  const csvDocs = [
    {
      group_name: 'Class A',
      type: 'GROUP',
      level: 'Beginner',
      students: ['Eve Green'],
    },
  ];

  const result = computeRosterDiff(csvDocs, existingGroups, existingStudents);

  assert.equal(result.summaryChips.newStudents, 1);
  const cardA = result.changedGroups.find(g => g.name === 'Class A');
  assert.ok(cardA);
  assert.equal(cardA.additions.length, 1);
  assert.equal(cardA.additions[0].status, 'NEW');
  assert.equal(cardA.additions[0].label, 'New student');
});

test('5. Student listed in two CSV groups stays in both', () => {
  const fiona = makeStudent('Fiona Gallagher');

  const existingGroups = [
    {
      _id: makeObjectId(),
      group_name: 'Class A',
      type: 'GROUP',
      level: 'Beginner',
      students: ['Fiona Gallagher'],
      student_ids: [fiona._id],
    },
    {
      _id: makeObjectId(),
      group_name: 'Class B',
      type: 'GROUP',
      level: 'Intermediate',
      students: ['Fiona Gallagher'],
      student_ids: [fiona._id],
    },
  ];

  const existingStudents = [fiona];

  // CSV keeps Fiona in both Class A and Class B
  const csvDocs = [
    {
      group_name: 'Class A',
      type: 'GROUP',
      level: 'Beginner',
      students: ['Fiona Gallagher'],
    },
    {
      group_name: 'Class B',
      type: 'GROUP',
      level: 'Intermediate',
      students: ['Fiona Gallagher'],
    },
  ];

  const result = computeRosterDiff(csvDocs, existingGroups, existingStudents);

  // Neither should show changes
  assert.equal(result.changedGroups.length, 0);
  assert.equal(result.summaryChips.movedStudents, 0);
  assert.equal(result.summaryChips.notInCsvStudents, 0);
  assert.equal(result.summaryChips.newStudents, 0);
});

test('6. Rename candidate at >=50% overlap and not below', () => {
  const s1 = makeStudent('Student 1');
  const s2 = makeStudent('Student 2');
  const s3 = makeStudent('Student 3');
  const s4 = makeStudent('Student 4');
  const s5 = makeStudent('Student 5');
  const s6 = makeStudent('Student 6');
  const s7 = makeStudent('Student 7');

  const oldGroupId1 = makeObjectId();
  const oldGroupId2 = makeObjectId();

  const existingGroups = [
    {
      _id: oldGroupId1,
      group_name: 'Old Class High Overlap',
      type: 'GROUP',
      level: 'Beginner',
      students: ['Student 1', 'Student 2', 'Student 3', 'Student 4'],
      student_ids: [s1._id, s2._id, s3._id, s4._id],
    },
    {
      _id: oldGroupId2,
      group_name: 'Old Class Low Overlap',
      type: 'GROUP',
      level: 'Beginner',
      students: ['Student 1', 'Student 2', 'Student 3', 'Student 4'],
      student_ids: [s1._id, s2._id, s3._id, s4._id],
    },
  ];

  const existingStudents = [s1, s2, s3, s4, s5, s6, s7];

  // CSV has "New Class A" with 4 students, 2 match Old Class High Overlap (50%)
  // CSV has "New Class B" with 4 students, 1 matches Old Class Low Overlap (25%)
  const csvDocs = [
    {
      group_name: 'New Class A',
      type: 'GROUP',
      level: 'Beginner',
      students: ['Student 1', 'Student 2', 'Student 5', 'Student 6'],
    },
    {
      group_name: 'New Class B',
      type: 'GROUP',
      level: 'Beginner',
      students: ['Student 1', 'Student 5', 'Student 6', 'Student 7'],
    },
  ];

  const result = computeRosterDiff(csvDocs, existingGroups, existingStudents);

  const cardA = result.changedGroups.find(g => g.name === 'New Class A');
  assert.ok(cardA);
  assert.ok(cardA.renameCandidate, 'New Class A at 50% overlap should have renameCandidate');
  assert.equal(cardA.renameCandidate.oldName, 'Old Class High Overlap');
  assert.equal(cardA.renameCandidate.overlapPercent, 50);

  const cardB = result.changedGroups.find(g => g.name === 'New Class B');
  assert.ok(cardB);
  assert.equal(cardB.renameCandidate, null, 'New Class B at 25% overlap should NOT have renameCandidate');
});

test('7. DB group with misaligned students/student_ids resolves by name; ghost id is NOT a roster member', () => {
  const s1 = makeStudent('Student One');
  const s2 = makeStudent('Student Two');
  const s3Id = makeObjectId(); // Ghost ID — no matching name

  const studentById = new Map();
  const studentByNorm = new Map();
  studentById.set(String(s1._id), s1);
  studentById.set(String(s2._id), s2);
  studentByNorm.set(s1.normalized_name, s1);
  studentByNorm.set(s2.normalized_name, s2);

  // Group where names and ids are reversed and length is mismatched (s3Id is ghost)
  const misalignedGroup = {
    _id: makeObjectId(),
    group_name: 'Shuffled Group',
    type: 'GROUP',
    level: 'Beginner',
    students: ['Student One', 'Student Two'],
    student_ids: [s2._id, s1._id, s3Id], // Shuffled + extra ghost id
  };

  // resolveDbGroupStudents must only return 2 members (the two named students)
  const resolved = resolveDbGroupStudents(misalignedGroup, studentById, studentByNorm);
  assert.equal(resolved.length, 2, 'Ghost id must not become a roster member');
  assert.equal(resolved[0].rawName, 'Student One');
  assert.equal(String(resolved[0].studentId), String(s1._id));
  assert.equal(resolved[0].key, `id:${s1._id}`);

  assert.equal(resolved[1].rawName, 'Student Two');
  assert.equal(String(resolved[1].studentId), String(s2._id));

  // Ghost id counted correctly
  assert.equal(countGhostIds(misalignedGroup, studentByNorm), 1, 'Should count 1 ghost id (s3Id)');

  // Full diff flags inconsistentGroups and ghostIds
  const csvDocs = [
    {
      group_name: 'Shuffled Group',
      type: 'GROUP',
      level: 'Beginner',
      students: ['Student One', 'Student Two'],
    },
  ];

  const diffResult = computeRosterDiff(csvDocs, [misalignedGroup], [s1, s2]);
  assert.equal(diffResult.summaryChips.inconsistentGroups, 1, 'Should flag 1 inconsistent group');
  assert.equal(diffResult.summaryChips.ghostIds, 1, 'Should report 1 ghost id');
  assert.equal(diffResult.summaryChips.groupsWithGhostIds, 1, 'Should report 1 group with ghost ids');

  // No removals (ghost id must not produce a removal row)
  const card = diffResult.changedGroups.find(g => g.name === 'Shuffled Group');
  assert.equal(card, undefined, 'No roster changes when CSV matches the named students exactly');
});

test('8. Name containing a double quote passes through diff untouched', () => {
  const quotedName = 'Anna "Bobby" O\'Neil';
  const anna = makeStudent(quotedName);

  const existingGroups = [
    {
      _id: makeObjectId(),
      group_name: 'Special "Quotes" Class',
      type: 'GROUP',
      level: 'Advanced',
      students: [quotedName],
      student_ids: [anna._id],
    },
  ];

  const existingStudents = [anna];

  const csvDocs = [
    {
      group_name: 'Special "Quotes" Class',
      type: 'GROUP',
      level: 'Advanced',
      students: [quotedName],
    },
  ];

  const result = computeRosterDiff(csvDocs, existingGroups, existingStudents);

  // Check resolved student key and name
  const resolved = resolveDbGroupStudents(existingGroups[0], new Map([[String(anna._id), anna]]), new Map([[anna.normalized_name, anna]]));
  assert.equal(resolved[0].rawName, quotedName);
  assert.equal(resolved[0].key, `id:${anna._id}`);

  // When added as a new student with quotes
  const newQuotedDocs = [
    {
      group_name: 'Brand New Class',
      type: 'GROUP',
      level: 'Advanced',
      students: ['Another "Quoted" Name'],
    },
  ];

  const newDiffResult = computeRosterDiff(newQuotedDocs, existingGroups, existingStudents);
  const brandNewCard = newDiffResult.changedGroups.find(g => g.name === 'Brand New Class');
  assert.ok(brandNewCard);
  assert.equal(brandNewCard.additions[0].rawName, 'Another "Quoted" Name');
});

test('9. Ghost student_ids without matching names do not appear as roster members, removals, or "Student" rows', () => {
  const alice = makeStudent('Alice Smith');
  const bob = makeStudent('Bob Jones');
  const ghost1 = makeObjectId();
  const ghost2 = makeObjectId();

  const groupWithGhosts = {
    _id: makeObjectId(),
    group_name: 'Ghost Class',
    type: 'GROUP',
    level: 'Intermediate',
    students: ['Alice Smith', 'Bob Jones'],
    student_ids: [alice._id, bob._id, ghost1, ghost2],
  };

  const studentById = new Map([
    [String(alice._id), alice],
    [String(bob._id), bob],
  ]);
  const studentByNorm = new Map([
    [alice.normalized_name, alice],
    [bob.normalized_name, bob],
  ]);

  // resolveDbGroupStudents only returns Alice and Bob
  const resolved = resolveDbGroupStudents(groupWithGhosts, studentById, studentByNorm);
  assert.equal(resolved.length, 2, 'Must only resolve the 2 named students');
  assert.equal(resolved[0].rawName, 'Alice Smith');
  assert.equal(resolved[1].rawName, 'Bob Jones');

  // countGhostIds returns 2
  assert.equal(countGhostIds(groupWithGhosts, studentByNorm), 2, 'Should count 2 ghost IDs');

  // When CSV matches named students exactly:
  const csvDocs = [
    {
      group_name: 'Ghost Class',
      type: 'GROUP',
      level: 'Intermediate',
      students: ['Alice Smith', 'Bob Jones'],
    },
  ];

  const diffResult = computeRosterDiff(csvDocs, [groupWithGhosts], [alice, bob]);
  const card = diffResult.changedGroups.find(g => g.name === 'Ghost Class');
  assert.equal(card, undefined, 'No changes should be reported since CSV matches named members');

  assert.equal(diffResult.summaryChips.ghostIds, 2);
  assert.equal(diffResult.summaryChips.groupsWithGhostIds, 1);

  // allowedRemovalsByGroup has no removals for this group
  const removals = diffResult.allowedRemovalsByGroup.get('Ghost Class') || [];
  assert.equal(removals.length, 0, 'No removals should be allowed for ghost IDs');
});

test('10. student_ids containing a real DB student ID but missing from group.students does NOT make them a roster member', () => {
  const alice = makeStudent('Alice Smith');
  const bob = makeStudent('Bob Jones');
  const charlie = makeStudent('Charlie Brown'); // Real student doc, but NOT in group.students

  const group = {
    _id: makeObjectId(),
    group_name: 'Two Person Class',
    type: 'GROUP',
    level: 'Beginner',
    students: ['Alice Smith', 'Bob Jones'],
    student_ids: [alice._id, charlie._id], // Charlie is in student_ids, but not students[]
  };

  const studentById = new Map([
    [String(alice._id), alice],
    [String(bob._id), bob],
    [String(charlie._id), charlie],
  ]);
  const studentByNorm = new Map([
    [alice.normalized_name, alice],
    [bob.normalized_name, bob],
    [charlie.normalized_name, charlie],
  ]);

  // Names in group.students[] are the single source of truth
  const resolved = resolveDbGroupStudents(group, studentById, studentByNorm);
  assert.equal(resolved.length, 2, 'Must only resolve Alice and Bob');
  assert.deepEqual(resolved.map(r => r.rawName), ['Alice Smith', 'Bob Jones']);
  assert.ok(!resolved.some(r => r.rawName === 'Charlie Brown' || r.rawName === 'Student'), 'Charlie must not be a roster member');

  // countGhostIds returns 1 (charlie._id is not represented by any name in group.students)
  assert.equal(countGhostIds(group, studentByNorm), 1);

  // When CSV has Alice and Bob, no removals are generated for Charlie
  const csvDocs = [
    {
      group_name: 'Two Person Class',
      type: 'GROUP',
      level: 'Beginner',
      students: ['Alice Smith', 'Bob Jones'],
    },
  ];

  const diffResult = computeRosterDiff(csvDocs, [group], [alice, bob, charlie]);
  const card = diffResult.changedGroups.find(g => g.name === 'Two Person Class');
  assert.equal(card, undefined, 'No changes should be reported since CSV matches group.students');
});

