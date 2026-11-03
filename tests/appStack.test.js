'use strict';
/**
 * tests/appStack.test.js
 *
 * Static guard: reads app.js as a string and asserts every required Express
 * middleware / configuration statement is present.  Fails with a clear,
 * descriptive message naming the missing statement so no-one has to grep.
 *
 * This test does NOT start the server — it only inspects the source text.
 */

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('fs');
const path     = require('path');

const appSrc = fs.readFileSync(path.resolve(__dirname, '../app.js'), 'utf8');

function assertMatches(pattern, message) {
  assert.ok(
    pattern.test(appSrc),
    `MISSING STATEMENT: ${message}\n  Pattern: ${pattern}`
  );
}

// ---------------------------------------------------------------------------
// 1. trust proxy
// ---------------------------------------------------------------------------
test("app.js must set trust proxy 1", () => {
  assertMatches(
    /app\.set\(\s*['"]trust proxy['"]\s*,\s*1\s*\)/,
    "app.set('trust proxy', 1)"
  );
});

// ---------------------------------------------------------------------------
// 2. View engine
// ---------------------------------------------------------------------------
test("app.js must set view engine to ejs", () => {
  assertMatches(
    /app\.set\(\s*['"]view engine['"]\s*,\s*['"]ejs['"]\s*\)/,
    "app.set('view engine', 'ejs')"
  );
});

test("app.js must set views directory", () => {
  assertMatches(
    /app\.set\(\s*['"]views['"]\s*,/,
    "app.set('views', <path>)"
  );
});

// ---------------------------------------------------------------------------
// 3. Body parsers & middleware
// ---------------------------------------------------------------------------
test("app.js must register express.urlencoded body parser", () => {
  assertMatches(
    /express\.urlencoded\s*\(/,
    "express.urlencoded({ extended: true, ... })"
  );
});

test("app.js must register express.json body parser", () => {
  assertMatches(
    /express\.json\s*\(/,
    "express.json({ limit: ... })"
  );
});

test("app.js must register methodOverride", () => {
  assertMatches(
    /methodOverride\s*\(/,
    "methodOverride(...)"
  );
});

test("app.js must use compression()", () => {
  assertMatches(
    /compression\s*\(\s*\)/,
    "compression()"
  );
});

// ---------------------------------------------------------------------------
// 4. Rate limiters — definition & mounting
// ---------------------------------------------------------------------------
test("loginLimiter must be defined with windowMs 15 min and max 20", () => {
  // Look for the loginLimiter block: windowMs: 15 * 60 * 1000 then max: 20
  // within roughly 300 chars of each other to avoid false positives.
  const match = /windowMs\s*:\s*15\s*\*\s*60\s*\*\s*1000[\s\S]{0,300}max\s*:\s*20/.test(appSrc)
             || /max\s*:\s*20[\s\S]{0,300}windowMs\s*:\s*15\s*\*\s*60\s*\*\s*1000/.test(appSrc);
  assert.ok(
    match,
    'MISSING STATEMENT: loginLimiter must have windowMs: 15 * 60 * 1000 and max: 20'
  );
});

test("loginLimiter must be applied to /auth/login route", () => {
  assertMatches(
    /app\.use\(\s*['"]\/auth\/login['"]\s*,\s*loginLimiter\s*\)/,
    "app.use('/auth/login', loginLimiter)"
  );
});

test("generalLimiter must have max 300", () => {
  assertMatches(
    /max\s*:\s*300/,
    "generalLimiter max: 300"
  );
});

test("generalLimiter skip must cover /api/cron and /auth/heartbeat", () => {
  // Both paths must appear in the skip expression (order may vary)
  const hasCron      = /\/api\/cron/.test(appSrc);
  const hasHeartbeat = /\/auth\/heartbeat/.test(appSrc);
  assert.ok(
    hasCron && hasHeartbeat,
    'MISSING STATEMENT: generalLimiter skip must reference /api/cron and /auth/heartbeat'
  );
});

test("generalLimiter must be mounted with app.use(generalLimiter)", () => {
  assertMatches(
    /app\.use\(\s*generalLimiter\s*\)/,
    "app.use(generalLimiter)"
  );
});

// ---------------------------------------------------------------------------
// 5. Session middleware
// ---------------------------------------------------------------------------
test("app.js must mount session middleware", () => {
  assertMatches(
    /app\.use\(\s*session\s*\(/,
    "app.use(session({ ... }))"
  );
});

// ---------------------------------------------------------------------------
// 6. CSRF protection
// ---------------------------------------------------------------------------
test("app.js must mount CSRF protection", () => {
  // accept csrfProtection, csurf, csrf — the actual symbol may vary
  assertMatches(
    /app\.use\(\s*csrfProtection\s*\)/,
    "app.use(csrfProtection)"
  );
});

// ---------------------------------------------------------------------------
// 7. CSP via Helmet
// ---------------------------------------------------------------------------
test("app.js must configure CSP (createCspMiddleware or contentSecurityPolicy)", () => {
  assertMatches(
    /createCspMiddleware|contentSecurityPolicy/,
    "createCspMiddleware() or helmet.contentSecurityPolicy() must appear in app.js"
  );
});

// ---------------------------------------------------------------------------
// 8. CSP report endpoint
// ---------------------------------------------------------------------------
test("app.js must mount /csp-report route", () => {
  assertMatches(
    /app\.use\(\s*['"]\/csp-report['"]/,
    "app.use('/csp-report', ...)"
  );
});

// ---------------------------------------------------------------------------
// 9. Ordering: /api/cron must be mounted BEFORE the session middleware
// ---------------------------------------------------------------------------
test("/api/cron must be mounted before session middleware", () => {
  const cronIdx    = appSrc.indexOf("'/api/cron'");
  const sessionIdx = appSrc.search(/app\.use\(\s*session\s*\(/);

  assert.ok(cronIdx !== -1,   "MISSING STATEMENT: app.use('/api/cron', ...) not found in app.js");
  assert.ok(sessionIdx !== -1, "MISSING STATEMENT: app.use(session(...)) not found in app.js");
  assert.ok(
    cronIdx < sessionIdx,
    `ORDERING VIOLATION: '/api/cron' mount (offset ${cronIdx}) must appear BEFORE session middleware (offset ${sessionIdx}).` +
    ' Cron routes must not require a session so they can be authenticated cheaply via Bearer token.'
  );
});
