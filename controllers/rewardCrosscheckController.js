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

// GET /reports/api/reports-by-dates?dates=2026-07-16,2026-07-17,...
// Returns DB counts only for the exact dates requested
exports.getReportsByDates = async (req, res) => {
  try {
    const { dates } = req.query;
    if (!dates) return res.status(400).json({ error: 'No dates provided.' });

    const dateKeys = dates.split(',').map(d => d.trim()).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    if (dateKeys.length === 0) return res.status(400).json({ error: 'No valid dates provided.' });

    // Build date ranges for each unique date
    const dateConditions = dateKeys.map(dk => {
      const [y, m, d] = dk.split('-').map(Number);
      return { $gte: new Date(y, m - 1, d), $lte: new Date(y, m - 1, d, 23, 59, 59, 999) };
    });

    const reports = await Report.find({
      teacher: req.session.user._id,
      $or: dateConditions.map(cond => ({ date: cond })),
    }).sort({ date: 1 });

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

    // Include all requested dates (even ones with no DB records → 0 counts)
    const days = dateKeys.map(dk => dailyMap[dk] || {
      dateKey: dk,
      counts: { F: 0, P: 0, H: 0, A: 0 },
      sessions: [],
    });

    return res.json({ ok: true, days });
  } catch (err) {
    console.error('getReportsByDates error:', err);
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

    const modelsToTry = [
      'gemini-flash-latest',
      'gemini-3.6-flash',
      'gemini-3.7-flash',
      'gemini-2.5-flash',
    ];

    let lastError = '';
    let rawText = '';

    for (const model of modelsToTry) {
      try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
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
              maxOutputTokens: 8192,
              responseMimeType: 'application/json',
              responseSchema: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    dateKey: { type: 'STRING', description: 'Date in YYYY-MM-DD format' },
                    F: { type: 'INTEGER', description: 'Full/Prime sessions count' },
                    P: { type: 'INTEGER', description: 'Prime Assisted sessions count' },
                    H: { type: 'INTEGER', description: 'Half Prime sessions count' },
                    A: { type: 'INTEGER', description: 'Assistant sessions count' },
                  },
                  required: ['dateKey', 'F', 'P', 'H', 'A'],
                },
              },
            },
          }),
        });

        if (!geminiRes.ok) {
          const errText = await geminiRes.text();
          lastError = `Model ${model} returned ${geminiRes.status}: ${errText.slice(0, 150)}`;
          console.warn(lastError);
          continue; // Try next model in list
        }

        const geminiData = await geminiRes.json();
        rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (rawText) break; // Succeeded!
      } catch (reqErr) {
        lastError = `Model ${model} request failed: ${reqErr.message}`;
        console.warn(lastError);
      }
    }

    if (!rawText) {
      console.error('All Gemini models failed. Last error:', lastError);
      return res.status(502).json({ error: 'AI analysis failed. ' + lastError });
    }

    // Parse the JSON array from Gemini's response (with fallback recovery)
    let rows = [];
    try {
      const cleaned = rawText.replace(/```json?/gi, '').replace(/```/g, '').trim();
      rows = JSON.parse(cleaned);
    } catch (parseErr) {
      console.warn('Direct JSON.parse failed, attempting regex recovery...', parseErr.message);
      // Fallback: extract individual JSON objects from rawText
      const objMatches = rawText.match(/\{[^{}]*"dateKey"[^{}]*\}/g);
      if (objMatches && objMatches.length > 0) {
        for (const objStr of objMatches) {
          try {
            const parsedObj = JSON.parse(objStr);
            if (parsedObj && parsedObj.dateKey) rows.push(parsedObj);
          } catch (e) {
            // Ignore single corrupt chunk
          }
        }
      }
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      console.error('Failed to parse Gemini response:', rawText.slice(0, 500));
      return res.status(502).json({ error: 'Could not parse AI response as JSON.', raw: rawText.slice(0, 300) });
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

