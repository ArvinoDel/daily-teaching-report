/**
 * reward-crosscheck.js
 * Client-side logic for Teaching Reward Crosscheck page.
 * Handles: image upload, clipboard paste, Tesseract OCR, table parsing,
 * API fetch for DB reports, side-by-side diff rendering, dispute export.
 */

/* ─── STATE ─────────────────────────────────────────── */
let currentImageFile  = null;   // File object from upload
let supervisorRows    = [];     // [{dateKey:'2026-07-16', dateLabel:'Thu, 16 Jul', F:2, P:0, H:0, A:3}, ...]
let dbDays            = [];     // [{dateKey, counts:{F,P,H,A}, sessions:[...]}, ...]
let dbLoaded          = false;

const MONTH_MAP = {
  jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
  jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
};

const LETTER_LABEL = { F:'Prime Full', P:'Prime Assisted', H:'½ Prime', A:'Assistant' };

/* ─── INIT ───────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  // Read embedded server configuration
  try {
    const cfgEl = document.getElementById('rc-config-json');
    if (cfgEl && cfgEl.textContent) {
      window.RC = JSON.parse(cfgEl.textContent);
    }
  } catch (e) {
    console.error('Failed to parse RC config JSON:', e);
  }
  window.RC = window.RC || { commMap: {}, selectedYear: new Date().getFullYear(), selectedMonth: new Date().getMonth() + 1, hasCommission: false };

  // Auto-load DB reports on page load
  loadDbReports();

  // Period load button
  document.getElementById('btn-load-period').addEventListener('click', loadDbReports);

  // OCR button
  document.getElementById('btn-run-ocr').addEventListener('click', runOcr);

  // Clipboard paste anywhere on page
  document.addEventListener('paste', handlePaste);

  // Show supervisor table section with empty table so user can add manually
  showSupervisorSection();
});

/* ─── PERIOD / DB LOAD ───────────────────────────────── */
async function loadDbReports() {
  const year  = document.getElementById('sel-year').value;
  const month = String(document.getElementById('sel-month').value).padStart(2, '0');
  const period = `${year}-${month}`;

  const statusWrap = document.getElementById('period-status');
  const statusText = document.getElementById('period-status-text');
  statusWrap.classList.remove('hidden');
  statusText.textContent = '⏳ Loading your reports…';

  try {
    const res  = await fetch(`/reports/api/daily-summary?month=${period}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'API error');

    dbDays   = data.days;
    dbLoaded = true;

    // Update RC globals
    window.RC.selectedYear  = parseInt(year);
    window.RC.selectedMonth = parseInt(month);

    const total = dbDays.reduce((s, d) => s + d.counts.F + d.counts.P + d.counts.H + d.counts.A, 0);
    statusText.textContent = `✅ Loaded ${dbDays.length} day(s) · ${total} session(s) for ${period}`;
    statusText.className   = 'text-emerald-600 font-semibold text-xs';

    // Re-run crosscheck if supervisor data already present
    if (supervisorRows.length > 0) runCrosscheck();

  } catch (err) {
    statusText.textContent = `❌ Failed: ${err.message}`;
    statusText.className   = 'text-red-500 font-semibold text-xs';
  }
}

/* ─── IMAGE HANDLING ─────────────────────────────────── */
function handleFileSelect(e) {
  const file = e.target.files[0];
  if (file) loadImage(file);
}

function handleDrop(e) {
  e.preventDefault();
  document.getElementById('dropzone').classList.remove('border-brand-400', 'bg-brand-50/40');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) loadImage(file);
}

function handlePaste(e) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) { loadImage(file); break; }
    }
  }
}

function loadImage(file) {
  currentImageFile = file;
  const url = URL.createObjectURL(file);
  document.getElementById('img-preview').src = url;
  document.getElementById('img-modal-img').src = url;
  document.getElementById('img-name').textContent = file.name || 'Pasted image';
  document.getElementById('img-size').textContent = `${(file.size / 1024).toFixed(1)} KB`;
  document.getElementById('img-preview-wrap').classList.remove('hidden');
  document.getElementById('dropzone').classList.add('hidden');
}

function resetImage() {
  currentImageFile = null;
  document.getElementById('img-preview').src = '';
  document.getElementById('img-preview-wrap').classList.add('hidden');
  document.getElementById('dropzone').classList.remove('hidden');
  document.getElementById('ocr-progress-wrap').classList.add('hidden');
  document.getElementById('img-upload').value = '';
}

function openImgModal() {
  const m = document.getElementById('img-modal');
  m.classList.remove('hidden');
  m.classList.add('flex');
}
function closeImgModal() {
  const m = document.getElementById('img-modal');
  m.classList.add('hidden');
  m.classList.remove('flex');
}

/* ─── OCR ────────────────────────────────────────────── */
async function runOcr() {
  if (!currentImageFile) return;

  const progressWrap = document.getElementById('ocr-progress-wrap');
  const progressBar  = document.getElementById('ocr-progress-bar');
  const statusText   = document.getElementById('ocr-status-text');
  progressWrap.classList.remove('hidden');

  try {
    const { createWorker } = Tesseract;
    const worker = await createWorker('eng', 1, {
      workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
      corePath:   'https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core.wasm.js',
      langPath:   'https://tessdata.projectnaptha.com/4.0.0',
      logger: m => {
        if (m.status === 'recognizing text') {
          const pct = Math.round((m.progress || 0) * 100);
          progressBar.style.width = pct + '%';
          statusText.textContent  = `Recognizing text… ${pct}%`;
        } else if (m.status) {
          statusText.textContent = m.status;
        }
      },
    });

    statusText.textContent = 'Running OCR…';
    const result = await worker.recognize(currentImageFile);
    await worker.terminate();

    progressBar.style.width = '100%';
    progressBar.classList.replace('bg-brand-500', 'bg-emerald-500');

    // Debug: log raw OCR text to console so we can see what Tesseract reads
    console.group('OCR Raw Output');
    console.log('Full text:\n', result.data.text);
    console.log('Total words found:', (result.data.words || []).length);
    console.groupEnd();

    statusText.textContent = '✅ OCR complete! Parsing table…';

    const parsed = parseTableFromOcr(result.data);

    if (parsed.length === 0) {
      statusText.textContent = '⚠️ Could not detect table rows. Please enter data manually.';
    } else {
      statusText.textContent = `✅ Extracted ${parsed.length} row(s). Verify & correct below.`;
      supervisorRows = parsed;
      renderSupervisorTable();
    }
    showSupervisorSection();

  } catch (err) {
    console.error('OCR error:', err);
    const errMsg = (err && err.message) ? err.message : 'Worker failed — check browser console.';
    statusText.textContent = '❌ OCR failed: ' + errMsg;
  }
}

/* ─── MAIN TABLE PARSER ─────────────────────────────────────
 *
 * Strategy:
 *  1. Group ALL OCR words into visual rows by Y-center proximity.
 *  2. Identify which rows contain a date (weekday + day number + month name).
 *  3. From those rows, collect all pure-digit words that appear to the
 *     RIGHT of the date text, sorted left-to-right by X.
 *  4. Determine 4 column X-zones (F, P, H, A) from the X spread of all
 *     such numbers across ALL date rows.
 *  5. Map each number to its column by closest X-zone center.
 *
 * Falls back to line-by-line text regex if word bbox data is absent.
 * ─────────────────────────────────────────────────────────── */
function parseTableFromOcr(ocrData) {
  const words = ocrData && ocrData.words;

  // ── Spatial path: word bboxes available
  if (words && words.length > 0) {
    const result = parseSpatial(words);
    if (result.length > 0) return result;
  }

  // ── Text fallback: plain line-by-line regex
  return parseTextFallback(ocrData && ocrData.text || '');
}

/* ── Spatial parser ────────────────────────────────────── */
function parseSpatial(allWords) {
  const DAY_PAT   = /^(mon|tue|wed|thu|fri|sat|sun),?$/i;
  const MONTH_PAT = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\.?$/i;
  const year      = window.RC.selectedYear || new Date().getFullYear();

  // ── 1. Group words into visual rows by Y-center (±25px)
  const ROW_SNAP = 25; // px tolerance for "same row"
  const rows = [];

  for (const w of allWords) {
    if (!w.bbox || !(w.text || '').trim()) continue;
    const cy = (w.bbox.y0 + w.bbox.y1) / 2;
    let row = rows.find(r => Math.abs(r.cy - cy) < ROW_SNAP);
    if (!row) {
      row = { cy, yMin: w.bbox.y0, yMax: w.bbox.y1, words: [] };
      rows.push(row);
    }
    row.yMin = Math.min(row.yMin, w.bbox.y0);
    row.yMax = Math.max(row.yMax, w.bbox.y1);
    row.words.push(w);
  }

  // Sort rows top-to-bottom; words left-to-right within each row
  rows.sort((a, b) => a.cy - b.cy);
  rows.forEach(r => r.words.sort((a, b) => a.bbox.x0 - b.bbox.x0));

  // ── 2. Identify date rows
  const dateRows = [];
  for (const row of rows) {
    const texts = row.words.map(w => (w.text || '').trim());

    // Must have weekday abbreviation
    const hasDOW = texts.some(t => DAY_PAT.test(t));
    if (!hasDOW) continue;

    // Must have month name
    const monthWord = row.words.find(w => MONTH_PAT.test((w.text || '').trim()));
    if (!monthWord) continue;
    const month = MONTH_MAP[monthWord.text.trim().toLowerCase().slice(0, 3)];
    if (!month) continue;

    // Must have a 1–2 digit number (the day)
    const dayWord = row.words.find(w => /^\d{1,2}$/.test((w.text || '').trim()));
    if (!dayWord) continue;
    const day = parseInt(dayWord.text.trim());
    if (day < 1 || day > 31) continue;

    // Rightmost X of words that are date-text (weekday/day/month)
    const dateWordSet = row.words.filter(w => {
      const t = (w.text || '').trim();
      return DAY_PAT.test(t) || MONTH_PAT.test(t) ||
             t === String(day) || /^[A-Za-z]+,?$/.test(t);
    });
    const dateEndX = Math.max(...dateWordSet.map(w => w.bbox.x1), 0);

    // Collect digit-only words that are to the RIGHT of the date area
    const numWords = row.words.filter(w => {
      if (w.bbox.x0 <= dateEndX) return false;
      const t = (w.text || '').replace(/[^\d]/g, '');
      if (!t) return false;
      const v = parseInt(t);
      return !isNaN(v) && v >= 0 && v < 100;
    });

    const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    dateRows.push({
      dateKey,
      dateLabel: formatDateLabel(new Date(dateKey)),
      dateEndX,
      rowCy: row.cy,
      numWords,
    });
  }

  if (dateRows.length === 0) return [];

  // ── 3. Determine F/P/H/A column X-zones from ALL numbers across ALL date rows
  const allNumWords = dateRows.flatMap(r => r.numWords);

  if (allNumWords.length === 0) {
    // Dates found but ZERO numbers visible — return dates with 0s so user
    // can fill in manually rather than silently returning nothing
    const seen = new Set();
    return dateRows
      .filter(r => !seen.has(r.dateKey) && seen.add(r.dateKey))
      .map(r => ({ dateKey: r.dateKey, dateLabel: r.dateLabel, F: 0, P: 0, H: 0, A: 0 }));
  }

  // X-centers of all discovered numbers
  const xcs = allNumWords.map(w => (w.bbox.x0 + w.bbox.x1) / 2).sort((a, b) => a - b);
  const xMin = xcs[0];
  const xMax = xcs[xcs.length - 1];

  // 4 equal-width column zones spanning F→A
  const span     = Math.max(xMax - xMin, 60); // at least 60px total span
  const zoneW    = span / 3; // 3 gaps for 4 cols: F, P, H, A
  const colCenters = [
    xMin,
    xMin + zoneW,
    xMin + zoneW * 2,
    xMax,
  ];

  function assignCol(xc) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < 4; i++) {
      const d = Math.abs(xc - colCenters[i]);
      if (d < bestD) { bestD = d; best = i; }
    }
    return ['F', 'P', 'H', 'A'][best];
  }

  // ── 4. Build final table
  const seen = new Set();
  return dateRows
    .filter(r => !seen.has(r.dateKey) && seen.add(r.dateKey))
    .map(r => {
      const counts = { F: 0, P: 0, H: 0, A: 0 };
      for (const w of r.numWords) {
        const xc  = (w.bbox.x0 + w.bbox.x1) / 2;
        const col = assignCol(xc);
        const val = parseInt((w.text || '').replace(/[^\d]/g, ''));
        if (!isNaN(val)) counts[col] = val;
      }
      return { dateKey: r.dateKey, dateLabel: r.dateLabel, ...counts };
    })
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}

/* ── Text fallback parser ──────────────────────────────── */
function parseTextFallback(rawText) {
  const DAY_PAT = /\b(mon|tue|wed|thu|fri|sat|sun)\b/i;
  const MON_PAT = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i;
  const NUM_PAT = /\d+/g;
  const year    = window.RC.selectedYear || new Date().getFullYear();

  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
  const seen  = new Set();
  const rows  = [];

  for (const line of lines) {
    if (!DAY_PAT.test(line)) continue;
    const monMatch = line.match(MON_PAT);
    if (!monMatch) continue;
    const dayMatch = line.match(/\b(\d{1,2})\b/);
    if (!dayMatch) continue;

    const day   = parseInt(dayMatch[1]);
    const month = MONTH_MAP[monMatch[1].toLowerCase()];
    if (!month || day < 1 || day > 31) continue;

    const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (seen.has(dateKey)) continue;
    seen.add(dateKey);

    // Strip weekday, month, and day digit; remaining numbers are F P H A in order
    const cleaned = line
      .replace(DAY_PAT, '')
      .replace(MON_PAT, '')
      .replace(new RegExp(`\\b${day}\\b`), '');
    const nums = [...cleaned.matchAll(NUM_PAT)].map(m => parseInt(m[0])).filter(n => n < 100);

    rows.push({
      dateKey,
      dateLabel: formatDateLabel(new Date(dateKey)),
      F: nums[0] || 0,
      P: nums[1] || 0,
      H: nums[2] || 0,
      A: nums[3] || 0,
    });
  }

  return rows.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}

/* ─── SUPERVISOR TABLE UI ────────────────────────────── */
function showSupervisorSection() {
  document.getElementById('supervisor-table-section').classList.remove('hidden');
}

function renderSupervisorTable() {
  const tbody = document.getElementById('supervisor-tbody');
  tbody.innerHTML = '';
  supervisorRows.forEach((row, i) => tbody.appendChild(buildSupervisorRow(row, i)));
}

function buildSupervisorRow(row, idx) {
  const tr = document.createElement('tr');
  tr.className = 'hover:bg-slate-50 transition';
  tr.dataset.idx = idx;

  const mkCell = (key, val, isDate = false) => {
    const td = document.createElement('td');
    td.className = isDate
      ? 'px-4 py-2.5 text-xs font-mono font-semibold text-slate-700 whitespace-nowrap'
      : 'px-4 py-2.5 text-center';

    if (isDate) {
      td.textContent = row.dateLabel;
    } else {
      const input = document.createElement('input');
      input.type      = 'number';
      input.min       = 0;
      input.max       = 99;
      input.value     = val;
      input.className = 'w-14 text-center text-sm font-bold text-slate-700 border border-transparent rounded-lg px-1 py-0.5 focus:outline-none focus:border-brand-300 focus:bg-brand-50 hover:border-slate-200 transition';
      input.addEventListener('input', () => {
        supervisorRows[idx][key] = parseInt(input.value) || 0;
        // Live recalculate if crosscheck already ran
        if (document.getElementById('results-section').classList.contains('hidden') === false) {
          runCrosscheck(true);
        }
      });
      td.appendChild(input);
    }
    return td;
  };

  const delTd = document.createElement('td');
  delTd.className = 'px-2 py-2.5 text-center';
  const delBtn = document.createElement('button');
  delBtn.innerHTML = '✕';
  delBtn.className = 'text-slate-300 hover:text-red-400 font-bold text-xs transition';
  delBtn.onclick   = () => { supervisorRows.splice(idx, 1); renderSupervisorTable(); };
  delTd.appendChild(delBtn);

  tr.appendChild(mkCell('date',  '', true));
  tr.appendChild(mkCell('F', row.F));
  tr.appendChild(mkCell('P', row.P));
  tr.appendChild(mkCell('H', row.H));
  tr.appendChild(mkCell('A', row.A));
  tr.appendChild(delTd);
  return tr;
}

function addSupervisorRow() {
  const year  = window.RC.selectedYear  || new Date().getFullYear();
  const month = window.RC.selectedMonth || (new Date().getMonth() + 1);
  const nextDay = supervisorRows.length
    ? (() => { const last = new Date(supervisorRows[supervisorRows.length-1].dateKey); last.setDate(last.getDate()+1); return last; })()
    : new Date(year, month-1, 1);

  const dateKey   = nextDay.toISOString().substring(0,10);
  const dateLabel = formatDateLabel(nextDay);
  supervisorRows.push({ dateKey, dateLabel, F:0, P:0, H:0, A:0 });
  renderSupervisorTable();
  showSupervisorSection();
}

/* ─── CROSSCHECK ENGINE ──────────────────────────────── */
function runCrosscheck(silent = false) {
  if (supervisorRows.length === 0) {
    if (!silent) alert('No supervisor data. Add rows or run OCR first.');
    return;
  }
  if (!dbLoaded) {
    if (!silent) alert('Please load your database reports first (Step 1).');
    return;
  }

  // Build a map from dateKey -> dbDay
  const dbMap = {};
  dbDays.forEach(d => { dbMap[d.dateKey] = d; });

  // Build a map from dateKey -> supervisorRow
  const supMap = {};
  supervisorRows.forEach(r => { supMap[r.dateKey] = r; });

  // Union of all dateKeys
  const allKeys = [...new Set([...Object.keys(supMap), ...Object.keys(dbMap)])].sort();

  let totalDays    = allKeys.length;
  let matchedDays  = 0;
  let mismatchDays = 0;
  const netDiff    = { F:0, P:0, H:0, A:0 };
  let idrDiff      = 0;
  const compRows   = [];

  for (const key of allKeys) {
    const sup = supMap[key] || { F:0, P:0, H:0, A:0 };
    const db  = dbMap[key]  ? dbMap[key].counts : { F:0, P:0, H:0, A:0 };
    const sessions = dbMap[key] ? dbMap[key].sessions : [];

    const diffF = sup.F - db.F;
    const diffP = sup.P - db.P;
    const diffH = sup.H - db.H;
    const diffA = sup.A - db.A;
    const isMatch = (diffF === 0 && diffP === 0 && diffH === 0 && diffA === 0);

    netDiff.F += diffF; netDiff.P += diffP; netDiff.H += diffH; netDiff.A += diffA;

    // IDR calculations
    const comm   = window.RC.commMap || {};
    const supIDR = sup.F*(comm.F||0) + sup.P*(comm.P||0) + sup.H*(comm.H||0) + sup.A*(comm.A||0);
    const dbIDR  = db.F*(comm.F||0)  + db.P*(comm.P||0)  + db.H*(comm.H||0)  + db.A*(comm.A||0);
    idrDiff += (supIDR - dbIDR);

    if (isMatch) matchedDays++; else mismatchDays++;

    compRows.push({ key, sup, db, diffF, diffP, diffH, diffA, isMatch, sessions, supIDR, dbIDR });
  }

  // ── Render KPI Cards
  document.getElementById('kpi-total').textContent    = totalDays;
  document.getElementById('kpi-match').textContent    = matchedDays;
  document.getElementById('kpi-mismatch').textContent = mismatchDays;
  document.getElementById('kpi-idr').textContent      = window.RC.hasCommission
    ? (idrDiff >= 0 ? '+' : '') + formatIDR(idrDiff)
    : 'N/A';
  document.getElementById('kpi-idr').className = `text-lg font-bold ${idrDiff < 0 ? 'text-red-500' : idrDiff > 0 ? 'text-emerald-600' : 'text-slate-700'}`;

  // ── Net Diff badges
  ['F','P','H','A'].forEach(l => {
    const el   = document.getElementById(`net-diff-${l}`);
    const v    = netDiff[l];
    el.textContent = (v > 0 ? '+' : '') + v;
    el.className   = `text-xl font-bold ${v < 0 ? 'text-red-500' : v > 0 ? 'text-amber-500' : 'text-emerald-600'}`;
  });

  // ── Comparison Table
  renderComparisonTable(compRows);

  // Show results + dispute button if mismatches
  document.getElementById('results-section').classList.remove('hidden');
  const dispBtn = document.getElementById('btn-dispute');
  if (mismatchDays > 0) { dispBtn.classList.remove('hidden'); dispBtn.classList.add('inline-flex'); }
  else dispBtn.classList.add('hidden');

  // Store for dispute generator
  window.RC._compRows = compRows;

  // Scroll to results
  if (!silent) {
    setTimeout(() => document.getElementById('results-section').scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
  }
}

/* ─── COMPARISON TABLE RENDERER ─────────────────────── */
function renderComparisonTable(compRows) {
  const tbody = document.getElementById('comparison-tbody');
  tbody.innerHTML = '';

  compRows.forEach(row => {
    const tr = document.createElement('tr');
    const bg = row.isMatch ? 'hover:bg-slate-50' : 'bg-red-50/40 hover:bg-red-50';
    tr.className = `${bg} transition cursor-pointer`;
    tr.onclick   = () => openDrilldown(row);

    const dateLabel = formatDateLabel(new Date(row.key));

    const mkDiffBadge = (diff) => {
      if (diff === 0)   return `<span class="text-slate-300 text-xs">—</span>`;
      const sign  = diff > 0 ? '+' : '';
      const color = diff > 0 ? 'amber' : 'red';
      return `<span class="inline-flex items-center justify-center text-xs font-bold text-${color}-600 bg-${color}-100 rounded-full px-2 py-0.5">${sign}${diff}</span>`;
    };

    const statusBadge = row.isMatch
      ? `<span class="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">✓ Match</span>`
      : `<span class="inline-flex items-center gap-1 text-xs font-bold text-red-700 bg-red-100 px-2 py-0.5 rounded-full">⚠ Diff</span>`;

    const idrDiff = row.supIDR - row.dbIDR;
    const idrBadge = window.RC.hasCommission
      ? `<span class="text-xs font-mono font-bold ${idrDiff < 0 ? 'text-red-500' : idrDiff > 0 ? 'text-amber-600' : 'text-slate-400'}">${idrDiff !== 0 ? (idrDiff > 0 ? '+' : '') + formatIDR(idrDiff) : '—'}</span>`
      : `<span class="text-xs text-slate-300">N/A</span>`;

    tr.innerHTML = `
      <td class="px-4 py-3 text-xs font-mono font-semibold text-slate-700 whitespace-nowrap">${dateLabel}</td>
      <td class="px-3 py-3 text-center" colspan="4">
        <span class="text-xs font-bold text-slate-600">${row.sup.F} / ${row.sup.P} / ${row.sup.H} / ${row.sup.A}</span>
      </td>
      <td class="px-3 py-3 text-center" colspan="4">
        <span class="text-xs font-bold text-slate-600">${row.db.F} / ${row.db.P} / ${row.db.H} / ${row.db.A}</span>
      </td>
      <td class="px-3 py-3 text-center">${statusBadge}</td>
      <td class="px-3 py-3 text-center hidden sm:table-cell">${idrBadge}</td>
    `;
    tbody.appendChild(tr);

    // If mismatch, add a subtle diff breakdown sub-row
    if (!row.isMatch) {
      const subTr = document.createElement('tr');
      subTr.className = 'bg-red-50/20';
      subTr.innerHTML = `
        <td class="px-4 pb-2 text-xs text-slate-400" colspan="11">
          Diff:&nbsp;
          F ${mkDiffBadge(row.diffF)}&nbsp;
          P ${mkDiffBadge(row.diffP)}&nbsp;
          H ${mkDiffBadge(row.diffH)}&nbsp;
          A ${mkDiffBadge(row.diffA)}
          &nbsp;·&nbsp;<span class="italic">${row.sessions.length} session(s) in DB</span>
        </td>`;
      tbody.appendChild(subTr);
    }
  });
}

/* ─── DRILLDOWN ──────────────────────────────────────── */
function openDrilldown(row) {
  const panel     = document.getElementById('drilldown-panel');
  const dateLabel = document.getElementById('drilldown-date-label');
  const content   = document.getElementById('drilldown-content');

  dateLabel.textContent = formatDateLabel(new Date(row.key));
  content.innerHTML = '';

  if (row.sessions.length === 0) {
    content.innerHTML = `<p class="text-xs text-slate-400 text-center py-4 italic">No sessions recorded in database for this date.</p>`;
  } else {
    row.sessions.forEach(s => {
      const colors = { F:'emerald', P:'purple', H:'amber', A:'sky' };
      const color  = colors[s.letter] || 'slate';
      const div    = document.createElement('div');
      div.className = `flex items-start gap-3 bg-slate-50 rounded-xl px-4 py-3`;
      div.innerHTML = `
        <span class="inline-flex items-center justify-center w-7 h-7 rounded-full bg-${color}-100 text-${color}-700 text-xs font-bold flex-shrink-0 mt-0.5">${s.letter}</span>
        <div class="min-w-0">
          <p class="text-sm font-bold text-slate-800 truncate">${escHtml(s.class_name)}</p>
          <p class="text-xs text-slate-500">${escHtml(LETTER_LABEL[s.letter] || s.teaching_type)} · ${escHtml(s.duration)} · ${escHtml(s.session_type)} · ${escHtml(s.session_mode)}</p>
          ${s.subject ? `<p class="text-xs text-slate-400 mt-0.5">Subject: ${escHtml(s.subject)}</p>` : ''}
        </div>
      `;
      content.appendChild(div);
    });
  }

  panel.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeDrilldown() {
  document.getElementById('drilldown-panel').classList.add('hidden');
}

/* ─── DISPUTE GENERATOR ──────────────────────────────── */
function generateDispute() {
  const rows = (window.RC._compRows || []).filter(r => !r.isMatch);
  if (rows.length === 0) return;

  const year  = window.RC.selectedYear;
  const month = window.RC.selectedMonth;
  const mName = new Date(year, month-1, 1).toLocaleString('en-US', { month: 'long', year:'numeric' });

  let msg = `📋 Teaching Reward Discrepancy Report\nPeriod: ${mName}\n`;
  msg += `${'─'.repeat(40)}\n`;

  rows.forEach(r => {
    const dl   = formatDateLabel(new Date(r.key));
    const diffs = [];
    if (r.diffF !== 0) diffs.push(`F: Supervisor=${r.sup.F} vs DB=${r.db.F} (diff ${r.diffF > 0 ? '+' : ''}${r.diffF})`);
    if (r.diffP !== 0) diffs.push(`P: Supervisor=${r.sup.P} vs DB=${r.db.P} (diff ${r.diffP > 0 ? '+' : ''}${r.diffP})`);
    if (r.diffH !== 0) diffs.push(`H: Supervisor=${r.sup.H} vs DB=${r.db.H} (diff ${r.diffH > 0 ? '+' : ''}${r.diffH})`);
    if (r.diffA !== 0) diffs.push(`A: Supervisor=${r.sup.A} vs DB=${r.db.A} (diff ${r.diffA > 0 ? '+' : ''}${r.diffA})`);

    msg += `\n📅 ${dl}\n`;
    diffs.forEach(d => msg += `   • ${d}\n`);

    if (r.sessions.length > 0) {
      msg += `   My recorded sessions:\n`;
      r.sessions.forEach(s => msg += `   – [${s.letter}] ${s.class_name}${s.subject ? ` (${s.subject})` : ''}\n`);
    }
  });

  msg += `${'─'.repeat(40)}\n`;
  if (window.RC.hasCommission) {
    const totalDiff = rows.reduce((s, r) => s + (r.supIDR - r.dbIDR), 0);
    msg += `💰 Total IDR Discrepancy: ${totalDiff >= 0 ? '+' : ''}${formatIDR(totalDiff)}\n`;
  }
  msg += `\nPlease review and confirm. Thank you.`;

  document.getElementById('dispute-text').value = msg;
  const m = document.getElementById('dispute-modal');
  m.classList.remove('hidden');
  m.classList.add('flex');
}

function closeDisputeModal() {
  const m = document.getElementById('dispute-modal');
  m.classList.add('hidden');
  m.classList.remove('flex');
}

async function copyDispute() {
  const text = document.getElementById('dispute-text').value;
  try {
    await navigator.clipboard.writeText(text);
    // Quick visual feedback
    const btn = document.querySelector('#dispute-modal button');
    const orig = btn.textContent;
    btn.textContent = '✅ Copied!';
    setTimeout(() => btn.textContent = orig, 2000);
  } catch {
    document.getElementById('dispute-text').select();
    document.execCommand('copy');
  }
}

/* ─── UTILITIES ──────────────────────────────────────── */
function formatDateLabel(date) {
  if (isNaN(date.getTime())) return 'Invalid Date';
  return date.toLocaleDateString('en-US', { weekday:'short', day:'2-digit', month:'short', year:'numeric' });
}

function formatIDR(n) {
  const abs = Math.abs(Math.round(n));
  const sign = n < 0 ? '-' : '';
  return sign + 'Rp\u00a0' + abs.toLocaleString('en-US');
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}
