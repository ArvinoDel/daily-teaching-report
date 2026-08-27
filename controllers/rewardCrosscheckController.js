const Report = require('../models/Report');
const User   = require('../models/User');

const TEACHING_TYPES = [
  'Prime Teacher (Full)',
  'Prime Teacher (Assisted)',
  '1/2 Prime Teacher',
  'Assistant Teacher',
];

// Map DB teaching_type -> supervisor column letter
const TYPE_TO_LETTER = {
  'Prime Teacher (Full)':     'F',
  'Prime Teacher (Assisted)': 'P',
  '1/2 Prime Teacher':        'H',
  'Assistant Teacher':        'A',
};

function formatIDR(n) {
  if (!n) return 'Rp\u00a00';
  return 'Rp\u00a0' + Number(n).toLocaleString('en-US');
}

// GET /reports/reward-crosscheck
exports.renderPage = async (req, res) => {
  try {
    const user = await User.findById(req.session.user._id).select('commission displayName');
    const comm = user?.commission || {};
    const commMap = {
      F: comm.primeFull     || 0,
      P: comm.primeAssisted || 0,
      H: comm.halfPrime     || 0,
      A: comm.assistant     || 0,
    };
    const hasCommission = Object.values(commMap).some(v => v > 0);

    // Default to current month
    const now = new Date();
    let selectedYear  = now.getFullYear();
    let selectedMonth = now.getMonth() + 1; // 1-based

    if (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) {
      const [y, m] = req.query.month.split('-').map(Number);
      selectedYear  = y;
      selectedMonth = m;
    }

    const monthLabel = new Date(selectedYear, selectedMonth - 1, 1)
      .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    const rcConfig = {
      commMap,
      hasCommission,
      selectedYear,
      selectedMonth,
    };

    res.render('reports/reward-crosscheck', {
      title: 'Reward Crosscheck',
      commMap,
      hasCommission,
      rcConfigJson: JSON.stringify(rcConfig),
      selectedYear,
      selectedMonth,
      monthLabel,
      displayName: user?.displayName || '',
    });
  } catch (err) {
    console.error('rewardCrosscheck renderPage error:', err);
    res.render('error', { message: 'Failed to load Reward Crosscheck page.' });
  }
};

// GET /reports/api/daily-summary?month=YYYY-MM
// Returns aggregated daily counts (F,P,H,A) + full session details for each day
exports.getMonthReportsApi = async (req, res) => {
  try {
    const { month } = req.query;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'Invalid month format. Use YYYY-MM.' });
    }
    const [year, mon] = month.split('-').map(Number);
    const monthStart  = new Date(year, mon - 1, 1);
    const monthEnd    = new Date(year, mon, 0, 23, 59, 59, 999);

    const reports = await Report.find({
      teacher: req.session.user._id,
      date:    { $gte: monthStart, $lte: monthEnd },
    }).sort({ date: 1 });

    // Aggregate into daily map keyed by YYYY-MM-DD
    const dailyMap = {};
    for (const r of reports) {
      const key = r.date.toISOString().substring(0, 10);
      if (!dailyMap[key]) {
        dailyMap[key] = {
          dateKey: key,
          counts:  { F: 0, P: 0, H: 0, A: 0 },
          sessions: [],
        };
      }
      const letter = TYPE_TO_LETTER[r.teaching_type];
      if (letter) dailyMap[key].counts[letter]++;
      dailyMap[key].sessions.push({
        _id:           String(r._id),
        class_name:    r.class_name,
        subject:       r.subject,
        teaching_type: r.teaching_type,
        letter:        letter || '?',
        duration:      r.durationFormatted,
        session_type:  r.session_type,
        session_mode:  r.session_mode,
      });
    }

    const days = Object.values(dailyMap).sort((a, b) => a.dateKey.localeCompare(b.dateKey));
    return res.json({ ok: true, days });
  } catch (err) {
    console.error('getMonthReportsApi error:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
};
