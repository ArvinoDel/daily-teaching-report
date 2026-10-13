/**
 * services/groupRosterService.js
 *
 * Roster operations service for manual group management:
 *  - Pure, DB-free helper functions for adding, removing, moving, and building rosters.
 *  - Thin DB wrappers for addStudentsToGroup, removeStudentFromGroup, moveStudent, and syncRosterFromNames.
 *  - Names are the single source of truth for membership; identity is Student.normalized_name.
 *  - Zero index pairing: always resolves names to pairs, runs pure helpers, and writes back aligned arrays.
 *  - Precomputed atomicity for moves (transaction with safe sequential fallback without mutation re-application).
 */

const mongoose = require('mongoose');
const Student = require('../models/Student');
const Group = require('../models/Group');
const { normalizeName } = require('../models/Student');
const studentService = require('./studentService');

/* ═══════════════════════════════════════════════════════════════
   1. PURE DB-FREE HELPERS
   Pairs shape: [{ name: string, norm: string, id: string|ObjectId|null }]
════════════════════════════════════════════════════════════════ */

/**
 * Build students[] and student_ids[] arrays from pairs.
 * Always guarantees 1-to-1 parallel alignment and equal length.
 * Null-safe for pairs where id is null/undefined.
 */
function pairsToRoster(pairs) {
  const safePairs = Array.isArray(pairs) ? pairs : [];
  return {
    students: safePairs.map(p => p.name),
    student_ids: safePairs.map(p => (p.id ? p.id : null)),
  };
}

/**
 * Pure helper: add new pairs to current pairs.
 * Dedupes against current and within incoming by normalized name (norm).
 * Respects maxStudents limit.
 */
function applyRosterAdd(currentPairs, incomingPairs, { maxStudents = 200 } = {}) {
  const pairs = [...(currentPairs || [])];
  const seenNorms = new Set(pairs.map(p => p.norm).filter(Boolean));
  const added = [];
  const skipped = [];

  for (const item of (incomingPairs || [])) {
    if (!item || !item.name) continue;
    const norm = item.norm || normalizeName(item.name);
    if (!norm) continue;

    if (seenNorms.has(norm)) {
      skipped.push({ name: item.name, reason: 'Already in this group' });
      continue;
    }

    if (pairs.length >= maxStudents) {
      skipped.push({ name: item.name, reason: `Max ${maxStudents} students per group.` });
      continue;
    }

    seenNorms.add(norm);
    const pair = { ...item, norm };
    pairs.push(pair);
    added.push(pair);
  }

  const roster = pairsToRoster(pairs);
  return {
    pairs,
    added,
    skipped,
    students: roster.students,
    student_ids: roster.student_ids,
  };
}

/**
 * Pure helper: remove pair by studentId or normKey.
 */
function applyRosterRemove(currentPairs, { studentId, normKey }) {
  const safePairs = [...(currentPairs || [])];
  const targetIdStr = studentId ? String(studentId) : null;

  const idx = safePairs.findIndex(p => {
    if (targetIdStr && p.id && String(p.id) === targetIdStr) return true;
    if (normKey && p.norm === normKey) return true;
    return false;
  });

  if (idx === -1) {
    const roster = pairsToRoster(safePairs);
    return {
      pairs: safePairs,
      removed: null,
      students: roster.students,
      student_ids: roster.student_ids,
    };
  }

  const removed = safePairs[idx];
  const pairs = safePairs.filter((_, i) => i !== idx);
  const roster = pairsToRoster(pairs);

  return {
    pairs,
    removed,
    students: roster.students,
    student_ids: roster.student_ids,
  };
}

/**
 * Pure helper: move a pair from fromPairs to toPairs.
 */
function applyRosterMove(fromPairs, toPairs, { studentId, normKey, maxStudents = 200 }) {
  const safeFrom = [...(fromPairs || [])];
  const safeTo = [...(toPairs || [])];
  const targetIdStr = studentId ? String(studentId) : null;

  const fromIdx = safeFrom.findIndex(p => {
    if (targetIdStr && p.id && String(p.id) === targetIdStr) return true;
    if (normKey && p.norm === normKey) return true;
    return false;
  });

  if (fromIdx === -1) {
    throw new Error('Student not found in source group.');
  }

  const item = safeFrom[fromIdx];
  const toSeenNorms = new Set(safeTo.map(p => p.norm).filter(Boolean));
  if (toSeenNorms.has(item.norm) || (targetIdStr && safeTo.some(p => p.id && String(p.id) === targetIdStr))) {
    throw new Error('Student is already in target group.');
  }

  if (safeTo.length >= maxStudents) {
    throw new Error(`Target group has reached maximum ${maxStudents} students.`);
  }

  const newFromPairs = safeFrom.filter((_, i) => i !== fromIdx);
  const newToPairs = [...safeTo, item];

  return {
    fromPairs: newFromPairs,
    toPairs: newToPairs,
    moved: item,
    fromRoster: pairsToRoster(newFromPairs),
    toRoster: pairsToRoster(newToPairs),
  };
}

/* ═══════════════════════════════════════════════════════════════
   2. ROSTER RESOLUTION HELPER (Name-First, DB-Backed)
════════════════════════════════════════════════════════════════ */

/**
 * Resolves a group's students into pairs [{ name, norm, id }]
 * by resolving each name through Student.normalized_name.
 * Names in group.students are the single source of truth.
 * IDs are found ONLY through matching names.
 * Names with no matching Student keep a null-safe pair (id: null) and are never dropped.
 *
 * @param {Object} group - Mongoose Group doc or plain object { students, ... }
 * @returns {Promise<Array<{ name: string, norm: string, id: ObjectId|null }>>}
 */
async function resolveGroupPairs(group) {
  const rawList = Array.isArray(group.students) ? group.students : [];
  const norms = rawList.map(s => normalizeName(s)).filter(Boolean);

  let studentDocs = [];
  if (norms.length > 0) {
    studentDocs = await Student.find({ normalized_name: { $in: norms } }).lean();
  }

  const studentByNorm = new Map(studentDocs.map(s => [s.normalized_name, s]));

  const pairs = [];
  for (const raw of rawList) {
    const trimmed = (raw || '').trim();
    if (!trimmed) continue;
    const norm = normalizeName(trimmed);
    const sDoc = norm ? studentByNorm.get(norm) : null;
    pairs.push({
      name: trimmed,
      norm,
      id: sDoc ? sDoc._id : null,
    });
  }

  return pairs;
}

/* ═══════════════════════════════════════════════════════════════
   3. THIN DB WRAPPERS
════════════════════════════════════════════════════════════════ */

/**
 * Add an array of raw student names to a group document.
 * Resolves current group names to pairs, calls pure helper applyRosterAdd,
 * and writes back both arrays using pairsToRoster.
 *
 * @param {Object} group - Loaded Mongoose Group doc
 * @param {string[]} rawNames - List of raw student names
 * @returns {Promise<{ added: Array, skipped: Array, group: Object }>}
 */
async function addStudentsToGroup(group, rawNames) {
  const names = Array.isArray(rawNames) ? rawNames : [rawNames];
  const currentPairs = await resolveGroupPairs(group);

  const incomingPairs = [];
  const added = [];
  const skipped = [];

  for (const raw of names) {
    const trimmed = (raw || '').trim();
    if (!trimmed) continue;

    if (trimmed.length > 100) {
      skipped.push({ name: trimmed, reason: 'Student name max 100 characters.' });
      continue;
    }

    const norm = normalizeName(trimmed);
    if (!norm) continue;

    // Check if already in DB by normalized name
    let studentDoc = await Student.findOne({ normalized_name: norm });
    let created = false;
    let reactivated = false;

    if (studentDoc) {
      if (studentDoc.status === 'inactive') {
        studentDoc.status = 'active';
        await studentDoc.save();
        reactivated = true;
      }
    } else {
      const matchResult = await studentService.matchOrCreateStudent(trimmed);
      studentDoc = matchResult.student;
      created = matchResult.created;
    }

    // Preserve existing raw_name/full_name spelling
    const storedName = studentDoc.raw_name || studentDoc.full_name || trimmed;

    incomingPairs.push({
      name: storedName,
      norm,
      id: studentDoc._id,
      _meta: {
        studentId: String(studentDoc._id),
        student_code: studentDoc.student_code,
        barcode: studentDoc.barcode,
        created,
        reactivated,
      },
    });
  }

  // Pure add
  const addResult = applyRosterAdd(currentPairs, incomingPairs, { maxStudents: 200 });

  for (const s of addResult.skipped) {
    skipped.push(s);
  }

  for (const a of addResult.added) {
    added.push({
      studentId: a._meta ? a._meta.studentId : String(a.id),
      name: a.name,
      student_code: a._meta ? a._meta.student_code : '',
      barcode: a._meta ? a._meta.barcode : '',
      created: a._meta ? a._meta.created : false,
      reactivated: a._meta ? a._meta.reactivated : false,
    });
  }

  group.students = addResult.students;
  group.student_ids = addResult.student_ids;
  await group.save();

  return { added, skipped, group };
}

/**
 * Remove a student from a group.
 * Resolves current group names to pairs, identifies the target by studentId
 * resolved to normalized_name, calls pure helper applyRosterRemove,
 * and writes back both arrays using pairsToRoster.
 *
 * Checks "no other group" by checking group.students names (resolved via normalized_name)
 * across all groups, not only student_ids, so ghost ids cannot block or trigger it.
 *
 * @param {Object} group - Loaded Mongoose Group doc
 * @param {string|ObjectId} studentId - Student ObjectId
 * @param {Object} options - { markInactive: boolean }
 * @returns {Promise<{ ok: true, removedName: string, studentId: string, markedInactive: boolean }>}
 */
async function removeStudentFromGroup(group, studentId, { markInactive = false } = {}) {
  const sDoc = await Student.findById(studentId);
  const targetNorm = sDoc ? sDoc.normalized_name : null;

  const currentPairs = await resolveGroupPairs(group);
  const result = applyRosterRemove(currentPairs, {
    studentId: String(studentId),
    normKey: targetNorm,
  });

  if (!result.removed) {
    throw new Error('Student not found in this group.');
  }

  const roster = pairsToRoster(result.pairs);
  group.students = roster.students;
  group.student_ids = roster.student_ids;
  await group.save();

  // A4: markInactive check across group.students names across all groups
  let markedInactive = false;
  if (markInactive && targetNorm) {
    const otherGroups = await Group.find({ _id: { $ne: group._id } }).select('students').lean();
    let foundInOtherGroup = false;

    for (const og of otherGroups) {
      for (const stName of (og.students || [])) {
        if (normalizeName(stName) === targetNorm) {
          foundInOtherGroup = true;
          break;
        }
      }
      if (foundInOtherGroup) break;
    }

    if (!foundInOtherGroup) {
      await Student.updateOne({ _id: studentId }, { $set: { status: 'inactive' } });
      markedInactive = true;
    }
  }

  return {
    ok: true,
    removedName: result.removed.name,
    studentId: String(studentId),
    markedInactive,
  };
}

/**
 * Move a student from fromGroup to toGroup.
 * Resolves both groups to pairs, precomputes new rosters for BOTH groups purely,
 * then persists: attempts transaction, falls back to sequential without re-applying mutations.
 *
 * @param {Object} fromGroup - Loaded Mongoose Group doc
 * @param {Object} toGroup - Loaded Mongoose Group doc
 * @param {string|ObjectId} studentId - Student ObjectId
 * @returns {Promise<{ ok: true, student: Object, name: string, studentId: string, atomic: string }>}
 */
async function moveStudent(fromGroup, toGroup, studentId) {
  if (String(fromGroup._id) === String(toGroup._id)) {
    throw new Error('Target group must be different from source group.');
  }

  const sDoc = await Student.findById(studentId);
  if (!sDoc) {
    throw new Error('Student not found.');
  }

  const fromPairs = await resolveGroupPairs(fromGroup);
  const toPairs   = await resolveGroupPairs(toGroup);

  // Precompute new rosters purely for BOTH groups
  const moveResult = applyRosterMove(fromPairs, toPairs, {
    studentId: String(studentId),
    normKey: sDoc.normalized_name,
    maxStudents: 200,
  });

  const fromRoster = moveResult.fromRoster;
  const toRoster   = moveResult.toRoster;

  let usedTransaction = false;

  try {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      toGroup.students = toRoster.students;
      toGroup.student_ids = toRoster.student_ids;
      fromGroup.students = fromRoster.students;
      fromGroup.student_ids = fromRoster.student_ids;

      await toGroup.save({ session });
      await fromGroup.save({ session });
      await session.commitTransaction();
      usedTransaction = true;
    } catch (txErr) {
      await session.abortTransaction();
      throw txErr;
    } finally {
      session.endSession();
    }
  } catch (txErr) {
    const isTxUnsupported = /Transaction numbers are only allowed/.test(txErr.message) ||
                            /transactions are not supported/.test(txErr.message) ||
                            txErr.codeName === 'OperationNotSupportedInTransaction' ||
                            txErr.code === 20;
    if (isTxUnsupported) {
      // Sequential fallback: assign the precomputed arrays directly without re-applying mutations
      toGroup.students = toRoster.students;
      toGroup.student_ids = toRoster.student_ids;
      await toGroup.save();

      fromGroup.students = fromRoster.students;
      fromGroup.student_ids = fromRoster.student_ids;
      await fromGroup.save();
      usedTransaction = false;
    } else {
      throw txErr;
    }
  }

  return {
    ok: true,
    student: sDoc,
    name: moveResult.moved.name,
    studentId: String(sDoc._id),
    atomic: usedTransaction ? 'transaction' : 'sequential-after-validation',
  };
}

/**
 * Sync entire roster from a list of names.
 * Used by groupCreate, groupUpdate, and the repair endpoint.
 * Returns { group, skipped: [{ name, reason }] }.
 *
 * @param {Object} group - Mongoose Group doc
 * @param {string[]} rawNames - List of names
 * @returns {Promise<{ group: Object, skipped: Array }>}
 */
async function syncRosterFromNames(group, rawNames) {
  const names = Array.isArray(rawNames) ? rawNames : [];
  const uniqueItems = [];
  const seenNorms = new Set();
  const skipped = [];

  for (const raw of names) {
    const trimmed = (raw || '').trim();
    if (!trimmed) continue;

    if (trimmed.length > 100) {
      skipped.push({ name: trimmed, reason: 'Student name max 100 characters.' });
      continue;
    }

    const norm = normalizeName(trimmed);
    if (!norm) continue;

    if (seenNorms.has(norm)) {
      skipped.push({ name: trimmed, reason: 'Duplicate student name in list.' });
      continue;
    }

    if (uniqueItems.length >= 200) {
      skipped.push({ name: trimmed, reason: 'Max 200 students per group.' });
      continue;
    }

    seenNorms.add(norm);
    uniqueItems.push({ raw: trimmed, norm });
  }

  const resolved = [];

  for (const item of uniqueItems) {
    let studentDoc = await Student.findOne({ normalized_name: item.norm });
    if (studentDoc) {
      if (studentDoc.status === 'inactive') {
        studentDoc.status = 'active';
        await studentDoc.save();
      }
    } else {
      const matchRes = await studentService.matchOrCreateStudent(item.raw);
      studentDoc = matchRes.student;
    }

    const storedName = studentDoc.raw_name || studentDoc.full_name || item.raw;
    resolved.push({
      name: storedName,
      id: studentDoc._id,
    });
  }

  group.students = resolved.map(r => r.name);
  group.student_ids = resolved.map(r => r.id);

  await group.save();
  return { group, skipped };
}

module.exports = {
  // Pure DB-free helpers
  pairsToRoster,
  applyRosterAdd,
  applyRosterRemove,
  applyRosterMove,

  // Name-first resolution helper
  resolveGroupPairs,

  // DB wrappers
  addStudentsToGroup,
  removeStudentFromGroup,
  moveStudent,
  syncRosterFromNames,
};
