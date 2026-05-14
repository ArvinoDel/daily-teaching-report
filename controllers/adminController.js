const User   = require('../models/User');
const Report = require('../models/Report');

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
  return 'Rp\u00a0' + n.toLocaleString('id-ID');
}

function parseStudentList(raw) {
  if (!raw || raw.trim() === '') return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function validateReportInput({ date, class_name, duration, teaching_type, notes, ac_students, absent_students, session_mode, session_type }) {
  const errors = [];
  if (!date || isNaN(new Date(date).getTime())) errors.push('Invalid date.');
  if (!class_name || class_name.trim().length === 0)  errors.push('Class name is required.');
  if (class_name && class_name.trim().length > 50)    errors.push('Class name max 50 characters.');
  const dur = Number(duration);
  if (!duration || isNaN(dur) || dur < 1 || !Number.isInteger(dur)) errors.push('Duration must be a whole number, min 1 minute.');
  if (!teaching_type || !TEACHING_TYPES.includes(teaching_type))   errors.push('Invalid teaching type.');
  if (notes && notes.length > 1000)                                 errors.push('Notes max 1000 characters.');
  if (ac_students     && ac_students.some(s => s.length > 50))     errors.push('AC student name max 50 characters.');
  if (absent_students && absent_students.some(s => s.length > 50)) errors.push('Absent student name max 50 characters.');
  if (session_mode && !['online', 'offline'].includes(session_mode)) errors.push('Invalid class mode.');
  if (session_type && !['group', 'private'].includes(session_type))  errors.push('Invalid session type.');
  return errors;
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
      User.countDocuments({ role: { $ne: 'admin' } }),
      User.countDocuments({ lastActiveAt: { $gte: fiveMinAgo }, role: { $ne: 'admin' } }),
      Report.countDocuments(),
      Report.countDocuments({ date: { $gte: monthStart, $lte: monthEnd } }),
    ]);

    const recentReports = await Report.find()
      .sort({ createdAt: -1 })
      .limit(8)
      .populate('teacher', 'displayName username');

    res.render('admin/dashboard', {
      totalUsers, onlineCount, totalReports, monthlyReports,
      recentReports, typeBadgeColor,
      monthLabel: now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
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

    const usersData = users.map(u => ({
      ...u.toObject({ virtuals: true }),
      isOnline:    !!(u.lastActiveAt && u.lastActiveAt >= fiveMinAgo),
      reportCount: countMap[String(u._id)] || 0,
    }));

    res.render('admin/users/index', { users: usersData });
  } catch (err) {
    console.error(err);
    res.render('error', { message: 'Failed to load users.' });
  }
};

exports.userEditForm = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.render('error', { message: 'User not found.' });
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

    // Prevent self-role demotion
    if (String(user._id) === String(req.session.user._id) && role !== 'admin') {
      errors.push('You cannot change your own role.');
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

    if (password && password.length > 0 && password.length < 6) {
      errors.push('Password must be at least 6 characters.');
    }

    if (errors.length > 0) {
      return res.render('admin/users/edit', { user, errors, success: null, currentYear });
    }

    user.username    = username.toLowerCase().trim();
    user.displayName = displayName.trim();
    if (String(user._id) !== String(req.session.user._id)) {
      user.role = ['teacher', 'admin'].includes(role) ? role : 'teacher';
    }
    user.joinDate   = parsedJoinDate;
    user.commission = {
      primeFull:     commValues.primeFull     ?? 0,
      primeAssisted: commValues.primeAssisted ?? 0,
      halfPrime:     commValues.halfPrime     ?? 0,
      assistant:     commValues.assistant     ?? 0,
    };
    if (password && password.length >= 6) user.password = password;

    await user.save();
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
    await Report.deleteMany({ teacher: user._id });
    await user.deleteOne();
    if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.status(200).json({ ok: true });
    }
    res.redirect('/admin/users');
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete user.' });
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
    if (session_type  && ['group', 'private'].includes(session_type))  filter.session_type = session_type;

    const [reports, teachers] = await Promise.all([
      Report.find(filter).sort({ date: -1 }).populate('teacher', 'displayName username'),
      User.find({ role: 'teacher' }).select('displayName username').sort({ displayName: 1 }),
    ]);

    res.render('admin/reports/index', {
      reports, teachers, teachingTypes: TEACHING_TYPES, typeBadgeColor,
      selectedTeacher:     teacher_id    || '',
      selectedType:        teaching_type || '',
      selectedMode:        session_mode  || '',
      selectedSessionType: session_type  || '',
      monthLabel, prevMonth, nextMonth, isCurrentMonth, selectedMonthStr,
    });
  } catch (err) {
    console.error(err);
    res.render('error', { message: 'Failed to load reports.' });
  }
};

exports.reportEditForm = async (req, res) => {
  try {
    const report = await Report.findById(req.params.id).populate('teacher', 'displayName username');
    if (!report) return res.render('error', { message: 'Report not found.' });
    res.render('admin/reports/edit', { report, teachingTypes: TEACHING_TYPES, errors: [] });
  } catch (err) {
    res.render('error', { message: 'Report not found.' });
  }
};

exports.reportUpdate = async (req, res) => {
  try {
    const { date, subject, class_name, duration, teaching_type, notes, session_mode, session_type } = req.body;
    const uses_personal_internet = req.body.uses_personal_internet === 'true';
    const ac_students     = parseStudentList(req.body.ac_students);
    const absent_students = parseStudentList(req.body.absent_students);

    const validationErrors = validateReportInput({ date, class_name, duration, teaching_type, notes, ac_students, absent_students, session_mode, session_type });
    if (validationErrors.length > 0) {
      const report = await Report.findById(req.params.id).populate('teacher', 'displayName username');
      return res.render('admin/reports/edit', { report, teachingTypes: TEACHING_TYPES, errors: validationErrors });
    }

    const report = await Report.findByIdAndUpdate(
      req.params.id,
      {
        date,
        subject:   subject ? subject.trim() : '',
        class_name: class_name.trim(),
        duration:   Number(duration),
        teaching_type,
        notes: (notes || '').trim(),
        ac_students, absent_students,
        session_mode: session_mode || 'offline',
        uses_personal_internet,
        session_type: session_type || 'group',
      },
      { new: true, runValidators: true }
    );

    if (!report) return res.render('error', { message: 'Report not found.' });
    req.session.flash = 'Report updated by admin.';
    res.redirect('/admin/reports');
  } catch (err) {
    console.error(err);
    const report = await Report.findById(req.params.id).populate('teacher', 'displayName username').catch(() => null);
    res.render('admin/reports/edit', { report, teachingTypes: TEACHING_TYPES, errors: ['Something went wrong.'] });
  }
};

exports.reportDelete = async (req, res) => {
  try {
    const report = await Report.findById(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    await report.deleteOne();
    if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.status(200).json({ ok: true });
    }
    res.redirect('/admin/reports');
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete report.' });
  }
};

/* ═══════════════════════════════════════════════════════════════
   Commission
════════════════════════════════════════════════════════════════ */
exports.commissionIndex = async (req, res) => {
  try {
    const { monthStart, monthEnd, prevMonth, nextMonth, isCurrentMonth, monthLabel, selectedMonthStr } =
      getMonthRange(req.query);

    const teachers = await User.find({ role: 'teacher' }).sort({ displayName: 1 });

    const commissionData = await Promise.all(teachers.map(async (teacher) => {
      const reports = await Report.find({
        teacher: teacher._id,
        date: { $gte: monthStart, $lte: monthEnd },
      });

      const comm = teacher.commission || {};
      const commMap = {
        'Prime Teacher (Full)':     comm.primeFull     || 0,
        'Prime Teacher (Assisted)': comm.primeAssisted || 0,
        '1/2 Prime Teacher':        comm.halfPrime     || 0,
        'Assistant Teacher':        comm.assistant     || 0,
      };

      const breakdown = TEACHING_TYPES.map(type => {
        const sessions = reports.filter(r => r.teaching_type === type).length;
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
    }));

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