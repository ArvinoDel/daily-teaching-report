const Report = require('../models/Report');
const Group  = require('../models/Group');

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
    const matchStage = {};
    if (group_id) {
      // Only include reports where the group's students appear in ac_students
      const targetGroup = allGroups.find(g => String(g._id) === group_id);
      if (targetGroup && targetGroup.students.length > 0) {
        matchStage.ac_students = { $in: targetGroup.students };
      }
    }

    // --- 3. Aggregate ac_students appearances across all reports ---
    const pipeline = [
      { $match: matchStage },
      { $unwind: '$ac_students' },
      {
        $group: {
          _id:          '$ac_students',
          count:        { $sum: 1 },
          lastSeen:     { $max: '$date' },
          uniqueDates:  { $addToSet: '$date' },
        },
      },
      {
        $project: {
          _id:         0,
          name:        '$_id',
          count:       1,
          lastSeen:    1,
          activeDays:  { $size: '$uniqueDates' },
        },
      },
    ];

    let students = await Report.aggregate(pipeline);

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

    const studentsWithTier = students.map(s => ({
      ...s,
      tier: s.count >= tierGold ? 'gold' : s.count >= tierSilver ? 'silver' : 'bronze',
      lastSeenFormatted: s.lastSeen
        ? new Date(s.lastSeen).toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' })
        : '—',
    }));

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
