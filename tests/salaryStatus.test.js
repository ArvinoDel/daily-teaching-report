'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const { Query } = require('mingo');

const {
  SALARY_STATUSES,
  canTransition,
  planGenerationAction,
  getJakartaDateString,
  getJakartaNoonDate,
  formatDisplayDate,
  validatePaidDate,
  planMarkPaid,
  buildPublishFilter,
  buildRetractFilter,
  buildMarkPaidFilter,
  buildReopenFilter,
  buildDraftEditFilter,
} = require('../services/salaryStatusService');

describe('Salary Status - canTransition() Matrix', () => {
  const allStatuses = [
    SALARY_STATUSES.DRAFT,
    SALARY_STATUSES.PUBLISHED,
    SALARY_STATUSES.PAID,
  ];

  const allowedTransitions = new Set([
    'draft->published',
    'published->draft',
    'published->paid',
    'paid->published',
  ]);

  test('exhaustive test of all status pairs', () => {
    for (const from of allStatuses) {
      for (const to of allStatuses) {
        const key = `${from}->${to}`;
        const expected = allowedTransitions.has(key);
        assert.equal(
          canTransition(from, to),
          expected,
          `Transition ${key} should be ${expected ? 'allowed' : 'refused'}`
        );
      }
    }
  });

  test('rejects draft -> paid direct transition', () => {
    assert.equal(canTransition('draft', 'paid'), false);
  });

  test('rejects paid -> draft direct transition', () => {
    assert.equal(canTransition('paid', 'draft'), false);
  });

  test('handles null, undefined, and invalid statuses gracefully', () => {
    assert.equal(canTransition(null, 'published'), false);
    assert.equal(canTransition('draft', null), false);
    assert.equal(canTransition(undefined, undefined), false);
    assert.equal(canTransition('', 'paid'), false);
    assert.equal(canTransition('draft', 'archived'), false);
    assert.equal(canTransition('unknown', 'published'), false);
  });
});

describe('Salary Status - planGenerationAction()', () => {
  test('returns create when existingSlip is null or undefined', () => {
    assert.equal(planGenerationAction(null), 'create');
    assert.equal(planGenerationAction(undefined), 'create');
  });

  test('returns update_preserve for draft when preserveEdits is true', () => {
    const draftSlip = { status: 'draft', _id: '1' };
    assert.equal(planGenerationAction(draftSlip, true), 'update_preserve');
    assert.equal(planGenerationAction(draftSlip), 'update_preserve'); // default true
  });

  test('returns overwrite_draft for draft when preserveEdits is false', () => {
    const draftSlip = { status: 'draft', _id: '1' };
    assert.equal(planGenerationAction(draftSlip, false), 'overwrite_draft');
  });

  test('returns skip for published slips regardless of preserveEdits', () => {
    const publishedSlip = { status: 'published', _id: '2' };
    assert.equal(planGenerationAction(publishedSlip, true), 'skip');
    assert.equal(planGenerationAction(publishedSlip, false), 'skip');
  });

  test('returns skip for paid slips regardless of preserveEdits', () => {
    const paidSlip = { status: 'paid', _id: '3' };
    assert.equal(planGenerationAction(paidSlip, true), 'skip');
    assert.equal(planGenerationAction(paidSlip, false), 'skip');
  });
});

describe('Salary Status - Atomic Transition Filters (Mingo Evaluation)', () => {
  const slips = [
    { _id: 's_draft', status: 'draft' },
    { _id: 's_published', status: 'published' },
    { _id: 's_paid', status: 'paid' },
  ];

  test('buildPublishFilter matches only draft slips', () => {
    const filterSingle = buildPublishFilter('s_draft');
    const matchedSingle = new Query(filterSingle).find(slips).all();
    assert.equal(matchedSingle.length, 1);
    assert.equal(matchedSingle[0]._id, 's_draft');

    const filterBulk = buildPublishFilter(['s_draft', 's_published', 's_paid']);
    const matchedBulk = new Query(filterBulk).find(slips).all();
    assert.equal(matchedBulk.length, 1);
    assert.equal(matchedBulk[0]._id, 's_draft');
  });

  test('buildRetractFilter matches only published slips', () => {
    const filter = buildRetractFilter('s_published');
    const matched = new Query(filter).find(slips).all();
    assert.equal(matched.length, 1);
    assert.equal(matched[0]._id, 's_published');

    const filterOnDraft = buildRetractFilter('s_draft');
    assert.equal(new Query(filterOnDraft).find(slips).all().length, 0);

    const filterOnPaid = buildRetractFilter('s_paid');
    assert.equal(new Query(filterOnPaid).find(slips).all().length, 0);
  });

  test('buildMarkPaidFilter matches only published slips', () => {
    const filter = buildMarkPaidFilter(['s_draft', 's_published', 's_paid']);
    const matched = new Query(filter).find(slips).all();
    assert.equal(matched.length, 1);
    assert.equal(matched[0]._id, 's_published');
  });

  test('buildReopenFilter matches only paid slips', () => {
    const filter = buildReopenFilter('s_paid');
    const matched = new Query(filter).find(slips).all();
    assert.equal(matched.length, 1);
    assert.equal(matched[0]._id, 's_paid');

    const filterOnPublished = buildReopenFilter('s_published');
    assert.equal(new Query(filterOnPublished).find(slips).all().length, 0);
  });

  test('buildDraftEditFilter matches only draft slips', () => {
    const filter = buildDraftEditFilter('s_draft');
    const matched = new Query(filter).find(slips).all();
    assert.equal(matched.length, 1);
    assert.equal(matched[0]._id, 's_draft');

    const filterOnPublished = buildDraftEditFilter('s_published');
    assert.equal(new Query(filterOnPublished).find(slips).all().length, 0);
  });
});

describe('Salary Status - Jakarta Date & PaidAt Validation', () => {
  const fixedNow = new Date('2026-11-06T10:00:00+07:00');

  test('getJakartaDateString returns YYYY-MM-DD in Asia/Jakarta', () => {
    const dateStr = getJakartaDateString(fixedNow);
    assert.equal(dateStr, '2026-11-06');
  });

  test('getJakartaNoonDate produces noon in UTC+7 (05:00:00Z)', () => {
    const noon = getJakartaNoonDate('2026-11-06');
    assert.ok(noon instanceof Date);
    assert.equal(noon.toISOString(), '2026-11-06T05:00:00.000Z');
  });

  test('formatDisplayDate formats date string nicely', () => {
    const noon = getJakartaNoonDate('2026-11-06');
    const formatted = formatDisplayDate(noon);
    assert.match(formatted, /6 Nov 2026/);
  });

  test('validatePaidDate accepts today in Jakarta', () => {
    const res = validatePaidDate('2026-11-06', null, fixedNow);
    assert.equal(res.ok, true);
    assert.ok(res.noonDate);
  });

  test('validatePaidDate accepts up to 7 days in the future', () => {
    const day7 = validatePaidDate('2026-11-13', null, fixedNow);
    assert.equal(day7.ok, true);

    const day8 = validatePaidDate('2026-11-14', null, fixedNow);
    assert.equal(day8.ok, false);
    assert.match(day8.error, /cannot be more than 7 days in the future/i);
  });

  test('validatePaidDate rejects dates before publishedAt', () => {
    const publishedAt = new Date('2026-11-05T05:00:00.000Z');
    const resBefore = validatePaidDate('2026-11-04', publishedAt, fixedNow);
    assert.equal(resBefore.ok, false);
    assert.match(resBefore.error, /cannot be before the published date/i);

    const resSame = validatePaidDate('2026-11-05', publishedAt, fixedNow);
    assert.equal(resSame.ok, true);

    const resAfter = validatePaidDate('2026-11-06', publishedAt, fixedNow);
    assert.equal(resAfter.ok, true);
  });

  test('validatePaidDate rejects malformed date strings', () => {
    assert.equal(validatePaidDate('not-a-date').ok, false);
    assert.equal(validatePaidDate('2026-13-45').ok, false);
    assert.equal(validatePaidDate('').ok, false);
    assert.equal(validatePaidDate(null).ok, false);
  });
});

describe('Salary Status - planMarkPaid() Planning', () => {
  const fixedNow = new Date('2026-11-06T10:00:00+07:00');

  test('rejects plan when payment date is invalid', () => {
    const plan = planMarkPaid({
      slips: [],
      paidAtStr: '2026-11-30', // > 7 days future
      now: fixedNow,
    });
    assert.equal(plan.validDate, false);
    assert.match(plan.dateError, /7 days/i);
    assert.equal(plan.eligible.length, 0);
  });

  test('splits candidate slips into eligible and skipped', () => {
    const publishedDate = new Date('2026-11-04T05:00:00.000Z');

    const slips = [
      {
        _id: 's1',
        status: 'published',
        publishedAt: publishedDate,
        teacher: { displayName: 'Teacher Alice' },
      },
      {
        _id: 's2',
        status: 'draft',
        teacher: { displayName: 'Teacher Bob' },
      },
      {
        _id: 's3',
        status: 'paid',
        teacher: { displayName: 'Teacher Charlie' },
      },
      {
        _id: 's4',
        status: 'published',
        publishedAt: new Date('2026-11-07T05:00:00.000Z'), // published in future relative to paidAt
        teacher: { displayName: 'Teacher David' },
      },
    ];

    const plan = planMarkPaid({
      slips,
      paidAtStr: '2026-11-06',
      now: fixedNow,
    });

    assert.equal(plan.validDate, true);
    assert.equal(plan.eligible.length, 1);
    assert.equal(plan.eligible[0]._id, 's1');

    assert.equal(plan.skipped.length, 3);
    assert.deepEqual(
      plan.skipped.map(s => ({ id: s.id, reason: s.reason })),
      [
        { id: 's2', reason: 'not_published' },
        { id: 's3', reason: 'already_paid' },
        { id: 's4', reason: 'before_published_date' },
      ]
    );
  });
});

describe('Salary Reopen - Reason Validation Rules', () => {
  function validateReopenReason(reason) {
    const clean = (reason || '').trim();
    if (!clean || clean.length < 5 || clean.length > 200) {
      return { ok: false, error: 'Reopen reason is required (5-200 characters).' };
    }
    return { ok: true, reason: clean };
  }

  test('rejects empty or whitespace-only reason', () => {
    assert.equal(validateReopenReason('').ok, false);
    assert.equal(validateReopenReason('   ').ok, false);
    assert.equal(validateReopenReason(null).ok, false);
    assert.equal(validateReopenReason(undefined).ok, false);
  });

  test('rejects reasons shorter than 5 characters', () => {
    assert.equal(validateReopenReason('oops').ok, false);
  });

  test('rejects reasons longer than 200 characters', () => {
    const longReason = 'a'.repeat(201);
    assert.equal(validateReopenReason(longReason).ok, false);
  });

  test('accepts valid reasons between 5 and 200 characters', () => {
    const res = validateReopenReason('Payment transfer failed; bank account number was incorrect.');
    assert.equal(res.ok, true);
    assert.equal(res.reason, 'Payment transfer failed; bank account number was incorrect.');
  });
});

describe('Salary Views - EJS XSS Escaping & Paid Stamp Rendering', () => {
  const maliciousName = '<script>alert("xss")</script>" onmouseover="alert(1)';

  test('views/admin/salaries/index.ejs escapes malicious teacher display names', async () => {
    const templatePath = path.resolve(__dirname, '../views/admin/salaries/index.ejs');

    const html = await ejs.renderFile(templatePath, {
      rows: [
        {
          _id: '670000000000000000000001',
          status: 'published',
          teacher: {
            _id: '670000000000000000000002',
            displayName: maliciousName,
            username: 'malicious_teacher',
          },
          subtotalIncomesFormatted: 'Rp 1,000,000',
          subtotalDeductionsFormatted: '—',
          totalSalaryFormatted: 'Rp 1,000,000',
          publishedAtFormatted: '5 Nov 2026',
          paidAtFormatted: null,
        },
        {
          _id: '670000000000000000000003',
          status: 'paid',
          teacher: {
            _id: '670000000000000000000004',
            displayName: 'Legit Teacher',
            username: 'legit_teacher',
          },
          subtotalIncomesFormatted: 'Rp 2,000,000',
          subtotalDeductionsFormatted: '—',
          totalSalaryFormatted: 'Rp 2,000,000',
          publishedAtFormatted: '5 Nov 2026',
          paidAtFormatted: '6 Nov 2026',
        },
      ],
      allRowsCount: 2,
      statusFilter: 'all',
      year: 2026,
      month: 11,
      monthLabel: 'November 2026',
      prevMonth: '2026-10',
      nextMonth: '2026-12',
      isCurrentMonth: true,
      selectedMonthStr: '2026-11',
      totalGross: 'Rp 3,000,000',
      totalDeductions: 'Rp 0',
      totalNet: 'Rp 3,000,000',
      draftCount: 0,
      publishedCount: 1,
      paidCount: 1,
      totalTeachers: 2,
      flash: null,
      firstDraftId: null,
      firstRowId: '670000000000000000000001',
      teachersWithoutRewards: null,
      missingReportsCount: 0,
      todayJakarta: '2026-11-06',
      user: { role: 'superadmin' },
      csrfToken: 'test_csrf',
    });

    // Verify raw unescaped script tag is NOT in the HTML
    assert.ok(!html.includes('<script>alert("xss")</script>'));
    // Verify escaped version is present
    assert.ok(html.includes('&lt;script&gt;alert(&#34;xss&#34;)&lt;/script&gt;') || html.includes('&lt;script&gt;'));
    // Verify paid date is displayed for the paid slip
    assert.ok(html.includes('6 Nov 2026'));
    // Verify script tags at bottom
    assert.ok(html.includes('admin-salaries.js'));
    assert.ok(html.includes('admin-salaries-status.js'));
  });

  test('views/admin/salaries/slip.ejs renders paid stamp with print styling', async () => {
    const templatePath = path.resolve(__dirname, '../views/admin/salaries/slip.ejs');

    const html = await ejs.renderFile(templatePath, {
      salary: {
        _id: '670000000000000000000010',
        status: 'paid',
        paidAt: new Date('2026-11-06T05:00:00.000Z'),
        month: 11,
        year: 2026,
        totalSalary: 2500000,
        basicSalary: 2500000,
      },
      teacher: {
        displayName: maliciousName,
        username: 'malicious_teacher',
      },
      user: { role: 'superadmin' },
      csrfToken: 'test_csrf',
      flow: null,
    });

    assert.ok(!html.includes('<script>alert("xss")</script>'));
    assert.ok(html.includes('paid-stamp'));
    assert.ok(html.includes('Paid on 6 Nov 2026'));
    assert.ok(html.includes('.paid-stamp {'));
  });

  test('views/reports/my-salary/slip.ejs renders paid stamp', async () => {
    const templatePath = path.resolve(__dirname, '../views/reports/my-salary/slip.ejs');

    const html = await ejs.renderFile(templatePath, {
      salary: {
        _id: '670000000000000000000020',
        status: 'paid',
        paidAt: new Date('2026-11-06T05:00:00.000Z'),
        month: 11,
        year: 2026,
        totalSalary: 3000000,
        basicSalary: 3000000,
      },
      teacher: {
        displayName: 'Teacher Jane',
        username: 'jane',
      },
      user: { role: 'teacher' },
      csrfToken: 'test_csrf',
    });

    assert.ok(html.includes('paid-stamp'));
    assert.ok(html.includes('Paid on 6 Nov 2026'));
  });

  test('views/reports/my-salary/index.ejs renders Published or Paid on date', async () => {
    const templatePath = path.resolve(__dirname, '../views/reports/my-salary/index.ejs');

    const html = await ejs.renderFile(templatePath, {
      rows: [
        {
          _id: '670000000000000000000030',
          status: 'published',
          monthLabel: 'October 2026',
          totalSalaryFormatted: 'Rp 2,500,000',
          publishedAtFormatted: '25 Oct 2026',
          paidAtFormatted: null,
        },
        {
          _id: '670000000000000000000031',
          status: 'paid',
          monthLabel: 'September 2026',
          totalSalaryFormatted: 'Rp 2,500,000',
          publishedAtFormatted: '25 Sep 2026',
          paidAtFormatted: '26 Sep 2026',
        },
      ],
      user: { role: 'teacher' },
      csrfToken: 'test_csrf',
    });

    assert.ok(html.includes('Published'));
    assert.ok(html.includes('Paid on 26 Sep 2026'));
  });
});

describe('Static Source Guard - No direct .status = assignment in adminSalaryController', () => {
  test('controllers/adminSalaryController.js contains no .status = write assignments', () => {
    const filePath = path.resolve(__dirname, '../controllers/adminSalaryController.js');
    const source = fs.readFileSync(filePath, 'utf8');

    // Strip comments to only check executable code
    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*/g, '');

    // Matches any .status = assignment, excluding == and ===
    const assignmentMatches = withoutComments.match(/\.status\s*=(?!=)/g);

    assert.equal(
      assignmentMatches,
      null,
      `Found direct .status = write assignments in adminSalaryController.js: ${JSON.stringify(assignmentMatches)}. All status updates must be atomic via database queries.`
    );
  });
});

