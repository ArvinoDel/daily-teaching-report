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

// POST /reports/api/analyze-sheet
// Body: { imageBase64: "<data:image/...;base64,...>", year: 2026, month: 7 }
// Returns: { ok: true, rows: [{dateKey, F, P, H, A}, ...] }
exports.analyzeSheet = async (req, res) => {
  try {
    const { imageBase64, year, month } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'No image provided.' });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured on server.' });

    // Strip data URL prefix if present → get pure base64 + mime
    const matches = imageBase64.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: 'Invalid image format. Must be a data URL.' });
    const [, mimeType, b64data] = matches;

    const prompt = `You are analyzing a teaching reward sheet / attendance summary table image.

The table has these columns (in order from left to right):
- DATE  (format like "Thu, 16 Jul" or "Thu 16 Jul" or "16-Jul")
- F     (Full / Prime Teacher Full session count — integer)
- P     (Prime Assisted session count — integer)
- H     (Half / ½ Prime session count — integer)
- A     (Assistant session count — integer)

The expected year is ${year || new Date().getFullYear()}, month is ${month || new Date().getMonth() + 1}.

Instructions:
1. Find every data row that contains a date.
2. For each row, read the F, P, H, A values (these are small integers, usually 0–10).
3. If a cell is blank, dashed, or empty → use 0.
4. Return ONLY a valid JSON array. No explanation, no markdown fences, no extra text.

Output format:
[
  { "dateKey": "YYYY-MM-DD", "F": 0, "P": 0, "H": 0, "A": 0 },
  ...
]`;

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    const geminiRes = await fetch(geminiUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: b64data } },
          ],
        }],
        generationConfig: {
          temperature:     0,
          maxOutputTokens: 2048,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('Gemini API error:', geminiRes.status, errText);
      return res.status(502).json({ error: `Gemini API error ${geminiRes.status}: ${errText.slice(0, 200)}` });
    }

    const geminiData = await geminiRes.json();
    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Parse the JSON array from Gemini's response
    let rows;
    try {
      // Strip any accidental markdown fences
      const cleaned = rawText.replace(/```json?/gi, '').replace(/```/g, '').trim();
      rows = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('Failed to parse Gemini response:', rawText);
      return res.status(502).json({ error: 'Could not parse Gemini response as JSON.', raw: rawText.slice(0, 500) });
    }

    if (!Array.isArray(rows)) {
      return res.status(502).json({ error: 'Gemini returned unexpected format.', raw: rawText.slice(0, 500) });
    }

    // Sanitize rows: ensure F/P/H/A are integers >= 0
    const sanitized = rows.map(r => ({
      dateKey: String(r.dateKey || ''),
      F: Math.max(0, parseInt(r.F) || 0),
      P: Math.max(0, parseInt(r.P) || 0),
      H: Math.max(0, parseInt(r.H) || 0),
      A: Math.max(0, parseInt(r.A) || 0),
    })).filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.dateKey));

    return res.json({ ok: true, rows: sanitized });
  } catch (err) {
    console.error('analyzeSheet error:', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

