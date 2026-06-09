const Report = require('../models/Report');
const User   = require('../models/User');
const Group  = require('../models/Group'); // 🟢 Added for autocomplete
const ExcelJS = require('exceljs');

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

exports.exportExcel = async (req, res) => {
  try {
    let selectedYear, selectedMonth;
    if (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) {
      const [y, m] = req.query.month.split('-').map(Number);
      selectedYear = y;
      selectedMonth = m - 1;
    } else {
      const now = new Date();
      selectedYear = now.getFullYear();
      selectedMonth = now.getMonth();
    }

    const monthStart = new Date(selectedYear, selectedMonth, 1);
    const monthEnd   = new Date(selectedYear, selectedMonth + 1, 0, 23, 59, 59, 999);
    const monthLabel = new Date(selectedYear, selectedMonth, 1)
      .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    const reports = await Report.find({
      teacher: req.session.user._id,
      date: { $gte: monthStart, $lte: monthEnd },
    }).sort({ date: 1 });

    const teacherUser = await User.findById(req.session.user._id).select('displayName username commission');
    if (!teacherUser) {
      return res.status(404).render('error', { message: 'Teacher details not found.' });
    }

    const comm = teacherUser.commission || {};
    const commMap = {
      'Prime Teacher (Full)':     comm.primeFull     || 0,
      'Prime Teacher (Assisted)': comm.primeAssisted || 0,
      '1/2 Prime Teacher':        comm.halfPrime     || 0,
      'Assistant Teacher':        comm.assistant     || 0,
    };
    const hasCommission = Object.values(commMap).some(v => v > 0);

    const fRate = commMap['Prime Teacher (Full)'];
    const pRate = commMap['Prime Teacher (Assisted)'];
    const hRate = commMap['1/2 Prime Teacher'];
    const aRate = commMap['Assistant Teacher'];

    const workbook = new ExcelJS.Workbook();

    // ══════════════════════════════════════════════════════════════
    // WORKSHEET 1: SUMMARY MATRIX (Calendar View)
    // ══════════════════════════════════════════════════════════════
    const matrixSheet = workbook.addWorksheet('Summary Matrix');
    matrixSheet.views = [{ showGridLines: true }];

    matrixSheet.columns = [
      { key: 'date', width: 16 },
      { key: 'F', width: 12 },
      { key: 'P', width: 12 },
      { key: 'H', width: 12 },
      { key: 'A', width: 12 },
      { key: 'total', width: 12 }
    ];

    // Merged Date Header (A1:A2)
    matrixSheet.mergeCells('A1:A2');
    const dateHeader = matrixSheet.getCell('A1');
    dateHeader.value = 'DATE';
    dateHeader.font = { name: 'Segoe UI', bold: true, size: 10 };
    dateHeader.alignment = { vertical: 'middle', horizontal: 'center' };
    
    // Merged Teacher Header (B1:F1)
    matrixSheet.mergeCells('B1:F1');
    const teacherHeader = matrixSheet.getCell('B1');
    teacherHeader.value = `${teacherUser.displayName.toUpperCase()} (${fRate.toLocaleString('id-ID')})`;
    teacherHeader.font = { name: 'Segoe UI', bold: true, size: 10 };
    teacherHeader.alignment = { vertical: 'middle', horizontal: 'center' };

    // Apply header background colors and borders (Row 1 & 2)
    const headerCells = ['A1', 'A2', 'B1', 'C1', 'D1', 'E1', 'F1'];
    headerCells.forEach(cellId => {
      const cell = matrixSheet.getCell(cellId);
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF8C471' } // Soft Amber Orange/Yellow
      };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFD68910' } },
        bottom: { style: 'thin', color: { argb: 'FFD68910' } },
        left: { style: 'thin', color: { argb: 'FFD68910' } },
        right: { style: 'thin', color: { argb: 'FFD68910' } }
      };
    });

    // Sub-headers (Row 2)
    const row2 = matrixSheet.getRow(2);
    row2.values = ['', 'F', 'P', 'H', 'A', 'Total'];
    row2.height = 20;

    for (let c = 2; c <= 6; c++) {
      const cell = row2.getCell(c);
      cell.font = { name: 'Segoe UI', bold: true, size: 10 };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF8C471' }
      };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFD68910' } },
        bottom: { style: 'thin', color: { argb: 'FFD68910' } },
        left: { style: 'thin', color: { argb: 'FFD68910' } },
        right: { style: 'thin', color: { argb: 'FFD68910' } }
      };
    }

    // Populate daily entries
    const daysInMonth = new Date(selectedYear, selectedMonth + 1, 0).getDate();
    
    let totalF = 0;
    let totalP = 0;
    let totalH = 0;
    let totalA = 0;
    let totalAll = 0;

    for (let d = 1; d <= daysInMonth; d++) {
      const currentDate = new Date(selectedYear, selectedMonth, d);
      const rowNumber = 3 + d - 1;
      const row = matrixSheet.getRow(rowNumber);
      row.height = 20;

      const dateStr = currentDate.toLocaleDateString('en-US', {
        weekday: 'short',
        day: 'numeric',
        month: 'short'
      });

      const reportsForDay = reports.filter(r => new Date(r.date).getDate() === d);

      const fCount = reportsForDay.filter(r => r.teaching_type === 'Prime Teacher (Full)').length;
      const pCount = reportsForDay.filter(r => r.teaching_type === 'Prime Teacher (Assisted)').length;
      const hCount = reportsForDay.filter(r => r.teaching_type === '1/2 Prime Teacher').length;
      const aCount = reportsForDay.filter(r => r.teaching_type === 'Assistant Teacher').length;
      const totalCount = reportsForDay.length;

      totalF += fCount;
      totalP += pCount;
      totalH += hCount;
      totalA += aCount;
      totalAll += totalCount;

      row.getCell(1).value = dateStr;
      row.getCell(2).value = fCount || '';
      row.getCell(3).value = pCount || '';
      row.getCell(4).value = hCount || '';
      row.getCell(5).value = aCount || '';
      row.getCell(6).value = totalCount || '';

      const isSunday = currentDate.getDay() === 0;

      for (let c = 1; c <= 6; c++) {
        const cell = row.getCell(c);
        cell.font = { name: 'Segoe UI', size: 10 };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
        };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };

        // Highlight Sundays or completely empty days in soft light yellow
        if (isSunday || totalCount === 0) {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFEF9E7' } // Light Yellow
          };
        }
      }
    }

    // Totals Row
    const totalRowNumber = 3 + daysInMonth;
    const totalRow = matrixSheet.getRow(totalRowNumber);
    totalRow.height = 24;

    totalRow.getCell(1).value = 'Total';
    totalRow.getCell(2).value = totalF;
    totalRow.getCell(3).value = totalP;
    totalRow.getCell(4).value = totalH;
    totalRow.getCell(5).value = totalA;
    totalRow.getCell(6).value = totalAll;

    for (let c = 1; c <= 6; c++) {
      const cell = totalRow.getCell(c);
      cell.font = { name: 'Segoe UI', bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF2ECC71' } // Green background
      };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FF27AE60' } },
        bottom: { style: 'thin', color: { argb: 'FF27AE60' } },
        left: { style: 'thin', color: { argb: 'FF27AE60' } },
        right: { style: 'thin', color: { argb: 'FF27AE60' } }
      };
    }

    // RUPIAH Calculation Row
    const rupiahRowNumber = totalRowNumber + 1;
    const rupiahRow = matrixSheet.getRow(rupiahRowNumber);
    rupiahRow.height = 36;

    rupiahRow.getCell(1).value = 'RUPIAH';
    rupiahRow.getCell(1).font = { name: 'Segoe UI', bold: true, size: 10 };
    rupiahRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };
    rupiahRow.getCell(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF8FAFC' }
    };
    rupiahRow.getCell(1).border = {
      top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
    };

    const grandTotalRupiah = (totalF * fRate) + (totalP * pRate) + (totalH * hRate) + (totalA * aRate);
    const rupiahFormulaString = `= (${totalF} x ${fRate.toLocaleString('id-ID')}) + (${totalP} x ${pRate.toLocaleString('id-ID')}) + (${totalH} x ${hRate.toLocaleString('id-ID')}) + (${totalA} x ${aRate.toLocaleString('id-ID')}) =\n${grandTotalRupiah.toLocaleString('id-ID')}`;

    matrixSheet.mergeCells(`B${rupiahRowNumber}:F${rupiahRowNumber}`);
    const formulaCell = matrixSheet.getCell(`B${rupiahRowNumber}`);
    formulaCell.value = rupiahFormulaString;
    formulaCell.font = { name: 'Segoe UI', bold: true, size: 10 };
    formulaCell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    formulaCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFEF9E7' } // Light Yellow
    };
    formulaCell.border = {
      top: { style: 'thin', color: { argb: 'FFD68910' } },
      bottom: { style: 'thin', color: { argb: 'FFD68910' } },
      left: { style: 'thin', color: { argb: 'FFD68910' } },
      right: { style: 'thin', color: { argb: 'FFD68910' } }
    };


    // ══════════════════════════════════════════════════════════════
    // WORKSHEET 2: DETAILED SESSIONS
    // ══════════════════════════════════════════════════════════════
    const detailedSheet = workbook.addWorksheet('Detailed Sessions');
    detailedSheet.views = [{ showGridLines: true }];

    const columnsConfig = [
      { key: 'no' },
      { key: 'date' },
      { key: 'class_name' },
      { key: 'subject' },
      { key: 'teaching_type' },
      { key: 'duration' },
      { key: 'session_mode' },
      { key: 'session_type' },
      { key: 'ac_students' },
      { key: 'absent_students' },
      { key: 'uses_personal_internet' }
    ];
    if (hasCommission) {
      columnsConfig.push({ key: 'commission_val' });
    }
    columnsConfig.push({ key: 'notes' });
    detailedSheet.columns = columnsConfig;

    // Title Row
    detailedSheet.mergeCells('A1:L1');
    const titleCell = detailedSheet.getCell('A1');
    titleCell.value = 'DAILY TEACHING REPORT SUMMARY';
    titleCell.font = { name: 'Segoe UI', size: 16, bold: true, color: { argb: 'FF15803D' } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'left' };

    // Metadata block
    detailedSheet.getCell('A2').value = 'Teacher:';
    detailedSheet.getCell('B2').value = teacherUser.displayName;
    detailedSheet.getCell('A3').value = 'Month:';
    detailedSheet.getCell('B3').value = monthLabel;

    detailedSheet.getCell('A2').font = { name: 'Segoe UI', bold: true, size: 10 };
    detailedSheet.getCell('B2').font = { name: 'Segoe UI', size: 10 };
    detailedSheet.getCell('A3').font = { name: 'Segoe UI', bold: true, size: 10 };
    detailedSheet.getCell('B3').font = { name: 'Segoe UI', size: 10 };

    // Stats block
    detailedSheet.getCell('E2').value = 'Total Sessions';
    detailedSheet.getCell('F2').value = reports.length;
    detailedSheet.getCell('E3').value = 'Total Hours';
    const totalMinutes = reports.reduce((sum, r) => sum + r.duration, 0);
    const totalHours = (totalMinutes / 60).toFixed(1);
    detailedSheet.getCell('F3').value = parseFloat(totalHours);

    detailedSheet.getCell('E2').font = { name: 'Segoe UI', bold: true, size: 10, color: { argb: 'FF475569' } };
    detailedSheet.getCell('F2').font = { name: 'Segoe UI', bold: true, size: 10 };
    detailedSheet.getCell('E3').font = { name: 'Segoe UI', bold: true, size: 10, color: { argb: 'FF475569' } };
    detailedSheet.getCell('F3').font = { name: 'Segoe UI', bold: true, size: 10 };

    if (hasCommission) {
      detailedSheet.getCell('E4').value = 'Total Commission';
      const totalCommission = reports.reduce((sum, r) => sum + (commMap[r.teaching_type] || 0), 0);
      detailedSheet.getCell('F4').value = totalCommission;
      detailedSheet.getCell('F4').numFormat = 'Rp #,##0';
      detailedSheet.getCell('E4').font = { name: 'Segoe UI', bold: true, size: 10, color: { argb: 'FF475569' } };
      detailedSheet.getCell('F4').font = { name: 'Segoe UI', bold: true, size: 10, color: { argb: 'FF15803D' } };
    }

    // Border stats cells
    const statsCells = ['E2', 'F2', 'E3', 'F3'];
    if (hasCommission) {
      statsCells.push('E4', 'F4');
    }
    statsCells.forEach(cellId => {
      const cell = detailedSheet.getCell(cellId);
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF8FAFC' }
      };
    });

    // Main Table Headers (Row 6)
    const headerRowNumber = 6;
    const headers = [
      'No.',
      'Date',
      'Class Name',
      'Subject',
      'Teaching Type',
      'Duration',
      'Session Mode',
      'Session Type',
      'Active Students',
      'Absent Students',
      'Internet (Personal)'
    ];
    if (hasCommission) {
      headers.push('Commission');
    }
    headers.push('Notes');

    const dHeaderRow = detailedSheet.getRow(headerRowNumber);
    dHeaderRow.values = headers;
    dHeaderRow.height = 28;

    dHeaderRow.eachCell((cell) => {
      cell.font = { name: 'Segoe UI', bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF15803D' }
      };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FF166534' } },
        bottom: { style: 'medium', color: { argb: 'FF166534' } },
        left: { style: 'thin', color: { argb: 'FF166534' } },
        right: { style: 'thin', color: { argb: 'FF166534' } }
      };
    });

    // Populate Detailed Data Rows
    reports.forEach((report, index) => {
      const rowNumber = headerRowNumber + 1 + index;
      const row = detailedSheet.getRow(rowNumber);

      const dateFormatted = new Date(report.date).toLocaleDateString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });

      const values = [
        index + 1,
        dateFormatted,
        report.class_name,
        report.subject || '',
        report.teaching_type,
        `${report.duration} min`,
        report.session_mode === 'online' ? 'Online' : 'Offline',
        report.session_type ? report.session_type.charAt(0).toUpperCase() + report.session_type.slice(1) : 'Group',
        report.ac_students && report.ac_students.length > 0 ? report.ac_students.join(', ') : '—',
        report.absent_students && report.absent_students.length > 0 ? report.absent_students.join(', ') : '—',
        report.uses_personal_internet ? 'Yes' : 'No'
      ];

      if (hasCommission) {
        values.push(commMap[report.teaching_type] || 0);
      }
      values.push(report.notes || '');

      row.values = values;
      row.height = 20;

      row.eachCell((cell, colNumber) => {
        cell.font = { name: 'Segoe UI', size: 10 };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        };

        // Alignments
        if ([1, 2, 6, 7, 8, 11].includes(colNumber)) {
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
        } else {
          cell.alignment = { vertical: 'middle', horizontal: 'left' };
        }

        // Commission formatting
        if (hasCommission && colNumber === 12) {
          cell.numFormat = 'Rp #,##0';
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
        }

        // Alternate row fill
        if (index % 2 === 1) {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF0FDF4' }
          };
        }
      });
    });

    // Total Row (Detailed Sheet)
    const dTotalRowNumber = headerRowNumber + 1 + reports.length;
    const dTotalRow = detailedSheet.getRow(dTotalRowNumber);
    dTotalRow.height = 22;

    const dTotalValues = new Array(headers.length).fill('');
    dTotalValues[0] = 'Total';
    dTotalValues[5] = `${totalMinutes} min`;

    if (hasCommission) {
      const totalCommission = reports.reduce((sum, r) => sum + (commMap[r.teaching_type] || 0), 0);
      dTotalValues[11] = totalCommission;
    }
    dTotalRow.values = dTotalValues;

    // Merge columns A to E for Total label
    detailedSheet.mergeCells(`A${dTotalRowNumber}:E${dTotalRowNumber}`);
    const dMergedTotalCell = detailedSheet.getCell(`A${dTotalRowNumber}`);
    dMergedTotalCell.alignment = { vertical: 'middle', horizontal: 'right' };
    dMergedTotalCell.font = { name: 'Segoe UI', bold: true, size: 10 };

    dTotalRow.eachCell((cell, colNumber) => {
      cell.font = { name: 'Segoe UI', bold: true, size: 10 };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FF94A3B8' } },
        bottom: { style: 'double', color: { argb: 'FF94A3B8' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      };

      if (colNumber === 6) {
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      }

      if (hasCommission && colNumber === 12) {
        cell.numFormat = 'Rp #,##0';
        cell.alignment = { vertical: 'middle', horizontal: 'right' };
      }
    });

    // Adjust column widths based on content length
    detailedSheet.columns.forEach((col) => {
      let maxLen = 10;
      col.eachCell({ includeEmpty: false }, (cell) => {
        if (cell.row > 1 && cell.value) {
          const valStr = cell.value.toString();
          if (valStr.length > maxLen) {
            maxLen = valStr.length;
          }
        }
      });
      col.width = Math.min(Math.max(maxLen + 3, 10), 40);
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const safeMonthLabel = monthLabel.replace(/[^a-zA-Z0-9]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="Daily_Teaching_Report_${safeMonthLabel}.xlsx"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Excel export error:', err);
    res.status(500).render('error', { message: 'Failed to generate Excel report.' });
  }
};