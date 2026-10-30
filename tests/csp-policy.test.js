const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

describe('CSP Production Policy Guard', () => {
  test('production policy has no unsafe-inline in script-src and script-src-attr is none', () => {
    const appFile = fs.readFileSync(path.resolve(__dirname, '../app.js'), 'utf8');

    // 1. Assert scriptSrcAttr is 'none'
    const scriptSrcAttrMatch = appFile.match(/scriptSrcAttr:\s*\[\s*["']'none'["']\s*\]/);
    assert.ok(scriptSrcAttrMatch, "scriptSrcAttr must be explicitly set to [\"'none'\"] in app.js");

    // 2. Extract Helmet production configuration block
    const prodConfigMatch = appFile.match(/contentSecurityPolicy:\s*process\.env\.NODE_ENV\s*===\s*['"]production['"]\s*\?\s*\{([\s\S]*?)\}\s*:\s*false/);
    assert.ok(prodConfigMatch, "Helmet production CSP configuration block must exist in app.js");
    const prodConfigText = prodConfigMatch[1];

    // Extract scriptSrc directive block
    const scriptSrcMatch = prodConfigText.match(/scriptSrc:\s*\[([\s\S]*?)\]/);
    assert.ok(scriptSrcMatch, "scriptSrc directive must be configured in production CSP");
    const scriptSrcBody = scriptSrcMatch[1];

    // Assert NO 'unsafe-inline' inside scriptSrc
    assert.strictEqual(
      /'unsafe-inline'|"unsafe-inline"/.test(scriptSrcBody),
      false,
      "script-src in production CSP must NOT contain 'unsafe-inline'"
    );

    // Assert NO 'unsafe-eval' inside scriptSrc
    assert.strictEqual(
      /'unsafe-eval'|"unsafe-eval"/.test(scriptSrcBody),
      false,
      "script-src in production CSP must NOT contain 'unsafe-eval'"
    );

    // Assert NO 'blob:' or 'data:' inside scriptSrc
    assert.strictEqual(
      /blob:|data:/.test(scriptSrcBody),
      false,
      "script-src in production CSP must NOT contain blob: or data:"
    );

    // Assert NO 'unpkg.com' inside scriptSrc
    assert.strictEqual(
      /unpkg\.com/.test(scriptSrcBody),
      false,
      "script-src in production CSP must NOT contain unpkg.com"
    );

    // Assert NO wildcard tailwindcss in scriptSrc
    assert.strictEqual(
      /\*\.tailwindcss\.com/.test(scriptSrcBody),
      false,
      "script-src in production CSP must NOT contain *.tailwindcss.com"
    );

    // Assert nonce function is configured in scriptSrc
    assert.ok(
      /nonce-\$\{res\.locals\.cspNonce\}/.test(scriptSrcBody) || /nonce-'\s*\+\s*res\.locals\.cspNonce/.test(scriptSrcBody),
      "script-src must include dynamic nonce resolver function using res.locals.cspNonce"
    );

    // 3. Assert containment directives
    assert.ok(/objectSrc:\s*\[\s*["']'none'["']\s*\]/.test(prodConfigText), "objectSrc must be ['none']");
    assert.ok(/baseUri:\s*\[\s*["']'self'["']\s*\]/.test(prodConfigText), "baseUri must be ['self']");
    assert.ok(/formAction:\s*\[\s*["']'self'["']\s*\]/.test(prodConfigText), "formAction must be ['self']");
    assert.ok(/frameAncestors:\s*\[\s*["']'self'["']\s*\]/.test(prodConfigText), "frameAncestors must be ['self']");
  });
});
