/**
 * services/groupRosterService.js
 *
 * Roster operations service for manual group management:
 *  - Pure, DB-free helper functions for adding, removing, moving, and building rosters.
 *  - Thin DB wrappers for addStudentsToGroup, removeStudentFromGroup, moveStudent, and syncRosterFromNames.
 *  - Enforces normalized_name deduplication, max 200 students per group, name-first identity.
 *  - Concurrency & atomicity management (transaction with sequential fallback).
 */

const mongoose = require('mongoose');
const Student = require('../models/Student');
const Group = require('../models/Group');
const { normalizeName } = require('../models/Student');
const studentService = require('./studentService');

/* ═══════════════════════════════════════════════════════════════
   1. PURE DB-FREE HELPERS
   Pairs shape: [{ name: string, norm: string, id: string|ObjectId }]
════════════════════════════════════════════════════════════════ */

/**
 * Build students[] and student_ids[] arrays from pairs.
 * Always guarantees 1-to-1 parallel alignment and equal length.
 */
function pairsToRoster(pairs) {
  return {
    students: pairs.map(p => p.name),
    student_ids: pairs.map(p => p.id),
  };
}

/**
 * Pure helper: add new pairs to current pairs.
 * Dedupes against current and within incoming by normalized name (norm).
 * Respects maxStudents limit.
 */
function applyRosterAdd(currentPairs, incomingPairs, { maxStudents = 200 } = {}) {
  const pairs = [...currentPairs];
  const seenNorms = new Set(currentPairs.map(p => p.norm));
  const added = [];
  const skipped = [];

  for (const item of incomingPairs) {
    if (!item || !item.name) continue;
    const norm = item.norm;
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
    pairs.push(item);
    added.push(item);
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
  const targetIdStr = studentId ? String(studentId) : null;
  const idx = currentPairs.findIndex(p => {
    if (targetIdStr && p.id && String(p.id) === targetIdStr) return true;
    if (normKey && p.norm === normKey) return true;
    return false;
  });

  if (idx === -1) {
    const roster = pairsToRoster(currentPairs);
    return {
      pairs: [...currentPairs],
      removed: null,
      students: roster.students,
      student_ids: roster.student_ids,
    };
  }

  const removed = currentPairs[idx];
  const pairs = currentPairs.filter((_, i) => i !== idx);
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
  const targetIdStr = studentId ? String(studentId) : null;
  const fromIdx = fromPairs.findIndex(p => {
    if (targetIdStr && p.id && String(p.id) === targetIdStr) return true;
    if (normKey && p.norm === normKey) return true;
    return false;
  });

  if (fromIdx === -1) {
    throw new Error('Student not found in source group.');
  }

  const item = fromPairs[fromIdx];
  const toSeenNorms = new Set(toPairs.map(p => p.norm));
  if (toSeenNorms.has(item.norm) || (targetIdStr && toPairs.some(p => p.id && String(p.id) === targetIdStr))) {
    throw new Error('Student is already in target group.');
  }

  if (toPairs.length >= maxStudents) {
    throw new Error(`Target group has reached maximum ${maxStudents} students.`);
  }

  const newFromPairs = fromPairs.filter((_, i) => i !== fromIdx);
  const newToPairs = [...toPairs, item];

  return {
    fromPairs: newFromPairs,
    toPairs: newToPairs,
    moved: item,
    fromRoster: pairsToRoster(newFromPairs),
    toRoster: pairsToRoster(newToPairs),
  };
}

/* ═══════════════════════════════════════════════════════════════
   2. THIN DB WRAPPERS
════════════════════════════════════════════════════════════════ */

/**
 * Add an array of raw student names to a group document.
 * Creates Student record with QR/barcode if new; links existing if matched by normalized name.
 * Stored name preserves existing raw_name to avoid spelling divergence.
 * Reactivates student if inactive.
 *
 * @param {Object} group - Loaded Mongoose Group doc
 * @param {string[]} rawNames - List of raw student names
 * @returns {Promise<{ added: Array, skipped: Array, group: Object }>}
 */
async function addStudentsToGroup(group, rawNames) {
  const names = Array.isArray(rawNames) ? rawNames : [rawNames];
  const added = [];
  const skipped = [];

  // Track existing normalized names in group
  const existingNorms = new Set(
    (group.students || []).map(s => normalizeName(s)).filter(Boolean)
  );

  for (const raw of names) {
    const trimmed = (raw || '').trim();
    if (!trimmed) continue;

    if (trimmed.length > 100) {
      skipped.push({ name: trimmed, reason: 'Student name max 100 characters.' });
      continue;
    }

    const norm = normalizeName(trimmed);
    if (!norm) continue;

    if (existingNorms.has(norm)) {
      skipped.push({ name: trimmed, reason: 'Already in this group' });
      continue;
    }

    if (group.students.length >= 200) {
      skipped.push({ name: trimmed, reason: 'Group has reached maximum 200 students.' });
      continue;
    }

    // Look for existing Student doc by normalized name
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

    // Preserved spelling: Student's existing raw_name or full_name, fallback to typed input
    const storedName = studentDoc.raw_name || studentDoc.full_name || trimmed;

    group.students.push(storedName);
    group.student_ids.push(studentDoc._id);
    existingNorms.add(norm);

    added.push({
      studentId: String(studentDoc._id),
      name: storedName,
      student_code: studentDoc.student_code,
      barcode: studentDoc.barcode,
      created,
      reactivated,
    });
  }

  await group.save();

  return { added, skipped, group };
}

/**
 * Remove a student from a group.
 * If markInactive is true AND the student belongs to no other group, sets Student.status = 'inactive'.
 *
 * @param {Object} group - Loaded Mongoose Group doc
 * @param {string|ObjectId} studentId - Student ObjectId
 * @param {Object} options - { markInactive: boolean }
 * @returns {Promise<{ ok: true, removedName: string, studentId: string, markedInactive: boolean }>}
 */
async function removeStudentFromGroup(group, studentId, { markInactive = false } = {}) {
  const targetIdStr = String(studentId);

  // Match index by student_ids
  let idx = (group.student_ids || []).findIndex(id => String(id) === targetIdStr);

  // Fallback: match by normalized name if student_ids was not populated
  if (idx === -1) {
    const sDoc = await Student.findById(studentId);
    if (sDoc && sDoc.normalized_name) {
      idx = (group.students || []).findIndex(name => normalizeName(name) === sDoc.normalized_name);
    }
  }

  if (idx === -1) {
    throw new Error('Student not found in this group.');
  }

  const removedName = group.students[idx];
  group.students.splice(idx, 1);
  if (group.student_ids && group.student_ids.length > idx) {
    group.student_ids.splice(idx, 1);
  }

  await group.save();

  let markedInactive = false;
  if (markInactive) {
    const remainingGroupCount = await Group.countDocuments({
      _id: { $ne: group._id },
      student_ids: studentId,
    });
    if (remainingGroupCount === 0) {
      await Student.updateOne({ _id: studentId }, { $set: { status: 'inactive' } });
      markedInactive = true;
    }
  }

  return {
    ok: true,
    removedName,
    studentId: targetIdStr,
    markedInactive,
  };
}

/**
 * Move a student from fromGroup to toGroup.
 * Uses atomic transaction if supported, fallback to sequential save (add target first, then remove source).
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

  const targetIdStr = String(studentId);
  const sDoc = await Student.findById(studentId);
  if (!sDoc) {
    throw new Error('Student not found.');
  }

  // Find index in fromGroup
  let fromIdx = (fromGroup.student_ids || []).findIndex(id => String(id) === targetIdStr);
  if (fromIdx === -1 && sDoc.normalized_name) {
    fromIdx = (fromGroup.students || []).findIndex(n => normalizeName(n) === sDoc.normalized_name);
  }
  if (fromIdx === -1) {
    throw new Error('Student not found in source group.');
  }

  const studentName = fromGroup.students[fromIdx] || sDoc.raw_name || sDoc.full_name;

  // Check if student already in toGroup
  const toNorms = new Set((toGroup.students || []).map(s => normalizeName(s)));
  if (toNorms.has(sDoc.normalized_name) || (toGroup.student_ids || []).some(id => String(id) === targetIdStr)) {
    throw new Error('Student is already in target group.');
  }

  if ((toGroup.students || []).length >= 200) {
    throw new Error('Target group has reached maximum 200 students.');
  }

  let usedTransaction = false;

  try {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      toGroup.students.push(studentName);
      toGroup.student_ids.push(sDoc._id);
      fromGroup.students.splice(fromIdx, 1);
      if (fromGroup.student_ids && fromGroup.student_ids.length > fromIdx) {
        fromGroup.student_ids.splice(fromIdx, 1);
      }
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
      // Safe fallback: add to target first, then remove from source
      toGroup.students.push(studentName);
      toGroup.student_ids.push(sDoc._id);
      await toGroup.save();

      fromGroup.students.splice(fromIdx, 1);
      if (fromGroup.student_ids && fromGroup.student_ids.length > fromIdx) {
        fromGroup.student_ids.splice(fromIdx, 1);
      }
      await fromGroup.save();
      usedTransaction = false;
    } else {
      throw txErr;
    }
  }

  return {
    ok: true,
    student: sDoc,
    name: studentName,
    studentId: targetIdStr,
    atomic: usedTransaction ? 'transaction' : 'sequential-after-validation',
  };
}

/**
 * Sync entire roster from a list of names.
 * Used by groupCreate and groupUpdate so even bulk text input creates Students and sets student_ids.
 *
 * @param {Object} group - Mongoose Group doc
 * @param {string[]} rawNames - List of names
 * @returns {Promise<Object>} Updated group doc
 */
async function syncRosterFromNames(group, rawNames) {
  const names = Array.isArray(rawNames) ? rawNames : [];
  const uniqueItems = [];
  const seenNorms = new Set();

  for (const raw of names) {
    const trimmed = (raw || '').trim();
    if (!trimmed) continue;
    if (trimmed.length > 100) continue;

    const norm = normalizeName(trimmed);
    if (!norm || seenNorms.has(norm)) continue;

    seenNorms.add(norm);
    uniqueItems.push({ raw: trimmed, norm });
    if (uniqueItems.length >= 200) break;
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
  return group;
}

module.exports = {
  // Pure DB-free helpers
  pairsToRoster,
  applyRosterAdd,
  applyRosterRemove,
  applyRosterMove,

  // DB wrappers
  addStudentsToGroup,
  removeStudentFromGroup,
  moveStudent,
  syncRosterFromNames,
};
