const mongoose = require('mongoose');
const Group    = require('../models/Group');
const Student  = require('../models/Student');
const AuditLog = require('../models/AuditLog');
const { normalizeName } = require('../models/Student');
const groupRosterService = require('../services/groupRosterService');

const { LEVELS, LEVEL_LABELS } = require('../models/Group');

/* ── Helpers ────────────────────────────────────────────────── */
function safeJson(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/**
 * Format group creation date in Asia/Jakarta as e.g. "13 Oct 2026".
 * Falls back to ObjectId timestamp if createdAt is missing.
 */
function formatGroupCreatedAt(group) {
  let date = group ? group.createdAt : null;
  if (!date && group && group._id && typeof group._id.getTimestamp === 'function') {
    try {
      date = group._id.getTimestamp();
    } catch (_) {}
  }
  if (!date) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Jakarta',
  }).format(new Date(date));
}

// One student per line → trimmed array
function parseStudentList(raw) {
  if (!raw || typeof raw !== 'string' || raw.trim() === '') return [];
  return raw.split('\n').map(s => s.trim()).filter(Boolean);
}

function validateGroupInput({ group_name, type, level, students }) {
  const errors = [];
  if (!group_name || group_name.trim().length === 0)
    errors.push('Group name is required.');
  if (group_name && group_name.trim().length > 100)
    errors.push('Group name max 100 characters.');
  if (!type || !['GROUP', 'PRIVATE'].includes(type))
    errors.push('Type must be GROUP or PRIVATE.');
  if (level && level.trim().length > 50)
    errors.push('Level max 50 characters.');
  if (students && students.some(s => s.length > 100))
    errors.push('Student name max 100 characters.');
  if (students && students.length > 200)
    errors.push('Max 200 students per group.');
  return errors;
}

async function logAudit(req, action, targetId, targetLabel, meta = {}) {
  try {
    const user = (req.session && req.session.user) || req.user || {};
    await AuditLog.create({
      admin:       user._id,
      adminName:   user.displayName || user.username || 'admin',
      action,
      targetType:  'group',
      targetId,
      targetLabel: String(targetLabel || ''),
      meta,
    });
  } catch (e) {
    console.error('Audit log error:', e);
  }
}

/**
 * Read-only helper: builds roster descriptors and detects inconsistencies
 * WITHOUT modifying or saving anything in the database.
 */
async function getGroupEditData(group) {
  const names = Array.isArray(group.students) ? group.students : [];
  const ids = Array.isArray(group.student_ids) ? group.student_ids : [];

  const norms = names.map(s => normalizeName(s)).filter(Boolean);
  const studentDocs = norms.length > 0
    ? await Student.find({ normalized_name: { $in: norms } }).lean()
    : [];

  const sNormMap = new Map(studentDocs.map(s => [s.normalized_name, s]));
  const representedStudentIds = new Set();
  let hasNamesWithoutStudent = false;

  // Single query for all other groups to compute isOnlyGroup by name and build targetGroups
  const otherGroups = await Group.find({ _id: { $ne: group._id } })
    .select('group_name type level students createdAt')
    .sort({ type: 1, group_name: 1 })
    .lean();

  const otherGroupsNormCounts = new Map();
  for (const og of otherGroups) {
    const seenInOg = new Set();
    for (const stName of (og.students || [])) {
      const n = normalizeName(stName);
      if (n && !seenInOg.has(n)) {
        seenInOg.add(n);
        otherGroupsNormCounts.set(n, (otherGroupsNormCounts.get(n) || 0) + 1);
      }
    }
  }

  const roster = names.map(name => {
    const norm = normalizeName(name);
    const sDoc = norm ? sNormMap.get(norm) : null;
    if (!sDoc) {
      hasNamesWithoutStudent = true;
    } else {
      representedStudentIds.add(String(sDoc._id));
    }

    const finalId = sDoc ? String(sDoc._id) : '';
    const otherCount = norm ? (otherGroupsNormCounts.get(norm) || 0) : 0;
    const isOnlyGroup = otherCount === 0;

    return {
      studentId: finalId,
      name,
      student_code: sDoc ? (sDoc.student_code || sDoc.barcode || '') : '',
      barcode: sDoc ? (sDoc.barcode || '') : '',
      status: sDoc ? (sDoc.status || 'active') : 'active',
      isOnlyGroup,
      hasStudentDoc: !!sDoc,
    };
  });

  const hasGhostIds = ids.some(id => !representedStudentIds.has(String(id)));
  const hasLengthMismatch = names.length !== ids.length;
  const isInconsistent = hasLengthMismatch || hasGhostIds || hasNamesWithoutStudent;

  const targetGroups = otherGroups.map(g => ({
    _id: String(g._id),
    group_name: g.group_name,
    type: g.type,
    level: g.level || '',
    student_count: (g.students || []).length,
  }));

  return {
    roster,
    targetGroups,
    isInconsistent,
    hasLengthMismatch,
    hasGhostIds,
    hasNamesWithoutStudent,
  };
}

/* ═══════════════════════════════════════════════════════════════
   List   GET /admin/groups
═══════════════════════════════════════════════════════════════ */
exports.groupsList = async (req, res) => {
  try {
    const { type, level, q, sort } = req.query;

    const filter = {};
    if (type  && ['GROUP', 'PRIVATE'].includes(type)) filter.type  = type;
    if (level && level.trim())                        filter.level = level.trim();
    if (q && q.trim()) {
      const qRegex = { $regex: q.trim(), $options: 'i' };
      filter.$or = [
        { group_name: qRegex },
        { students: qRegex },
      ];
    }

    let sortOption = { type: 1, group_name: 1 };
    // ObjectId ordering strictly matches creation time and ensures consistent sorting when createdAt is missing.
    if (sort === 'newest') sortOption = { _id: -1 };
    else if (sort === 'oldest') sortOption = { _id: 1 };

    const [groups, totalGroup, totalPrivate] = await Promise.all([
      Group.find(filter).sort(sortOption),
      Group.countDocuments({ type: 'GROUP' }),
      Group.countDocuments({ type: 'PRIVATE' }),
    ]);

    // Format created dates
    groups.forEach(g => {
      g.createdAtFormatted = formatGroupCreatedAt(g);
    });

    // Build available levels list in canonical order, custom ones appended
    const usedLevels      = await Group.distinct('level');
    const availableLevels = [
      ...LEVELS.filter(l => usedLevels.includes(l)),
      ...usedLevels.filter(l => l && !LEVELS.includes(l)).sort(),
    ];

    // Embed groups as safe JSON for the student-detail modal
    const groupsJson = safeJson(groups.map(g => ({
      _id:                String(g._id),
      group_name:         g.group_name,
      type:               g.type,
      level:              g.level || '',
      students:           g.students,
      createdAtFormatted: g.createdAtFormatted,
    })));

    const flashMessage = req.session.flash || null;
    delete req.session.flash;

    res.render('admin/groups/index', {
      groups,
      totalGroups:     totalGroup + totalPrivate,
      totalGroup,
      totalPrivate,
      availableLevels,
      LEVELS,
      LEVEL_LABELS,
      groupsJson,
      selectedType:  type  || '',
      selectedLevel: level || '',
      selectedSort:  sort  || '',
      searchQuery:   q     || '',
      flashMessage,
    });
  } catch (err) {
    console.error(err);
    res.render('error', { message: 'Failed to load groups.' });
  }
};

/* ═══════════════════════════════════════════════════════════════
   New form   GET /admin/groups/new
═══════════════════════════════════════════════════════════════ */
exports.groupNewForm = (req, res) => {
  res.render('admin/groups/new', {
    errors: [], formData: {}, LEVELS, LEVEL_LABELS,
  });
};

/* ═══════════════════════════════════════════════════════════════
   Create   POST /admin/groups
═══════════════════════════════════════════════════════════════ */
exports.groupCreate = async (req, res) => {
  try {
    const { group_name, type, level } = req.body;
    const students = parseStudentList(req.body.students);

    const errors = validateGroupInput({ group_name, type, level, students });
    if (errors.length > 0) {
      return res.render('admin/groups/new', {
        errors, formData: req.body, LEVELS, LEVEL_LABELS,
      });
    }

    const group = new Group({
      group_name: group_name.trim(),
      type,
      level:    level ? level.trim() : '',
      students: [],
      student_ids: [],
    });

    let skipMsg = '';
    if (students.length > 0) {
      const { skipped } = await groupRosterService.syncRosterFromNames(group, students);
      if (skipped && skipped.length > 0) {
        skipMsg = ` (${skipped.length} student(s) skipped)`;
      }
    } else {
      await group.save();
    }

    await logAudit(req, 'update', group._id, group.group_name, { note: 'created' });
    req.session.flash = `Group "${group.group_name}" created successfully!${skipMsg}`;
    res.redirect('/admin/groups');
  } catch (err) {
    console.error('groupCreate error:', err);
    res.render('admin/groups/new', {
      errors: ['Something went wrong. Please try again.'], formData: req.body, LEVELS, LEVEL_LABELS,
    });
  }
};

/* ═══════════════════════════════════════════════════════════════
   Edit form   GET /admin/groups/:id/edit
═══════════════════════════════════════════════════════════════ */
exports.groupEditForm = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.render('error', { message: 'Invalid group ID.' });
    }
    const group = await Group.findById(req.params.id);
    if (!group) return res.render('error', { message: 'Group not found.' });

    const formattedCreatedAt = formatGroupCreatedAt(group);
    const { roster, targetGroups, isInconsistent } = await getGroupEditData(group);
    const groupDataJson = safeJson({
      groupId: String(group._id),
      groupName: group.group_name,
      groupType: group.type,
      roster,
      targetGroups,
      isInconsistent,
    });

    res.render('admin/groups/edit', {
      group,
      roster,
      targetGroups,
      groupDataJson,
      isInconsistent,
      formattedCreatedAt,
      errors: [],
      success: null,
      LEVELS,
      LEVEL_LABELS,
    });
  } catch (err) {
    console.error('groupEditForm error:', err);
    res.render('error', { message: 'Group not found.' });
  }
};

/* ═══════════════════════════════════════════════════════════════
   Update   POST /admin/groups/:id
═══════════════════════════════════════════════════════════════ */
exports.groupUpdate = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.render('error', { message: 'Invalid group ID.' });
    }
    const group = await Group.findById(req.params.id);
    if (!group) return res.render('error', { message: 'Group not found.' });

    const formattedCreatedAt = formatGroupCreatedAt(group);
    const { group_name, type, level } = req.body;
    let students = undefined;
    if (req.body.students !== undefined) {
      students = parseStudentList(req.body.students);
    }

    const errors = validateGroupInput({ group_name, type, level, students });
    if (errors.length > 0) {
      const { roster, targetGroups, isInconsistent } = await getGroupEditData(group);
      const groupDataJson = safeJson({
        groupId: String(group._id),
        groupName: group.group_name,
        groupType: group.type,
        roster,
        targetGroups,
        isInconsistent,
      });
      return res.render('admin/groups/edit', {
        group, roster, targetGroups, groupDataJson, isInconsistent, formattedCreatedAt, errors, success: null, LEVELS, LEVEL_LABELS,
      });
    }

    const oldLabel   = group.group_name;
    group.group_name = group_name.trim();
    group.type       = type;
    group.level      = level ? level.trim() : '';

    let skipMsg = '';
    if (students !== undefined) {
      const { skipped } = await groupRosterService.syncRosterFromNames(group, students);
      if (skipped && skipped.length > 0) {
        skipMsg = ` (${skipped.length} student(s) skipped)`;
      }
    } else {
      await group.save();
    }

    await logAudit(req, 'update', group._id, oldLabel);
    const { roster, targetGroups, isInconsistent } = await getGroupEditData(group);
    const groupDataJson = safeJson({
      groupId: String(group._id),
      groupName: group.group_name,
      groupType: group.type,
      roster,
      targetGroups,
      isInconsistent,
    });
    return res.render('admin/groups/edit', {
      group, roster, targetGroups, groupDataJson, isInconsistent, formattedCreatedAt, errors: [], success: `Group updated successfully!${skipMsg}`, LEVELS, LEVEL_LABELS,
    });
  } catch (err) {
    console.error('groupUpdate error:', err);
    if (err.name === 'VersionError') {
      return res.status(409).render('error', { message: 'Group changed, refresh the page' });
    }
    const group = await Group.findById(req.params.id).catch(() => null);
    const formattedCreatedAt = formatGroupCreatedAt(group);
    const { roster, targetGroups, isInconsistent } = group
      ? await getGroupEditData(group).catch(() => ({ roster: [], targetGroups: [], isInconsistent: false }))
      : { roster: [], targetGroups: [], isInconsistent: false };
    const groupDataJson = safeJson({
      groupId: group ? String(group._id) : '',
      groupName: group ? group.group_name : '',
      groupType: group ? group.type : 'GROUP',
      roster,
      targetGroups,
      isInconsistent,
    });
    res.render('admin/groups/edit', {
      group, roster, targetGroups, groupDataJson, isInconsistent, formattedCreatedAt, errors: ['Something went wrong.'], success: null, LEVELS, LEVEL_LABELS,
    });
  }
};

/* ═══════════════════════════════════════════════════════════════
   Delete   DELETE /admin/groups/:id
═══════════════════════════════════════════════════════════════ */
exports.groupDelete = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid group ID.' });
    }
    const group = await Group.findById(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found.' });

    const label = group.group_name;
    await group.deleteOne();
    await logAudit(req, 'delete', group._id, label);

    if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.status(200).json({ ok: true });
    }
    res.redirect('/admin/groups');
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete group.' });
  }
};

/* ═══════════════════════════════════════════════════════════════
   Bulk delete   DELETE /admin/groups/bulk
═══════════════════════════════════════════════════════════════ */
exports.groupsBulkDelete = async (req, res) => {
  try {
    let ids = req.body.ids;
    if (!ids)                     return res.status(400).json({ error: 'No groups selected.' });
    if (!Array.isArray(ids)) ids  = [ids];
    if (ids.length === 0)         return res.status(400).json({ error: 'No groups selected.' });

    const validIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));
    if (validIds.length === 0)    return res.status(400).json({ error: 'No valid group IDs selected.' });

    const result = await Group.deleteMany({ _id: { $in: validIds } });
    await logAudit(req, 'delete', validIds[0], `Bulk delete — ${result.deletedCount} group(s)`);
    return res.status(200).json({ ok: true, deleted: result.deletedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to bulk delete groups.' });
  }
};

/* ═══════════════════════════════════════════════════════════════
   Student Search   GET /admin/students/search?q=...&limit=10
════════════════════════════════════════════════════════════════ */
exports.studentsSearch = async (req, res) => {
  try {
    const needle = (req.query.q || '').trim();
    if (!needle) return res.json([]);

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
    const regex = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    const students = await Student.find({
      $or: [
        { full_name: regex },
        { raw_name: regex },
        { student_code: regex },
        { normalized_name: regex },
      ],
    }).limit(limit).lean();

    const studentIds = students.map(s => s._id);
    const groups = await Group.find({ student_ids: { $in: studentIds } })
      .select('_id group_name type student_ids')
      .lean();

    const groupsByStudentId = new Map();
    for (const g of groups) {
      for (const sid of (g.student_ids || [])) {
        const k = String(sid);
        if (!groupsByStudentId.has(k)) groupsByStudentId.set(k, []);
        groupsByStudentId.get(k).push({
          _id: String(g._id),
          group_name: g.group_name,
          type: g.type,
        });
      }
    }

    const results = students.map(s => ({
      _id: String(s._id),
      full_name: s.full_name || s.raw_name || '',
      raw_name: s.raw_name || '',
      student_code: s.student_code || s.barcode || '',
      status: s.status || 'active',
      groups: groupsByStudentId.get(String(s._id)) || [],
    }));

    return res.json(results);
  } catch (err) {
    console.error('studentsSearch error:', err);
    return res.status(500).json({ ok: false, message: 'Search failed.' });
  }
};

/* ═══════════════════════════════════════════════════════════════
   Add Students   POST /admin/groups/:id/students
═══════════════════════════════════════════════════════════════ */
exports.groupAddStudents = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ ok: false, message: 'Invalid group ID.' });
    }

    let names = req.body.names;
    if (typeof names === 'string') {
      names = parseStudentList(names);
    }
    if (!Array.isArray(names) || names.length === 0) {
      return res.status(400).json({ ok: false, message: 'No student names provided.' });
    }

    const group = await Group.findById(req.params.id);
    if (!group) {
      return res.status(404).json({ ok: false, message: 'Group not found.' });
    }

    const { added, skipped } = await groupRosterService.addStudentsToGroup(group, names);

    for (const student of added) {
      await logAudit(req, 'group_student_add', group._id, group.group_name, {
        groupId: group._id,
        studentId: student.studentId,
        name: student.name,
        created: student.created,
      });
    }

    return res.json({ ok: true, added, skipped });
  } catch (err) {
    console.error('groupAddStudents error:', err);
    if (err.needsRepair) {
      return res.status(409).json({
        ok: false,
        needsRepair: true,
        groupId: err.groupId,
        groupName: err.groupName,
        message: err.message,
      });
    }
    if (err.name === 'VersionError') {
      return res.status(409).json({ ok: false, message: 'Group changed, refresh the page' });
    }
    return res.status(500).json({ ok: false, message: 'Failed to add students.' });
  }
};

/* ═══════════════════════════════════════════════════════════════
   Remove Student   POST /admin/groups/:id/students/:studentId/remove
═══════════════════════════════════════════════════════════════ */
exports.groupRemoveStudent = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id) || !mongoose.Types.ObjectId.isValid(req.params.studentId)) {
      return res.status(400).json({ ok: false, message: 'Invalid group or student ID.' });
    }

    const group = await Group.findById(req.params.id);
    if (!group) {
      return res.status(404).json({ ok: false, message: 'Group not found.' });
    }

    const markInactive = Boolean(req.body.markInactive);
    const result = await groupRosterService.removeStudentFromGroup(group, req.params.studentId, { markInactive });

    await logAudit(req, 'group_student_remove', group._id, group.group_name, {
      groupId: group._id,
      studentId: req.params.studentId,
      name: result.removedName,
      markedInactive: result.markedInactive,
    });

    return res.json({ ok: true, markedInactive: result.markedInactive });
  } catch (err) {
    console.error('groupRemoveStudent error:', err);
    if (err.needsRepair) {
      return res.status(409).json({
        ok: false,
        needsRepair: true,
        groupId: err.groupId,
        groupName: err.groupName,
        message: err.message,
      });
    }
    if (err.name === 'VersionError') {
      return res.status(409).json({ ok: false, message: 'Group changed, refresh the page' });
    }
    return res.status(500).json({ ok: false, message: 'Failed to remove student.' });
  }
};

/* ═══════════════════════════════════════════════════════════════
   Move Student   POST /admin/groups/:id/students/:studentId/move
═══════════════════════════════════════════════════════════════ */
exports.groupMoveStudent = async (req, res) => {
  try {
    const { id, studentId } = req.params;
    const { targetGroupId, confirmTypeChange } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(studentId) || !mongoose.Types.ObjectId.isValid(targetGroupId)) {
      return res.status(400).json({ ok: false, message: 'Invalid ID parameters.' });
    }

    if (String(id) === String(targetGroupId)) {
      return res.status(400).json({ ok: false, message: 'Target group must be different from source group.' });
    }

    const fromGroup = await Group.findById(id);
    const toGroup = await Group.findById(targetGroupId);

    if (!fromGroup || !toGroup) {
      return res.status(404).json({ ok: false, message: 'Source or target group not found.' });
    }

    if (fromGroup.type !== toGroup.type && !confirmTypeChange) {
      return res.status(409).json({
        ok: false,
        requiresTypeConfirmation: true,
        fromType: fromGroup.type,
        toType: toGroup.type,
        message: `Target group "${toGroup.group_name}" has type ${toGroup.type}, differing from current group type ${fromGroup.type}. Please confirm to proceed.`,
      });
    }

    const result = await groupRosterService.moveStudent(fromGroup, toGroup, studentId);

    await logAudit(req, 'group_student_move', fromGroup._id, fromGroup.group_name, {
      groupId: fromGroup._id,
      studentId: req.params.studentId,
      name: result.name,
      targetGroupId: toGroup._id,
      fromType: fromGroup.type,
      toType: toGroup.type,
      created: false,
    });

    return res.json({
      ok: true,
      targetGroupId: toGroup._id,
      studentId: String(studentId),
      name: result.name,
    });
  } catch (err) {
    console.error('groupMoveStudent error:', err);
    if (err.needsRepair) {
      return res.status(409).json({
        ok: false,
        needsRepair: true,
        groupId: err.groupId,
        groupName: err.groupName,
        message: err.message,
      });
    }
    if (err.name === 'VersionError') {
      return res.status(409).json({ ok: false, message: 'Group changed, refresh the page' });
    }
    return res.status(500).json({ ok: false, message: 'Failed to move student.' });
  }
};

/* ═══════════════════════════════════════════════════════════════
   Repair Roster   POST /admin/groups/:id/repair
═══════════════════════════════════════════════════════════════ */
exports.groupRepairRoster = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ ok: false, message: 'Invalid group ID.' });
    }

    const group = await Group.findById(req.params.id);
    if (!group) {
      return res.status(404).json({ ok: false, message: 'Group not found.' });
    }

    // Check whether syncRosterFromNames would drop any existing names (>100 chars or >200 students)
    const rawList = Array.isArray(group.students) ? group.students : [];
    const skipped = [];
    const seenNorms = new Set();
    let count = 0;

    for (const raw of rawList) {
      const trimmed = (raw || '').trim();
      if (!trimmed) continue;

      if (trimmed.length > 100) {
        skipped.push({ name: trimmed, reason: 'Student name max 100 characters.' });
        continue;
      }

      const norm = normalizeName(trimmed);
      if (!norm) continue;

      if (seenNorms.has(norm)) {
        // Exact duplicate by normalized name: merged automatically (keep the first)
        continue;
      }

      if (count >= 200) {
        skipped.push({ name: trimmed, reason: 'Max 200 students per group.' });
        continue;
      }

      seenNorms.add(norm);
      count++;
    }

    if (skipped.length > 0) {
      return res.status(422).json({
        ok: false,
        needsManualFix: true,
        skipped,
      });
    }

    const { mergedDuplicates } = await groupRosterService.syncRosterFromNames(group, group.students);

    await logAudit(req, 'group_roster_repair', group._id, group.group_name, {
      groupId: group._id,
      studentCount: (group.students || []).length,
      mergedCount: (mergedDuplicates || []).length,
    });

    const refreshedData = await getGroupEditData(group);

    let message = 'Roster repaired successfully.';
    if (mergedDuplicates && mergedDuplicates.length > 0) {
      message += ` (${mergedDuplicates.length} merged duplicate${mergedDuplicates.length > 1 ? 's' : ''})`;
    }

    return res.json({
      ok: true,
      message,
      roster: refreshedData.roster,
      isInconsistent: refreshedData.isInconsistent,
      mergedDuplicates: (mergedDuplicates || []).map(d => d.name),
    });
  } catch (err) {
    console.error('groupRepairRoster error:', err);
    if (err.name === 'VersionError') {
      return res.status(409).json({ ok: false, message: 'Group changed, refresh the page' });
    }
    return res.status(500).json({ ok: false, message: 'Failed to repair roster.' });
  }
};

module.exports.formatGroupCreatedAt = formatGroupCreatedAt;
module.exports.getGroupEditData = getGroupEditData;