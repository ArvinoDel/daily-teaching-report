/**
 * scripts/lib/parseRoster.js
 *
 * Parses the two roster CSVs (the printed "New Academic Year" group sheet
 * and the "Private" sheet) into plain objects shaped like the Group model:
 *   { group_name, type, level, students, _schedule_note }
 *
 * These CSVs are exports of a printed layout, not a normal data table —
 * see the comments on each parser for the block structure they expect.
 */

const fs = require('fs');
const { parse } = require('csv-parse/sync');

/* ── shared helpers ─────────────────────────────────────────────── */

const DAY_RE  = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tues|wed)\b/i;
const TIME_RE = /\d{1,2}[.:]\d{2}\s*(am|pm)\b/i;

function isBlank(v) {
  return !v || !v.trim();
}

function isPlaceholder(v) {
  const t = (v || '').trim();
  if (!t) return true;
  if (/^_+$/.test(t)) return true;
  if (t === '-') return true;
  return false;
}

function splitStudents(name) {
  return name.split(/\s*(?:&|\/| and )\s*/i).map(s => s.trim()).filter(Boolean);
}

function cellLooksSchedule(v) {
  return DAY_RE.test(v) || TIME_RE.test(v);
}

// A row "looks like a schedule row" if a majority of its non-blank cells
// contain a weekday name or a HH.MM/HH:MM am/pm time.
function rowLooksLikeSchedule(cells) {
  const nonBlank = cells.filter(c => c && c.trim());
  if (nonBlank.length === 0) return false;
  const hits = nonBlank.filter(cellLooksSchedule).length;
  return hits >= Math.max(1, Math.ceil(nonBlank.length / 2));
}

function readCsvRows(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  return parse(raw, { relax_column_count: true, skip_empty_lines: false });
}

function parseCsvString(csvString) {
  const raw = csvString.replace(/^\uFEFF/, '');
  return parse(raw, { relax_column_count: true, skip_empty_lines: false });
}

function getRow(rows, idx, width) {
  const r = rows[idx] || [];
  return Array.from({ length: width }, (_, j) => r[j] || '');
}

/* ── Groups CSV ──────────────────────────────────────────────────
 * Layout: pages of 4 columns. Each page starts with a
 * "NEW ACADEMIC YEAR ..." header row. Within a page, blocks repeat:
 *   up to 6 rows of student names (one column per group)
 *   1 schedule row (day & time, one per column)
 *   1 level row (e.g. A3, I2, one per column)
 * Blank rows and page-footer rows (page number / "CIREBON, <date>") are
 * skipped. A schedule row is detected, not counted, so block size is
 * inferred rather than fixed.
 * ────────────────────────────────────────────────────────────────*/
function parseGroupsCsvFromRows(rows) {
  const records = [];
  let buffer = [[], [], [], []];
  let awaitingLevel = false;
  let scheduleCache = null;

  for (const row of rows) {
    const cells = getRow([row], 0, 4);

    if ((cells[0] || '').includes('NEW ACADEMIC YEAR')) {
      buffer = [[], [], [], []];
      awaitingLevel = false;
      continue;
    }

    if (awaitingLevel) {
      for (let col = 0; col < 4; col++) {
        const level = (cells[col] || '').trim();
        const students = buffer[col].filter(s => !isPlaceholder(s));
        if (students.length && level) {
          records.push({
            type: 'GROUP',
            level,
            schedule: scheduleCache ? (scheduleCache[col] || '').trim() : '',
            students,
          });
        }
      }
      buffer = [[], [], [], []];
      awaitingLevel = false;
      scheduleCache = null;
      continue;
    }

    if (rowLooksLikeSchedule(cells)) {
      scheduleCache = cells;
      awaitingLevel = true;
      continue;
    }

    if (cells.every(isBlank)) continue; // footer / spacer row

    for (let col = 0; col < 4; col++) {
      const v = (cells[col] || '').trim();
      if (v) buffer[col].push(v);
    }
  }

  return records;
}

/* ── Private CSV ─────────────────────────────────────────────────
 * Layout: 6 columns. Blocks start with a row of all "PRIVATE" cells,
 * followed by either:
 *   5-line block: PRIVATE / names / grade / schedule / level
 *   4-line block: PRIVATE / names / schedule / level   (no grade row)
 * The two shapes are distinguished by probing the row right after the
 * name row: if it looks like a schedule, the grade row is absent.
 * ────────────────────────────────────────────────────────────────*/
function parsePrivateCsvFromRows(rows) {
  const records = [];
  let i = 0;

  while (i < rows.length) {
    const cells = getRow(rows, i, 6);

    if (cells.some(c => c.trim() === 'PRIVATE')) {
      const nameRow = getRow(rows, i + 1, 6);
      const probeRow = getRow(rows, i + 2, 6);

      let gradeRow, scheduleRow, levelRow, blockLen;
      if (rowLooksLikeSchedule(probeRow)) {
        gradeRow = Array(6).fill('');
        scheduleRow = probeRow;
        levelRow = getRow(rows, i + 3, 6);
        blockLen = 4;
      } else {
        gradeRow = probeRow;
        scheduleRow = getRow(rows, i + 3, 6);
        levelRow = getRow(rows, i + 4, 6);
        blockLen = 5;
      }

      for (let col = 0; col < 6; col++) {
        const rawName = (nameRow[col] || '').trim();
        if (isPlaceholder(rawName)) continue;

        const grade = (gradeRow[col] || '').trim();
        const level = (levelRow[col] || '').trim();
        const schedule = (scheduleRow[col] || '').trim();
        const students = splitStudents(rawName).map(nm => (grade ? `${nm} ${grade}` : nm));

        if (students.length) {
          records.push({ type: 'PRIVATE', level, schedule, students });
        }
      }

      i += blockLen;
      continue;
    }
    i += 1;
  }

  return records;
}

/* ── group_name generation ──────────────────────────────────────
 * Convention: "<first name of first student>'s Group - <level>"
 * Collisions get a " (2)", " (3)"... suffix.
 * ────────────────────────────────────────────────────────────────*/
function firstNameOf(studentStr) {
  const tokens = (studentStr || '').trim().split(/\s+/);
  return tokens.length ? tokens[0].replace(/[.,]+$/, '') : 'Student';
}

function buildGroupRecords(rawRecords) {
  const used = new Set();
  const out = [];

  for (const rec of rawRecords) {
    if (!rec.students || !rec.students.length) continue;

    const fn = firstNameOf(rec.students[0]);
    const lvl = (rec.level || '').trim() || 'Unassigned';
    const base = `${fn}'s Group - ${lvl}`;
    let name = base;
    let n = 2;
    while (used.has(name)) {
      name = `${base} (${n})`;
      n += 1;
    }
    used.add(name);

    out.push({
      group_name: name,
      type: rec.type,
      level: rec.level || '',
      students: rec.students,
      _schedule_note: rec.schedule || '', // informational only, not part of the Group schema
    });
  }

  return out;
}

function parseGroupsCsv(filePath) {
  return parseGroupsCsvFromRows(readCsvRows(filePath));
}

function parsePrivateCsv(filePath) {
  return parsePrivateCsvFromRows(readCsvRows(filePath));
}

function parseGroupsCsvFromString(csvString) {
  return parseGroupsCsvFromRows(parseCsvString(csvString));
}

function parsePrivateCsvFromString(csvString) {
  return parsePrivateCsvFromRows(parseCsvString(csvString));
}

module.exports = {
  parseGroupsCsv,
  parsePrivateCsv,
  parseGroupsCsvFromString,
  parsePrivateCsvFromString,
  buildGroupRecords,
};
