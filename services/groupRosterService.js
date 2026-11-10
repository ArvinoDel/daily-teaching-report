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
const { assessNameMatch, recordGradeChange } = require('./studentIdentityService');

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
 * Pure helper: plan renaming a student in a pairs list.
 * Finds student by id OR normalized name in a pairs list and returns the new pairs,
 * or null when the student is not in it.
 * Checks for duplicates against other students in the pairs list.
 *
 * @param {Array<{ name: string, norm: string, id: string|ObjectId|null }>} pairs
 * @param {Object} options
 * @param {string|ObjectId} [options.studentId]
 * @param {string} [options.oldNorm]
 * @param {string} options.newName
 * @returns {Array<{ name: string, norm: string, id: string|ObjectId|null }>|null}
 */
function planRenameInGroup(pairs, { studentId, oldNorm, newName }) {
  if (!newName || typeof newName !== 'string' || !newName.trim()) {
    const err = new Error('Student name is required.');
    err.status = 400;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  const trimmed = newName.trim();
  if (trimmed.length > 100) {
    const err = new Error('Student name max 100 characters.');
    err.status = 400;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  const newNorm = normalizeName(trimmed);
  if (!newNorm) {
    const err = new Error('Invalid student name.');
    err.status = 400;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  const safePairs = Array.isArray(pairs) ? pairs : [];
  const targetIdStr = studentId ? String(studentId) : null;
  const targetOldNorm = oldNorm ? String(oldNorm).toLowerCase() : null;

  const idx = safePairs.findIndex(p => {
    if (targetIdStr && p.id && String(p.id) === targetIdStr) return true;
    if (targetOldNorm && p.norm === targetOldNorm) return true;
    return false;
  });

  if (idx === -1) {
    return null;
  }

  // Check if newNorm collides with another student in this group
  const duplicate = safePairs.find((p, i) => i !== idx && p.norm === newNorm);
  if (duplicate) {
    const err = new Error(`A student with this name already exists in this group ("${duplicate.name}").`);
    err.status = 409;
    err.code = 'CONFLICT';
    err.duplicate = true;
    throw err;
  }

  const target = safePairs[idx];
  const updatedPair = {
    ...target,
    name: trimmed,
    norm: newNorm,
  };

  return safePairs.map((p, i) => (i === idx ? updatedPair : p));
}

/**
 * Pure helper: rename a student in currentPairs.
 * Thin wrapper around planRenameInGroup for backward compatibility.
 *
 * @param {Array<{ name: string, norm: string, id: string|ObjectId|null }>} currentPairs
 * @param {Object} options
 * @param {string|ObjectId} [options.studentId]
 * @param {string} [options.normKey]
 * @param {string} options.newName
 * @returns {{ pairs: Array, renamed: Object, oldName: string, students: string[], student_ids: Array }}
 */
function applyRosterRename(currentPairs, { studentId, normKey, newName }) {
  const safePairs = Array.isArray(currentPairs) ? currentPairs : [];
  const targetIdStr = studentId ? String(studentId) : null;
  const targetOldNorm = normKey ? String(normKey).toLowerCase() : null;

  const idx = safePairs.findIndex(p => {
    if (targetIdStr && p.id && String(p.id) === targetIdStr) return true;
    if (targetOldNorm && p.norm === targetOldNorm) return true;
    return false;
  });

  const newPairs = planRenameInGroup(currentPairs, { studentId, oldNorm: normKey, newName });
  if (newPairs === null || idx === -1) {
    const err = new Error('Student not found in this group.');
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }

  const oldName = safePairs[idx].name;
  const updatedPair = newPairs[idx];
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
async function addStudentsToGroup(group, rawNames, options = {}) {
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

  const confirmedNames = new Set(
    Array.isArray(options.confirmSameStudent) ? options.confirmSameStudent : []
  );

  // Pre-check for possible namesakes across incoming names.
  // If ANY name resolves to a likely namesake without confirmation, return 409 and ADD NOTHING.
  const possibleNamesakes = [];
  for (const raw of names) {
    const trimmed = (raw || '').trim();
    if (!trimmed || trimmed.length > 100) continue;
    const norm = normalizeName(trimmed);
    if (!norm) continue;

    const existingDoc = await Student.findOne({ normalized_name: norm });
    if (existingDoc) {
      let groupNames = [];
      if (Array.isArray(existingDoc.groups) && existingDoc.groups.length > 0) {
        groupNames = existingDoc.groups
          .map(g => (typeof g === 'object' && g ? (g.group_name || g.name) : String(g)))
          .filter(Boolean);
      }
      if (mongoose.connection && mongoose.connection.readyState === 1) {
        try {
          const sGroups = await Group.find({
            $or: [
              { student_ids: existingDoc._id },
              { students: new RegExp(norm, 'i') },
            ],
          }).select('group_name').lean();
          if (sGroups && sGroups.length) {
            groupNames = sGroups.map(g => g.group_name).filter(Boolean);
          }
        } catch (_) {}
      }
      const docObj = typeof existingDoc.toObject === 'function' ? existingDoc.toObject() : existingDoc;
      const matchResult = assessNameMatch({ ...docObj, groupNames }, trimmed);

      if (matchResult.kind === 'likely_namesake') {
        if (!confirmedNames.has(norm)) {
          possibleNamesakes.push({
            rawName: trimmed,
            norm,
            studentId: String(existingDoc._id),
            name: existingDoc.full_name || existingDoc.raw_name,
            grade_school: existingDoc.grade_school || '',
            status: existingDoc.status || 'active',
            groupNames,
            gradeDelta: matchResult.gradeDelta,
          });
        }
      }
    }
  }

  if (possibleNamesakes.length > 0) {
    const err = new Error('Possible namesake detected.');
    err.status = 409;
    err.code = 'POSSIBLE_NAMESAKE';
    err.possibleNamesake = possibleNamesakes;
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
      let docModified = false;
      const newGradeSchool = extractGradeSchool(trimmed);
      if (newGradeSchool && newGradeSchool !== studentDoc.grade_school) {
        if (recordGradeChange(studentDoc, newGradeSchool, 'manual')) {
          docModified = true;
        }
      }
      if (studentDoc.status === 'inactive') {
        studentDoc.status = 'active';
        reactivated = true;
        docModified = true;
      }
      if (docModified) {
        await studentDoc.save();
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
 * Safe save order sequencing:
 * 1. Saves Student first (protected by unique index on normalized_name).
 *    Treats duplicate-key error (11000) as 409 conflict.
 * 2. Saves Group second. If group save fails, attempts best-effort restoration
 *    of student's previous attributes (raw_name, full_name, normalized_name, grade_school)
 *    and rethrows original group error.
 *
 * @param {Object} student - Student doc or fake
 * @param {Object} group - Group doc or fake
 * @param {Object} newStudentData - { raw_name, full_name, normalized_name, grade_school }
 * @param {Object} newGroupRoster - { students, student_ids }
 */
async function saveStudentAndGroupWithRollback(student, group, newStudentData, newGroupRoster) {
  const previousState = {
    raw_name: student.raw_name,
    full_name: student.full_name,
    normalized_name: student.normalized_name,
    grade_school: student.grade_school,
  };

  const previousHistory = Array.isArray(student.grade_history) ? [...student.grade_history] : [];

  student.raw_name = newStudentData.raw_name;
  student.full_name = newStudentData.full_name;
  student.normalized_name = newStudentData.normalized_name;
  student.grade_school = newStudentData.grade_school;

  if (newStudentData.grade_school && newStudentData.grade_school !== previousState.grade_school) {
    recordGradeChange(student, newStudentData.grade_school, 'manual');
  }

  try {
    await student.save();
  } catch (studentErr) {
    if (studentErr.code === 11000 || (studentErr.message && studentErr.message.includes('E11000'))) {
      const conflictErr = new Error('A student with this name already exists in the system.');
      conflictErr.status = 409;
      conflictErr.code = 'CONFLICT';
      conflictErr.conflict = true;
      throw conflictErr;
    }
    throw studentErr;
  }

  // Count other students with the new normalized_name and roll back with a 409 if any exist
  let duplicateCount = 0;
  if (mongoose.connection && mongoose.connection.readyState === 1) {
    duplicateCount = await Student.countDocuments({
      normalized_name: newStudentData.normalized_name,
      _id: { $ne: student._id },
    });
  } else if (Student.countDocuments !== mongoose.Model.countDocuments) {
    duplicateCount = await Student.countDocuments({
      normalized_name: newStudentData.normalized_name,
      _id: { $ne: student._id },
    });
  } else if (Student.findOne !== mongoose.Model.findOne) {
    const dup = await Student.findOne({
      normalized_name: newStudentData.normalized_name,
      _id: { $ne: student._id },
    });
    duplicateCount = dup ? 1 : 0;
  } else if (Student.find !== mongoose.Model.find) {
    const others = await Student.find({
      normalized_name: newStudentData.normalized_name,
      _id: { $ne: student._id },
    });
    const list = others && typeof others.lean === 'function' ? await others.lean() : others;
    duplicateCount = Array.isArray(list)
      ? list.filter(s => s && s.normalized_name === newStudentData.normalized_name && String(s._id) !== String(student._id)).length
      : 0;
  }

  if (duplicateCount > 0) {
    try {
      student.raw_name = previousState.raw_name;
      student.full_name = previousState.full_name;
      student.normalized_name = previousState.normalized_name;
      student.grade_school = previousState.grade_school;
      student.grade_history = previousHistory;
      await student.save();
    } catch (restoreErr) {
      console.error('Failed to restore student after duplicate count failure:', restoreErr);
    }
    const conflictErr = new Error('A student with this name already exists in the system.');
    conflictErr.status = 409;
    conflictErr.code = 'CONFLICT';
    conflictErr.conflict = true;
    throw conflictErr;
  }

  group.students = newGroupRoster.students;
  group.student_ids = newGroupRoster.student_ids;

  try {
    await group.save();
  } catch (groupErr) {
    try {
      student.raw_name = previousState.raw_name;
      student.full_name = previousState.full_name;
      student.normalized_name = previousState.normalized_name;
      student.grade_school = previousState.grade_school;
      await student.save();
    } catch (restoreErr) {
      console.error('Failed to restore student after group save failure:', restoreErr);
    }
    throw groupErr;
  }
}

/**
 * Rename a student in a group.
 * Resolves current group names to pairs, identifies the target by studentId,
 * checks for unlinked names (needs repair) and global normalized_name collisions,
 * calls pure helper planRenameInGroup, and updates group, Student doc, other groups, and past reports.
 *
 * @param {Object} group - Loaded Mongoose Group doc
 * @param {string|ObjectId} studentId - Student ObjectId
 * @param {string} newName - New raw name string
 * @returns {Promise<{ ok: true, name: string, oldName: string, studentId: string, student: Object, groupsUpdated: number, reportsUpdated: number, historyIncomplete: boolean, skippedGroups: Array }>}
 */
async function renameStudentInGroup(group, studentId, newName) {
  const trimmed = (newName || '').trim();
  if (!trimmed) {
    const err = new Error('Student name is required.');
    err.status = 400;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  if (trimmed.length > 100) {
    const err = new Error('Student name max 100 characters.');
    err.status = 400;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  const newNorm = normalizeName(trimmed);
  if (!newNorm) {
    const err = new Error('Invalid student name.');
    err.status = 400;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  const currentPairs = await resolveGroupPairs(group);
  const unlinked = currentPairs.find(p => !p.id);
  if (unlinked) {
    const err = new Error("Repair this group's roster first.");
    err.needsRepair = true;
    err.status = 409;
    err.code = 'NEEDS_REPAIR';
    err.groupId = group._id ? String(group._id) : '';
    err.groupName = group.group_name || '';
    throw err;
  }

  const sDoc = await Student.findById(studentId);
  if (!sDoc) {
    const err = new Error('Student not found.');
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
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
    err.status = 409;
    err.code = 'CONFLICT';
    throw err;
  }

  const oldRawName = sDoc.raw_name;
  const oldFullName = sDoc.full_name;
  const oldNorm = sDoc.normalized_name;
  const newFullName = extractFullName(trimmed);
  const newGradeSchool = extractGradeSchool(trimmed);

  // Pure helper handles group-level duplicate and array mutation
  const newCurrentPairs = planRenameInGroup(currentPairs, {
    studentId: String(studentId),
    oldNorm,
    newName: trimmed,
  });

  if (!newCurrentPairs) {
    const err = new Error('Student not found in this group.');
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }

  const newCurrentRoster = pairsToRoster(newCurrentPairs);

  // Safe save order: Student first, then current group (with rollback on failure)
  await saveStudentAndGroupWithRollback(
    sDoc,
    group,
    {
      raw_name: trimmed,
      full_name: newFullName,
      normalized_name: newNorm,
      grade_school: newGradeSchool,
    },
    newCurrentRoster
  );

  // Keep other groups containing this student in sync (Zero index pairing)
  let groupsUpdated = 0;
  const skippedGroups = [];

  try {
    const allOtherGroups = await Group.find({ _id: { $ne: group._id } });

    for (const og of allOtherGroups) {
      const hasName = (og.students || []).some(s => normalizeName(s) === oldNorm);
      const hasId = (og.student_ids || []).some(sid => String(sid) === String(sDoc._id));
      if (!hasName && !hasId) {
        continue;
      }

      // Build pairs with resolveGroupPairs (names are the source of truth)
      const ogPairs = await resolveGroupPairs(og);

      // Check if other group contains unlinked names (needsRepair situation)
      const unlinkedOg = ogPairs.find(p => !p.id);
      if (unlinkedOg) {
        skippedGroups.push({
          groupId: og._id,
          group_name: og.group_name,
          reason: "Group roster contains unlinked students (repair needed).",
        });
        continue;
      }

      let newOgPairs;
      try {
        newOgPairs = planRenameInGroup(ogPairs, {
          studentId: String(sDoc._id),
          oldNorm,
          newName: trimmed,
        });
      } catch (planErr) {
        if (planErr.duplicate || planErr.code === 'CONFLICT' || planErr.status === 409) {
          skippedGroups.push({
            groupId: og._id,
            group_name: og.group_name,
            reason: `A student with this name already exists in this group.`,
          });
          continue;
        }
        throw planErr;
      }

      if (!newOgPairs) {
        continue;
      }

      const ogRoster = pairsToRoster(newOgPairs);
      og.students = ogRoster.students;
      og.student_ids = ogRoster.student_ids;

      try {
        await og.save();
        groupsUpdated++;
      } catch (ogSaveErr) {
        console.error(`Error saving other group ${og._id}:`, ogSaveErr);
        skippedGroups.push({
          groupId: og._id,
          group_name: og.group_name,
          reason: `Failed to save changes: ${ogSaveErr.message}`,
        });
      }
    }
  } catch (syncErr) {
    console.error('Error syncing renamed student across other groups:', syncErr);
  }

  // Update past reports so student AC achievements and logs remain consistent
  let reportsUpdated = 0;
  let historyIncomplete = false;

  const Report = require('../models/Report');

  async function updateReportField(field, oldVal, newVal) {
    if (!oldVal || !newVal || oldVal === newVal) return;
    try {
      const res = await Report.updateMany(
        { [field]: oldVal },
        { $set: { [`${field}.$[elem]`]: newVal } },
        { arrayFilters: [{ elem: oldVal }] }
      );
      if (res && typeof res.modifiedCount === 'number') {
        reportsUpdated += res.modifiedCount;
      }
    } catch (reportErr) {
      historyIncomplete = true;
      console.error(`Error updating student name in report field "${field}" from "${oldVal}" to "${newVal}":`, reportErr);
    }
  }

  if (oldRawName && oldRawName !== trimmed) {
    await updateReportField('ac_students', oldRawName, trimmed);
    await updateReportField('ac_reduced_students', oldRawName, trimmed);
    await updateReportField('absent_students', oldRawName, trimmed);
  }

  if (oldFullName && oldFullName !== newFullName && oldFullName !== oldRawName) {
    await updateReportField('ac_students', oldFullName, newFullName);
    await updateReportField('ac_reduced_students', oldFullName, newFullName);
    await updateReportField('absent_students', oldFullName, newFullName);
  }

  return {
    ok: true,
    name: trimmed,
    oldName: oldRawName,
    studentId: String(sDoc._id),
    student: sDoc,
    groupsUpdated,
    reportsUpdated,
    historyIncomplete,
    skippedGroups,
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
  planRenameInGroup,

  // Name-first resolution helper
  resolveGroupPairs,

  // DB wrappers & sequencing
  saveStudentAndGroupWithRollback,
  addStudentsToGroup,
  removeStudentFromGroup,
  moveStudent,
  renameStudentInGroup,
  syncRosterFromNames,
};

