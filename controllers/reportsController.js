const Report = require('../models/Report');

const TEACHING_TYPES = ['Prime Teacher (Full)', 'Assistant Teacher', '1/2 Prime Teacher', 'Prime Teacher (Assisted)'];

// Helper: badge color per teaching type
const typeBadgeColor = {
  'Prime Teacher (Full)': 'emerald',
  'Assistant Teacher': 'sky',
  '1/2 Prime Teacher': 'amber',
  'Prime Teacher (Assisted)': 'purple',
};

// [FIX] Server-side input validation helper
function validateReportInput({ date, subject, class_name, duration, teaching_type, notes }) {
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
  return errors;
}

// GET / — Dashboard & list semua laporan (dengan filter)
exports.index = async (req, res) => {
  try {
    const { teaching_type } = req.query;
    const filter = { teacher: req.session.user._id };
    if (teaching_type && TEACHING_TYPES.includes(teaching_type)) {
      filter.teaching_type = teaching_type;
    }

    const reports = await Report.find(filter).sort({ date: -1 });

    // Statistik ringkasan
    const allReports = await Report.find({ teacher: req.session.user._id });
    const totalMinutes = allReports.reduce((sum, r) => sum + r.duration, 0);
    const totalHours = (totalMinutes / 60).toFixed(1);
    const totalReports = allReports.length;
    const thisMonth = new Date();
    const monthlyReports = allReports.filter(r => {
      const d = new Date(r.date);
      return d.getMonth() === thisMonth.getMonth() && d.getFullYear() === thisMonth.getFullYear();
    });
    const monthlyMinutes = monthlyReports.reduce((sum, r) => sum + r.duration, 0);
    const monthlyHours = (monthlyMinutes / 60).toFixed(1);
    const countByType = (type) => allReports.filter(r => r.teaching_type === type).length;

    // Ambil flash message dari session lalu hapus agar tidak muncul lagi
    const successMessage = req.session.flash || null;
    delete req.session.flash;

    res.render('reports/index', {
      reports,
      teachingTypes: TEACHING_TYPES,
      selectedType: teaching_type || '',
      typeBadgeColor,
      stats: {
        totalReports,
        totalHours,
        monthlyHours,
        monthlyReports: monthlyReports.length,
        primeCount: countByType('Prime Teacher (Full)'),
        assistCount: countByType('Assistant Teacher'),
        halfCount: countByType('1/2 Prime Teacher'),
        primeAssistedCount: countByType('Prime Teacher (Assisted)')
      },
      successMessage,
    });
  } catch (err) {
    console.error(err);
    res.render('error', { message: 'Failed to load report!' });
  }
};

// GET /new — Form tambah laporan
exports.newForm = (req, res) => {
  res.render('reports/new', {
    teachingTypes: TEACHING_TYPES,
    errors: [],
    formData: {},
  });
};

// POST / — Simpan laporan baru
exports.create = async (req, res) => {
  try {
    const { date, subject, class_name, duration, teaching_type, notes } = req.body;

    // [FIX] Server-side validation before trusting any input
    const validationErrors = validateReportInput({ date, subject, class_name, duration, teaching_type, notes });
    if (validationErrors.length > 0) {
      return res.render('reports/new', { teachingTypes: TEACHING_TYPES, errors: validationErrors, formData: req.body });
    }

    const report = new Report({
      date, subject: subject.trim(), class_name: class_name.trim(),
      duration: Number(duration),
      teaching_type, notes: (notes || '').trim(),
      teacher: req.session.user._id,
    });
    await report.save();
    req.session.flash = 'Report has been created!';
    res.redirect('/reports');
  } catch (err) {
    const errors = err.errors
      ? Object.values(err.errors).map(e => e.message)
      : ['Terjadi kesalahan. Silakan coba lagi.'];
    res.render('reports/new', {
      teachingTypes: TEACHING_TYPES,
      errors,
      formData: req.body,
    });
  }
};

// GET /:id — Detail laporan
exports.show = async (req, res) => {
  try {
    const report = await Report.findOne({ _id: req.params.id, teacher: req.session.user._id });
    if (!report) return res.render('error', { message: 'Report not found.' });
    res.render('reports/show', { report, typeBadgeColor });
  } catch (err) {
    res.render('error', { message: 'Report not found.' });
  }
};

// GET /:id/edit — Form edit laporan
exports.editForm = async (req, res) => {
  try {
    const report = await Report.findOne({ _id: req.params.id, teacher: req.session.user._id });
    if (!report) return res.render('error', { message: 'Report not found.' });
    res.render('reports/edit', { report, teachingTypes: TEACHING_TYPES, errors: [] });
  } catch (err) {
    res.render('error', { message: 'Report not found.' });
  }
};

// PUT /:id — Update laporan
exports.update = async (req, res) => {
  try {
    const { date, subject, class_name, duration, teaching_type, notes } = req.body;

    // [FIX] Server-side validation before trusting any input
    const validationErrors = validateReportInput({ date, subject, class_name, duration, teaching_type, notes });
    if (validationErrors.length > 0) {
      const report = await Report.findOne({ _id: req.params.id, teacher: req.session.user._id });
      return res.render('reports/edit', { report, teachingTypes: TEACHING_TYPES, errors: validationErrors });
    }

    const report = await Report.findOneAndUpdate(
      { _id: req.params.id, teacher: req.session.user._id }, // [FIX] Verify ownership
      { date, subject: subject.trim(), class_name: class_name.trim(), duration: Number(duration), teaching_type, notes: (notes || '').trim() },
      { new: true, runValidators: true }
    );
    if (!report) return res.render('error', { message: 'Report not found.' });
    req.session.flash = 'Report has been updated!';
    res.redirect('/reports');
  } catch (err) {
    const errors = err.errors
      ? Object.values(err.errors).map(e => e.message)
      : ['Terjadi kesalahan saat memperbarui.'];
    const report = await Report.findOne({ _id: req.params.id, teacher: req.session.user._id });
    res.render('reports/edit', { report, teachingTypes: TEACHING_TYPES, errors });
  }
};

// DELETE /:id — Hapus laporan
exports.destroy = async (req, res) => {
  try {
    // [FIX] Verify ownership before deleting to prevent IDOR
    const report = await Report.findOne({ _id: req.params.id, teacher: req.session.user._id });
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    await report.deleteOne();
    req.session.flash = 'Report has been deleted!';
    // Support both fetch (JSON) and form POST
    if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.status(200).json({ ok: true });
    }
    res.redirect('/reports');
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete report.' });
  }
};
