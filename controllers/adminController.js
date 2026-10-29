const User     = require('../models/User');
const Report   = require('../models/Report');
const Salary   = require('../models/Salary');
const AuditLog = require('../models/AuditLog'); // 🟢 Audit log
const Group    = require('../models/Group');
const Material = require('../models/Material'); // 🟢 Added for material autocomplete
const { normalizeMaterialName, formatMaterialDisplayName } = require('../models/Material');
const { recordMaterial, resolveMaterialId, recountMaterialUsage, resolveGroupLevel } = require('../services/materialService');
const {
  normalizeClassFields,
  validateCompetition,
} = require('../services/reportInputService');
const onboardingService = require('../services/onboardingService');

const TEACHING_TYPES = [
  'Prime Teacher (Full)',
  'Assistant Teacher',
  '1/2 Prime Teacher',
  'Prime Teacher (Assisted)',
];

const typeBadgeColor = {
  'Prime Teacher (Full)':     'emerald',
  'Prime Teacher (Assisted)': 'purple',
  'Assistant Teacher':        'sky',
  '1/2 Prime Teacher':        'amber',
};

function formatIDR(n) {
  return 'Rp\u00a0' + n.toLocaleString('en-US');
}

function parseStudentList(raw) {
  if (!raw || raw.trim() === '') return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

// 🟠 Orange: consistent English messages + stricter integer check (rejects "60.5", "60.0")
function validateReportInput({ date, subject, class_name, duration, teaching_type, notes, ac_students, absent_students, ac_reduced_students, session_mode, session_type, teacher, partner_teacher, partner_teacher_name, teacherUser }) {
  const errors = [];
  if (!date || isNaN(new Date(date).getTime())) errors.push('Invalid date.');
  if (subject && subject.trim().length > 100) errors.push('Subject max 100 characters.');
  if (!teacher) {
    errors.push('Teacher is required.');
  } else if (!/^[0-9a-fA-F]{24}$/.test(teacher)) {
    errors.push('Invalid teacher selected.');
  }
  if (class_name === undefined || class_name === null || class_name === '') {
    errors.push('Class name is required.');
  } else if (typeof class_name !== 'string') {
    errors.push('Invalid class name.');
  } else {
    const trimmed = class_name.trim();
    if (trimmed.length === 0) errors.push('Class name is required.');
    else if (trimmed.length > 50) errors.push('Class name max 50 characters.');
  }
  const durStr = String(duration || '').trim();
  const dur    = Number(durStr);
  if (!durStr || !/^\d+$/.test(durStr) || isNaN(dur) || dur < 1) {
    errors.push('Duration must be a whole number, min 1 minute.');
  }
  if (!teaching_type || !TEACHING_TYPES.includes(teaching_type))   errors.push('Invalid teaching type.');
  // Require partner teacher name when submitting as Assistant Teacher or 1/2 Prime Teacher
  if (teaching_type === 'Assistant Teacher' || teaching_type === '1/2 Prime Teacher') {
    if (!partner_teacher_name || !partner_teacher_name.trim()) {
      const roleLabel = teaching_type === 'Assistant Teacher' ? 'Prime Teacher' : 'Partner Teacher';
      errors.push(`${roleLabel} name is required when using the ${teaching_type} type.`);
    } else {
      // Prevent tagging oneself
      if (partner_teacher && teacher && String(partner_teacher) === String(teacher)) {
        errors.push('You cannot tag yourself as the partner teacher.');
      } else if (teacherUser) {
        const pName = partner_teacher_name.trim().toLowerCase();
        const dName = (teacherUser.displayName || '').trim().toLowerCase();
        const uName = (teacherUser.username || '').trim().toLowerCase();
        if ((dName && pName === dName) || (uName && (pName === uName || pName === `@${uName}`))) {
          errors.push('You cannot tag yourself as the partner teacher.');
        }
      }
    }
  }
  if (notes && notes.length > 1000)                                 errors.push('Notes max 1000 characters.');
  if (ac_students     && ac_students.some(s => s.length > 50))     errors.push('AC student name max 50 characters.');
  if (absent_students && absent_students.some(s => s.length > 50)) errors.push('Absent student name max 50 characters.');
  if (ac_reduced_students && ac_reduced_students.some(s => s.length > 50)) errors.push('AC deducted student name max 50 characters.');
  if (ac_students     && ac_students.length     > 500) errors.push('Max 500 AC students.');     // Bug #2 fix
  if (absent_students && absent_students.length > 500) errors.push('Max 500 absent students.'); // Bug #2 fix
  if (ac_reduced_students && ac_reduced_students.length > 500) errors.push('Max 500 AC deducted students.');
  if (session_mode && !['online', 'offline'].includes(session_mode)) errors.push('Invalid class mode.');
  if (session_type && !['group', 'private', 'competition'].includes(session_type))  errors.push('Invalid session type.');
  return errors;
}

function safeJson(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

// 🟢 Fetch groups as safe JSON for embedding in views
async function getGroupsJson() {
  try {
    const groups = await Group.find()
      .sort({ group_name: 1 })
      .select('group_name type level students');
    return safeJson(groups.map(g => ({
      _id:        String(g._id),
      group_name: g.group_name,
      type:       g.type,
      level:      g.level || '',
      students:   g.students,
    })));
  } catch (e) {
    console.error('getGroupsJson error:', e);
    return '[]';
  }
}

// 🟢 Fetch all teachers as safe JSON for partner-teacher autocomplete
async function getTeachersJson() {
  try {
    const teachers = await User.find({ role: 'teacher' })
      .select('displayName username')
      .sort({ displayName: 1 });
    return safeJson(teachers.map(t => ({
      _id:         String(t._id),
      displayName: t.displayName,
      username:    t.username,
    })));
  } catch (e) {
    console.error('getTeachersJson error:', e);
    return '[]';
  }
}

// 🟢 Fetch materials as safe JSON for embedding in the report form
async function getMaterialsJson() {
  try {
    const materials = await Material.find()
      .select('name level usageCount hasContent')
      .sort({ usageCount: -1, name: 1 })
      .lean();
    return safeJson(materials.map(function(m) { return {
      _id:        String(m._id),
      name:       m.name,
      level:      m.level || '',
      usageCount: m.usageCount || 0,
      hasContent: Boolean(m.hasContent),
    }; }));
  } catch (e) {
    console.error('getMaterialsJson (admin) error:', e);
    return '[]';
  }
}

function toMonthStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function getMonthRange(query) {
  let selectedYear, selectedMonth;
  if (query.month && /^\d{4}-\d{2}$/.test(query.month)) {
    const [y, m] = query.month.split('-').map(Number);
    selectedYear = y; selectedMonth = m - 1;
  } else {
    const now = new Date();
    selectedYear = now.getFullYear(); selectedMonth = now.getMonth();
  }
  const monthStart     = new Date(selectedYear, selectedMonth, 1);
  const monthEnd       = new Date(selectedYear, selectedMonth + 1, 0, 23, 59, 59, 999);
  const prevMonth      = toMonthStr(new Date(selectedYear, selectedMonth - 1, 1));
  const nextMonth      = toMonthStr(new Date(selectedYear, selectedMonth + 1, 1));
  const isCurrentMonth = toMonthStr(new Date(selectedYear, selectedMonth, 1)) === toMonthStr(new Date());
  const monthLabel     = new Date(selectedYear, selectedMonth, 1)
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const selectedMonthStr = toMonthStr(new Date(selectedYear, selectedMonth, 1));
  return { monthStart, monthEnd, prevMonth, nextMonth, isCurrentMonth, monthLabel, selectedMonthStr };
}

// 🟢 Audit log helper
async function logAudit(req, action, targetType, targetId, targetLabel, meta = {}) {
  try {
    await AuditLog.create({
      admin:       req.session.user._id,
      adminName:   req.session.user.displayName || req.session.user.username,
      action,
      targetType,
      targetId,
      targetLabel: String(targetLabel || ''),
      meta,
    });
  } catch (e) {
    console.error('Audit log error:', e);
  }
}

/* ═══════════════════════════════════════════════════════════════
   Dashboard
════════════════════════════════════════════════════════════════ */
exports.dashboard = async (req, res) => {
  try {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const now        = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const [totalUsers, onlineCount, totalReports, monthlyReports] = await Promise.all([
      User.countDocuments({ role: 'teacher' }),
      User.countDocuments({ lastActiveAt: { $gte: fiveMinAgo } }),
      Report.countDocuments(),
      Report.countDocuments({ date: { $gte: monthStart, $lte: monthEnd } }),
    ]);

    const recentReports = await Report.find()
      .sort({ createdAt: -1 })
      .limit(8)
      .populate('teacher', 'displayName username');

    // 🟢 Chart: reports per teacher this month
    const rawByTeacher = await Report.aggregate([
      { $match: { date: { $gte: monthStart, $lte: monthEnd } } },
      { $group: { _id: '$teacher', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]);
    const teacherDocs = await User.find({ _id: { $in: rawByTeacher.map(r => r._id) } }).select('displayName');
    const teacherMap  = {};
    teacherDocs.forEach(t => { teacherMap[String(t._id)] = t.displayName; });
    const chartTeachers = rawByTeacher.map(r => ({
      name:  teacherMap[String(r._id)] || 'Unknown',
      count: r.count,
    }));

    // 🟢 Chart: daily trend this month
    const rawDailyTrend = await Report.aggregate([
      { $match: { date: { $gte: monthStart, $lte: monthEnd } } },
      { $group: {
        _id:   { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
        count: { $sum: 1 },
      }},
      { $sort: { _id: 1 } },
    ]);
    const dailyTrend = rawDailyTrend.map(r => ({ date: r._id, count: r.count }));

    res.render('admin/dashboard', {
      totalUsers, onlineCount, totalReports, monthlyReports,
      recentReports, typeBadgeColor,
      monthLabel:         now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
      chartTeachersJson:  safeJson(chartTeachers),
      dailyTrendJson:     safeJson(dailyTrend),
    });
  } catch (err) {
    console.error(err);
    res.render('error', { message: 'Failed to load admin dashboard.' });
  }
};

/* ═══════════════════════════════════════════════════════════════
   Users
════════════════════════════════════════════════════════════════ */
exports.usersList = async (req, res) => {
  try {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const users      = await User.find().sort({ role: 1, displayName: 1 });

    const reportCounts = await Report.aggregate([
      { $group: { _id: '$teacher', count: { $sum: 1 } } },
    ]);
    const countMap = {};
    reportCounts.forEach(r => { countMap[String(r._id)] = r.count; });

    let noRewardsCount = 0;
    const allUsersData = users.map(u => {
      const comm = u.commission || {};
      const hasRewards = [comm.primeFull, comm.primeAssisted, comm.halfPrime, comm.assistant].some(v => (Number(v) || 0) > 0);
      const rewardsNotSet = u.role === 'teacher' && !hasRewards;
      if (rewardsNotSet) noRewardsCount++;
      return {
        ...u.toObject({ virtuals: true }),
        isOnline:    !!(u.lastActiveAt && new Date(u.lastActiveAt).getTime() >= fiveMinAgo.getTime()),
        reportCount: countMap[String(u._id)] || 0,
        rewardsNotSet,
      };
    });

    const filter = req.query.filter || '';
    const displayedUsers = filter === 'no-rewards'
      ? allUsersData.filter(u => u.rewardsNotSet)
      : allUsersData;

    res.render('admin/users/index', {
      users: displayedUsers,
      totalUsersCount: allUsersData.length,
      noRewardsCount,
      filter,
    });
  } catch (err) {
    console.error(err);
    res.render('error', { message: 'Failed to load users.' });
  }
};

exports.userEditForm = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.render('error', { message: 'User not found.' });

    // Restrict admins from editing superadmins
    if (req.session.user.role === 'admin' && user.role === 'superadmin') {
      return res.status(403).render('error', { message: 'Access denied. Admins cannot edit superadmins.' });
    }

    const currentYear = new Date().getFullYear();
    res.render('admin/users/edit', { user, errors: [], success: null, currentYear });
  } catch (err) {
    res.render('error', { message: 'User not found.' });
  }
};

exports.userUpdate = async (req, res) => {
  const currentYear = new Date().getFullYear();
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.render('error', { message: 'User not found.' });

    // Restrict admins from updating superadmins
    if (req.session.user.role === 'admin' && user.role === 'superadmin') {
      return res.status(403).render('error', { message: 'Access denied. Admins cannot edit superadmins.' });
    }

    const { username, displayName, role, password, joinMonth, joinYear } = req.body;
    const errors = [];

    if (!displayName || displayName.trim().length === 0) errors.push('Full name is required.');
    else if (displayName.trim().length > 50)             errors.push('Full name max 50 characters.');

    if (!username || username.trim().length < 3)  errors.push('Username must be at least 3 characters.');
    else if (username.trim().length > 30)          errors.push('Username max 30 characters.');
    else {
      const existing = await User.findOne({
        username: username.toLowerCase().trim(),
        _id: { $ne: user._id },
      });
      if (existing) errors.push('Username already taken.');
    }

    if (String(user._id) === String(req.session.user._id) && role !== user.role) {
      errors.push('You cannot change your own role.');
    }

    // Admins cannot change other users' roles
    if (req.session.user.role === 'admin' && String(user._id) !== String(req.session.user._id)) {
      if (role && role !== user.role) {
        errors.push('Admins cannot change other users\' roles.');
      }
    }

    // Prevent non-superadmins from assigning/changing someone to superadmin
    if (req.session.user.role !== 'superadmin' && role === 'superadmin' && user.role !== 'superadmin') {
      errors.push('Only superadmins can assign the superadmin role.');
    }

    let parsedJoinDate = user.joinDate || null;
    if (joinMonth && joinYear) {
      const m = parseInt(joinMonth), y = parseInt(joinYear);
      if (!isNaN(m) && !isNaN(y) && m >= 1 && m <= 12 && y >= 1970 && y <= currentYear) {
        parsedJoinDate = new Date(y, m - 1, 1);
        if (parsedJoinDate > new Date()) parsedJoinDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      }
    }

    const commFields = ['primeFull', 'primeAssisted', 'halfPrime', 'assistant'];
    const commValues = {};
    for (const field of commFields) {
      const raw = req.body[`commission_${field}`];
      const val = raw !== undefined && raw !== '' ? Number(raw) : 0;
      if (isNaN(val) || val < 0) errors.push(`Commission for ${field} must be 0 or more.`);
      else commValues[field] = Math.round(val);
    }

    // Parse salary profile defaults (all optional, default 0)
    const spNum = (key) => Math.max(0, Math.round(parseFloat(req.body[key]) || 0));
    const mealRateFullVal = (req.body.sp_mealRateFull !== undefined && req.body.sp_mealRateFull !== '')
      ? spNum('sp_mealRateFull') : 22500;
    const transportRateVal = (req.body.sp_transportRate !== undefined && req.body.sp_transportRate !== '')
      ? spNum('sp_transportRate') : 22500;
    const posMonthsReq = (req.body.sp_positionMonthsRequired !== undefined && req.body.sp_positionMonthsRequired !== '')
      ? Math.max(0, parseInt(req.body.sp_positionMonthsRequired, 10) || 0) : 3;
    const rewMonthsReq = (req.body.sp_rewardMonthsRequired !== undefined && req.body.sp_rewardMonthsRequired !== '')
      ? Math.max(0, parseInt(req.body.sp_rewardMonthsRequired, 10) || 0) : 6;

    const salaryProfileValues = {
      basicSalary:        spNum('sp_basicSalary'),
      monthlyIncentive:   spNum('sp_monthlyIncentive'),
      healthAllowance:    spNum('sp_healthAllowance'),
      positionAllowance:  spNum('sp_positionAllowance'),
      loyaltyAllowance:   spNum('sp_loyaltyAllowance'),
      wifeChildAllowance: spNum('sp_wifeChildAllowance'),
      mealRateFull:       mealRateFullVal,
      mealRateHalf:       spNum('sp_mealRateHalf'),
      transportRate:      transportRateVal,
      bpjsKetenagakerjaan:              spNum('sp_bpjsKetenagakerjaan'),
      tax:                              spNum('sp_tax'),
      positionAllowanceMonthsRequired:  posMonthsReq,
      teachingRewardMonthsRequired:     rewMonthsReq,
    };

    if (password && password.length > 0 && password.length < 6) {
      errors.push('Password must be at least 6 characters.');
    }

    if (errors.length > 0) {
      return res.render('admin/users/edit', { user, errors, success: null, currentYear });
    }

    const oldLabel = `${user.displayName} (@${user.username})`;
    user.username    = username.toLowerCase().trim();
    user.displayName = displayName.trim();
    
    // Only update role if it's allowed: superadmin can change it, or admin is editing self (which is locked by check above anyway)
    if (String(user._id) !== String(req.session.user._id)) {
      if (req.session.user.role === 'superadmin') {
        user.role = ['teacher', 'admin', 'superadmin'].includes(role) ? role : 'teacher';
      }
    }

    user.joinDate   = parsedJoinDate;
    user.commission = {
      primeFull:     commValues.primeFull     ?? 0,
      primeAssisted: commValues.primeAssisted ?? 0,
      halfPrime:     commValues.halfPrime     ?? 0,
      assistant:     commValues.assistant     ?? 0,
    };
    user.salaryProfile = salaryProfileValues;
    if (password && password.length >= 6) user.password = password;

    await user.save();
    await logAudit(req, 'update', 'user', user._id, oldLabel); // 🟢 log
    return res.render('admin/users/edit', { user, errors: [], success: 'User updated successfully!', currentYear });
  } catch (err) {
    console.error(err);
    const user = await User.findById(req.params.id).catch(() => null);
    res.render('admin/users/edit', { user, errors: ['Something went wrong.'], success: null, currentYear });
  }
};

exports.userDelete = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (String(user._id) === String(req.session.user._id)) {
      return res.status(400).json({ error: 'Cannot delete your own account.' });
    }

    // Restrict admins from deleting superadmins
    if (req.session.user.role === 'admin' && user.role === 'superadmin') {
      return res.status(403).json({ error: 'Access denied. Admins cannot delete superadmins.' });
    }

    const label = `${user.displayName} (@${user.username})`;

    // Bug #5 fix: nullify partner refs in other teachers' reports before deleting
    const userReports = await Report.find({ teacher: user._id }).select('material').lean();
    const userReportIds = userReports.map(r => r._id);
    const affectedMaterialIds = [...new Set(userReports.map(r => r.material).filter(Boolean).map(id => String(id)))];

    await Promise.all([
      Report.deleteMany({ teacher: user._id }),
      Salary.deleteMany({ teacher: user._id }),
      Report.updateMany({ partner_teacher: user._id }, { $set: { partner_teacher: null } }),
      userReportIds.length > 0
        ? Report.updateMany({ linked_report: { $in: userReportIds } }, { $set: { linked_report: null } })
        : Promise.resolve(),
    ]);

    if (affectedMaterialIds.length > 0) {
      recountMaterialUsage(affectedMaterialIds).catch(e =>
        console.error('recountMaterialUsage error on userDelete (non-fatal):', e)
      );
    }

    await user.deleteOne();
    await logAudit(req, 'delete', 'user', user._id, label); // 🟢 log
    if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.status(200).json({ ok: true });
    }
    res.redirect('/admin/users');
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete user.' });
  }
};

// 🟢 Bulk delete users
exports.usersBulkDelete = async (req, res) => {
  try {
    let ids = req.body.ids;
    if (!ids) return res.status(400).json({ error: 'No users selected.' });
    if (!Array.isArray(ids)) ids = [ids];
    if (ids.length === 0) return res.status(400).json({ error: 'No users selected.' });

    const selfId = String(req.session.user._id);
    ids = ids.filter(id => id !== selfId);
    if (ids.length === 0) return res.status(400).json({ error: 'Cannot delete your own account.' });

    // Restrict admins from bulk deleting superadmins
    if (req.session.user.role === 'admin') {
      const superAdmins = await User.find({ _id: { $in: ids }, role: 'superadmin' });
      if (superAdmins.length > 0) {
        return res.status(403).json({ error: 'Access denied. Admins cannot delete superadmins.' });
      }
    }

    // Bug #5 fix: nullify partner refs in other teachers' reports before bulk delete
    const bulkReports = await Report.find({ teacher: { $in: ids } }).select('material').lean();
    const bulkReportIds = bulkReports.map(r => r._id);
    const affectedMaterialIds = [...new Set(bulkReports.map(r => r.material).filter(Boolean).map(id => String(id)))];

    await Promise.all([
      Report.deleteMany({ teacher: { $in: ids } }),
      Salary.deleteMany({ teacher: { $in: ids } }),
      Report.updateMany({ partner_teacher: { $in: ids } }, { $set: { partner_teacher: null } }),
      bulkReportIds.length > 0
        ? Report.updateMany({ linked_report: { $in: bulkReportIds } }, { $set: { linked_report: null } })
        : Promise.resolve(),
    ]);

    if (affectedMaterialIds.length > 0) {
      recountMaterialUsage(affectedMaterialIds).catch(e =>
        console.error('recountMaterialUsage error on usersBulkDelete (non-fatal):', e)
      );
    }

    const result = await User.deleteMany({ _id: { $in: ids } });
    await logAudit(req, 'delete', 'user', ids[0], `Bulk delete — ${result.deletedCount} user(s)`);
    return res.status(200).json({ ok: true, deleted: result.deletedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to bulk delete users.' });
  }
};

/* ═══════════════════════════════════════════════════════════════
   Reports
════════════════════════════════════════════════════════════════ */
exports.reportsList = async (req, res) => {
  try {
    const { teacher_id, teaching_type, session_mode, session_type } = req.query;
    const { monthStart, monthEnd, prevMonth, nextMonth, isCurrentMonth, monthLabel, selectedMonthStr } =
      getMonthRange(req.query);

    const filter = { date: { $gte: monthStart, $lte: monthEnd } };
    if (teacher_id) filter.teacher = teacher_id;
    if (teaching_type && TEACHING_TYPES.includes(teaching_type)) filter.teaching_type = teaching_type;
    if (session_mode  && ['online', 'offline'].includes(session_mode)) filter.session_mode = session_mode;
    if (session_type  && ['group', 'private', 'competition'].includes(session_type))  filter.session_type = session_type;

    const [reports, teachers] = await Promise.all([
      Report.find(filter).sort({ date: -1 }).populate('teacher', 'displayName username'),
      User.find({ role: 'teacher' }).select('displayName username').sort({ displayName: 1 }),
    ]);

    // 🟡 Flash message support (from reportUpdate redirect)
    const successMessage = req.session.flash || null;
    delete req.session.flash;

    res.render('admin/reports/index', {
      reports, teachers, teachingTypes: TEACHING_TYPES, typeBadgeColor,
      selectedTeacher:     teacher_id    || '',
      selectedType:        teaching_type || '',
      selectedMode:        session_mode  || '',
      selectedSessionType: session_type  || '',
      monthLabel, prevMonth, nextMonth, isCurrentMonth, selectedMonthStr,
      successMessage,
    });
  } catch (err) {
    console.error(err);
    res.render('error', { message: 'Failed to load reports.' });
  }
};

exports.reportEditForm = async (req, res) => {
  try {
    const [report, groupsJson, teachersJson, teachers, materialsJson] = await Promise.all([
      Report.findById(req.params.id)
        .populate('teacher', 'displayName username')
        .populate('material', 'hasContent'),
      getGroupsJson(),
      getTeachersJson(),
      User.find({ role: 'teacher' }).select('displayName username').sort({ displayName: 1 }),
      getMaterialsJson(),
    ]);
    if (!report) return res.render('error', { message: 'Report not found.' });
    res.render('admin/reports/edit', { report, teachingTypes: TEACHING_TYPES, errors: [], groupsJson, teachersJson, teachers, materialsJson });
  } catch (err) {
    res.render('error', { message: 'Report not found.' });
  }
};

exports.reportUpdate = async (req, res) => {
  try {
    const { date, subject, duration, teaching_type, notes, session_mode, session_type, teacher } = req.body;
    const uses_personal_internet = req.body.uses_personal_internet === 'true';
    const ac_students          = parseStudentList(req.body.ac_students);
    const absent_students      = parseStudentList(req.body.absent_students);
    const ac_reduced_students  = parseStudentList(req.body.ac_reduced_students);

    const normalized = normalizeClassFields({
      session_type,
      class_name: req.body.class_name,
      competition_groups: req.body.competition_groups,
    });
    const class_name = normalized.class_name;
    const competition_groups = normalized.competition_groups;

    const compErrors = validateCompetition({
      session_type,
      competition_groups,
    });

    const partner_teacher_name = (req.body.partner_teacher_name || '').trim();
    const partner_teacher_id   = req.body.partner_teacher && /^[0-9a-fA-F]{24}$/.test(req.body.partner_teacher)
      ? req.body.partner_teacher : null;

    const teacherUser = teacher ? await User.findById(teacher).select('displayName username').lean() : null;
    const validationErrors = validateReportInput({
      date, subject, class_name, duration, teaching_type, notes, ac_students, absent_students, ac_reduced_students, session_mode, session_type,
      teacher, partner_teacher: partner_teacher_id, partner_teacher_name, teacherUser
    });
    validationErrors.push(...compErrors);

    if (validationErrors.length > 0) {
      const [report, groupsJson, teachersJson, teachers, materialsJson] = await Promise.all([
        Report.findById(req.params.id).populate('teacher', 'displayName username'),
        getGroupsJson(),
        getTeachersJson(),
        User.find({ role: 'teacher' }).select('displayName username').sort({ displayName: 1 }),
        getMaterialsJson(),
      ]);
      const formData = {
        ...req.body,
        class_name,
        competition_groups,
      };
      if (report) {
        report.session_type = session_type || report.session_type;
        report.class_name = class_name;
        report.competition_groups = competition_groups;
      }
      return res.render('admin/reports/edit', { report, formData, teachingTypes: TEACHING_TYPES, errors: validationErrors, groupsJson, teachersJson, teachers, materialsJson });
    }

    // Load old report values BEFORE update to detect material/level changes
    const oldReport = await Report.findById(req.params.id)
      .select('subject class_name session_type material')
      .lean();

    // Resolve material for the updated report
    let newMaterialId = null;
    const newSubjectTrimmed = subject ? subject.trim() : '';
    const oldSubjectTrimmed = (oldReport && oldReport.subject) || '';
    const newNorm = normalizeMaterialName(newSubjectTrimmed);
    const oldNorm = normalizeMaterialName(oldSubjectTrimmed);
    const newLevel = await resolveGroupLevel(class_name ? class_name.trim() : '', session_type || 'group');
    const oldLevel = oldReport ? await resolveGroupLevel(oldReport.class_name || '', oldReport.session_type || 'group') : '';
    const isMaterialChanged = (newNorm !== oldNorm || newLevel !== oldLevel);
    const materialExists = isMaterialChanged ? true : await Material.exists({ nameNormalized: newNorm, level: newLevel });

    if (newNorm && (isMaterialChanged || !materialExists)) {
      newMaterialId = await recordMaterial({
        subject:     newSubjectTrimmed,
        className:   class_name ? class_name.trim() : '',
        sessionType: session_type || 'group',
        teacherId:   teacher || req.session.user._id,
      });
    } else if (newNorm && oldReport && !oldReport.material) {
      // Legacy report where text/level didn't change but material is null: resolve and set it
      newMaterialId = await resolveMaterialId(newSubjectTrimmed, class_name ? class_name.trim() : '', session_type || 'group');
      if (!newMaterialId) {
        newMaterialId = await recordMaterial({
          subject:     newSubjectTrimmed,
          className:   class_name ? class_name.trim() : '',
          sessionType: session_type || 'group',
          teacherId:   teacher || req.session.user._id,
        });
      }
    } else if (newNorm && oldReport) {
      newMaterialId = oldReport.material;
    }

    const sharedUpdate = {
      teacher,
      date,
      subject:                subject ? subject.trim() : '',
      material:               newMaterialId || null,
      class_name:             class_name.trim(),
      duration:               Number(duration),
      teaching_type,
      notes:                  (notes || '').trim(),
      ac_students, absent_students, ac_reduced_students,
      session_mode:           session_mode || 'offline',
      uses_personal_internet,
      session_type:           session_type || 'group',
      competition_groups,
      partner_teacher:        partner_teacher_id || null,
      partner_teacher_name:   partner_teacher_name || '',
    };

    const report = await Report.findByIdAndUpdate(
      req.params.id,
      sharedUpdate,
      { new: true, runValidators: true }
    );

    if (!report) return res.render('error', { message: 'Report not found.' });

    // Sync linked report fields if one exists
    if (report.linked_report) {
      // Bug #6 fix: recalculate partner teaching_type when original changes
      const linkedTypeUpdate = {};
      if (teaching_type === 'Assistant Teacher') linkedTypeUpdate.teaching_type = 'Prime Teacher (Assisted)';
      else if (teaching_type === '1/2 Prime Teacher') linkedTypeUpdate.teaching_type = '1/2 Prime Teacher';
      await Report.findByIdAndUpdate(report.linked_report, {
        date,
        subject:                subject ? subject.trim() : '',
        material:               newMaterialId || null,
        class_name:             class_name.trim(),
        duration:               Number(duration),
        notes:                  (notes || '').trim(),
        ac_students,
        absent_students,
        ac_reduced_students,
        session_mode:           session_mode || 'offline',
        uses_personal_internet,
        session_type:           session_type || 'group',
        competition_groups,
        ...linkedTypeUpdate,
      });
    }

    // Recount usage if material reference changed
    if (oldReport) {
      const oldMatId = oldReport.material ? String(oldReport.material) : '';
      const newMatId = newMaterialId ? String(newMaterialId) : '';
      if (oldMatId !== newMatId) {
        recountMaterialUsage([oldReport.material, newMaterialId].filter(Boolean)).catch(e =>
          console.error('recountMaterialUsage error on admin update (non-fatal):', e)
        );
      }
    }

    await logAudit(req, 'update', 'report', report._id, `${report.class_name} — ${report.date.toISOString().substring(0, 10)}`);
    req.session.flash = 'Report updated by admin.';
    res.redirect('/admin/reports');
  } catch (err) {
    console.error(err);
    const [report, groupsJson, teachersJson, teachers, materialsJson] = await Promise.all([
      Report.findById(req.params.id).populate('teacher', 'displayName username').catch(() => null),
      getGroupsJson(),
      getTeachersJson(),
      User.find({ role: 'teacher' }).select('displayName username').sort({ displayName: 1 }),
      getMaterialsJson(),
    ]);
    res.render('admin/reports/edit', { report, teachingTypes: TEACHING_TYPES, errors: ['Something went wrong.'], groupsJson, teachersJson, teachers, materialsJson });
  }
};

exports.reportDelete = async (req, res) => {
  try {
    const report = await Report.findById(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    const label = `${report.class_name} — ${report.date.toISOString().substring(0, 10)}`;
    const affectedMaterialId = report.material;

    // Delete auto-generated linked report if it exists
    if (report.linked_report) {
      await Report.findOneAndDelete({ _id: report.linked_report, is_auto_generated: true });
      await Report.findByIdAndUpdate(report.linked_report, { $set: { linked_report: null } });
    }

    await report.deleteOne();

    if (affectedMaterialId) {
      recountMaterialUsage([affectedMaterialId]).catch(e =>
        console.error('recountMaterialUsage error on admin reportDelete (non-fatal):', e)
      );
    }

    await logAudit(req, 'delete', 'report', report._id, label);
    if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.status(200).json({ ok: true });
    }
    res.redirect('/admin/reports');
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete report.' });
  }
};

// 🟢 Bulk delete reports
exports.reportsBulkDelete = async (req, res) => {
  try {
    let ids = req.body.ids;
    if (!ids) return res.status(400).json({ error: 'No reports selected.' });
    if (!Array.isArray(ids)) ids = [ids];
    if (ids.length === 0) return res.status(400).json({ error: 'No reports selected.' });

    // Also delete auto-generated linked reports for each selected report
    const reportsToDelete = await Report.find({ _id: { $in: ids } }).select('material linked_report').lean();
    const affectedMaterialIds = [...new Set(reportsToDelete.map(r => r.material).filter(Boolean).map(id => String(id)))];

    const linkedIds = reportsToDelete
      .map(r => r.linked_report)
      .filter(Boolean)
      .map(id => String(id));
    if (linkedIds.length > 0) {
      await Report.deleteMany({ _id: { $in: linkedIds }, is_auto_generated: true });
    }

    const result = await Report.deleteMany({ _id: { $in: ids } });

    if (affectedMaterialIds.length > 0) {
      recountMaterialUsage(affectedMaterialIds).catch(e =>
        console.error('recountMaterialUsage error on admin reportsBulkDelete (non-fatal):', e)
      );
    }
    await logAudit(req, 'delete', 'report', ids[0], `Bulk delete — ${result.deletedCount} report(s)`);
    return res.status(200).json({ ok: true, deleted: result.deletedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to bulk delete reports.' });
  }
};

/* ═══════════════════════════════════════════════════════════════
   Commission  — 🟡 Fixed N+1 query (single aggregate)
════════════════════════════════════════════════════════════════ */
exports.commissionIndex = async (req, res) => {
  try {
    const { monthStart, monthEnd, prevMonth, nextMonth, isCurrentMonth, monthLabel, selectedMonthStr } =
      getMonthRange(req.query);

    const teachers = await User.find({ role: 'teacher' }).sort({ displayName: 1 });

    // Single aggregate instead of N individual Report.find() calls
    const reportAgg = await Report.aggregate([
      { $match: { date: { $gte: monthStart, $lte: monthEnd } } },
      { $group: {
        _id:      { teacher: '$teacher', teaching_type: '$teaching_type' },
        sessions: { $sum: 1 },
      }},
    ]);

    // Build lookup: teacherId → { typeName → count }
    const aggMap = {};
    for (const row of reportAgg) {
      const tid  = String(row._id.teacher);
      const type = row._id.teaching_type;
      if (!aggMap[tid]) aggMap[tid] = {};
      aggMap[tid][type] = row.sessions;
    }

    const commissionData = teachers.map((teacher) => {
      const comm = teacher.commission || {};
      const commMap = {
        'Prime Teacher (Full)':     comm.primeFull     || 0,
        'Prime Teacher (Assisted)': comm.primeAssisted || 0,
        '1/2 Prime Teacher':        comm.halfPrime     || 0,
        'Assistant Teacher':        comm.assistant     || 0,
      };
      const tid = String(teacher._id);

      const breakdown = TEACHING_TYPES.map(type => {
        const sessions = (aggMap[tid] && aggMap[tid][type]) || 0;
        const price    = commMap[type];
        const total    = sessions * price;
        return { type, sessions, price, total, priceFormatted: formatIDR(price), totalFormatted: formatIDR(total) };
      });

      const totalSessions   = breakdown.reduce((s, r) => s + r.sessions, 0);
      const totalCommission = breakdown.reduce((s, r) => s + r.total, 0);
      const hasCommission   = Object.values(commMap).some(v => v > 0);

      return {
        teacher,
        breakdown,
        totalSessions,
        totalCommission,
        totalCommissionFormatted: formatIDR(totalCommission),
        hasCommission,
      };
    });

    const grandTotal          = commissionData.reduce((s, d) => s + d.totalCommission, 0);
    const grandTotalFormatted = formatIDR(grandTotal);

    res.render('admin/commission', {
      commissionData, monthLabel, prevMonth, nextMonth, isCurrentMonth, selectedMonthStr,
      grandTotal, grandTotalFormatted, TEACHING_TYPES, typeBadgeColor,
    });
  } catch (err) {
    console.error(err);
    res.render('error', { message: 'Failed to load commission data.' });
  }
};

/* ═══════════════════════════════════════════════════════════════
   Audit Log  🟢
════════════════════════════════════════════════════════════════ */
exports.auditLogIndex = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 30;
    const skip  = (page - 1) * limit;

    const filter = {};
    const allowedActions = ['update', 'delete', 'salary_generate', 'salary_publish', 'salary_update', 'salary_bulk_update'];
    const allowedTargets = ['report', 'user', 'group', 'salary'];
    if (req.query.action     && allowedActions.includes(req.query.action))     filter.action     = req.query.action;
    if (req.query.targetType && allowedTargets.includes(req.query.targetType)) filter.targetType = req.query.targetType;

    const [logs, totalCount] = await Promise.all([
      AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      AuditLog.countDocuments(filter),
    ]);

    const totalPages = Math.ceil(totalCount / limit);

    res.render('admin/audit-log', {
      logs, totalCount, currentPage: page, totalPages,
      selectedAction: req.query.action     || '',
      selectedType:   req.query.targetType || '',
    });
  } catch (err) {
    console.error(err);
    res.render('error', { message: 'Failed to load audit log.' });
  }
};

/* ═══════════════════════════════════════════════════════════════
   Reports Summary  🟢
   Add this export to the bottom of controllers/adminController.js
════════════════════════════════════════════════════════════════ */
exports.reportsSummaryIndex = async (req, res) => {
  try {
    const {
      monthStart, monthEnd,
      prevMonth, nextMonth,
      isCurrentMonth, monthLabel, selectedMonthStr,
    } = getMonthRange(req.query);

    const [reports, groups] = await Promise.all([
      Report.find({ date: { $gte: monthStart, $lte: monthEnd } })
        .sort({ date: -1, createdAt: -1 })
        .populate('teacher', 'displayName username'),
      Group.find().select('group_name level').lean(),
    ]);

    // Map group_name (case-insensitive) to level
    const groupLevelMap = new Map();
    for (const g of groups) {
      if (g.group_name && g.level) {
        groupLevelMap.set(g.group_name.trim().toLowerCase(), g.level.trim().toUpperCase());
      }
    }

    // Attach groupLevel to each report
    for (const r of reports) {
      r.groupLevel = r.class_name ? groupLevelMap.get(r.class_name.trim().toLowerCase()) || '' : '';
    }

    // Group by calendar date (YYYY-MM-DD) — already sorted desc so day order is preserved
    const byDate = {};
    for (const r of reports) {
      const key = r.date.toISOString().substring(0, 10);
      if (!byDate[key]) {
        byDate[key] = {
          dateKey:   key,
          dateLabel: r.date.toLocaleDateString('en-US', {
            weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
          }),
          reports: [],
        };
      }
      byDate[key].reports.push(r);
    }

    const days = Object.values(byDate); // descending date order

    res.render('admin/reports/summary', {
      days,
      totalReports: reports.length,
      monthLabel, prevMonth, nextMonth, isCurrentMonth, selectedMonthStr,
      typeBadgeColor,
    });
  } catch (err) {
    console.error(err);
    res.render('error', { message: 'Failed to load reports summary.' });
  }
};

exports.onboardingReport = async (req, res) => {
  try {
    const now = new Date();
    const teachers = await User.find({
      role: 'teacher',
      'onboarding.startedAt': { $ne: null },
      'onboarding.legacy': { $ne: true },
    })
      .select('_id displayName username profilePicture commission onboarding createdAt')
      .lean();

    const teacherIds = teachers.map(t => t._id);

    const reportAgg = await Report.aggregate([
      {
        $match: {
          teacher: { $in: teacherIds },
          is_auto_generated: { $ne: true },
        },
      },
      {
        $group: {
          _id: '$teacher',
          count: { $sum: 1 },
        },
      },
    ]);

    const reportCounts = {};
    for (const row of reportAgg) {
      reportCounts[String(row._id)] = row.count;
    }

    const report = onboardingService.buildOnboardingReport(teachers, reportCounts, now);

    res.render('admin/onboarding/index', {
      title: 'Admin — Onboarding Report',
      report,
      csrfToken: (req.session && req.session.csrfToken) || (res.locals && res.locals.csrfToken) || '',
    });
  } catch (err) {
    console.error('onboardingReport error:', err);
    res.render('error', { message: 'Failed to load onboarding report.' });
  }
};

exports.onboardingSendReminder = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId || !/^[0-9a-fA-F]{24}$/.test(userId)) {
      return res.status(400).json({ ok: false, error: 'Invalid user ID.' });
    }

    const teacher = await User.findById(userId);
    if (!teacher || teacher.role !== 'teacher') {
      return res.status(404).json({ ok: false, error: 'Teacher not found.' });
    }

    const now = new Date();

    // Compute facts and state FIRST: return 400 if complete or no pending step without touching lastAdminSentAt
    const facts = await onboardingService.getFacts(teacher);
    const state = onboardingService.computeOnboardingState(teacher, facts, now);
    if (!state.nextStep || !state.nextStep.key) {
      return res.status(400).json({ ok: false, error: 'Teacher onboarding is complete or has no pending step.' });
    }

    const check = onboardingService.canAdminSendReminder(teacher, now);
    if (!check.allowed) {
      return res.status(429).json({ ok: false, error: 'A reminder was already sent to this teacher in the last 24 hours.' });
    }

    const prevLastAdminSentAt = teacher.onboarding?.reminders?.lastAdminSentAt ?? null;
    const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const claimFilter = onboardingService.buildAdminReminderClaimFilter({ userId: teacher._id, cutoff: cutoff24h });

    const updated = await User.findOneAndUpdate(
      claimFilter,
      {
        $set: { 'onboarding.reminders.lastAdminSentAt': now },
      },
      { new: true }
    );

    if (!updated) {
      return res.status(429).json({ ok: false, error: 'A reminder was already sent to this teacher in the last 24 hours.' });
    }

    const Notification = require('../models/Notification');
    const stepKey = state.nextStep.key;
    const message = onboardingService.STEP_REMINDER_MESSAGES[stepKey] || 'Finish your setup to get the most out of your dashboard.';
    const link = (state.nextStep.cta && state.nextStep.cta.href) ? state.nextStep.cta.href : '/reports';

    try {
      await Notification.create({
        recipient: teacher._id,
        type: 'onboarding_reminder',
        category: 'system',
        title: 'Finish your setup',
        message,
        link,
        metadata: {
          action: 'onboarding_reminder',
          step: stepKey,
          adminTriggered: true,
        },
      });

      await AuditLog.create({
        admin: req.session.user._id,
        adminName: req.session.user.displayName || req.session.user.username || 'Admin',
        action: 'onboarding_remind',
        targetType: 'user',
        targetId: teacher._id,
        targetLabel: teacher.displayName || teacher.username || 'Teacher',
        meta: {
          step: stepKey,
        },
      });

      return res.json({
        ok: true,
        lastAdminSentAt: now,
        message: 'Reminder sent successfully.',
      });
    } catch (notifErr) {
      // Best-effort restoration of previous lastAdminSentAt
      try {
        await User.updateOne(
          { _id: teacher._id },
          { $set: { 'onboarding.reminders.lastAdminSentAt': prevLastAdminSentAt } }
        );
      } catch (rollbackErr) {
        console.error('Failed to restore lastAdminSentAt after Notification failure:', rollbackErr);
      }
      throw notifErr;
    }
  } catch (err) {
    console.error('onboardingSendReminder error:', err);
    return res.status(500).json({ ok: false, error: 'Failed to send reminder.' });
  }
};

