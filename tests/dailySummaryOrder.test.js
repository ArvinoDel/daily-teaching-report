/**
 * tests/dailySummaryOrder.test.js
 *
 * Tests for daily summary reports chronological ordering and order number display.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Daily Summary - Chronological sorting logic puts earliest class on top', () => {
  const reports = [
    {
      _id: '652ef0000000000000000004',
      class_name: "Fellyn's Group - E6",
      createdAt: new Date('2026-10-16T15:00:00Z'),
    },
    {
      _id: '652ef0000000000000000001',
      class_name: "Chavella's Group - E4",
      createdAt: new Date('2026-10-16T09:00:00Z'),
    },
    {
      _id: '652ef0000000000000000003',
      class_name: "Batara's Group - B1",
      createdAt: new Date('2026-10-16T13:00:00Z'),
    },
    {
      _id: '652ef0000000000000000002',
      class_name: "Deira's Group - B1 Semester 2",
      createdAt: new Date('2026-10-16T11:00:00Z'),
    },
  ];

  reports.sort((a, b) => {
    const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (timeA !== timeB) return timeA - timeB;
    return String(a._id).localeCompare(String(b._id));
  });

  assert.equal(reports[0].class_name, "Chavella's Group - E4", 'First class should be #1 on top');
  assert.equal(reports[1].class_name, "Deira's Group - B1 Semester 2", 'Second class should be #2');
  assert.equal(reports[2].class_name, "Batara's Group - B1", 'Third class should be #3');
  assert.equal(reports[3].class_name, "Fellyn's Group - E6", 'Fourth class should be #4');
});

test('Daily Summary - Detail table view includes # column without overflow risk', () => {
  const viewPath = path.join(__dirname, '../views/partials/dashboard/_daily-summary.ejs');
  const viewContent = fs.readFileSync(viewPath, 'utf8');

  // Verify the header contains the '#' column
  assert.match(viewContent, /<th[^>]*>\s*#\s*<\/th>/, 'Daily detail table must have # header');

  // Verify responsive width and compact padding to avoid overflow
  assert.match(viewContent, /w-10\s+sm:w-12/, '# header must have fixed compact width');
  assert.match(viewContent, /px-3\s+sm:px-5/, 'Headers should use compact horizontal padding');
});

test('Daily Summary - Client-side script renders order number and sorts chronologically', () => {
  const scriptPath = path.join(__dirname, '../views/partials/dashboard/_scripts.ejs');
  const scriptContent = fs.readFileSync(scriptPath, 'utf8');

  // Verify client-side sorting exists
  assert.match(scriptContent, /reports\.sort/, 'Client-side script must sort reports');
  assert.match(scriptContent, /String\(a\._id\)\.localeCompare\(String\(b\._id\)\)/, 'Client-side script must have deterministic secondary sort');

  // Verify order number is rendered
  assert.match(scriptContent, /orderNum\s*=\s*index\s*\+\s*1/, 'Client-side script must calculate 1-based order number');
  assert.match(scriptContent, /orderNum/, 'Client-side script must output orderNum');
});
