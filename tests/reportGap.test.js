'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { Query } = require('mingo');

const {
  DEFAULT_CONFIG,
  getConfig,
  toLocalDateStr,
  getLocalWeekday,
  addDays,
  diffDays,
  getWeekdayName,
  buildReportGapReminderClaimFilter,
  buildAggregationPipeline,
  detectReportGaps,
} = require('../services/reportGapService');

/* ══════════════════════════════════════════════════════════════
   1. DETECTOR 1: teacher_day with synthetic data
══════════════════════════════════════════════════════════════ */
test('Report Gap Detector - teacher_day rules', async (t) => {
  // Evaluation anchor: Friday, 30 October 2026, 14:00 WIB
  const now = new Date('2026-10-30T07:00:00.000Z');
  const todayStr = '2026-10-30';
  assert.equal(toLocalDateStr(now), todayStr);
  assert.equal(getWeekdayName(todayStr), 'Friday');

  const teacherAId = '650000000000000000000001';
  const teachers = [
    { _id: teacherAId, displayName: 'Sarah Teacher', username: 'sarah' },
  ];

  // Helper to generate Wednesday dates for the previous 8 weeks:
  // Days ago:
  // Week 0: daysAgo 2 -> 2026-10-28 (Wed)
  // Week 1: daysAgo 9 -> 2026-10-21 (Wed)
  // Week 2: daysAgo 16 -> 2026-10-14 (Wed)
  // Week 3: daysAgo 23 -> 2026-10-07 (Wed)
  // Week 4: daysAgo 30 -> 2026-09-30 (Wed)
  // Week 5: daysAgo 37 -> 2026-09-23 (Wed)
  // Week 6: daysAgo 44 -> 2026-09-16 (Wed)
  // Week 7: daysAgo 51 -> 2026-09-09 (Wed)

  await t.test('usual weekday missed: emits gap with evidence', () => {
    // Teacher reported on Wednesday in 6 of the 8 weeks (weeks 1 to 6), but missed week 0 (2026-10-28)
    const teacherReports = [
      { teacher: teacherAId, localDate: '2026-10-21', count: 1 },
      { teacher: teacherAId, localDate: '2026-10-14', count: 1 },
      { teacher: teacherAId, localDate: '2026-10-07', count: 1 },
      { teacher: teacherAId, localDate: '2026-09-30', count: 1 },
      { teacher: teacherAId, localDate: '2026-09-23', count: 1 },
      { teacher: teacherAId, localDate: '2026-09-16', count: 1 },
    ];

    const result = detectReportGaps({
      teacherReports,
      classReports: [],
      teachers,
      noClassDates: [],
      acks: [],
      now,
    });

    assert.equal(result.teacherDayGaps.length, 1);
    const gap = result.teacherDayGaps[0];
    assert.equal(gap.teacherId, teacherAId);
    assert.equal(gap.date, '2026-10-28');
    assert.equal(gap.weekday, 'Wednesday');
    assert.equal(gap.evidence, 'Usually reports on Wednesday: 6 of the last 8 weeks');
  });

  await t.test('usual weekday present: no gap emitted', () => {
    // Teacher reported on all 7 Wednesdays including 2026-10-28
    const teacherReports = [
      { teacher: teacherAId, localDate: '2026-10-28', count: 1 },
      { teacher: teacherAId, localDate: '2026-10-21', count: 1 },
      { teacher: teacherAId, localDate: '2026-10-14', count: 1 },
      { teacher: teacherAId, localDate: '2026-10-07', count: 1 },
      { teacher: teacherAId, localDate: '2026-09-30', count: 1 },
      { teacher: teacherAId, localDate: '2026-09-23', count: 1 },
    ];

    const result = detectReportGaps({
      teacherReports,
      classReports: [],
      teachers,
      noClassDates: [],
      acks: [],
      now,
    });

    const gapsFor28 = result.teacherDayGaps.filter(g => g.date === '2026-10-28');
    assert.equal(gapsFor28.length, 0, 'Report on 2026-10-28 means no gap');
  });

  await t.test('today excluded: gap is never emitted for today', () => {
    // Suppose teacher usually reports on Friday (today is Friday 2026-10-30)
    const teacherReports = [
      { teacher: teacherAId, localDate: '2026-10-23', count: 1 }, // last Friday
      { teacher: teacherAId, localDate: '2026-10-16', count: 1 },
      { teacher: teacherAId, localDate: '2026-10-09', count: 1 },
      { teacher: teacherAId, localDate: '2026-10-02', count: 1 },
      { teacher: teacherAId, localDate: '2026-09-25', count: 1 },
    ];

    const result = detectReportGaps({
      teacherReports,
      classReports: [],
      teachers,
      noClassDates: [],
      acks: [],
      now,
    });

    const gapsForToday = result.teacherDayGaps.filter(g => g.date === todayStr);
    assert.equal(gapsForToday.length, 0, 'Today must never be emitted as a missing report gap');
  });

  await t.test('no-class date suppresses teacher_day gap', () => {
    const teacherReports = [
      { teacher: teacherAId, localDate: '2026-10-21', count: 1 },
      { teacher: teacherAId, localDate: '2026-10-14', count: 1 },
      { teacher: teacherAId, localDate: '2026-10-07', count: 1 },
      { teacher: teacherAId, localDate: '2026-09-30', count: 1 },
    ];

    const noClassDates = [
      { from: '2026-10-27', to: '2026-10-29', label: 'Mid-term School Holiday' },
    ];

    const result = detectReportGaps({
      teacherReports,
      classReports: [],
      teachers,
      noClassDates,
      acks: [],
      now,
    });

    const gapsFor28 = result.teacherDayGaps.filter(g => g.date === '2026-10-28');
    assert.equal(gapsFor28.length, 0, 'Global no-class date must suppress gap');
  });

  await t.test('acknowledgement suppresses teacher_day gap', () => {
    const teacherReports = [
      { teacher: teacherAId, localDate: '2026-10-21', count: 1 },
      { teacher: teacherAId, localDate: '2026-10-14', count: 1 },
      { teacher: teacherAId, localDate: '2026-10-07', count: 1 },
      { teacher: teacherAId, localDate: '2026-09-30', count: 1 },
    ];

    const acks = [
      {
        kind: 'teacher_day',
        teacher: teacherAId,
        date: '2026-10-28',
        reason: 'leave',
        note: 'Teacher was on sick leave',
      },
    ];

    const result = detectReportGaps({
      teacherReports,
      classReports: [],
      teachers,
      noClassDates: [],
      acks,
      now,
    });

    const gapsFor28 = result.teacherDayGaps.filter(g => g.date === '2026-10-28');
    assert.equal(gapsFor28.length, 0, 'Acknowledgement must suppress gap');
  });

  await t.test('new teacher with too little history gets nothing', () => {
    const newTeacherId = '650000000000000000000002';
    const newTeachers = [
      { _id: newTeacherId, displayName: 'New Teacher', username: 'newbie' },
    ];

    // Only reported on Wednesday in 2 weeks (2 < PATTERN_MIN_WEEKS = 4)
    const teacherReports = [
      { teacher: newTeacherId, localDate: '2026-10-21', count: 1 },
      { teacher: newTeacherId, localDate: '2026-10-14', count: 1 },
    ];

    const result = detectReportGaps({
      teacherReports,
      classReports: [],
      teachers: newTeachers,
      noClassDates: [],
      acks: [],
      now,
    });

    assert.equal(result.teacherDayGaps.length, 0, 'Teacher with < 4 weeks of history has no usual weekday');
  });

  await t.test('partner copy counts as presence', () => {
    // Partner copy created for teacherA on 2026-10-28
    const teacherReports = [
      { teacher: teacherAId, localDate: '2026-10-28', count: 1 }, // e.g. from is_auto_generated partner report
      { teacher: teacherAId, localDate: '2026-10-21', count: 1 },
      { teacher: teacherAId, localDate: '2026-10-14', count: 1 },
      { teacher: teacherAId, localDate: '2026-10-07', count: 1 },
      { teacher: teacherAId, localDate: '2026-09-30', count: 1 },
    ];

    const result = detectReportGaps({
      teacherReports,
      classReports: [],
      teachers,
      noClassDates: [],
      acks: [],
      now,
    });

    const gapsFor28 = result.teacherDayGaps.filter(g => g.date === '2026-10-28');
    assert.equal(gapsFor28.length, 0, 'Partner report presence counts as report submission');
  });
});

/* ══════════════════════════════════════════════════════════════
   2. DETECTOR 2: teacher_silent thresholds and suppression
══════════════════════════════════════════════════════════════ */
test('Report Gap Detector - teacher_silent rules', async (t) => {
  const now = new Date('2026-10-30T07:00:00.000Z');
  const teacherId = '650000000000000000000010';
  const teachers = [
    { _id: teacherId, displayName: 'Active Teacher', username: 'active' },
  ];

  await t.test('>= 8 reports in 8 weeks and 0 in last 10 days triggers silent gap', () => {
    // 8 reports between 15 and 40 days ago (last report 15 days ago = 2026-10-15)
    const teacherReports = [
      { teacher: teacherId, localDate: '2026-10-15', count: 2 },
      { teacher: teacherId, localDate: '2026-10-08', count: 2 },
      { teacher: teacherId, localDate: '2026-10-01', count: 2 },
      { teacher: teacherId, localDate: '2026-09-24', count: 2 },
    ]; // total count = 8

    const result = detectReportGaps({
      teacherReports,
      classReports: [],
      teachers,
      noClassDates: [],
      acks: [],
      now,
    });

    assert.equal(result.teacherSilentGaps.length, 1);
    const gap = result.teacherSilentGaps[0];
    assert.equal(gap.teacherId, teacherId);
    assert.equal(gap.silenceDays, 15);
    assert.equal(gap.totalReports, 8);
    assert.ok(gap.evidence.includes('8 reports in previous 8 weeks'));
    assert.ok(gap.evidence.includes('0 in last 15 days'));
  });

  await t.test('< 8 reports in 8 weeks does not trigger teacher_silent', () => {
    // Only 7 reports in 8 weeks
    const teacherReports = [
      { teacher: teacherId, localDate: '2026-10-15', count: 7 },
    ];

    const result = detectReportGaps({
      teacherReports,
      classReports: [],
      teachers,
      noClassDates: [],
      acks: [],
      now,
    });

    assert.equal(result.teacherSilentGaps.length, 0, 'Below 8 reports threshold should not trigger silent alert');
  });

  await t.test('report in the last 10 days prevents teacher_silent', () => {
    // 8 reports total, but 1 was 5 days ago (2026-10-25)
    const teacherReports = [
      { teacher: teacherId, localDate: '2026-10-25', count: 1 },
      { teacher: teacherId, localDate: '2026-10-10', count: 7 },
    ];

    const result = detectReportGaps({
      teacherReports,
      classReports: [],
      teachers,
      noClassDates: [],
      acks: [],
      now,
    });

    assert.equal(result.teacherSilentGaps.length, 0, 'Report within 10 days means teacher is not silent');
  });

  await t.test('acknowledgement suppresses teacher_silent gap', () => {
    const teacherReports = [
      { teacher: teacherId, localDate: '2026-10-12', count: 8 },
    ];

    const acks = [
      {
        kind: 'teacher_silent',
        teacher: teacherId,
        reason: 'other',
        note: 'Teacher on extended sabbatical',
      },
    ];

    const result = detectReportGaps({
      teacherReports,
      classReports: [],
      teachers,
      noClassDates: [],
      acks,
      now,
    });

    assert.equal(result.teacherSilentGaps.length, 0, 'Acknowledged teacher_silent gap must be suppressed');
  });
});

/* ══════════════════════════════════════════════════════════════
   3. DETECTOR 3: group_silent thresholds and competition exclusion
══════════════════════════════════════════════════════════════ */
test('Report Gap Detector - group_silent rules', async (t) => {
  const now = new Date('2026-10-30T07:00:00.000Z');

  await t.test('>= 3 reports in 8 weeks and none in last 10 days triggers group_silent', () => {
    const classReports = [
      { _id: 'IELTS-A', count: 4, lastDate: '2026-10-18' }, // 12 days ago
    ];

    const result = detectReportGaps({
      teacherReports: [],
      classReports,
      teachers: [],
      noClassDates: [],
      acks: [],
      now,
    });

    assert.equal(result.groupSilentGaps.length, 1);
    const gap = result.groupSilentGaps[0];
    assert.equal(gap.groupName, 'IELTS-A');
    assert.equal(gap.silenceDays, 12);
    assert.equal(gap.totalReports, 4);
    assert.ok(gap.evidence.includes('4 reports in previous 8 weeks'));
    assert.ok(gap.evidence.includes('none in last 12 days'));
  });

  await t.test('< 3 reports in 8 weeks does not trigger group_silent', () => {
    const classReports = [
      { _id: 'TOEFL-Tiny', count: 2, lastDate: '2026-10-15' },
    ];

    const result = detectReportGaps({
      teacherReports: [],
      classReports,
      teachers: [],
      noClassDates: [],
      acks: [],
      now,
    });

    assert.equal(result.groupSilentGaps.length, 0, 'Groups with < 3 reports are excluded');
  });

  await t.test('report in last 10 days prevents group_silent', () => {
    const classReports = [
      { _id: 'General-English', count: 6, lastDate: '2026-10-25' }, // 5 days ago
    ];

    const result = detectReportGaps({
      teacherReports: [],
      classReports,
      teachers: [],
      noClassDates: [],
      acks: [],
      now,
    });

    assert.equal(result.groupSilentGaps.length, 0, 'Class active within last 10 days is not silent');
  });

  await t.test('competition sessions excluded in pipeline match stage', () => {
    const minDate = new Date('2026-09-01T00:00:00.000Z');
    const pipeline = buildAggregationPipeline(minDate);

    // Verify classReports facet filters out competition session_type
    const classFacet = pipeline[1].$facet.classReports;
    const matchStage = classFacet[0].$match;
    assert.deepEqual(matchStage.session_type, { $ne: 'competition' });
  });

  await t.test('acknowledgement suppresses group_silent gap', () => {
    const classReports = [
      { _id: 'Saturday-Kids', count: 5, lastDate: '2026-10-16' },
    ];

    const acks = [
      {
        kind: 'group_silent',
        group: 'Saturday-Kids',
        reason: 'no_class',
        note: 'Course completed for the term',
      },
    ];

    const result = detectReportGaps({
      teacherReports: [],
      classReports,
      teachers: [],
      noClassDates: [],
      acks,
      now,
    });

    assert.equal(result.groupSilentGaps.length, 0, 'Acknowledged group_silent gap must be suppressed');
  });
});

/* ══════════════════════════════════════════════════════════════
   4. ATOMIC CLAIM FILTER EVALUATION (mingo)
══════════════════════════════════════════════════════════════ */
test('Report Gap Reminder - 24h atomic claim filter evaluated with mingo', async () => {
  const userId = '650000000000000000000099';
  const now = new Date('2026-10-30T10:00:00.000Z');
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const filter = buildReportGapReminderClaimFilter({ userId, cutoff });
  const query = new Query(filter);

  // 1. Document with no reportGapReminders field at all
  const docNoField = {
    _id: userId,
    username: 'fresh_teacher',
  };
  assert.equal(query.test(docNoField), true, 'Document without reportGapReminders field matches claim filter');

  // 2. Document with reportGapReminders.lastSentAt = null
  const docNullField = {
    _id: userId,
    reportGapReminders: { lastSentAt: null },
  };
  assert.equal(query.test(docNullField), true, 'Document with null lastSentAt matches claim filter');

  // 3. Document with reminder sent 2 hours ago (< 24h)
  const doc2hAgo = {
    _id: userId,
    reportGapReminders: {
      lastSentAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
    },
  };
  assert.equal(query.test(doc2hAgo), false, 'Document with reminder sent 2h ago does NOT match claim filter');

  // 4. Document with reminder sent 25 hours ago (> 24h)
  const doc25hAgo = {
    _id: userId,
    reportGapReminders: {
      lastSentAt: new Date(now.getTime() - 25 * 60 * 60 * 1000),
    },
  };
  assert.equal(query.test(doc25hAgo), true, 'Document with reminder sent 25h ago matches claim filter');

  // 5. Different user ID should NOT match
  const docOtherUser = {
    _id: '650000000000000000000088',
    reportGapReminders: { lastSentAt: null },
  };
  assert.equal(query.test(docOtherUser), false, 'Different userId must not match claim filter');
});

/* ══════════════════════════════════════════════════════════════
   5. TIMEZONE EDGE CASE (23:30 WIB vs 00:30 WIB)
══════════════════════════════════════════════════════════════ */
test('Timezone Edge Case - 23:30 WIB and 00:30 WIB land on correct local dates', () => {
  // Asia/Jakarta is UTC+7 (WIB)
  // 2026-10-28 23:30 WIB = 2026-10-28 16:30:00 UTC
  const lateNightWIB = new Date('2026-10-28T16:30:00.000Z');
  // 2026-10-29 00:30 WIB = 2026-10-28 17:30:00 UTC (notice UTC date is still 28th!)
  const earlyMorningWIB = new Date('2026-10-28T17:30:00.000Z');

  const dateLate = toLocalDateStr(lateNightWIB);
  const dateEarly = toLocalDateStr(earlyMorningWIB);

  assert.equal(dateLate, '2026-10-28', '23:30 WIB must land on 2026-10-28');
  assert.equal(dateEarly, '2026-10-29', '00:30 WIB must land on 2026-10-29');

  const weekdayLate = getLocalWeekday(lateNightWIB);
  const weekdayEarly = getLocalWeekday(earlyMorningWIB);

  assert.equal(weekdayLate, 'Wednesday');
  assert.equal(weekdayEarly, 'Thursday');
});

/* ══════════════════════════════════════════════════════════════
   6. RENDER TEST: views/admin/report-gaps/index.ejs
      (XSS escaping, quotes, no inline scripts, responsive table)
══════════════════════════════════════════════════════════════ */
test('Report Gap View Render - XSS escaping, quotes, container scroll, no inline scripts', async () => {
  const templatePath = path.join(__dirname, '..', 'views', 'admin', 'report-gaps', 'index.ejs');

  const mockData = {
    title: 'Admin — Possible Missing Reports',
    csrfToken: 'test-token',
    currentUser: {
      _id: '650000000000000000000001',
      role: 'admin',
      displayName: 'Admin User',
      joinDate: new Date('2024-01-01'),
      lastActiveAt: new Date(),
    },
    unreadNotificationCount: 0,
    lookback: 14,
    config: DEFAULT_CONFIG,
    formatShortDate: (d) => `Formatted: ${d}`,
    summary: {
      total: 3,
      teacherDayCount: 1,
      teacherSilentCount: 1,
      groupSilentCount: 1,
    },
    teacherDayGaps: [
      {
        teacherId: '650000000000000000000001',
        teacherName: '<script>alert("teacher_xss")</script> & "Quotes"',
        date: '2026-10-28',
        weekday: 'Wednesday',
        evidence: 'Usually reports on Wednesday: 6 of the last 8 weeks',
      },
    ],
    teacherSilentGaps: [
      {
        teacherId: '650000000000000000000002',
        teacherName: '<img src=x onerror=alert(1)> Teacher',
        lastReportDate: '2026-10-15',
        silenceDays: 15,
        totalReports: 10,
        evidence: '10 reports in previous 8 weeks, 0 in last 15 days',
      },
    ],
    groupSilentGaps: [
      {
        groupName: '<script>alert("group")</script> "Special Class"',
        lastDate: '2026-10-16',
        silenceDays: 14,
        totalReports: 4,
        evidence: '4 reports in previous 8 weeks, none in last 14 days',
      },
    ],
    noClassDates: [
      {
        _id: '650000000000000000000099',
        from: '2026-10-25',
        to: '2026-10-27',
        label: '<script>alert("holiday")</script> "National Day"',
      },
    ],
  };

  const html = await ejs.renderFile(templatePath, mockData);

  // 1. Unescaped dangerous scripts must NOT exist
  assert.ok(!html.includes('<script>alert("teacher_xss")</script>'), 'Unescaped script must not exist');
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'), 'Unescaped img onerror must not exist');
  assert.ok(!html.includes('<script>alert("group")</script>'), 'Unescaped group script must not exist');
  assert.ok(!html.includes('<script>alert("holiday")</script>'), 'Unescaped holiday script must not exist');

  // 2. Escaped entities must be present
  assert.ok(
    html.includes('&lt;script&gt;alert(&#34;teacher_xss&#34;)&lt;/script&gt;') ||
    html.includes('&lt;script&gt;alert(&quot;teacher_xss&quot;)&lt;/script&gt;'),
    'Teacher name must be safely escaped'
  );

  // 3. Table containers have overflow-x-auto for 375px screens
  assert.ok(html.includes('overflow-x-auto w-full'), 'Tables must scroll inside their own container');

  // 4. No inline event handlers in report-gaps view template
  const fs = require('node:fs');
  const templateSource = fs.readFileSync(templatePath, 'utf8');
  const inlineHandlerRegex = /\b(onclick|onsubmit|onload|onerror|onchange|oninput)\s*=/i;
  assert.ok(!inlineHandlerRegex.test(templateSource), 'report-gaps template must not contain inline event handlers');

  // 5. Zero inline script tags in view template (only external src)
  const inlineScriptRegex = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  const inlineScriptsInTemplate = [];
  let m;
  while ((m = inlineScriptRegex.exec(templateSource)) !== null) {
    if (m[1].trim().length > 0) {
      inlineScriptsInTemplate.push(m[1].trim());
    }
  }
  assert.equal(inlineScriptsInTemplate.length, 0, 'No inline scripts allowed in report gaps page template');

  // 6. External client JS linked
  assert.ok(html.includes('<script defer src="/js/report-gaps.js"></script>'), 'Client JS file linked with defer');
});
