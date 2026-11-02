const { test, describe } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { getCspDirectives, isCspReportOnly, createCspMiddleware } = require('../middleware/csp');

describe('CSP Production Policy Guard', () => {
  test('production directives have no unsafe-inline or unsafe-eval in script-src and script-src-attr is none', () => {
    const oldTailwindCdn = process.env.TAILWIND_CDN;
    delete process.env.TAILWIND_CDN;

    const directives = getCspDirectives({ wasm: false });

    // 1. Assert scriptSrcAttr is 'none'
    assert.deepStrictEqual(directives.scriptSrcAttr, ["'none'"], "scriptSrcAttr must be explicitly set to ['none']");

    // 2. Assert scriptSrc containment
    const scriptSrc = directives.scriptSrc;
    const scriptSrcStr = scriptSrc.map(s => (typeof s === 'function' ? s.toString() : s)).join(' ');

    assert.strictEqual(/'unsafe-inline'/.test(scriptSrcStr), false, "script-src must NOT contain 'unsafe-inline'");
    assert.strictEqual(/'unsafe-eval'/.test(scriptSrcStr), false, "script-src must NOT contain 'unsafe-eval'");
    assert.strictEqual(/blob:|data:/.test(scriptSrcStr), false, "script-src must NOT contain blob: or data:");
    assert.strictEqual(/unpkg\.com/.test(scriptSrcStr), false, "script-src must NOT contain unpkg.com");
    assert.strictEqual(/\*\.tailwindcss\.com/.test(scriptSrcStr), false, "script-src must NOT contain *.tailwindcss.com");
    assert.strictEqual(/https:\/\/cdn\.tailwindcss\.com/.test(scriptSrcStr), false, "cdn.tailwindcss.com must be omitted when TAILWIND_CDN is not true");

    // Assert dynamic nonce resolver function is present
    const nonceFn = scriptSrc.find(s => typeof s === 'function');
    assert.ok(nonceFn, "script-src must include dynamic nonce resolver function");
    assert.strictEqual(
      nonceFn({}, { locals: { cspNonce: 'TESTNONCE123' } }),
      "'nonce-TESTNONCE123'",
      "nonce function must return 'nonce-<res.locals.cspNonce>'"
    );

    // 3. Assert containment directives
    assert.deepStrictEqual(directives.objectSrc, ["'none'"], "objectSrc must be ['none']");
    assert.deepStrictEqual(directives.baseUri, ["'self'"], "baseUri must be ['self']");
    assert.deepStrictEqual(directives.formAction, ["'self'"], "formAction must be ['self']");
    assert.deepStrictEqual(directives.frameAncestors, ["'self'"], "frameAncestors must be ['self']");

    if (oldTailwindCdn !== undefined) process.env.TAILWIND_CDN = oldTailwindCdn;
  });

  test('TAILWIND_CDN=true conditionally adds cdn.tailwindcss.com for rollback', () => {
    const oldTailwindCdn = process.env.TAILWIND_CDN;
    process.env.TAILWIND_CDN = 'true';

    const directives = getCspDirectives({ wasm: false });
    assert.ok(directives.scriptSrc.includes('https://cdn.tailwindcss.com'), 'scriptSrc includes cdn.tailwindcss.com when TAILWIND_CDN=true');
    assert.ok(directives.styleSrc.includes('https://cdn.tailwindcss.com'), 'styleSrc includes cdn.tailwindcss.com when TAILWIND_CDN=true');
    assert.ok(directives.connectSrc.includes('https://cdn.tailwindcss.com'), 'connectSrc includes cdn.tailwindcss.com when TAILWIND_CDN=true');

    if (oldTailwindCdn !== undefined) process.env.TAILWIND_CDN = oldTailwindCdn;
    else delete process.env.TAILWIND_CDN;
  });

  test('report-only default and CSP_ENFORCE / CSP_REPORT_ONLY behavior', () => {
    const origEnforce = process.env.CSP_ENFORCE;
    const origReportOnly = process.env.CSP_REPORT_ONLY;

    try {
      // Default production state: report-only
      delete process.env.CSP_ENFORCE;
      delete process.env.CSP_REPORT_ONLY;
      assert.strictEqual(isCspReportOnly(), true, 'Production policy must default to report-only');

      // CSP_ENFORCE === 'true' enables enforcement
      process.env.CSP_ENFORCE = 'true';
      delete process.env.CSP_REPORT_ONLY;
      assert.strictEqual(isCspReportOnly(), false, 'CSP_ENFORCE=true should enable enforcement (not report-only)');

      // CSP_REPORT_ONLY === 'true' overrides CSP_ENFORCE
      process.env.CSP_ENFORCE = 'true';
      process.env.CSP_REPORT_ONLY = 'true';
      assert.strictEqual(isCspReportOnly(), true, 'CSP_REPORT_ONLY=true keeps forcing report-only even with CSP_ENFORCE=true');
    } finally {
      if (origEnforce !== undefined) process.env.CSP_ENFORCE = origEnforce;
      else delete process.env.CSP_ENFORCE;
      if (origReportOnly !== undefined) process.env.CSP_REPORT_ONLY = origReportOnly;
      else delete process.env.CSP_REPORT_ONLY;
    }
  });

  test('global policy excludes wasm-unsafe-eval, reward-crosscheck policy includes wasm-unsafe-eval', async () => {
    // 1. Directives comparison
    const globalDirectives = getCspDirectives({ wasm: false });
    assert.strictEqual(
      globalDirectives.scriptSrc.includes("'wasm-unsafe-eval'"),
      false,
      "global policy script-src must NOT contain 'wasm-unsafe-eval'"
    );

    const crosscheckDirectives = getCspDirectives({ wasm: true });
    assert.strictEqual(
      crosscheckDirectives.scriptSrc.includes("'wasm-unsafe-eval'"),
      true,
      "reward crosscheck policy script-src MUST contain 'wasm-unsafe-eval'"
    );

    // 2. HTTP middleware test
    const origEnforce = process.env.CSP_ENFORCE;
    const origReportOnly = process.env.CSP_REPORT_ONLY;
    process.env.CSP_ENFORCE = 'true';
    delete process.env.CSP_REPORT_ONLY;

    try {
      const app = express();
      app.use((req, res, next) => {
        res.locals.cspNonce = 'testnonce';
        next();
      });

      // App-level global CSP
      app.use(createCspMiddleware({ wasm: false }));

      // Global route
      app.get('/test-global', (req, res) => res.send('global ok'));

      // Route with per-route override (reward crosscheck)
      app.get('/reports/reward-crosscheck', createCspMiddleware({ wasm: true }), (req, res) => res.send('crosscheck ok'));

      const server = app.listen(0);
      const port = server.address().port;

      try {
        const globalRes = await fetch(`http://127.0.0.1:${port}/test-global`);
        const globalCsp = globalRes.headers.get('content-security-policy') || '';
        assert.ok(!globalCsp.includes('wasm-unsafe-eval'), 'Global policy must NOT have wasm-unsafe-eval');

        const crosscheckRes = await fetch(`http://127.0.0.1:${port}/reports/reward-crosscheck`);
        const crosscheckCsp = crosscheckRes.headers.get('content-security-policy') || '';
        assert.ok(crosscheckCsp.includes('wasm-unsafe-eval'), 'Reward crosscheck policy MUST have wasm-unsafe-eval');
      } finally {
        server.close();
      }
    } finally {
      if (origEnforce !== undefined) process.env.CSP_ENFORCE = origEnforce;
      else delete process.env.CSP_ENFORCE;
      if (origReportOnly !== undefined) process.env.CSP_REPORT_ONLY = origReportOnly;
      else delete process.env.CSP_REPORT_ONLY;
    }
  });
});
