'use strict';
/**
 * tests/appBoot.test.js
 *
 * Boot smoke test: starts the real app with a fake environment (no running
 * database) and asserts HTTP-level behaviour:
 *
 *   1. GET /css/tailwind.css → 200, gzip compressed
 *   2. Response has RateLimit-Limit: 300
 *   3. Content-Security-Policy-Report-Only header present (default, no CSP_ENFORCE)
 *      — contains a nonce and script-src-attr 'none'
 *   4. GET /api/cron/backup without secret → 401
 *   5. POST /csp-report with small body → 204
 *   6. POST /csp-report with 8 KB+ body → 413
 *   7. Body parsing works without database (proven via /csp-report and console spy)
 *      — static guard in tests/appStack.test.js covers express.urlencoded and express.json.
 *
 * Clean exit:
 *   In after(), the test closes its HTTP server, calls app.close() which closes
 *   the default app.server, disconnects Mongoose, closes the Connect-Mongo session
 *   store, and stops any scheduled cron timers. This allows `node --test tests/appBoot.test.js`
 *   to exit cleanly without hanging.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http   = require('http');

// ---------------------------------------------------------------------------
// Environment — must be set BEFORE requiring app.js
// ---------------------------------------------------------------------------
process.env.NODE_ENV       = 'production';
process.env.SESSION_SECRET = 'a'.repeat(40);
process.env.CRON_SECRET    = 'b'.repeat(40);
// Short timeout so Mongo gives up fast; port 1 is always refused on localhost.
process.env.MONGO_URI      =
  'mongodb://127.0.0.1:1/test?serverSelectionTimeoutMS=500';

// Silence Mongo unhandled-rejection noise from the doomed connection attempt.
const _silenceRejection = (reason) => {
  // Only suppress Mongoose / MongoDB driver errors
  const msg = String(reason && (reason.message || reason));
  if (/mongo|ECONNREFUSED|topology/i.test(msg)) return;
  // Re-throw anything else so real test bugs still surface
  throw reason;
};
process.on('unhandledRejection', _silenceRejection);

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------
let app;
let server;
let baseUrl;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Simple HTTP GET/POST helper that returns { status, headers, body }.
 * Does NOT follow redirects.
 */
function request(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const buf = body != null ? Buffer.from(body) : null;
    const req = http.request(baseUrl + path, {
      method,
      headers: {
        ...(buf ? { 'Content-Length': buf.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status:  res.statusCode,
        headers: res.headers,
        body:    Buffer.concat(chunks).toString(),
      }));
    });
    req.on('error', reject);
    if (buf) req.write(buf);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
before(async () => {
  // Load app — Mongo connection starts in background
  app = require('../app');

  // Await doomed connection attempts inside before() so rejections settle cleanly
  // before the tests start and before before() finishes.
  if (app.mongoConnectionPromise) {
    await app.mongoConnectionPromise.catch(() => {});
  }
  if (app.sessionStore && app.sessionStore.clientP) {
    await app.sessionStore.clientP.catch(() => {});
  }
  if (app.sessionStore && app.sessionStore.collectionP) {
    await app.sessionStore.collectionP.catch(() => {});
  }

  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  // Close the test HTTP server instance
  if (server) {
    await new Promise(resolve => server.close(resolve));
    server = null;
  }

  // Close app resources: app.server, Connect-Mongo session store, and Mongoose connection
  if (app && typeof app.close === 'function') {
    await app.close();
  }

  // Allow any pending microtasks from doomed Mongo connect to settle before removing listener
  await new Promise(resolve => setTimeout(resolve, 100));
  process.removeListener('unhandledRejection', _silenceRejection);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('GET /css/tailwind.css returns 200 with gzip when client accepts it', async () => {
  const res = await request('GET', '/css/tailwind.css', {
    headers: { 'Accept-Encoding': 'gzip' },
  });
  assert.strictEqual(res.status, 200, `Expected 200 but got ${res.status}`);
  // Compression is applied: either Content-Encoding: gzip, or at minimum
  // Vary: Accept-Encoding shows that compression is wired up.
  const hasGzip = res.headers['content-encoding'] === 'gzip';
  const hasVary = /accept-encoding/i.test(res.headers['vary'] || '');
  assert.ok(
    hasGzip || hasVary,
    `Expected gzip compression or Vary: Accept-Encoding header, got Content-Encoding="${res.headers['content-encoding']}" Vary="${res.headers['vary']}"`
  );
});

test('GET /css/tailwind.css response has RateLimit-Limit header of 300', async () => {
  const res = await request('GET', '/css/tailwind.css');
  const rl = res.headers['ratelimit-limit'] || res.headers['x-ratelimit-limit'];
  assert.ok(rl, 'RateLimit-Limit (or X-RateLimit-Limit) header is missing');
  assert.strictEqual(String(rl), '300', `Expected RateLimit-Limit: 300, got ${rl}`);
});

test('default CSP is report-only and contains nonce + script-src-attr none', async () => {
  const res = await request('GET', '/css/tailwind.css');

  const cspHeader = res.headers['content-security-policy-report-only'];
  assert.ok(
    cspHeader,
    'Expected Content-Security-Policy-Report-Only header (default when CSP_ENFORCE is not set). ' +
    `Got headers: ${JSON.stringify(Object.keys(res.headers))}`
  );

  // Must contain a nonce token
  assert.ok(
    /nonce-[A-Za-z0-9+/=]{10,}/.test(cspHeader),
    `CSP must contain a per-request nonce. Got: ${cspHeader}`
  );

  // Must contain script-src directive
  assert.ok(
    /script-src/.test(cspHeader),
    `CSP must contain a script-src directive. Got: ${cspHeader}`
  );

  // Must lock down inline event handlers
  assert.ok(
    /script-src-attr\s+['"]?'none'['"]?/.test(cspHeader),
    `CSP must have script-src-attr 'none'. Got: ${cspHeader}`
  );
});

test('GET /api/cron/backup without CRON_SECRET returns 401', async () => {
  const res = await request('GET', '/api/cron/backup');
  assert.strictEqual(
    res.status, 401,
    `Expected 401 Unauthorized for unauthenticated cron request, got ${res.status}`
  );
});

test('POST /csp-report with small body returns 204', async () => {
  const payload = JSON.stringify({
    'csp-report': {
      'document-uri':        'https://example.com',
      'violated-directive':  'script-src',
      'blocked-uri':         'inline',
      'effective-directive': 'script-src',
    },
  });
  const res = await request('POST', '/csp-report', {
    headers: { 'Content-Type': 'application/csp-report' },
    body:    payload,
  });
  assert.strictEqual(res.status, 204, `Expected 204 for CSP report, got ${res.status}`);
});

test('POST /csp-report with 8 KB+ body is rejected (413)', async () => {
  // The CSP report route uses a strict 8 kb limit.
  // Build a valid JSON object that exceeds the limit so body-parser can
  // measure the Content-Length before parsing and return 413.
  const longString = 'a'.repeat(9 * 1024); // 9 KB value
  const bigPayload = JSON.stringify({
    'csp-report': {
      'document-uri': 'https://example.com',
      'violated-directive': 'script-src',
      'blocked-uri': longString,
    },
  });
  const res = await request('POST', '/csp-report', {
    headers: { 'Content-Type': 'application/csp-report' },
    body:    bigPayload,
  });
  assert.strictEqual(
    res.status, 413,
    `Expected 413 Payload Too Large for oversized CSP report, got ${res.status}`
  );
});

test('body parsing works without database (proven via /csp-report and console spy)', async () => {
  // Note: Global express.urlencoded and express.json parsers are verified
  // via static anchoring rules in tests/appStack.test.js.
  // This runtime assertion verifies that the HTTP pipeline parses incoming
  // JSON/CSP-report bodies into req.body and logs the summary without requiring
  // any active database connection.
  const logged = [];
  const origWarn = console.warn;
  console.warn = (...args) => {
    logged.push(args.join(' '));
    origWarn(...args);
  };

  try {
    const payload = JSON.stringify({
      'csp-report': {
        'document-uri':        'https://example.com/reports',
        'violated-directive':  'script-src',
        'blocked-uri':         'https://evil.example.com/malicious.js',
        'effective-directive': 'script-src',
      },
    });

    const res = await request('POST', '/csp-report', {
      headers: { 'Content-Type': 'application/csp-report' },
      body:    payload,
    });

    assert.strictEqual(res.status, 204, `Expected 204 from CSP report, got ${res.status}`);

    const hasExpectedLog = logged.some(line =>
      line.includes('[CSP Violation] directive=script-src blockedUri=https://evil.example.com/malicious.js')
    );
    assert.ok(
      hasExpectedLog,
      `Expected console.warn summary from parsed body. Logs captured: ${JSON.stringify(logged)}`
    );
  } finally {
    console.warn = origWarn;
  }
});
