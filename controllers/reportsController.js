const Report = require('../models/Report');
const User   = require('../models/User');

const TEACHING_TYPES = ['Prime Teacher (Full)', 'Assistant Teacher', '1/2 Prime Teacher', 'Prime Teacher (Assisted)'];

const typeBadgeColor = {
  'Prime Teacher (Full)': 'emerald',
  'Assistant Teacher': 'sky',
  '1/2 Prime Teacher': 'amber',
  'Prime Teacher (Assisted)': 'purple',
};

function parseStudentList(raw) {
  if (!raw || raw.trim() === '') return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function validateReportInput({ date, subject, class_name, duration, teaching_type, notes, ac_students, absent_students }) {
  const errors = [];
  if (!date || isNaN(new Date(date).getTime())) errors.push('Tanggal tidak valid.');
  if (!subject || subject.trim().length === 0) errors.push('Mata pelajaran wajib diisi.');
  if (subject && subject.trim().length > 100) errors.push('Mata pelajaran maksimal 100 karakter.');
  if (!class_name || class_name.trim().length === 0) errors.push('Nama kelas wajib diisi.');
  if (class_name && class_name.trim().length > 50) errors.push('Nama kelas maksimal 50 karakter.');
  const dur = Number(duration);
  if (!duration || isNaN(dur) || dur < 1 || !Number.isInteger(dur)) errors.push('Durasi harus berupa bilangan bulat minimal 1 menit.');
  if (!teaching_type || !TEACHING_TYPES.includes(teaching_type)) errors.push('Tipe pengajar tidak valid.');
  if (notes && notes.length > 1000) errors.push('Catatan maksimal 1000 karakter.');
  if (ac_students && ac_students.some(s => s.length > 50)) errors.push('Nama siswa AC maksimal 50 karakter.');
  if (absent_students && absent_students.some(s => s.length > 50)) errors.push('Nama siswa Absent maksimal 50 karakter.');
  if (ac_students && ac_students.length > 100) errors.push('Maksimal 100 siswa AC.');
  if (absent_students && absent_students.length > 100) errors.push('Maksimal 100 siswa Absent.');
  return errors;
}

function formatIDR(n) {
  return 'Rp\u00a0' + n.toLocaleString('id-ID');
}

// GET / — Dashboard
exports.index = async (req, res) => {
  try {
    const { teaching_type } = req.query;

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
    const reports = await Report.find(listFilter).sort({ date: -1 });

    // ── Commission table ─────────────────────────────────────────
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
    // ─────────────────────────────────────────────────────────────

    const successMessage = req.session.flash || null;
    delete req.session.flash;

    res.render('reports/index', {
      reports, teachingTypes: TEACHING_TYPES, selectedType: teaching_type || '', typeBadgeColor,
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
      hasCommission, commissionTable, commissionTotal, commissionTotalFormatted, totalSessions,
    });
  } catch (err) {
    console.error(err);
    res.render('error', { message: 'Failed to load report!' });
  }
};

exports.newForm = (req, res) => {
  res.render('reports/new', { teachingTypes: TEACHING_TYPES, errors: [], formData: {} });
};

exports.create = async (req, res) => {
  try {
    const { date, subject, class_name, duration, teaching_type, notes } = req.body;
    const ac_students     = parseStudentList(req.body.ac_students);
    const absent_students = parseStudentList(req.body.absent_students);

    const validationErrors = validateReportInput({ date, subject, class_name, duration, teaching_type, notes, ac_students, absent_students });
    if (validationErrors.length > 0) {
      return res.render('reports/new', { teachingTypes: TEACHING_TYPES, errors: validationErrors, formData: req.body });
    }

    const report = new Report({
      date, subject: subject.trim(), class_name: class_name.trim(),
      duration: Number(duration), teaching_type, notes: (notes || '').trim(),
      ac_students, absent_students, teacher: req.session.user._id,
    });
    await report.save();
    req.session.flash = 'Report has been created!';
    res.redirect('/reports');
  } catch (err) {
    const errors = err.errors ? Object.values(err.errors).map(e => e.message) : ['Terjadi kesalahan. Silakan coba lagi.'];
    res.render('reports/new', { teachingTypes: TEACHING_TYPES, errors, formData: req.body });
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

exports.editForm = async (req, res) => {
  try {
    const report = await Report.findOne({ _id: req.params.id, teacher: req.session.user._id });
    if (!report) return res.render('error', { message: 'Report not found.' });
    res.render('reports/edit', { report, teachingTypes: TEACHING_TYPES, errors: [] });
  } catch (err) {
    res.render('error', { message: 'Report not found.' });
  }
};

exports.update = async (req, res) => {
  try {
    const { date, subject, class_name, duration, teaching_type, notes } = req.body;
    const ac_students     = parseStudentList(req.body.ac_students);
    const absent_students = parseStudentList(req.body.absent_students);

    const validationErrors = validateReportInput({ date, subject, class_name, duration, teaching_type, notes, ac_students, absent_students });
    if (validationErrors.length > 0) {
      const report = await Report.findOne({ _id: req.params.id, teacher: req.session.user._id });
      return res.render('reports/edit', { report, teachingTypes: TEACHING_TYPES, errors: validationErrors });
    }

    const report = await Report.findOneAndUpdate(
      { _id: req.params.id, teacher: req.session.user._id },
      { date, subject: subject.trim(), class_name: class_name.trim(), duration: Number(duration), teaching_type, notes: (notes || '').trim(), ac_students, absent_students },
      { new: true, runValidators: true }
    );
    if (!report) return res.render('error', { message: 'Report not found.' });
    req.session.flash = 'Report has been updated!';
    res.redirect('/reports');
  } catch (err) {
    const errors = err.errors ? Object.values(err.errors).map(e => e.message) : ['Terjadi kesalahan saat memperbarui.'];
    const report = await Report.findOne({ _id: req.params.id, teacher: req.session.user._id });
    res.render('reports/edit', { report, teachingTypes: TEACHING_TYPES, errors });
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