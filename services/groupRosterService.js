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
const { normalizeName, extractFullName, extractGradeSchool } = require('../models/Student');
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
    student_ids: safePairs.filter(p => p && p.id).map(p => p.id),
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

/**
 * Pure helper: rename a student in currentPairs.
 * Validates newName, checks for duplicates within currentPairs,
 * updates name and norm while preserving id.
 *
 * @param {Array<{ name: string, norm: string, id: string|ObjectId|null }>} currentPairs
 * @param {Object} options
 * @param {string|ObjectId} [options.studentId]
 * @param {string} [options.normKey]
 * @param {string} options.newName
 * @returns {{ pairs: Array, renamed: Object, oldName: string, students: string[], student_ids: Array }}
 */
function applyRosterRename(currentPairs, { studentId, normKey, newName }) {
  if (!newName || typeof newName !== 'string' || !newName.trim()) {
    throw new Error('Student name is required.');
  }
  const trimmed = newName.trim();
  if (trimmed.length > 100) {
    throw new Error('Student name max 100 characters.');
  }
  const newNorm = normalizeName(trimmed);
  if (!newNorm) {
    throw new Error('Invalid student name.');
  }

  const safePairs = [...(currentPairs || [])];
  const targetIdStr = studentId ? String(studentId) : null;

  const idx = safePairs.findIndex(p => {
    if (targetIdStr && p.id && String(p.id) === targetIdStr) return true;
    if (normKey && p.norm === normKey) return true;
    return false;
  });

  if (idx === -1) {
    throw new Error('Student not found in this group.');
  }

  // Check if newNorm collides with another student in this group
  const duplicate = safePairs.find((p, i) => i !== idx && p.norm === newNorm);
  if (duplicate) {
    throw new Error(`A student with this name already exists in this group ("${duplicate.name}").`);
  }

  const target = safePairs[idx];
  const oldName = target.name;
  const updatedPair = {
    ...target,
    name: trimmed,
    norm: newNorm,
  };

  const newPairs = safePairs.map((p, i) => (i === idx ? updatedPair : p));
  const roster = pairsToRoster(newPairs);

  return {
    pairs: newPairs,
    renamed: updatedPair,
    oldName,
    students: roster.students,
    student_ids: roster.student_ids,
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
 * Refuses to run if group has unlinked names.
 *
 * @param {Object} group - Loaded Mongoose Group doc
 * @param {string[]} rawNames - List of raw student names
 * @returns {Promise<{ added: Array, skipped: Array, group: Object }>}
 */
async function addStudentsToGroup(group, rawNames) {
  const names = Array.isArray(rawNames) ? rawNames : [rawNames];
  const currentPairs = await resolveGroupPairs(group);

  const unlinked = currentPairs.find(p => !p.id);
  if (unlinked) {
    const err = new Error("Repair this group's roster first.");
    err.needsRepair = true;
    err.groupId = group._id ? String(group._id) : '';
    err.groupName = group.group_name || '';
    throw err;
  }

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
 * Refuses to run if group has unlinked names.
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
  const currentPairs = await resolveGroupPairs(group);

  const unlinked = currentPairs.find(p => !p.id);
  if (unlinked) {
    const err = new Error("Repair this group's roster first.");
    err.needsRepair = true;
    err.groupId = group._id ? String(group._id) : '';
    err.groupName = group.group_name || '';
    throw err;
  }

  const sDoc = await Student.findById(studentId);
  const targetNorm = sDoc ? sDoc.normalized_name : null;

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
 * Refuses to run if either group has unlinked names.
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
  const fromUnlinked = fromPairs.find(p => !p.id);
  if (fromUnlinked) {
    const err = new Error("Repair this group's roster first.");
    err.needsRepair = true;
    err.groupId = fromGroup._id ? String(fromGroup._id) : '';
    err.groupName = fromGroup.group_name || '';
    throw err;
  }

  const toPairs   = await resolveGroupPairs(toGroup);
  const toUnlinked = toPairs.find(p => !p.id);
  if (toUnlinked) {
    const err = new Error(`Repair target group "${toGroup.group_name}"'s roster first.`);
    err.needsRepair = true;
    err.groupId = toGroup._id ? String(toGroup._id) : '';
    err.groupName = toGroup.group_name || '';
    throw err;
  }

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
 * Rename a student in a group.
 * Resolves current group names to pairs, identifies the target by studentId,
 * checks for unlinked names (needs repair) and global normalized_name collisions,
 * calls pure helper applyRosterRename, and updates group, Student doc, other groups, and past reports.
 *
 * @param {Object} group - Loaded Mongoose Group doc
 * @param {string|ObjectId} studentId - Student ObjectId
 * @param {string} newName - New raw name string
 * @returns {Promise<{ ok: true, name: string, oldName: string, studentId: string, student: Object }>}
 */
async function renameStudentInGroup(group, studentId, newName) {
  const currentPairs = await resolveGroupPairs(group);

  const unlinked = currentPairs.find(p => !p.id);
  if (unlinked) {
    const err = new Error("Repair this group's roster first.");
    err.needsRepair = true;
    err.groupId = group._id ? String(group._id) : '';
    err.groupName = group.group_name || '';
    throw err;
  }

  const sDoc = await Student.findById(studentId);
  if (!sDoc) {
    throw new Error('Student not found.');
  }

  const trimmed = (newName || '').trim();
  if (!trimmed) {
    throw new Error('Student name is required.');
  }
  if (trimmed.length > 100) {
    throw new Error('Student name max 100 characters.');
  }
  const newNorm = normalizeName(trimmed);
  if (!newNorm) {
    throw new Error('Invalid student name.');
  }

  // Check if another Student document in the database has this normalized name
  const existingOther = await Student.findOne({
    normalized_name: newNorm,
    _id: { $ne: sDoc._id },
  });
  if (existingOther) {
    const err = new Error(
      `A student named "${existingOther.full_name || existingOther.raw_name}" (${existingOther.student_code || 'existing'}) already exists in the system.`
    );
    err.conflict = true;
    throw err;
  }

  // Pure helper handles group-level duplicate and array mutation
  const renameResult = applyRosterRename(currentPairs, {
    studentId: String(studentId),
    normKey: sDoc.normalized_name,
    newName: trimmed,
  });

  const oldRawName = sDoc.raw_name;
  const oldFullName = sDoc.full_name;

  // Persist group roster
  group.students = renameResult.students;
  group.student_ids = renameResult.student_ids;
  await group.save();

  // Update Student document
  sDoc.raw_name = trimmed;
  sDoc.full_name = extractFullName(trimmed);
  sDoc.normalized_name = newNorm;
  sDoc.grade_school = extractGradeSchool(trimmed);
  await sDoc.save();

  // Keep other groups containing this student in sync
  try {
    const otherGroups = await Group.find({
      _id: { $ne: group._id },
      $or: [
        { student_ids: sDoc._id },
        { students: { $in: [oldRawName, oldFullName].filter(Boolean) } },
      ],
    });

    for (const og of otherGroups) {
      let changed = false;
      if (Array.isArray(og.student_ids) && Array.isArray(og.students)) {
        for (let i = 0; i < og.student_ids.length; i++) {
          if (String(og.student_ids[i]) === String(sDoc._id)) {
            if (og.students[i] !== trimmed) {
              og.students[i] = trimmed;
              changed = true;
            }
          }
        }
      }
      if (Array.isArray(og.students)) {
        for (let i = 0; i < og.students.length; i++) {
          if (og.students[i] === oldRawName || (oldFullName && og.students[i] === oldFullName)) {
            if (og.students[i] !== trimmed) {
              og.students[i] = trimmed;
              changed = true;
            }
          }
        }
      }
      if (changed) {
        await og.save();
      }
    }
  } catch (syncErr) {
    console.error('Error syncing renamed student across other groups:', syncErr);
  }

  // Update past reports so student AC achievements and logs remain consistent
  try {
    const Report = require('../models/Report');
    if (oldRawName && oldRawName !== trimmed) {
      await Report.updateMany(
        { ac_students: oldRawName },
        { $set: { 'ac_students.$[elem]': trimmed } },
        { arrayFilters: [{ elem: oldRawName }] }
      );
      await Report.updateMany(
        { ac_reduced_students: oldRawName },
        { $set: { 'ac_reduced_students.$[elem]': trimmed } },
        { arrayFilters: [{ elem: oldRawName }] }
      );
      await Report.updateMany(
        { absent_students: oldRawName },
        { $set: { 'absent_students.$[elem]': trimmed } },
        { arrayFilters: [{ elem: oldRawName }] }
      );
    }
    const newFullName = sDoc.full_name;
    if (oldFullName && oldFullName !== newFullName && oldFullName !== oldRawName) {
      await Report.updateMany(
        { ac_students: oldFullName },
        { $set: { 'ac_students.$[elem]': newFullName } },
        { arrayFilters: [{ elem: oldFullName }] }
      );
      await Report.updateMany(
        { ac_reduced_students: oldFullName },
        { $set: { 'ac_reduced_students.$[elem]': newFullName } },
        { arrayFilters: [{ elem: oldFullName }] }
      );
      await Report.updateMany(
        { absent_students: oldFullName },
        { $set: { 'absent_students.$[elem]': newFullName } },
        { arrayFilters: [{ elem: oldFullName }] }
      );
    }
  } catch (reportErr) {
    console.error('Error updating student name in reports:', reportErr);
  }

  return {
    ok: true,
    name: trimmed,
    oldName: renameResult.oldName || oldRawName,
    studentId: String(sDoc._id),
    student: sDoc,
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
  const mergedDuplicates = [];

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
      mergedDuplicates.push({ name: trimmed, reason: 'Duplicate student name in list.' });
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
  group.student_ids = resolved.filter(r => r && r.id).map(r => r.id);

  await group.save();
  return { group, skipped, mergedDuplicates };
}

module.exports = {
  // Pure DB-free helpers
  pairsToRoster,
  applyRosterAdd,
  applyRosterRemove,
  applyRosterMove,
  applyRosterRename,

  // Name-first resolution helper
  resolveGroupPairs,

  // DB wrappers
  addStudentsToGroup,
  removeStudentFromGroup,
  moveStudent,
  renameStudentInGroup,
  syncRosterFromNames,
};
