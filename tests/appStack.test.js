'use strict';
/**
 * tests/appStack.test.js
 *
 * Static guard suite for app.js Express middleware and configuration stack.
 *
 * Tests:
 *   1. stripComments state machine unit tests (strings with //, template literals,
 *      regex literals, nested quotes, block comments inside strings).
 *   2. Real app.js validation via checkAppStack (must have 0 missing/misordered statements).
 *   3. Mutation tests: each required statement deleted and commented out must report
 *      exactly that rule ID.
 *   4. Ordering mutation tests: /api/cron deleted or moved after session must fail.
 *   5. Comment insulation: an express.json mention inside comments cannot satisfy express-json.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const {
  stripComments,
  checkAppStack,
  REQUIRED_RULES,
} = require('./helpers/appStack');

const APP_PATH = path.resolve(__dirname, '../app.js');
const appSrc   = fs.readFileSync(APP_PATH, 'utf8');

// ---------------------------------------------------------------------------
// 1. stripComments unit tests
// ---------------------------------------------------------------------------
describe('stripComments state machine', () => {
  test('preserves string containing // (e.g. URLs)', () => {
    const input = 'const url = "https://example.com/api";';
    assert.strictEqual(stripComments(input), input);
  });

  test('preserves template literal containing //', () => {
    const input = 'const msg = `hello // world ${name}`;';
    assert.strictEqual(stripComments(input), input);
  });

  test('preserves regex literal with slash and comment-like characters', () => {
    const input = 'const r = /\\/\\* [a-z]+ \\*\\//;';
    assert.strictEqual(stripComments(input), input);
  });

  test('preserves nested quotes inside strings', () => {
    const input1 = `const s = 'nested "double" quotes inside';`;
    const input2 = `const s = "nested 'single' quotes inside";`;
    assert.strictEqual(stripComments(input1), input1);
    assert.strictEqual(stripComments(input2), input2);
  });

  test('preserves block comment syntax when inside a string', () => {
    const input = 'const s = "this has /* block comment */ inside string";';
    assert.strictEqual(stripComments(input), input);
  });

  test('strips real single-line comments but preserves newlines and code', () => {
    const input = 'const a = 1; // line comment\nconst b = 2;';
    const stripped = stripComments(input);
    assert.ok(!stripped.includes('line comment'));
    assert.ok(stripped.includes('const a = 1;'));
    assert.ok(stripped.includes('const b = 2;'));
  });

  test('strips real block comments but preserves newlines and code', () => {
    const input = 'const a = 1; /* block\ncomment */ const b = 2;';
    const stripped = stripComments(input);
    assert.ok(!stripped.includes('block'));
    assert.ok(!stripped.includes('comment'));
    assert.ok(stripped.includes('const a = 1;'));
    assert.ok(stripped.includes('const b = 2;'));
  });

  test('handles comments with quote characters without getting stuck in string mode', () => {
    const input = "// it's a test with quotes: \"hello\"\nconst c = 3;";
    const stripped = stripComments(input);
    assert.ok(!stripped.includes("it's a test"));
    assert.ok(stripped.includes('const c = 3;'));
  });
});

// ---------------------------------------------------------------------------
// 2. Real app.js validation
// ---------------------------------------------------------------------------
describe('Real app.js stack guard', () => {
  test('app.js satisfies all required middleware, configs, and ordering rules', () => {
    const issues = checkAppStack(appSrc);
    assert.deepStrictEqual(
      issues,
      [],
      `app.js is missing or has misordered statements: ${JSON.stringify(issues, null, 2)}`
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Anchoring & comment insulation
// ---------------------------------------------------------------------------
describe('Pattern anchoring and comment insulation', () => {
  test('a comment mentioning express.json does not satisfy express-json pattern', () => {
    const fakeSource = `
      // Here is a comment mentioning express.json({ limit: '8kb' })
      /* Another comment with app.use(express.json()) */
      app.set('trust proxy', 1);
    `;
    const issues = checkAppStack(fakeSource);
    const jsonIssue = issues.find(i => i.id === 'express-json');
    assert.ok(jsonIssue, 'Expected express-json to be reported missing when only in comments');
  });
});

// ---------------------------------------------------------------------------
// 4. Mutation tests for all required statements
// ---------------------------------------------------------------------------
describe('Mutation tests for required statements', () => {
  // Mapping of rule IDs to their exact unique anchor string in the real app.js
  const STATEMENT_ANCHORS = {
    'trust-proxy': "app.set('trust proxy', 1);",
    'view-engine': "app.set('view engine', 'ejs');",
    'views-dir': "app.set('views', path.join(__dirname, 'views'));",
    'express-urlencoded': "app.use(express.urlencoded({ extended: true, limit: '10mb' }));",
    'express-json': "app.use(express.json({ limit: '10mb' }));",
    'method-override': "app.use(methodOverride(function (req) {",
    'compression': "app.use(compression());",
    'general-limiter-def': "const generalLimiter = rateLimit({",
    'general-limiter-mount': "app.use(generalLimiter);",
    'login-limiter-def': "const loginLimiter = rateLimit({",
    'login-limiter-mount': "app.use('/auth/login', loginLimiter);",
    'csp': "contentSecurityPolicy: process.env.NODE_ENV === 'production'",
    'csp-report-mount': "app.use('/csp-report', cspReportRoutes);",
    'cron-mount': "app.use('/api/cron', cronRoutes);",
    'session': "app.use(session({",
    'csrf': "app.use(csrfProtection);",
  };

  for (const rule of REQUIRED_RULES) {
    const anchor = STATEMENT_ANCHORS[rule.id];
    if (!anchor) continue;

    test(`mutation: deleting line for ${rule.id} causes checkAppStack to report ${rule.id}`, () => {
      assert.ok(appSrc.includes(anchor), `Anchor for ${rule.id} not found in app.js: "${anchor}"`);
      const mutated = appSrc.replace(anchor, '');
      const issues = checkAppStack(mutated);
      const found = issues.find(i => i.id === rule.id);
      assert.ok(found, `Expected checkAppStack to report ${rule.id} missing when deleted`);
    });

    test(`mutation: commenting out line for ${rule.id} causes checkAppStack to report ${rule.id}`, () => {
      assert.ok(appSrc.includes(anchor), `Anchor for ${rule.id} not found in app.js: "${anchor}"`);
      const mutated = appSrc.replace(anchor, '// ' + anchor);
      const issues = checkAppStack(mutated);
      const found = issues.find(i => i.id === rule.id);
      assert.ok(found, `Expected checkAppStack to report ${rule.id} missing when commented out`);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. Ordering mutations
// ---------------------------------------------------------------------------
describe('Ordering mutations', () => {
  const cronLine = "app.use('/api/cron', cronRoutes);";
  const sessionLine = "app.use(session({";

  test('mutation: deleting /api/cron mount entirely reports cron-mount', () => {
    const mutated = appSrc.replace(cronLine, '');
    const issues = checkAppStack(mutated);
    assert.ok(issues.some(i => i.id === 'cron-mount'), 'Expected cron-mount issue');
  });

  test('mutation: moving /api/cron mount after session middleware reports cron-before-session', () => {
    assert.ok(appSrc.includes(cronLine));
    assert.ok(appSrc.includes(sessionLine));

    // Remove cron from original place
    const withoutCron = appSrc.replace(cronLine, '');
    // Insert cron after the session block
    const sessionIdx = withoutCron.indexOf(sessionLine);
    const sessionEnd = withoutCron.indexOf('}));', sessionIdx) + 4;
    const mutated = withoutCron.slice(0, sessionEnd) + '\n' + cronLine + '\n' + withoutCron.slice(sessionEnd);

    const issues = checkAppStack(mutated);
    assert.ok(
      issues.some(i => i.id === 'cron-before-session'),
      `Expected cron-before-session when /api/cron is after session. Got: ${JSON.stringify(issues)}`
    );
  });

  test('mutation: moving /csp-report mount after session middleware reports csp-report-before-session', () => {
    const cspReportLine = "app.use('/csp-report', cspReportRoutes);";
    assert.ok(appSrc.includes(cspReportLine));

    const withoutCspReport = appSrc.replace(cspReportLine, '');
    const sessionIdx = withoutCspReport.indexOf(sessionLine);
    const sessionEnd = withoutCspReport.indexOf('}));', sessionIdx) + 4;
    const mutated = withoutCspReport.slice(0, sessionEnd) + '\n' + cspReportLine + '\n' + withoutCspReport.slice(sessionEnd);

    const issues = checkAppStack(mutated);
    assert.ok(
      issues.some(i => i.id === 'csp-report-before-session'),
      `Expected csp-report-before-session when /csp-report is after session. Got: ${JSON.stringify(issues)}`
    );
  });
});
