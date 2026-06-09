const Report = require('../models/Report');
const User   = require('../models/User');
const Group  = require('../models/Group'); // 🟢 Added for autocomplete

const TEACHING_TYPES = ['Prime Teacher (Full)', 'Assistant Teacher', '1/2 Prime Teacher', 'Prime Teacher (Assisted)'];

const typeBadgeColor = {
  'Prime Teacher (Full)': 'emerald',
  'Assistant Teacher': 'sky',
  '1/2 Prime Teacher': 'amber',
  'Prime Teacher (Assisted)': 'purple',
};

function safeJsonForHtml(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function parseStudentList(raw) {
  if (!raw || raw.trim() === '') return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function validateReportInput({ date, subject, class_name, duration, teaching_type, notes, ac_students, absent_students, session_mode, session_type, teacher }) {
  const errors = [];
  if (!date || isNaN(new Date(date).getTime())) errors.push('Invalid date.');
  if (teacher !== undefined) {
    if (!teacher) errors.push('Teacher is required.');
    else if (!/^[0-9a-fA-F]{24}$/.test(teacher)) errors.push('Invalid teacher selected.');
  }
  if (subject && subject.trim().length > 100) errors.push('Subject max 100 characters.');
  if (!class_name || class_name.trim().length === 0) errors.push('Class name is required.');
  if (class_name && class_name.trim().length > 200) errors.push('Class name max 200 characters.');
  const dur = Number(duration);
  if (!duration || isNaN(dur) || dur < 1 || !Number.isInteger(dur)) errors.push('Duration must be an integer of at least 1 minute.');
  if (!teaching_type || !TEACHING_TYPES.includes(teaching_type)) errors.push('Invalid teaching type.');
  if (notes && notes.length > 1000) errors.push('Notes max 1000 characters.');
  if (ac_students && ac_students.some(s => s.length > 50)) errors.push('AC student name max 50 characters.');
  if (absent_students && absent_students.some(s => s.length > 50)) errors.push('Absent student name max 50 characters.');
  if (ac_students && ac_students.length > 500) errors.push('Max 500 AC students.');
  if (absent_students && absent_students.length > 500) errors.push('Max 500 absent students.');
  if (session_mode && !['online', 'offline'].includes(session_mode)) errors.push('Invalid class mode.');
  if (session_type && !['group', 'private', 'competition'].includes(session_type)) errors.push('Invalid session type.');
  return errors;
}

function formatIDR(n) {
  return 'Rp\u00a0' + n.toLocaleString('en-US');
}

// 🟢 Fetch groups as safe JSON for embedding in views
async function getGroupsJson() {
  try {
    const groups = await Group.find()
      .sort({ group_name: 1 })
      .select('group_name type level students');
    return safeJsonForHtml(groups.map(g => ({
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

// GET / — Dashboard
exports.index = async (req, res) => {
  try {
    if (req.session.user && (req.session.user.role === 'admin' || req.session.user.role === 'superadmin')) {
      return res.redirect('/admin');
    }

    const { teaching_type, session_mode, session_type } = req.query;

    let selectedYear, selectedMonth;
    if (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) {
      const [y, m] = req.query.month.split('-').map(Number);
      selectedYear = y; selectedMonth = m - 1;
    } else {
      const now = new Date();
      selectedYear = now.getFullYear(); selectedMonth = now.getMonth();
    }

    const monthStart = new Date(selectedYear, selectedMonth, 1);
    const monthEnd   = new Date(selectedYear, selectedMonth + 1, 0, 23, 59, 59, 999);

    const toMonthStr = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const prevMonth      = toMonthStr(new Date(selectedYear, selectedMonth - 1, 1));
    const nextMonth      = toMonthStr(new Date(selectedYear, selectedMonth + 1, 1));
    const isCurrentMonth = toMonthStr(new Date(selectedYear, selectedMonth, 1)) === toMonthStr(new Date());
    const monthLabel     = new Date(selectedYear, selectedMonth, 1)
      .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    const allReports    = await Report.find({ teacher: req.session.user._id });
    const totalMinutes  = allReports.reduce((sum, r) => sum + r.duration, 0);
    const totalHours    = (totalMinutes / 60).toFixed(1);
    const totalReports  = allReports.length;

    const now2 = new Date();
    const thisMonthReports = allReports.filter(r => {
      const d = new Date(r.date);
      return d.getMonth() === now2.getMonth() && d.getFullYear() === now2.getFullYear();
    });
    const monthlyHours = (thisMonthReports.reduce((sum, r) => sum + r.duration, 0) / 60).toFixed(1);

    const selectedMonthReports = await Report.find({
      teacher: req.session.user._id,
      date: { $gte: monthStart, $lte: monthEnd },
    }).sort({ date: 1 });

    const countByType = (type) => selectedMonthReports.filter(r => r.teaching_type === type).length;

    const dailyMap = {};
    for (const r of selectedMonthReports) {
      const key = r.date.toISOString().substring(0, 10);
      if (!dailyMap[key]) {
        dailyMap[key] = {
          date: r.date, dateKey: key, reports: [],
          counts: { 'Prime Teacher (Full)': 0, 'Prime Teacher (Assisted)': 0, 'Assistant Teacher': 0, '1/2 Prime Teacher': 0 },
        };
      }
      dailyMap[key].reports.push(r);
      if (dailyMap[key].counts[r.teaching_type] !== undefined) dailyMap[key].counts[r.teaching_type]++;
    }
    const dailySummary = Object.values(dailyMap).sort((a, b) => new Date(b.date) - new Date(a.date));

    const listFilter = { teacher: req.session.user._id };
    if (teaching_type && TEACHING_TYPES.includes(teaching_type)) listFilter.teaching_type = teaching_type;
    if (session_mode && ['online', 'offline'].includes(session_mode)) listFilter.session_mode = session_mode;
    if (session_type && ['group', 'private', 'competition'].includes(session_type)) listFilter.session_type = session_type;
    const reports = await Report.find(listFilter).sort({ date: -1 });

    const currentUser = await User.findById(req.session.user._id).select('commission');
    const comm = currentUser?.commission || {};
    const commMap = {
      'Prime Teacher (Full)':     comm.primeFull     || 0,
      'Prime Teacher (Assisted)': comm.primeAssisted || 0,
      '1/2 Prime Teacher':        comm.halfPrime     || 0,
      'Assistant Teacher':        comm.assistant     || 0,
    };
    const hasCommission = Object.values(commMap).some(v => v > 0);

    const commissionTable = TEACHING_TYPES.map(type => {
      const sessions = countByType(type);
      const price    = commMap[type];
      const total    = sessions * price;
      return { type, sessions, price, total, priceFormatted: formatIDR(price), totalFormatted: formatIDR(total) };
    });
    const commissionTotal          = commissionTable.reduce((sum, r) => sum + r.total, 0);
    const commissionTotalFormatted = formatIDR(commissionTotal);
    const totalSessions            = commissionTable.reduce((sum, r) => sum + r.sessions, 0);

    const successMessage = req.session.flash || null;
    delete req.session.flash;

    res.render('reports/index', {
      reports, teachingTypes: TEACHING_TYPES, selectedType: teaching_type || '', typeBadgeColor,
      selectedMode: session_mode || '',
      selectedSessionType: session_type || '',
      stats: {
        totalReports, totalHours, monthlyHours,
        monthlyReports: thisMonthReports.length,
        primeCount:         countByType('Prime Teacher (Full)'),
        assistCount:        countByType('Assistant Teacher'),
        halfCount:          countByType('1/2 Prime Teacher'),
        primeAssistedCount: countByType('Prime Teacher (Assisted)'),
      },
      monthLabel, prevMonth, nextMonth, isCurrentMonth,
      selectedMonthStr: toMonthStr(new Date(selectedYear, selectedMonth, 1)),
      dailySummary, successMessage,
      dailySummaryJson: safeJsonForHtml(dailySummary.map(day => ({
        dateLabel: new Date(day.date).toLocaleDateString('en-US', {
          weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
        }),
        reports: day.reports.map(r => ({
          _id:              String(r._id),
          subject:          r.subject,
          class_name:       r.class_name,
          teaching_type:    r.teaching_type,
          durationFormatted: r.durationFormatted,
        })),
      }))),
      hasCommission, commissionTable, commissionTotal, commissionTotalFormatted, totalSessions,
    });
  } catch (err) {
    console.error(err);
    res.render('error', { message: 'Failed to load report!' });
  }
};

// 🟢 Now async — fetches groups for autocomplete + teachers list if admin/superadmin
exports.newForm = async (req, res) => {
  try {
    const groupsJson = await getGroupsJson();
    const isAdmin = req.session.user && (req.session.user.role === 'admin' || req.session.user.role === 'superadmin');
    const teachers = isAdmin
      ? await User.find({ role: 'teacher' }).select('displayName username').sort({ displayName: 1 })
      : [];
    res.render('reports/new', { teachingTypes: TEACHING_TYPES, errors: [], formData: {}, groupsJson, teachers });
  } catch (err) {
    res.render('reports/new', { teachingTypes: TEACHING_TYPES, errors: [], formData: {}, groupsJson: '[]', teachers: [] });
  }
};

exports.create = async (req, res) => {
  const isAdmin = req.session.user && (req.session.user.role === 'admin' || req.session.user.role === 'superadmin');
  try {
    const { date, subject, class_name, duration, teaching_type, notes, session_mode, session_type, teacher } = req.body;
    const uses_personal_internet = req.body.uses_personal_internet === 'true';
    const ac_students     = parseStudentList(req.body.ac_students);
    const absent_students = parseStudentList(req.body.absent_students);
    const competition_groups = session_type === 'competition' ? parseStudentList(req.body.competition_groups) : [];

    const teacherId = isAdmin && teacher ? teacher : req.session.user._id;

    const validationErrors = validateReportInput({
      date, subject, class_name, duration, teaching_type, notes, ac_students, absent_students, session_mode, session_type,
      teacher: isAdmin ? teacherId : undefined
    });
    if (validationErrors.length > 0) {
      const [groupsJson, teachers] = await Promise.all([
        getGroupsJson(),
        isAdmin ? User.find({ role: 'teacher' }).select('displayName username').sort({ displayName: 1 }) : []
      ]);
      return res.render('reports/new', { teachingTypes: TEACHING_TYPES, errors: validationErrors, formData: req.body, groupsJson, teachers });
    }

    const report = new Report({
      date,
      subject: subject ? subject.trim() : '',
      class_name: class_name.trim(),
      duration: Number(duration),
      teaching_type,
      notes: (notes || '').trim(),
      ac_students,
      absent_students,
      teacher: teacherId,
      session_mode: session_mode || 'offline',
      uses_personal_internet,
      session_type: session_type || 'group',
      competition_groups,
    });
    await report.save();
    req.session.flash = 'Report has been created!';
    res.redirect('/reports');
  } catch (err) {
    const errors = err.errors ? Object.values(err.errors).map(e => e.message) : ['An error occurred. Please try again.'];
    const [groupsJson, teachers] = await Promise.all([
      getGroupsJson(),
      isAdmin ? User.find({ role: 'teacher' }).select('displayName username').sort({ displayName: 1 }) : []
    ]);
    res.render('reports/new', { teachingTypes: TEACHING_TYPES, errors, formData: req.body, groupsJson, teachers });
  }
};

exports.show = async (req, res) => {
  try {
    const report = await Report.findOne({ _id: req.params.id, teacher: req.session.user._id });
    if (!report) return res.render('error', { message: 'Report not found.' });
    res.render('reports/show', { report, typeBadgeColor });
  } catch (err) {
    res.render('error', { message: 'Report not found.' });
  }
};

// 🟢 Now fetches groups for autocomplete + pre-selection
exports.editForm = async (req, res) => {
  try {
    const [report, groupsJson] = await Promise.all([
      Report.findOne({ _id: req.params.id, teacher: req.session.user._id }),
      getGroupsJson(),
    ]);
    if (!report) return res.render('error', { message: 'Report not found.' });
    res.render('reports/edit', { report, teachingTypes: TEACHING_TYPES, errors: [], groupsJson });
  } catch (err) {
    res.render('error', { message: 'Report not found.' });
  }
};

exports.update = async (req, res) => {
  try {
    const { date, subject, class_name, duration, teaching_type, notes, session_mode, session_type } = req.body;
    const uses_personal_internet = req.body.uses_personal_internet === 'true';
    const ac_students     = parseStudentList(req.body.ac_students);
    const absent_students = parseStudentList(req.body.absent_students);
    const competition_groups = session_type === 'competition' ? parseStudentList(req.body.competition_groups) : [];

    const validationErrors = validateReportInput({ date, subject, class_name, duration, teaching_type, notes, ac_students, absent_students, session_mode, session_type });
    if (validationErrors.length > 0) {
      const [report, groupsJson] = await Promise.all([
        Report.findOne({ _id: req.params.id, teacher: req.session.user._id }),
        getGroupsJson(), // 🟢 keep autocomplete on error
      ]);
      return res.render('reports/edit', { report, teachingTypes: TEACHING_TYPES, errors: validationErrors, groupsJson });
    }

    const report = await Report.findOneAndUpdate(
      { _id: req.params.id, teacher: req.session.user._id },
      {
        date,
        subject: subject ? subject.trim() : '',
        class_name: class_name.trim(),
        duration: Number(duration),
        teaching_type,
        notes: (notes || '').trim(),
        ac_students,
        absent_students,
        session_mode: session_mode || 'offline',
        uses_personal_internet,
        session_type: session_type || 'group',
        competition_groups,
      },
      { new: true, runValidators: true }
    );
    if (!report) return res.render('error', { message: 'Report not found.' });
    req.session.flash = 'Report has been updated!';
    res.redirect('/reports');
  } catch (err) {
    const errors = err.errors ? Object.values(err.errors).map(e => e.message) : ['An error occurred while updating.'];
    const [report, groupsJson] = await Promise.all([
      Report.findOne({ _id: req.params.id, teacher: req.session.user._id }),
      getGroupsJson(),
    ]);
    res.render('reports/edit', { report, teachingTypes: TEACHING_TYPES, errors, groupsJson });
  }
};

exports.destroy = async (req, res) => {
  try {
    const report = await Report.findOne({ _id: req.params.id, teacher: req.session.user._id });
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    await report.deleteOne();
    req.session.flash = 'Report has been deleted!';
    if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.status(200).json({ ok: true });
    }
    res.redirect('/reports');
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete report.' });
  }
};