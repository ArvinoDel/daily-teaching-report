const mongoose = require('mongoose');
const Report        = require('../models/Report');
const Group         = require('../models/Group');
const Student       = require('../models/Student');
const AcTransaction = require('../models/AcTransaction');
const { normalizeName } = require('../models/Student');
const {
  getStudentAcTotal,
  getStudentAcHistory,
  migrateExistingStudents,
} = require('../services/studentService');

function safeJson(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/* ═══════════════════════════════════════════════════════════════
   GET /admin/student-achievements
════════════════════════════════════════════════════════════════ */
exports.index = async (req, res) => {
  try {
    const { group_id, q, sort = 'count_desc' } = req.query;

    // --- 1. Load all groups (for filter dropdown + membership lookup) ---
    const allGroups = await Group.find().sort({ group_name: 1 }).lean();

    // Build a map: studentName (lowercased) → [{ groupId, groupName, type, level }]
    const studentGroupMap = {}; // key: normalized name
    const normalizeKey = (name) => name.trim().toLowerCase();

    for (const g of allGroups) {
      for (const student of g.students) {
        const key = normalizeKey(student);
        if (!studentGroupMap[key]) studentGroupMap[key] = [];
        studentGroupMap[key].push({
          groupId:   String(g._id),
          groupName: g.group_name,
          type:      g.type,
          level:     g.level || '',
        });
      }
    }

    // --- 2. Build match stage for reports ---
    const matchStageAdd = {};
    const matchStageReduce = {};
    if (group_id) {
      const targetGroup = allGroups.find(g => String(g._id) === group_id);
      if (targetGroup && targetGroup.students.length > 0) {
        matchStageAdd.ac_students = { $in: targetGroup.students };
        matchStageReduce.ac_reduced_students = { $in: targetGroup.students };
      }
    }

    // --- 3. Aggregate ac_students & ac_reduced_students across reports ---
    // Bug #3 fix: exclude auto-generated linked reports to prevent double-counting
    const [addStats, reduceStats] = await Promise.all([
      Report.aggregate([
        { $match: { ...matchStageAdd,    is_auto_generated: { $ne: true } } },
        { $unwind: '$ac_students' },
        {
          $group: {
            _id:          '$ac_students',
            count:        { $sum: 1 },
            lastSeen:     { $max: '$date' },
            uniqueDates:  { $addToSet: '$date' },
          },
        },
      ]),
      Report.aggregate([
        { $match: { ...matchStageReduce, is_auto_generated: { $ne: true } } },
        { $unwind: '$ac_reduced_students' },
        {
          $group: {
            _id:          '$ac_reduced_students',
            count:        { $sum: 1 },
            lastSeen:     { $max: '$date' },
            uniqueDates:  { $addToSet: '$date' },
          },
        },
      ]),
    ]);

    const studentStatsMap = {};
    for (const item of addStats) {
      studentStatsMap[item._id] = {
        name: item._id,
        count: item.count,
        lastSeen: item.lastSeen,
        uniqueDates: new Set((item.uniqueDates || []).map(d => new Date(d).toISOString().slice(0, 10))),
      };
    }
    for (const item of reduceStats) {
      if (studentStatsMap[item._id]) {
        studentStatsMap[item._id].count -= item.count;
        if (!studentStatsMap[item._id].lastSeen || new Date(item.lastSeen) > new Date(studentStatsMap[item._id].lastSeen)) {
          studentStatsMap[item._id].lastSeen = item.lastSeen;
        }
        (item.uniqueDates || []).forEach(d => studentStatsMap[item._id].uniqueDates.add(new Date(d).toISOString().slice(0, 10)));
      } else {
        studentStatsMap[item._id] = {
          name: item._id,
          count: -item.count,
          lastSeen: item.lastSeen,
          uniqueDates: new Set((item.uniqueDates || []).map(d => new Date(d).toISOString().slice(0, 10))),
        };
      }
    }

    let students = Object.values(studentStatsMap).map(s => ({
      name: s.name,
      count: Math.max(0, s.count),
      lastSeen: s.lastSeen,
      activeDays: s.uniqueDates.size,
    }));

    // --- 4. Attach group memberships ---
    students = students.map(s => {
      const key    = normalizeKey(s.name);
      const groups = studentGroupMap[key] || [];
      return { ...s, groups };
    });

    // --- 5. Filter: only students that belong to at least one group
    //        (unless a specific group_id is selected — already filtered above) ---
    // We always only show students who are in a group
    students = students.filter(s => s.groups.length > 0);

    // --- 6. Search filter ---
    if (q && q.trim()) {
      const needle = q.trim().toLowerCase();
      students = students.filter(s =>
        s.name.toLowerCase().includes(needle) ||
        s.groups.some(g => g.groupName.toLowerCase().includes(needle))
      );
    }

    // --- 7. Sort ---
    const sortFns = {
      count_desc:   (a, b) => b.count - a.count,
      count_asc:    (a, b) => a.count - b.count,
      name_asc:     (a, b) => a.name.localeCompare(b.name),
      name_desc:    (a, b) => b.name.localeCompare(a.name),
      recent:       (a, b) => new Date(b.lastSeen) - new Date(a.lastSeen),
    };
    students.sort(sortFns[sort] || sortFns.count_desc);

    // --- 8. Summary stats ---
    const totalStudents   = students.length;
    const totalAchievements = students.reduce((s, st) => s + st.count, 0);
    const topCount        = students.length > 0 ? students[0].count : 0;
    const avgCount        = totalStudents > 0
      ? (totalAchievements / totalStudents).toFixed(1)
      : '0.0';

    // Tier thresholds (relative to top)
    const tierGold   = Math.ceil(topCount * 0.66);
    const tierSilver = Math.ceil(topCount * 0.33);

    // --- 9. Load Student identity records to attach barcode + student_code ---
    // Build a map from normalized name → student identity
    const allStudentDocs = await Student.find({}).lean();
    const studentIdentityMap = {}; // normalizedName → { barcode, student_code, _id }
    for (const sd of allStudentDocs) {
      if (sd.normalized_name) {
        studentIdentityMap[sd.normalized_name] = {
          studentId:    String(sd._id),
          barcode:      sd.barcode,
          student_code: sd.student_code,
        };
      }
    }

    const studentsWithTier = students.map(s => {
      const nkey    = normalizeName(s.name);
      const identity = studentIdentityMap[nkey] || {};
      return {
        ...s,
        studentId:    identity.studentId    || null,
        barcode:      identity.barcode      || null,
        student_code: identity.student_code || null,
        tier: s.count >= tierGold ? 'gold' : s.count >= tierSilver ? 'silver' : 'bronze',
        lastSeenFormatted: s.lastSeen
          ? new Date(s.lastSeen).toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' })
          : '—',
      };
    });

    const flashMessage = req.session.flash || null;
    delete req.session.flash;

    res.render('admin/student-achievements/index', {
      students:         studentsWithTier,
      allGroups,
      selectedGroupId:  group_id || '',
      searchQuery:      q || '',
      selectedSort:     sort,
      totalStudents,
      totalAchievements,
      avgCount,
      topCount,
      flashMessage,
      studentsJson:   safeJson(studentsWithTier),
      allGroupsJson:  safeJson(allGroups),
    });
  } catch (err) {
    console.error(err);
    res.render('error', { message: 'Failed to load student achievements.' });
  }
};

/* ═══════════════════════════════════════════════════════════════
   GET /admin/student-achievements/scan?barcode=XXX
   JSON endpoint — called via AJAX when a barcode is scanned.
════════════════════════════════════════════════════════════════ */
exports.lookupByBarcode = async (req, res) => {
  try {
    const { barcode } = req.query;
    if (!barcode) return res.status(400).json({ ok: false, error: 'No barcode provided.' });

    const student = await Student.findOne({ barcode: barcode.trim() }).lean();
    if (!student) return res.status(404).json({ ok: false, error: 'Student not found for that barcode.' });

    const [acTotal, acHistory] = await Promise.all([
      getStudentAcTotal(student),
      getStudentAcHistory(student),
    ]);

    // Fetch group names
    // Bug #11 fix: fall back to string-name match when student_ids not yet populated
    const groups = await Group.find({
      $or: [
        { student_ids: student._id },
        { students: { $in: [student.raw_name, student.full_name].filter(Boolean) } },
      ],
    }).select('group_name type level').lean();

    return res.json({
      ok: true,
      student: {
        _id:          String(student._id),
        student_code: student.student_code,
        barcode:      student.barcode,
        full_name:    student.full_name,
        raw_name:     student.raw_name,
        grade_school: student.grade_school,
        status:       student.status,
        groups:       groups.map(g => ({
          groupId:   String(g._id),
          groupName: g.group_name,
          type:      g.type,
          level:     g.level || '',
        })),
        acTotal,
        acHistory: acHistory.map(h => ({
          _id:        h._id ? String(h._id) : undefined,
          date:       h.date,
          class_name: h.class_name,
          subject:    h.subject,
          count:      h.count,
          type:       h.type,
          source:     h.source,
          teacher:    h.teacher,
          note:       h.note || '',
        })),
      },
    });
  } catch (err) {
    console.error('lookupByBarcode error:', err);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
};

/* ═══════════════════════════════════════════════════════════════
   GET /admin/student-achievements/student/:id
   JSON endpoint — called via AJAX when "View Card" is clicked.
════════════════════════════════════════════════════════════════ */
exports.studentProfile = async (req, res) => {
  try {
    const student = await Student.findById(req.params.id).lean();
    if (!student) return res.status(404).json({ ok: false, error: 'Student not found.' });

    const [acTotal, acHistory] = await Promise.all([
      getStudentAcTotal(student),
      getStudentAcHistory(student),
    ]);

    // Bug #11 fix: fall back to string-name match when student_ids not yet populated
    const groups = await Group.find({
      $or: [
        { student_ids: student._id },
        { students: { $in: [student.raw_name, student.full_name].filter(Boolean) } },
      ],
    }).select('group_name type level').lean();

    return res.json({
      ok: true,
      student: {
        _id:          String(student._id),
        student_code: student.student_code,
        barcode:      student.barcode,
        full_name:    student.full_name,
        raw_name:     student.raw_name,
        grade_school: student.grade_school,
        status:       student.status,
        groups:       groups.map(g => ({
          groupId:   String(g._id),
          groupName: g.group_name,
          type:      g.type,
          level:     g.level || '',
        })),
        acTotal,
        acHistory: acHistory.map(h => ({
          _id:        h._id ? String(h._id) : undefined,
          date:       h.date,
          class_name: h.class_name,
          subject:    h.subject,
          count:      h.count,
          type:       h.type,
          source:     h.source,
          teacher:    h.teacher,
          note:       h.note || '',
        })),
      },
    });
  } catch (err) {
    console.error('studentProfile error:', err);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
};

/* ═══════════════════════════════════════════════════════════════
   POST /admin/student-achievements/migrate
   One-click migration triggered by Admin UI
════════════════════════════════════════════════════════════════ */
exports.migrateStudents = async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      console.log('Mongoose not ready (state=' + mongoose.connection.readyState + '). Connecting...');
      await mongoose.connect(process.env.MONGO_URI, {
        serverSelectionTimeoutMS: 8000,
      });
    }
    const result = await migrateExistingStudents();
    return res.json({
      ok: true,
      message: `Migration completed! Created ${result.created} new students, linked ${result.groupsUpdated} classes.`,
      ...result,
    });
  } catch (err) {
    console.error('migrateStudents error:', err);
    let errMsg = err.message || 'Migration failed.';
    if (err.name === 'MongooseServerSelectionError' || errMsg.includes('Server selection timed out')) {
      errMsg = 'Database connection timed out. In MongoDB Atlas, go to "Network Access" and ensure "0.0.0.0/0" (Allow Access from Anywhere) is active.';
    }
    return res.status(500).json({ ok: false, error: errMsg });
  }
};
