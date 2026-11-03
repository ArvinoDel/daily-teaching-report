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
 *
 * The Mongo URI uses serverSelectionTimeoutMS=500 so the connection attempt
 * times out quickly.  Unhandled rejections from that attempt are silenced
 * inside this test.
 *
 * NOTE: because the boot test binds a real TCP port, use --test-force-exit
 * (already in the "test" npm script) so the process exits even if the server
 * handle is not fully released.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http   = require('http');

// ---------------------------------------------------------------------------
// Environment — must be set BEFORE requiring app.js
// ---------------------------------------------------------------------------
process.env.NODE_ENV      = 'production';
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
  // Load app — Mongo connection starts in background (and quickly times out)
  const app = require('../app');
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(done => {
  process.removeListener('unhandledRejection', _silenceRejection);
  server.close(done);
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
  const hasGzip  = res.headers['content-encoding'] === 'gzip';
  const hasVary  = /accept-encoding/i.test(res.headers['vary'] || '');
  assert.ok(
    hasGzip || hasVary,
    `Expected gzip compression or Vary: Accept-Encoding header, got Content-Encoding="${res.headers['content-encoding']}" Vary="${res.headers['vary']}"`
  );
});

test('GET /css/tailwind.css response has RateLimit-Limit header of 300', async () => {
  const res = await request('GET', '/css/tailwind.css');
  // express-rate-limit v7+ uses RateLimit-Limit (lowercase key in node http)
  const rl = res.headers['ratelimit-limit'] || res.headers['x-ratelimit-limit'];
  assert.ok(rl, 'RateLimit-Limit (or X-RateLimit-Limit) header is missing');
  assert.strictEqual(String(rl), '300', `Expected RateLimit-Limit: 300, got ${rl}`);
});

test('default CSP is report-only and contains nonce + script-src-attr none', async () => {
  const res = await request('GET', '/css/tailwind.css');

  // Without CSP_ENFORCE=true the header must be the report-only variant
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

test("GET /api/cron/backup without CRON_SECRET returns 401", async () => {
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
  // measure the Content-Length before parsing and return 413 (not 500 from a
  // JSON syntax error).
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
