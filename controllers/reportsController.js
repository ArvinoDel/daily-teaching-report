const Report = require('../models/Report');

const TEACHING_TYPES = ['Prime Teacher (Full)', 'Assistant Teacher', '1/2 Prime Teacher', 'Prime Teacher (Assisted)'];

// Helper: badge color per teaching type
const typeBadgeColor = {
  'Prime Teacher (Full)': 'emerald',
  'Assistant Teacher': 'sky',
  '1/2 Prime Teacher': 'amber',
  'Prime Teacher (Assisted)': 'purple',
};

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
    // Hitung per tipe
    const countByType = (type) => allReports.filter(r => r.teaching_type === type).length;


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
        // Tambahkan 3 baris ini:
        primeCount: countByType('Prime Teacher (Full)'),
        assistCount: countByType('Assistant Teacher'),
        halfCount: countByType('1/2 Prime Teacher'),
        primeAssistedCount: countByType('Prime Teacher (Assisted)')
      },
      successMessage: req.query.success || null,
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
    const report = new Report({
      date, subject, class_name,
      duration: Number(duration),
      teaching_type, notes,
      teacher: req.session.user._id,
    });
    await report.save();
    res.redirect('/reports?success=Report+has+been+created!');
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
    const report = await Report.findByIdAndUpdate(
      req.params.id,
      { date, subject, class_name, duration: Number(duration), teaching_type, notes },
      { new: true, runValidators: true }
    );
    if (!report) return res.render('error', { message: 'Report not found.' });
    res.redirect('/reports?success=Report+has+been+updated!');
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
    await Report.findByIdAndDelete(req.params.id);
    res.redirect('/reports?success=Report+has+been deleted!');
  } catch (err) {
    res.render('error', { message: 'Failed to delete report.' });
  }
};
