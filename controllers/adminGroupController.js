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
    await AuditLog.create({
      admin:       req.session.user._id,
      adminName:   req.session.user.displayName || req.session.user.username,
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

async function getGroupEditData(group) {
  // Sync legacy/misaligned roster if needed
  if (group.students.length > 0 && (!group.student_ids || group.student_ids.length !== group.students.length)) {
    await groupRosterService.syncRosterFromNames(group, group.students);
  }

  const studentDocs = await Student.find({ _id: { $in: group.student_ids } }).lean();
  const sDocMap = new Map(studentDocs.map(s => [String(s._id), s]));
  const sNormMap = new Map(studentDocs.map(s => [s.normalized_name, s]));

  const allGroupMemberships = await Group.find({ student_ids: { $in: group.student_ids } }).select('_id student_ids').lean();
  const studentGroupCounts = new Map();
  for (const g of allGroupMemberships) {
    for (const sid of (g.student_ids || [])) {
      const k = String(sid);
      studentGroupCounts.set(k, (studentGroupCounts.get(k) || 0) + 1);
    }
  }

  const roster = (group.students || []).map((name, i) => {
    const sId = group.student_ids && group.student_ids[i] ? String(group.student_ids[i]) : null;
    const sDoc = (sId && sDocMap.get(sId)) || sNormMap.get(normalizeName(name));
    const finalId = sDoc ? String(sDoc._id) : (sId || '');
    const totalGroups = finalId ? (studentGroupCounts.get(finalId) || 1) : 1;
    return {
      studentId: finalId,
      name,
      student_code: sDoc ? (sDoc.student_code || sDoc.barcode || '') : '',
      barcode: sDoc ? (sDoc.barcode || '') : '',
      status: sDoc ? (sDoc.status || 'active') : 'active',
      isOnlyGroup: totalGroups <= 1,
    };
  });

  const otherGroups = await Group.find({ _id: { $ne: group._id } })
    .select('group_name type level students')
    .sort({ type: 1, group_name: 1 })
    .lean();

  const targetGroups = otherGroups.map(g => ({
    _id: String(g._id),
    group_name: g.group_name,
    type: g.type,
    level: g.level || '',
    student_count: (g.students || []).length,
  }));

  return { roster, targetGroups };
}

/* ═══════════════════════════════════════════════════════════════
   List   GET /admin/groups
════════════════════════════════════════════════════════════════ */
exports.groupsList = async (req, res) => {
  try {
    const { type, level, q } = req.query;

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

    const [groups, totalGroup, totalPrivate] = await Promise.all([
      Group.find(filter).sort({ type: 1, group_name: 1 }),
      Group.countDocuments({ type: 'GROUP' }),
      Group.countDocuments({ type: 'PRIVATE' }),
    ]);

    // Build available levels list in canonical order, custom ones appended
    const usedLevels      = await Group.distinct('level');
    const availableLevels = [
      ...LEVELS.filter(l => usedLevels.includes(l)),
      ...usedLevels.filter(l => l && !LEVELS.includes(l)).sort(),
    ];

    // Embed groups as safe JSON for the student-detail modal
    const groupsJson = safeJson(groups.map(g => ({
      _id:        String(g._id),
      group_name: g.group_name,
      type:       g.type,
      level:      g.level || '',
      students:   g.students,
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
════════════════════════════════════════════════════════════════ */
exports.groupNewForm = (req, res) => {
  res.render('admin/groups/new', {
    errors: [], formData: {}, LEVELS, LEVEL_LABELS,
  });
};

/* ═══════════════════════════════════════════════════════════════
   Create   POST /admin/groups
════════════════════════════════════════════════════════════════ */
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

    if (students.length > 0) {
      await groupRosterService.syncRosterFromNames(group, students);
    } else {
      await group.save();
    }

    await logAudit(req, 'update', group._id, group.group_name, { note: 'created' });
    req.session.flash = `Group "${group.group_name}" created successfully!`;
    res.redirect('/admin/groups');
  } catch (err) {
    console.error(err);
    res.render('admin/groups/new', {
      errors: ['Something went wrong: ' + err.message], formData: req.body, LEVELS, LEVEL_LABELS,
    });
  }
};

/* ═══════════════════════════════════════════════════════════════
   Edit form   GET /admin/groups/:id/edit
════════════════════════════════════════════════════════════════ */
exports.groupEditForm = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.render('error', { message: 'Invalid group ID.' });
    }
    const group = await Group.findById(req.params.id);
    if (!group) return res.render('error', { message: 'Group not found.' });

    const { roster, targetGroups } = await getGroupEditData(group);
    const groupDataJson = safeJson({
      groupId: String(group._id),
      groupName: group.group_name,
      groupType: group.type,
      roster,
      targetGroups,
    });

    res.render('admin/groups/edit', {
      group,
      roster,
      targetGroups,
      groupDataJson,
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

    const { group_name, type, level } = req.body;
    let students = undefined;
    if (req.body.students !== undefined) {
      students = parseStudentList(req.body.students);
    }

    const errors = validateGroupInput({ group_name, type, level, students });
    if (errors.length > 0) {
      const { roster, targetGroups } = await getGroupEditData(group);
      const groupDataJson = safeJson({
        groupId: String(group._id),
        groupName: group.group_name,
        groupType: group.type,
        roster,
        targetGroups,
      });
      return res.render('admin/groups/edit', {
        group, roster, targetGroups, groupDataJson, errors, success: null, LEVELS, LEVEL_LABELS,
      });
    }

    const oldLabel   = group.group_name;
    group.group_name = group_name.trim();
    group.type       = type;
    group.level      = level ? level.trim() : '';

    if (students !== undefined) {
      await groupRosterService.syncRosterFromNames(group, students);
    } else {
      await group.save();
    }

    await logAudit(req, 'update', group._id, oldLabel);
    const { roster, targetGroups } = await getGroupEditData(group);
    const groupDataJson = safeJson({
      groupId: String(group._id),
      groupName: group.group_name,
      groupType: group.type,
      roster,
      targetGroups,
    });
    return res.render('admin/groups/edit', {
      group, roster, targetGroups, groupDataJson, errors: [], success: 'Group updated successfully!', LEVELS, LEVEL_LABELS,
    });
  } catch (err) {
    console.error('groupUpdate error:', err);
    if (err.name === 'VersionError') {
      return res.status(409).render('error', { message: 'Group changed, refresh the page' });
    }
    const group = await Group.findById(req.params.id).catch(() => null);
    const { roster, targetGroups } = group ? await getGroupEditData(group).catch(() => ({ roster: [], targetGroups: [] })) : { roster: [], targetGroups: [] };
    const groupDataJson = safeJson({
      groupId: group ? String(group._id) : '',
      groupName: group ? group.group_name : '',
      groupType: group ? group.type : 'GROUP',
      roster,
      targetGroups,
    });
    res.render('admin/groups/edit', {
      group, roster, targetGroups, groupDataJson, errors: ['Something went wrong.'], success: null, LEVELS, LEVEL_LABELS,
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
════════════════════════════════════════════════════════════════ */
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
    if (err.name === 'VersionError') {
      return res.status(409).json({ ok: false, message: 'Group changed, refresh the page' });
    }
    return res.status(500).json({ ok: false, message: err.message || 'Failed to add students.' });
  }
};

/* ═══════════════════════════════════════════════════════════════
   Remove Student   POST /admin/groups/:id/students/:studentId/remove
════════════════════════════════════════════════════════════════ */
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
    if (err.name === 'VersionError') {
      return res.status(409).json({ ok: false, message: 'Group changed, refresh the page' });
    }
    return res.status(500).json({ ok: false, message: err.message || 'Failed to remove student.' });
  }
};

/* ═══════════════════════════════════════════════════════════════
   Move Student   POST /admin/groups/:id/students/:studentId/move
════════════════════════════════════════════════════════════════ */
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
    if (err.name === 'VersionError') {
      return res.status(409).json({ ok: false, message: 'Group changed, refresh the page' });
    }
    return res.status(500).json({ ok: false, message: err.message || 'Failed to move student.' });
  }
};