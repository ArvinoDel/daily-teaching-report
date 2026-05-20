const Group    = require('../models/Group');
const AuditLog = require('../models/AuditLog');

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
  if (!raw || raw.trim() === '') return [];
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

/* ═══════════════════════════════════════════════════════════════
   List   GET /admin/groups
════════════════════════════════════════════════════════════════ */
exports.groupsList = async (req, res) => {
  try {
    const { type, level, q } = req.query;

    const filter = {};
    if (type  && ['GROUP', 'PRIVATE'].includes(type)) filter.type  = type;
    if (level && level.trim())                        filter.level = level.trim();
    if (q     && q.trim())
      filter.group_name = { $regex: q.trim(), $options: 'i' };

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

    const group = await Group.create({
      group_name: group_name.trim(),
      type,
      level:    level ? level.trim() : '',
      students,
    });

    await logAudit(req, 'update', group._id, group.group_name, { note: 'created' });
    req.session.flash = `Group "${group.group_name}" created successfully!`;
    res.redirect('/admin/groups');
  } catch (err) {
    console.error(err);
    res.render('admin/groups/new', {
      errors: ['Something went wrong.'], formData: req.body, LEVELS, LEVEL_LABELS,
    });
  }
};

/* ═══════════════════════════════════════════════════════════════
   Edit form   GET /admin/groups/:id/edit
════════════════════════════════════════════════════════════════ */
exports.groupEditForm = async (req, res) => {
  try {
    const group = await Group.findById(req.params.id);
    if (!group) return res.render('error', { message: 'Group not found.' });
    res.render('admin/groups/edit', {
      group, errors: [], success: null, LEVELS, LEVEL_LABELS,
    });
  } catch (err) {
    res.render('error', { message: 'Group not found.' });
  }
};

/* ═══════════════════════════════════════════════════════════════
   Update   POST /admin/groups/:id
════════════════════════════════════════════════════════════════ */
exports.groupUpdate = async (req, res) => {
  try {
    const group = await Group.findById(req.params.id);
    if (!group) return res.render('error', { message: 'Group not found.' });

    const { group_name, type, level } = req.body;
    const students = parseStudentList(req.body.students);

    const errors = validateGroupInput({ group_name, type, level, students });
    if (errors.length > 0) {
      return res.render('admin/groups/edit', {
        group, errors, success: null, LEVELS, LEVEL_LABELS,
      });
    }

    const oldLabel   = group.group_name;
    group.group_name = group_name.trim();
    group.type       = type;
    group.level      = level ? level.trim() : '';
    group.students   = students;
    await group.save();

    await logAudit(req, 'update', group._id, oldLabel);
    return res.render('admin/groups/edit', {
      group, errors: [], success: 'Group updated successfully!', LEVELS, LEVEL_LABELS,
    });
  } catch (err) {
    console.error(err);
    const group = await Group.findById(req.params.id).catch(() => null);
    res.render('admin/groups/edit', {
      group, errors: ['Something went wrong.'], success: null, LEVELS, LEVEL_LABELS,
    });
  }
};

/* ═══════════════════════════════════════════════════════════════
   Delete   DELETE /admin/groups/:id
════════════════════════════════════════════════════════════════ */
exports.groupDelete = async (req, res) => {
  try {
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
════════════════════════════════════════════════════════════════ */
exports.groupsBulkDelete = async (req, res) => {
  try {
    let ids = req.body.ids;
    if (!ids)                     return res.status(400).json({ error: 'No groups selected.' });
    if (!Array.isArray(ids)) ids  = [ids];
    if (ids.length === 0)         return res.status(400).json({ error: 'No groups selected.' });

    const result = await Group.deleteMany({ _id: { $in: ids } });
    await logAudit(req, 'delete', ids[0], `Bulk delete — ${result.deletedCount} group(s)`);
    return res.status(200).json({ ok: true, deleted: result.deletedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to bulk delete groups.' });
  }
};