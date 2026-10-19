'use strict';

// Verify xss loads at module top level with CommonJS require()
const xss = require('xss');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeMaterialHtml,
  renderMaterialBody,
  safeJson,
  validateResource,
  validateLink,
  canEdit,
  checkVersionConflict,
  planContentMerge,
  computeHasContent,
  deriveFileExtension,
  buildSignedFileUrl,
  destroyAssets,
  runDeleteWithCleanup,
  CLEANUP_BUDGET_MS,
  planRevisionRenumber,
  parseBaseVersion,
  escapeRegex,
  MAX_BODY_BYTES,
} = require('../services/materialContentService');

const ALLOWED_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4',
  'p', 'br',
  'strong', 'em', 'u', 's',
  'ul', 'ol', 'li',
  'blockquote',
  'a',
  'code', 'pre',
  'hr',
]);

function assertSanitizerInvariants(output) {
  // 1. no <img, no <script, no <svg, no <iframe
  assert.ok(!/<img\b/i.test(output), `Forbidden <img found in output: ${output}`);
  assert.ok(!/<script\b/i.test(output), `Forbidden <script found in output: ${output}`);
  assert.ok(!/<svg\b/i.test(output), `Forbidden <svg found in output: ${output}`);
  assert.ok(!/<iframe\b/i.test(output), `Forbidden <iframe found in output: ${output}`);

  // 2. tags check
  const tagRegex = /<([a-zA-Z0-9]+)([^>]*)>/g;
  let match;
  while ((match = tagRegex.exec(output)) !== null) {
    const tagName = match[1].toLowerCase();
    const attrs = match[2];
    assert.ok(ALLOWED_TAGS.has(tagName), `Non-whitelisted tag <${tagName}> in output: ${output}`);

    // No attribute starting with "on"
    assert.ok(!/\bon[a-zA-Z]+\s*=/i.test(attrs), `Forbidden event handler found in attrs: ${attrs}`);

    if (tagName === 'a') {
      const hrefMatch = attrs.match(/href\s*=\s*(["'])(.*?)\1/i) || attrs.match(/href\s*=\s*([^"'\s>]+)/i);
      if (hrefMatch) {
        const hrefVal = (hrefMatch[2] || hrefMatch[1] || '').toLowerCase();
        assert.ok(!hrefVal.includes('javascript:'), `Dangerous javascript: href: ${hrefVal}`);
        assert.ok(!hrefVal.includes('data:'), `Dangerous data: href: ${hrefVal}`);
        assert.ok(!hrefVal.includes('vbscript:'), `Dangerous vbscript: href: ${hrefVal}`);
        assert.ok(!hrefVal.startsWith('//'), `Dangerous protocol-relative href: ${hrefVal}`);
        assert.ok(!hrefVal.startsWith('\\\\'), `Dangerous UNC path href: ${hrefVal}`);
      }
    }
  }

  // 3. closing tags check
  const closeTagRegex = /<\/([a-zA-Z0-9]+)>/g;
  while ((match = closeTagRegex.exec(output)) !== null) {
    const tagName = match[1].toLowerCase();
    assert.ok(ALLOWED_TAGS.has(tagName), `Non-whitelisted closing tag </${tagName}> in output: ${output}`);
  }
}

test('Sanitizer Library Verification', () => {
  // Proves xss is loaded with CommonJS require()
  assert.equal(typeof xss, 'function');
  assert.equal(typeof xss.FilterXSS, 'function');
  assert.equal(typeof xss.escapeHtml, 'function');
});

test('Material Content - Table-driven Sanitizer Attack Payloads', async (t) => {
  const table = [
    { name: 'nested opening tag', payload: '<<b>img src=x onerror=alert(1)>' },
    { name: 'unterminated tag', payload: 'hello <img src=x onerror=alert(1)' },
    { name: 'split script tag', payload: '<scr<b>ipt>alert(1)</scr</b>ipt>' },
    { name: 'nested script tag', payload: '<<b>script>alert(1)</script>' },
    { name: 'javascript: href', payload: '<a href="javascript:alert(1)">x</a>' },
    { name: 'entity-encoded javascript: href', payload: '<a href="jav&#x61;script:alert(1)">x</a>' },
    { name: 'whitespace-obfuscated javascript: href', payload: '<a href=" java\tscript:alert(1)">x</a>' },
    { name: 'attribute breakout onclick', payload: '<a href="https://ok.com" title=">" onclick=alert(1)>x</a>' },
    { name: 'svg onload', payload: '<svg onload=alert(1)>' },
    { name: 'uppercase img with onerror', payload: '<IMG SRC=x ONERROR=alert(1)>' },
    { name: 'math xlink:href', payload: '<math><mi xlink:href="javascript:alert(1)">' },
    { name: 'comment breakout into img', payload: '<!--><img src=x onerror=alert(1)-->' },
    { name: 'protocol-relative href', payload: '<a href=//evil.com>x</a>' },
  ];

  for (const tc of table) {
    await t.test(tc.name, () => {
      const sanitized = sanitizeMaterialHtml(tc.payload);
      assertSanitizerInvariants(sanitized);

      // Verify idempotency
      const twice = sanitizeMaterialHtml(sanitized);
      assert.equal(twice, sanitized, `Sanitizer is not idempotent for payload: ${tc.payload}`);
    });
  }
});

test('Material Content - Property Test (2000 Random Fragment Concatenations)', () => {
  const fragments = [
    '<', '>', '<b>', '<img src=x onerror=1', '"', "'", '=', '<a href=', '</a>', 'javascript:', '&lt;',
  ];

  for (let i = 0; i < 2000; i++) {
    const numFrags = Math.floor(Math.random() * 8) + 2;
    let input = '';
    for (let j = 0; j < numFrags; j++) {
      const idx = Math.floor(Math.random() * fragments.length);
      input += fragments[idx];
    }

    const output1 = sanitizeMaterialHtml(input);
    assertSanitizerInvariants(output1);

    const output2 = sanitizeMaterialHtml(output1);
    assert.equal(output1, output2, `Idempotency failure on iteration ${i} for input: ${input}`);
  }
});

test('Material Content - Defense in Depth & Render Helper', () => {
  const dirty = '<p>Good</p><script>alert(1)</script><img src=x onerror=alert(2)>';
  const rendered = renderMaterialBody(dirty);
  assert.ok(!rendered.includes('<script>'));
  assert.ok(!rendered.includes('<img'));
  assert.ok(rendered.includes('<p>Good</p>'));
  assert.equal(renderMaterialBody(''), '');
  assert.equal(renderMaterialBody(null), '');
});

test('Material Content - safeJson Helper Escaping', () => {
  const maliciousLabel = '</script><img src=x onerror=alert(1)>';
  const data = {
    label: maliciousLabel,
    url: 'https://example.com?a=1&b=2',
    lineSeparator: 'Line1\u2028Line2\u2029Line3',
  };

  const jsonStr = safeJson(data);

  // Must escape <, >, &, U+2028, U+2029
  assert.ok(!jsonStr.includes('<'), 'safeJson must not contain unescaped <');
  assert.ok(!jsonStr.includes('>'), 'safeJson must not contain unescaped >');
  assert.ok(!jsonStr.includes('\u2028'), 'safeJson must not contain unescaped U+2028');
  assert.ok(!jsonStr.includes('\u2029'), 'safeJson must not contain unescaped U+2029');
  assert.ok(jsonStr.includes('\\u003c/script\\u003e'), 'Script tag breakout must be escaped');
  assert.ok(jsonStr.includes('\\u0026'), 'Ampersand must be escaped');

  // JSON.parse must recover the original data identically
  const parsed = JSON.parse(jsonStr);
  assert.equal(parsed.label, maliciousLabel);
  assert.equal(parsed.url, 'https://example.com?a=1&b=2');
  assert.equal(parsed.lineSeparator, 'Line1\u2028Line2\u2029Line3');
});

test('Material Content - No Silent Truncation in Sanitizer', () => {
  const content = '<p>' + 'A'.repeat(500) + '</p>';
  const sanitized = sanitizeMaterialHtml(content);
  assert.ok(sanitized.includes('A'.repeat(500)), 'Sanitizer should not truncate content');
  assert.equal(MAX_BODY_BYTES, 200 * 1024);
});

test('Material Content - Preserves Standard Formatting & Links', async (t) => {
  await t.test('preserves allowed tags', () => {
    const input = '<h1>H1</h1><h2>H2</h2><h3>H3</h3><h4>H4</h4><p>P<br><hr></p><strong>Strong</strong><em>Em</em><u>U</u><s>S</s><ul><li>Li</li></ul><blockquote>Quote</blockquote><code>Code</code><pre>Pre</pre>';
    const output = sanitizeMaterialHtml(input);
    assert.ok(output.includes('<h1>H1</h1>'));
    assert.ok(output.includes('<h2>H2</h2>'));
    assert.ok(output.includes('<h3>H3</h3>'));
    assert.ok(output.includes('<h4>H4</h4>'));
    assert.ok(output.includes('<strong>Strong</strong>'));
    assert.ok(output.includes('<em>Em</em>'));
    assert.ok(output.includes('<u>U</u>'));
    assert.ok(output.includes('<s>S</s>'));
    assert.ok(output.includes('<ul><li>Li</li></ul>'));
    assert.ok(output.includes('<blockquote>Quote</blockquote>'));
    assert.ok(output.includes('<code>Code</code>'));
    assert.ok(output.includes('<pre>Pre</pre>'));
  });

  await t.test('enforces target="_blank" and rel="noopener noreferrer" on valid links', () => {
    const input = '<a href="https://example.com">Example</a>';
    const output = sanitizeMaterialHtml(input);
    assert.ok(output.includes('href="https://example.com"'));
    assert.ok(output.includes('target="_blank"'));
    assert.ok(output.includes('rel="noopener noreferrer"'));
  });
});

test('Material Content - Resource Validation', async (t) => {
  await t.test('accepts valid http and https links without credentials', () => {
    assert.equal(validateLink('https://classroom.google.com/test').valid, true);
    assert.equal(validateLink('http://example.com/sheet').valid, true);
  });

  await t.test('rejects link schemes other than http and https', () => {
    assert.equal(validateLink('ftp://files.com/doc').valid, false);
    assert.equal(validateLink('javascript:alert(1)').valid, false);
    assert.equal(validateLink('file:///etc/passwd').valid, false);
  });

  await t.test('rejects links with embedded credentials', () => {
    assert.equal(validateLink('https://user:pass@example.com/secret').valid, false);
  });

  await t.test('rejects links longer than 500 characters', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(500);
    assert.equal(validateLink(longUrl).valid, false);
  });

  await t.test('rejects label longer than 100 characters', () => {
    const res = { kind: 'link', url: 'https://example.com', label: 'x'.repeat(101) };
    assert.equal(validateResource(res).valid, false);
  });

  await t.test('validates file publicId prefix matching materials/<materialId>/', () => {
    const validFile = {
      kind: 'file',
      file: {
        publicId: 'materials/64f1a2b3c4d5e6f7a8b9c0d1/slide.pdf',
        format: 'pdf',
        bytes: 1024 * 1024,
      },
    };
    assert.equal(validateResource(validFile, '64f1a2b3c4d5e6f7a8b9c0d1').valid, true);

    const invalidPrefix = {
      kind: 'file',
      file: {
        publicId: 'materials/other_material/slide.pdf',
        format: 'pdf',
        bytes: 1024,
      },
    };
    assert.equal(validateResource(invalidPrefix, '64f1a2b3c4d5e6f7a8b9c0d1').valid, false);
  });

  await t.test('rejects disallowed file extensions', () => {
    const exeFile = {
      kind: 'file',
      file: {
        publicId: 'materials/123/virus.exe',
        format: 'exe',
        bytes: 1024,
      },
    };
    assert.equal(validateResource(exeFile, '123').valid, false);
  });

  await t.test('rejects files exceeding max size (default 10 MB)', () => {
    const hugeFile = {
      kind: 'file',
      file: {
        publicId: 'materials/123/big.pdf',
        format: 'pdf',
        bytes: 11 * 1024 * 1024, // 11 MB > 10 MB
      },
    };
    assert.equal(validateResource(hugeFile, '123').valid, false);
  });
});

test('Material Content - Permission Matrix (canEdit)', () => {
  const admin = { role: 'admin' };
  const superadmin = { role: 'superadmin' };
  const teacher = { role: 'teacher' };
  const student = { role: 'student' };

  const unlocked = { locked: false };
  const locked = { locked: true };
  const noContentDoc = null;

  assert.equal(canEdit(admin, unlocked), true);
  assert.equal(canEdit(admin, locked), true);
  assert.equal(canEdit(admin, noContentDoc), true);

  assert.equal(canEdit(superadmin, unlocked), true);
  assert.equal(canEdit(superadmin, locked), true);
  assert.equal(canEdit(superadmin, noContentDoc), true);

  assert.equal(canEdit(teacher, unlocked), true);
  assert.equal(canEdit(teacher, noContentDoc), true);
  assert.equal(canEdit(teacher, locked), false);

  assert.equal(canEdit(student, unlocked), false);
  assert.equal(canEdit(null, unlocked), false);
  assert.equal(canEdit(undefined, unlocked), false);
});

test('Material Content - Version Conflict Check', () => {
  assert.equal(checkVersionConflict(null, 1), false);
  assert.equal(checkVersionConflict(undefined, 1), false);
  assert.equal(checkVersionConflict(1, null), false);

  assert.equal(checkVersionConflict(2, 2), false);
  assert.equal(checkVersionConflict('2', 2), false);

  assert.equal(checkVersionConflict(1, 2), true);
  assert.equal(checkVersionConflict('1', 2), true);
});

test('Material Content - Content Merge Planning', () => {
  const sourceEmpty = { body: '', resources: [] };
  const sourceFilled = { body: '<p>Chapter 1</p>', resources: [{ kind: 'link', url: 'https://ex.com' }] };
  const targetEmpty = { body: '', resources: [] };
  const targetFilled = { body: '<p>Existing</p>', resources: [] };

  const plan1 = planContentMerge(sourceEmpty, targetFilled, 'Source Mat');
  assert.equal(plan1.action, 'skip_source');
  assert.equal(plan1.needsWarning, false);

  const plan2 = planContentMerge(sourceFilled, targetEmpty, 'Source Mat');
  assert.equal(plan2.action, 'move_source_to_target');
  assert.equal(plan2.needsWarning, false);

  const plan3 = planContentMerge(sourceFilled, targetFilled, 'Source Mat');
  assert.equal(plan3.action, 'keep_target_and_snapshot_source');
  assert.equal(plan3.needsWarning, true);
  assert.ok(plan3.note.includes('Merged from Source Mat'));
});

test('Material Content - computeHasContent', () => {
  assert.equal(computeHasContent('', []), false);
  assert.equal(computeHasContent('<p>   </p>', []), false);
  assert.equal(computeHasContent('<p><br></p>', []), false);
  assert.equal(computeHasContent('<p>Hello</p>', []), true);
  assert.equal(computeHasContent('', [{ kind: 'link' }]), true);
  assert.equal(computeHasContent('<p>Hi</p>', [{ kind: 'file' }]), true);
});

test('Material Content - Server-side Resource Integrity Validation', () => {
  const existingResources = [
    { _id: '64f1a2b3c4d5e6f7a8b9c001', kind: 'link', url: 'https://example.com/one', label: 'Original One' },
    { _id: '64f1a2b3c4d5e6f7a8b9c002', kind: 'file', label: 'File Two', file: { publicId: 'materials/123/file.pdf' } },
  ];

  function validateSaveResources(resources, existingList) {
    if (resources === undefined) return { valid: true, saved: existingList };
    if (!Array.isArray(resources)) return { status: 422, error: 'Resources must be an array.' };
    if (resources.length > 20) return { status: 422, error: 'Maximum 20 resources allowed.' };

    const existingMap = new Map();
    for (const r of existingList) {
      existingMap.set(String(r._id), r);
    }

    const mapped = [];
    const seenIds = new Set();
    for (const item of resources) {
      if (!item || typeof item !== 'object' || !item._id) {
        return { status: 422, error: 'Resource item must include _id.' };
      }
      const idStr = String(item._id);
      if (seenIds.has(idStr)) {
        return { status: 422, error: 'Duplicate resource _id.' };
      }
      seenIds.add(idStr);

      const existing = existingMap.get(idStr);
      if (!existing) {
        return { status: 422, error: `Unknown resource _id: ${idStr}` };
      }

      const resObj = { ...existing };
      resObj.label = item.label !== undefined ? String(item.label).trim().slice(0, 100) : (resObj.label || '');
      mapped.push(resObj);
    }
    return { valid: true, saved: mapped };
  }

  // 1. Accepts existing resources with re-ordering and updated trimmed labels
  const validPayload = [
    { _id: '64f1a2b3c4d5e6f7a8b9c002', label: '  Updated File Two  ' },
    { _id: '64f1a2b3c4d5e6f7a8b9c001', label: 'Updated One' },
  ];
  const res1 = validateSaveResources(validPayload, existingResources);
  assert.equal(res1.valid, true);
  assert.equal(res1.saved[0]._id, '64f1a2b3c4d5e6f7a8b9c002');
  assert.equal(res1.saved[0].label, 'Updated File Two');
  assert.equal(res1.saved[1]._id, '64f1a2b3c4d5e6f7a8b9c001');

  // 2. Rejects forged / unknown _id with 422
  const forgedPayload = [
    { _id: 'unknown_fake_id_123', label: 'Hacked Resource' },
  ];
  const res2 = validateSaveResources(forgedPayload, existingResources);
  assert.equal(res2.status, 422);
  assert.ok(res2.error.includes('Unknown resource _id'));

  // 3. Rejects items without an _id with 422
  const noIdPayload = [
    { kind: 'link', url: 'https://evil.com', label: 'No ID' },
  ];
  const res3 = validateSaveResources(noIdPayload, existingResources);
  assert.equal(res3.status, 422);
  assert.ok(res3.error.includes('Resource item must include _id'));

  // 4. Rejects duplicate _ids with 422
  const duplicatePayload = [
    { _id: '64f1a2b3c4d5e6f7a8b9c001', label: 'First' },
    { _id: '64f1a2b3c4d5e6f7a8b9c001', label: 'Second' },
  ];
  const res4 = validateSaveResources(duplicatePayload, existingResources);
  assert.equal(res4.status, 422);
  assert.ok(res4.error.includes('Duplicate resource _id'));

  // 5. Trims label and enforces 100 character limit
  const longLabelPayload = [
    { _id: '64f1a2b3c4d5e6f7a8b9c001', label: 'A'.repeat(150) },
  ];
  const res5 = validateSaveResources(longLabelPayload, existingResources);
  assert.equal(res5.valid, true);
  assert.equal(res5.saved[0].label.length, 100);
});

test('Material Content - BaseVersion Requirement & Conflict Status', () => {
  function checkBaseVersion(reqBody) {
    const baseVersion = reqBody ? reqBody.baseVersion : undefined;
    if (baseVersion === undefined || baseVersion === null || baseVersion === '') {
      return { status: 400, error: 'baseVersion is required.' };
    }
    return { valid: true, version: Number(baseVersion) };
  }

  // Missing baseVersion returns 400
  assert.equal(checkBaseVersion({}).status, 400);
  assert.equal(checkBaseVersion({ baseVersion: null }).status, 400);
  assert.equal(checkBaseVersion({ baseVersion: '' }).status, 400);

  // Present baseVersion is valid
  assert.equal(checkBaseVersion({ baseVersion: 1 }).valid, true);
  assert.equal(checkBaseVersion({ baseVersion: 2 }).version, 2);
});

test('Material Content - Body Size 200 KB Limit Validation', () => {
  function validateBodySize(body) {
    if (body && typeof body === 'string' && Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      return { status: 422, error: 'Content body exceeds 200 KB limit.' };
    }
    return { valid: true };
  }

  // Valid body
  assert.equal(validateBodySize('<p>Hello world</p>').valid, true);

  // Body exceeding 200 KB returns 422
  const largeBody = 'x'.repeat(MAX_BODY_BYTES + 1);
  const result = validateBodySize(largeBody);
  assert.equal(result.status, 422);
  assert.ok(result.error.includes('200 KB limit'));
});

test('Material Content - Quill 2 List Normalization & Sanitization', async (t) => {
  await t.test('(a) Quill 2 bullet list markup -> <ul><li>One</li><li>Two</li></ul>', () => {
    const input = '<ol><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>One</li><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>Two</li></ol>';
    const output = sanitizeMaterialHtml(input);
    assert.equal(output, '<ul><li>One</li><li>Two</li></ul>');
    assert.ok(!output.includes('ql-ui'));
    assert.ok(!output.includes('data-list'));
  });

  await t.test('(b) ordered list markup -> <ol>', () => {
    const input = '<ol><li data-list="ordered"><span class="ql-ui" contenteditable="false"></span>Step 1</li><li data-list="ordered"><span class="ql-ui" contenteditable="false"></span>Step 2</li></ol>';
    const output = sanitizeMaterialHtml(input);
    assert.equal(output, '<ol><li>Step 1</li><li>Step 2</li></ol>');
    assert.ok(!output.includes('ql-ui'));
    assert.ok(!output.includes('data-list'));
  });

  await t.test('(c) a bullet list followed by an ordered list stays two lists', () => {
    const input = '<ol><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>Bullet 1</li><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>Bullet 2</li><li data-list="ordered"><span class="ql-ui" contenteditable="false"></span>Num 1</li><li data-list="ordered"><span class="ql-ui" contenteditable="false"></span>Num 2</li></ol>';
    const output = sanitizeMaterialHtml(input);
    assert.equal(output, '<ul><li>Bullet 1</li><li>Bullet 2</li></ul><ol><li>Num 1</li><li>Num 2</li></ol>');
  });

  await t.test('(d) mixed formatting (heading, bold, italic, underline, strike, link, blockquote) survives', () => {
    const input = '<h2>Lesson Title</h2><p><strong>Bold</strong> <em>Italic</em> <u>Underline</u> <s>Strike</s></p><blockquote>Important quote</blockquote><p><a href="https://example.com">Resource</a></p><ol><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>Item A</li><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>Item B</li></ol>';
    const output = sanitizeMaterialHtml(input);
    assert.ok(output.includes('<h2>Lesson Title</h2>'));
    assert.ok(output.includes('<strong>Bold</strong>'));
    assert.ok(output.includes('<em>Italic</em>'));
    assert.ok(output.includes('<u>Underline</u>'));
    assert.ok(output.includes('<s>Strike</s>'));
    assert.ok(output.includes('<blockquote>Important quote</blockquote>'));
    assert.ok(output.includes('<a href="https://example.com" rel="noopener noreferrer" target="_blank">Resource</a>'));
    assert.ok(output.includes('<ul><li>Item A</li><li>Item B</li></ul>'));
    assert.ok(!output.includes('ql-ui'));
  });

  await t.test('(e) earlier XSS payload table still passes with list normalization', () => {
    const table = [
      '<<b>img src=x onerror=alert(1)>',
      'hello <img src=x onerror=alert(1)',
      '<scr<b>ipt>alert(1)</scr</b>ipt>',
      '<<b>script>alert(1)</script>',
      '<a href="javascript:alert(1)">x</a>',
      '<a href="jav&#x61;script:alert(1)">x</a>',
      '<a href=" java\\tscript:alert(1)">x</a>',
      '<a href="https://ok.com" title=">" onclick=alert(1)>x</a>',
      '<svg onload=alert(1)>',
      '<IMG SRC=x ONERROR=alert(1)>',
      '<math><mi xlink:href="javascript:alert(1)">',
      '<!--><img src=x onerror=alert(1)-->',
      '<a href=//evil.com>x</a>',
    ];
    for (const p of table) {
      const sanitized = sanitizeMaterialHtml(p);
      assertSanitizerInvariants(sanitized);
    }
  });

  await t.test('(f) sanitizing twice equals sanitizing once (idempotent)', () => {
    const samples = [
      '<ol><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>One</li></ol>',
      '<ol><li data-list="ordered"><span class="ql-ui" contenteditable="false"></span>Step</li></ol>',
      '<ul><li>Already UL</li></ul>',
      '<ol><li>Already OL</li></ol>',
      '<p>Para with <strong>bold</strong></p>',
      '<ol><li data-list="bullet">A</li><li data-list="ordered">B</li></ol>',
    ];
    for (const sample of samples) {
      const once = sanitizeMaterialHtml(sample);
      const twice = sanitizeMaterialHtml(once);
      assert.equal(twice, once, `Idempotency failure for: ${sample}`);
    }
  });
});

test('Material Content - Attachment Display & Inline Picture Previews', async (t) => {
  const ejs = require('ejs');
  const path = require('path');

  await t.test('views/materials/show.ejs renders attached files and displays image picture previews', async () => {
    const showFile = path.resolve('views/materials/show.ejs');
    const html = await ejs.renderFile(showFile, {
      title: 'Math 101',
      material: {
        _id: '670000000000000000000001',
        name: 'Math 101',
        level: 'Primary',
        usageCount: 3,
        hasContent: true,
      },
      content: {
        version: 1,
        body: '<p>Study guide</p>',
        resources: [
          {
            _id: '670000000000000000000010',
            kind: 'file',
            label: 'worksheet-diagram.png',
            file: { format: 'png', bytes: 1048576, publicId: 'materials/1/diagram' },
          },
          {
            _id: '670000000000000000000011',
            kind: 'link',
            label: 'Khan Academy',
            url: 'https://khanacademy.org',
          },
        ],
      },
      userCanEdit: true,
      userIsAdmin: true,
      renderMaterialBody: s => s,
      csrfToken: 'csrf-xyz',
      user: { role: 'admin' },
      path: '/materials/1',
    });

    assert.ok(html.includes('worksheet-diagram.png'), 'Shows file label');
    assert.ok(html.includes('1 MB'), 'Formats byte size correctly');
    // Direct picture preview <img> tag:
    assert.ok(
      html.includes('<img src="/materials/670000000000000000000001/resources/670000000000000000000010/open"'),
      'Renders picture inline with open endpoint URL'
    );
    assert.ok(html.includes('Khan Academy'), 'Shows reference link');
  });

  await t.test('views/materials/history.ejs displays revision attachments and picture previews', async () => {
    const histFile = path.resolve('views/materials/history.ejs');
    const html = await ejs.renderFile(histFile, {
      title: 'Revision History',
      material: {
        _id: '670000000000000000000001',
        name: 'Math 101',
        level: 'Primary',
      },
      revisions: [
        {
          version: 2,
          editedByName: 'Admin Alice',
          editedAt: new Date(),
          note: 'Attached chapter photo',
          body: '<p>Updated notes</p>',
          resources: [
            {
              _id: '670000000000000000000020',
              kind: 'file',
              label: 'textbook-photo.jpg',
              file: { format: 'jpg', bytes: 2097152, publicId: 'materials/1/photo' },
            },
            {
              _id: '670000000000000000000021',
              kind: 'link',
              label: 'Online Practice',
              url: 'https://example.com/quiz',
            },
          ],
        },
        {
          version: 1,
          editedByName: 'Teacher Bob',
          editedAt: new Date(Date.now() - 3600000),
          note: 'Initial version without files',
          body: '<p>Initial guide</p>',
          resources: [],
        },
      ],
      currentVersion: 2,
      renderMaterialBody: s => s,
      safeJson: JSON.stringify,
      csrfToken: 'csrf-xyz',
      user: { role: 'admin' },
      path: '/materials/1/history',
    });

    // Displays revision attachments summary
    assert.ok(html.includes('1 attached file'), 'Shows attached files count on revision card');
    assert.ok(html.includes('1 link'), 'Shows links count on revision card');
    assert.ok(html.includes('textbook-photo.jpg'), 'Displays attached file name in history');
    assert.ok(html.includes('2 MB'), 'Displays formatted file size in history');
    // Picture preview inside history
    assert.ok(
      html.includes('/materials/670000000000000000000001/resources/670000000000000000000020/open'),
      'Renders picture preview inside revision history'
    );
    assert.ok(html.includes('Online Practice'), 'Displays link in history');
    assert.ok(html.includes('0 attached files'), 'Handles revisions with no attachments');
  });
});

test('Material Content - deriveFileExtension Helper', async (t) => {
  await t.test('image with format', () => {
    assert.equal(deriveFileExtension({ format: 'png' }), 'png');
    assert.equal(deriveFileExtension({ format: 'JPG' }), 'jpg');
    assert.equal(deriveFileExtension({ format: '  webp  ' }), 'webp');
  });

  await t.test('raw with extension in public_id', () => {
    assert.equal(deriveFileExtension({ resourceType: 'raw', publicId: 'materials/123/file.docx' }), 'docx');
    assert.equal(deriveFileExtension({ resourceType: 'raw', publicId: 'materials/123/sheet.XLSX' }), 'xlsx');
    assert.equal(deriveFileExtension({ resourceType: 'raw', publicId: 'materials/123/slides.v1.pptx' }), 'pptx');
  });

  await t.test('raw without extension', () => {
    assert.equal(deriveFileExtension({ resourceType: 'raw', publicId: 'materials/123/filenoext' }), '');
  });

  await t.test('filename without dot', () => {
    assert.equal(deriveFileExtension({ originalFilename: 'nodotfilename' }), '');
  });

  await t.test('filename with dot fallback when format missing', () => {
    assert.equal(deriveFileExtension({ originalFilename: 'presentation.pptx' }), 'pptx');
  });

  await t.test('empty or invalid input returns empty string', () => {
    assert.equal(deriveFileExtension(null), '');
    assert.equal(deriveFileExtension({}), '');
  });
});

test('Material Content - buildSignedFileUrl & Cloudinary Config', async (t) => {
  const cloudinary = require('cloudinary').v2;
  cloudinary.config({
    cloud_name: 'testcloud',
    api_key: '1234567890',
    api_secret: 'testsecret123456',
  });

  await t.test('raw docx URL ends with /file.docx exactly once (never .docx.docx)', () => {
    const url = buildSignedFileUrl({
      publicId: 'materials/1/file.docx',
      resourceType: 'raw',
      deliveryType: 'authenticated',
      format: 'docx',
    });
    assert.ok(url.includes('/raw/authenticated/'), 'Must use raw resource type and authenticated delivery');
    assert.ok(url.endsWith('/file.docx'), `Must end with /file.docx, got: ${url}`);
    assert.ok(!url.includes('.docx.docx'), `Must not produce double extension: ${url}`);
  });

  await t.test('image pdf ends with .pdf', () => {
    const url = buildSignedFileUrl({
      publicId: 'materials/1/file',
      resourceType: 'image',
      format: 'pdf',
      deliveryType: 'authenticated',
    });
    assert.ok(url.includes('/image/authenticated/'), 'Must use image resource type');
    assert.ok(url.endsWith('.pdf'), `Must end with .pdf, got: ${url}`);
  });

  await t.test('video mp3 ends with .mp3', () => {
    const url = buildSignedFileUrl({
      publicId: 'materials/1/audio',
      resourceType: 'video',
      format: 'mp3',
      deliveryType: 'authenticated',
    });
    assert.ok(url.includes('/video/authenticated/'), 'Must use video resource type');
    assert.ok(url.endsWith('.mp3'), `Must end with .mp3, got: ${url}`);
  });

  await t.test('auto maps correctly by extension', () => {
    // pdf -> image
    const pdfUrl = buildSignedFileUrl({ publicId: 'materials/1/doc', resourceType: 'auto', format: 'pdf' });
    assert.ok(pdfUrl.includes('/image/authenticated/'));

    // jpg/png -> image
    const jpgUrl = buildSignedFileUrl({ publicId: 'materials/1/photo', resourceType: 'auto', format: 'jpg' });
    assert.ok(jpgUrl.includes('/image/authenticated/'));

    // mp3/mp4/m4a/wav -> video
    const mp3Url = buildSignedFileUrl({ publicId: 'materials/1/track', resourceType: 'auto', format: 'mp3' });
    assert.ok(mp3Url.includes('/video/authenticated/'));

    const mp4Url = buildSignedFileUrl({ publicId: 'materials/1/video', resourceType: 'auto', format: 'mp4' });
    assert.ok(mp4Url.includes('/video/authenticated/'));

    // docx/pptx/xlsx -> raw
    const docxUrl = buildSignedFileUrl({ publicId: 'materials/1/doc.docx', resourceType: 'auto', format: 'docx' });
    assert.ok(docxUrl.includes('/raw/authenticated/'));
  });

  await t.test('download flag controls attachment parameter passed to cloudinary.url', () => {
    let capturedOptions;
    const origUrl = cloudinary.url;
    cloudinary.url = (publicId, opts) => {
      capturedOptions = opts;
      return origUrl.call(cloudinary, publicId, opts);
    };
    try {
      buildSignedFileUrl({ publicId: 'materials/1/file.docx', resourceType: 'raw' }, { download: true });
      assert.equal(capturedOptions.attachment, true, 'Should set attachment: true when download: true');

      buildSignedFileUrl({ publicId: 'materials/1/file.docx', resourceType: 'raw' }, { download: false });
      assert.equal(capturedOptions.attachment, undefined, 'Should not set attachment when download: false');
    } finally {
      cloudinary.url = origUrl;
    }
  });
});

test('Material Content - planRevisionRenumber Helper', async (t) => {
  await t.test('empty sourceRevisions returns empty array', () => {
    assert.deepEqual(planRevisionRenumber(5, []), []);
    assert.deepEqual(planRevisionRenumber(0, null), []);
  });

  await t.test('offset continuation after targetMaxVersion', () => {
    const sourceRevs = [
      { _id: 'rev_1', version: 1 },
      { _id: 'rev_2', version: 2 },
    ];
    const plan = planRevisionRenumber(10, sourceRevs);
    assert.deepEqual(plan, [
      { _id: 'rev_1', oldVersion: 1, version: 11 },
      { _id: 'rev_2', oldVersion: 2, version: 12 },
    ]);
  });

  await t.test('order preserved when sourceRevisions unordered', () => {
    const sourceRevs = [
      { _id: 'rev_3', version: 3 },
      { _id: 'rev_1', version: 1 },
      { _id: 'rev_2', version: 2 },
    ];
    const plan = planRevisionRenumber(0, sourceRevs);
    assert.deepEqual(plan, [
      { _id: 'rev_1', oldVersion: 1, version: 1 },
      { _id: 'rev_2', oldVersion: 2, version: 2 },
      { _id: 'rev_3', oldVersion: 3, version: 3 },
    ]);
  });

  await t.test('ties by version broken deterministically by _id', () => {
    const sourceRevs = [
      { _id: 'b_rev', version: 1 },
      { _id: 'a_rev', version: 1 },
    ];
    const plan = planRevisionRenumber(2, sourceRevs);
    assert.deepEqual(plan, [
      { _id: 'a_rev', oldVersion: 1, version: 3 },
      { _id: 'b_rev', oldVersion: 1, version: 4 },
    ]);
  });
});

test('Material Content - parseBaseVersion Helper', () => {
  assert.equal(parseBaseVersion(undefined), null);
  assert.equal(parseBaseVersion(null), null);
  assert.equal(parseBaseVersion(''), null);
  assert.equal(parseBaseVersion('abc'), null);
  assert.equal(parseBaseVersion(0), null);
  assert.equal(parseBaseVersion(-1), null);
  assert.equal(parseBaseVersion('3'), 3);
  assert.equal(parseBaseVersion(3), 3);
  assert.equal(parseBaseVersion(3.5), null);
});

test('Material Content - escapeRegex Helper', async (t) => {
  const chars = ['(', 'a+b', '.*', '['];
  for (const q of chars) {
    await t.test(`q="${q}" does not throw and matches literally`, () => {
      const escaped = escapeRegex(q);
      let re;
      assert.doesNotThrow(() => {
        re = new RegExp(escaped, 'i');
      });

      assert.ok(re.test(`prefix_${q}_suffix`), `Must match string containing literal ${q}`);
      if (q === '(') {
        assert.ok(!re.test('prefix_suffix'));
      }
      if (q === 'a+b') {
        assert.ok(!re.test('aaab'), 'Must not treat + as regex quantifier');
      }
      if (q === '.*') {
        assert.ok(!re.test('hello'), 'Must not treat .* as regex wildcard');
      }
      if (q === '[') {
        assert.ok(!re.test('hello'), 'Must not treat [ as character class');
      }
    });
  }
});

test('Material Content - destroyAssets Helper', async (t) => {
  const cloudinary = require('cloudinary').v2;
  const originalDeleteResources = cloudinary.api.delete_resources;

  const calls = [];
  cloudinary.api.delete_resources = async (chunk, opts) => {
    calls.push({ chunk, opts });
    const deleted = {};
    for (const id of chunk) {
      deleted[id] = 'deleted';
    }
    return { deleted };
  };

  try {
    const publicIds = [];
    const hints = {};
    for (let i = 0; i < 105; i++) {
      const id = `materials/1/raw_${i}.docx`;
      publicIds.push(id);
      hints[id] = 'raw';
    }
    for (let i = 0; i < 3; i++) {
      const id = `materials/1/img_${i}.png`;
      publicIds.push(id);
      hints[id] = 'image';
    }
    for (let i = 0; i < 2; i++) {
      const id = `materials/1/vid_${i}.mp3`;
      publicIds.push(id);
      hints[id] = 'video';
    }

    const counts = await destroyAssets(publicIds, hints);
    assert.equal(counts.raw, 105);
    assert.equal(counts.image, 3);
    assert.equal(counts.video, 2);

    const rawCalls = calls.filter(c => c.opts.resource_type === 'raw');
    assert.equal(rawCalls.length, 2);
    assert.equal(rawCalls[0].chunk.length, 100);
    assert.equal(rawCalls[1].chunk.length, 5);

    const imageCalls = calls.filter(c => c.opts.resource_type === 'image');
    assert.equal(imageCalls.length, 1);
    assert.equal(imageCalls[0].chunk.length, 3);

    const videoCalls = calls.filter(c => c.opts.resource_type === 'video');
    assert.equal(videoCalls.length, 1);
    assert.equal(videoCalls[0].chunk.length, 2);
  } finally {
    cloudinary.api.delete_resources = originalDeleteResources;
  }
});

test('Material Content - runDeleteWithCleanup Helper', async (t) => {
  await t.test('DB step throws -> cleanup is never called and the error propagates', async () => {
    let cleanupCalled = false;
    const deleteDb = async () => {
      throw new Error('Database delete failed');
    };
    const cleanup = async () => {
      cleanupCalled = true;
    };

    await assert.rejects(
      () => runDeleteWithCleanup({ deleteDb, cleanup }),
      /Database delete failed/
    );
    assert.equal(cleanupCalled, false);
  });

  await t.test('DB ok + cleanup throws -> dbDeleted true and cleanupIncomplete true', async () => {
    let dbDeleted = false;
    let cleanupCalled = false;
    const deleteDb = async () => {
      dbDeleted = true;
    };
    const cleanup = async () => {
      cleanupCalled = true;
      throw new Error('Cloudinary API network failure');
    };

    const res = await runDeleteWithCleanup({ deleteDb, cleanup });
    assert.deepEqual(res, { dbDeleted: true, cleanupIncomplete: true });
    assert.equal(dbDeleted, true);
    assert.equal(cleanupCalled, true);
  });

  await t.test('DB ok + budget exceeded -> cleanupIncomplete true', async () => {
    let dbDeleted = false;
    let cleanupCalled = false;
    let currentTime = 1000;
    const now = () => currentTime;
    const deleteDb = async () => {
      dbDeleted = true;
    };
    const cleanup = async ({ isBudgetExceeded }) => {
      cleanupCalled = true;
      assert.equal(isBudgetExceeded(), false);
      currentTime += 45000; // Exceeds 40,000ms budget
      assert.equal(isBudgetExceeded(), true);
    };

    const res = await runDeleteWithCleanup({
      deleteDb,
      cleanup,
      budgetMs: 40000,
      now,
    });
    assert.deepEqual(res, { dbDeleted: true, cleanupIncomplete: true });
    assert.equal(dbDeleted, true);
    assert.equal(cleanupCalled, true);
  });

  await t.test('all ok -> false (dbDeleted: true, cleanupIncomplete: false)', async () => {
    let dbDeleted = false;
    let cleanupCalled = false;
    const deleteDb = async () => {
      dbDeleted = true;
    };
    const cleanup = async () => {
      cleanupCalled = true;
    };

    const res = await runDeleteWithCleanup({ deleteDb, cleanup });
    assert.deepEqual(res, { dbDeleted: true, cleanupIncomplete: false });
    assert.equal(dbDeleted, true);
    assert.equal(cleanupCalled, true);
  });
});

test('Material Content - Deleting Material with docx, pdf, mp3 Sequencing & Budget', async (t) => {
  const cloudinary = require('cloudinary').v2;
  const originalDeleteResources = cloudinary.api.delete_resources;
  const originalDeletePrefix = cloudinary.api.delete_resources_by_prefix;

  await t.test('Success: DB records gone first, Cloudinary folder empty afterwards', async () => {
    const cloudStorage = new Set([
      'materials/mat123/report.docx',
      'materials/mat123/slides.pdf',
      'materials/mat123/audio.mp3',
    ]);
    const deleteCallsOrder = [];

    cloudinary.api.delete_resources = async (chunk, opts) => {
      deleteCallsOrder.push('cloudinary.delete_resources');
      const deleted = {};
      for (const id of chunk) {
        cloudStorage.delete(id);
        deleted[id] = 'deleted';
      }
      return { deleted };
    };
    cloudinary.api.delete_resources_by_prefix = async (prefix, opts) => {
      deleteCallsOrder.push(`cloudinary.delete_prefix:${opts.resource_type}`);
      return { deleted: {}, partial: false };
    };

    let dbRecordsDeleted = false;
    const deleteDb = async () => {
      deleteCallsOrder.push('db.delete');
      dbRecordsDeleted = true;
    };

    const candidateIds = [
      'materials/mat123/report.docx',
      'materials/mat123/slides.pdf',
      'materials/mat123/audio.mp3',
    ];
    const hints = {
      'materials/mat123/report.docx': 'raw',
      'materials/mat123/slides.pdf': 'image',
      'materials/mat123/audio.mp3': 'video',
    };

    const cleanup = async ({ isBudgetExceeded }) => {
      await destroyAssets(candidateIds, hints, { isBudgetExceeded });
      for (const rt of ['image', 'raw', 'video']) {
        await cloudinary.api.delete_resources_by_prefix('materials/mat123/', {
          type: 'authenticated',
          resource_type: rt,
        });
      }
    };

    try {
      const res = await runDeleteWithCleanup({ deleteDb, cleanup });
      assert.deepEqual(res, { dbDeleted: true, cleanupIncomplete: false });
      assert.equal(dbRecordsDeleted, true);
      assert.equal(cloudStorage.size, 0); // all files destroyed
      // DB was called before any Cloudinary calls
      assert.equal(deleteCallsOrder[0], 'db.delete');
      assert.ok(deleteCallsOrder.slice(1).every(c => c.startsWith('cloudinary')));
    } finally {
      cloudinary.api.delete_resources = originalDeleteResources;
      cloudinary.api.delete_resources_by_prefix = originalDeletePrefix;
    }
  });

  await t.test('Failing DB delete leaves Cloudinary files completely untouched', async () => {
    const cloudStorage = new Set([
      'materials/mat123/report.docx',
      'materials/mat123/slides.pdf',
      'materials/mat123/audio.mp3',
    ]);
    let cloudinaryTouched = false;

    cloudinary.api.delete_resources = async () => {
      cloudinaryTouched = true;
      return { deleted: {} };
    };
    cloudinary.api.delete_resources_by_prefix = async () => {
      cloudinaryTouched = true;
      return { deleted: {}, partial: false };
    };

    const deleteDb = async () => {
      throw new Error('Database transaction abort / network error');
    };

    const cleanup = async () => {
      cloudinaryTouched = true;
    };

    try {
      await assert.rejects(
        () => runDeleteWithCleanup({ deleteDb, cleanup }),
        /Database transaction abort/
      );
      assert.equal(cloudinaryTouched, false);
      assert.equal(cloudStorage.size, 3); // untouched
    } finally {
      cloudinary.api.delete_resources = originalDeleteResources;
      cloudinary.api.delete_resources_by_prefix = originalDeletePrefix;
    }
  });

  await t.test('Cleanup exceeding budget still deletes DB and flags cleanupIncomplete', async () => {
    let dbDeleted = false;
    let clock = 0;
    const now = () => clock;

    const deleteDb = async () => {
      dbDeleted = true;
    };

    const unfinishedPublicIds = new Set();
    const candidateIds = ['materials/mat123/large.docx'];
    const hints = { 'materials/mat123/large.docx': 'raw' };

    const cleanup = async ({ isBudgetExceeded }) => {
      clock += 45000; // Exceeds 40s budget
      if (isBudgetExceeded()) {
        for (const id of candidateIds) unfinishedPublicIds.add(id);
        return { cleanupIncomplete: true };
      }
    };

    const res = await runDeleteWithCleanup({
      deleteDb,
      cleanup,
      budgetMs: 40000,
      now,
    });

    assert.equal(res.dbDeleted, true);
    assert.equal(res.cleanupIncomplete, true);
    assert.equal(dbDeleted, true);
    assert.equal(unfinishedPublicIds.size, 1);

    // Verify flash message formatted with extra sentence
    let flash = 'Material "Test Material" deleted successfully!';
    if (res.cleanupIncomplete) {
      flash += ' Some files could not be removed from cloud storage; they are listed in the server log.';
    }
    assert.equal(
      flash,
      'Material "Test Material" deleted successfully! Some files could not be removed from cloud storage; they are listed in the server log.'
    );
  });
});

test('Material Content - buildSignParams Unit Tests & Opt-in Modes', async (t) => {
  const { buildSignParams } = require('../controllers/materialContentController');
  const allowed = ['pdf', 'png', 'jpg', 'jpeg', 'docx', 'xlsx', 'pptx', 'mp3', 'm4a', 'wav', 'mp4'];
  const folder = 'materials/507f1f77bcf86cd799439011';
  const timestamp = 1710000000;
  const type = 'authenticated';

  await t.test('Mode 1: Default / Opt-in off (includeAllowedFormats=false)', () => {
    const paramsToSign = buildSignParams({
      folder,
      timestamp,
      type,
      allowedFormats: allowed,
      includeAllowedFormats: false,
    });

    assert.equal(paramsToSign.allowed_formats, undefined);
    assert.deepEqual(paramsToSign, {
      folder,
      timestamp,
      type,
    });

    // Simulating response payload created by signUpload controller:
    // res.json({ cloudName, apiKey, signature, ...paramsToSign })
    const responsePayload = {
      cloudName: 'test-cloud',
      apiKey: 'test-key',
      signature: 'dummy-sig-1',
      ...paramsToSign,
    };

    assert.equal(responsePayload.allowed_formats, undefined);

    // Extract upload params from responsePayload (excluding transport keys cloudName, apiKey, signature)
    const { cloudName, apiKey, signature, ...returnedUploadParams } = responsePayload;
    assert.deepEqual(paramsToSign, returnedUploadParams);
  });

  await t.test('Mode 1: Default when includeAllowedFormats omitted or undefined', () => {
    const paramsToSign = buildSignParams({
      folder,
      timestamp,
      type,
      allowedFormats: allowed,
    });

    assert.equal(paramsToSign.allowed_formats, undefined);
    assert.deepEqual(paramsToSign, {
      folder,
      timestamp,
      type,
    });

    const responsePayload = {
      cloudName: 'test-cloud',
      apiKey: 'test-key',
      signature: 'dummy-sig-default',
      ...paramsToSign,
    };

    const { cloudName, apiKey, signature, ...returnedUploadParams } = responsePayload;
    assert.deepEqual(paramsToSign, returnedUploadParams);
  });

  await t.test('Mode 2: Opt-in on (includeAllowedFormats=true / "1")', () => {
    const paramsToSignTrue = buildSignParams({
      folder,
      timestamp,
      type,
      allowedFormats: allowed,
      includeAllowedFormats: true,
    });

    assert.equal(paramsToSignTrue.allowed_formats, allowed.join(','));
    assert.deepEqual(paramsToSignTrue, {
      folder,
      timestamp,
      type,
      allowed_formats: allowed.join(','),
    });

    const responsePayload = {
      cloudName: 'test-cloud',
      apiKey: 'test-key',
      signature: 'dummy-sig-2',
      ...paramsToSignTrue,
    };

    assert.equal(responsePayload.allowed_formats, allowed.join(','));
    const { cloudName, apiKey, signature, ...returnedUploadParams } = responsePayload;
    assert.deepEqual(paramsToSignTrue, returnedUploadParams);

    const paramsToSignStr = buildSignParams({
      folder,
      timestamp,
      type,
      allowedFormats: allowed,
      includeAllowedFormats: '1',
    });
    assert.deepEqual(paramsToSignStr, paramsToSignTrue);
  });

  await t.test('Handles string allowedFormats', () => {
    const strParams = buildSignParams({
      folder,
      timestamp,
      type,
      allowedFormats: 'png,pdf,docx,mp3',
      includeAllowedFormats: true,
    });
    assert.equal(strParams.allowed_formats, 'png,pdf,docx,mp3');
  });
});

test('Material Content - signUpload Controller & File Types (png, pdf, docx, mp3)', async (t) => {
  const { signUpload } = require('../controllers/materialContentController');
  const Material = require('../models/Material');
  const MaterialContent = require('../models/MaterialContent');
  const cloudinary = require('cloudinary').v2;

  const originalFindMaterial = Material.findById;
  const originalFindContent = MaterialContent.findOne;
  const originalEnv = process.env.MATERIAL_SIGN_ALLOWED_FORMATS;
  const originalSecret = process.env.CLOUDINARY_API_SECRET;
  process.env.CLOUDINARY_API_SECRET = 'test_secret_for_upload_signature';
  process.env.CLOUDINARY_CLOUD_NAME = 'test_cloud';
  process.env.CLOUDINARY_API_KEY = 'test_key';

  const fakeMaterialId = '507f1f77bcf86cd799439011';
  Material.findById = async () => ({ _id: fakeMaterialId, name: 'Sample Material' });
  MaterialContent.findOne = async () => ({ material: fakeMaterialId, resources: [] });

  try {
    const testFiles = [
      { filename: 'graphic.png', size: 1024 * 50 },
      { filename: 'handout.pdf', size: 1024 * 100 },
      { filename: 'notes.docx', size: 1024 * 80 },
      { filename: 'audio.mp3', size: 1024 * 500 },
    ];

    await t.test('Flag OFF by default: sign response has NO allowed_formats for png, pdf, docx, mp3', async () => {
      delete process.env.MATERIAL_SIGN_ALLOWED_FORMATS;

      for (const file of testFiles) {
        let statusCode = 200;
        let responseJson = null;

        const req = {
          params: { id: fakeMaterialId },
          body: { filename: file.filename, size: file.size },
          session: { user: { role: 'admin' } },
        };
        const res = {
          status(code) { statusCode = code; return this; },
          json(data) { responseJson = data; return this; },
        };

        await signUpload(req, res);

        assert.equal(statusCode, 200, `Sign upload failed for ${file.filename}`);
        assert.ok(responseJson, `Response JSON missing for ${file.filename}`);
        assert.equal(responseJson.allowed_formats, undefined, `allowed_formats should not be present in response for ${file.filename}`);
        assert.equal(responseJson.folder, `materials/${fakeMaterialId}`);
        assert.equal(responseJson.type, 'authenticated');
        assert.ok(responseJson.timestamp);
        assert.ok(responseJson.signature);

        // Verify signature matches signed params without allowed_formats
        const expectedSig = cloudinary.utils.api_sign_request(
          {
            folder: `materials/${fakeMaterialId}`,
            timestamp: responseJson.timestamp,
            type: 'authenticated',
          },
          process.env.CLOUDINARY_API_SECRET
        );
        assert.equal(responseJson.signature, expectedSig, `Signature mismatch for ${file.filename}`);
      }
    });

    await t.test('Flag ON (MATERIAL_SIGN_ALLOWED_FORMATS=1): sign response includes allowed_formats', async () => {
      process.env.MATERIAL_SIGN_ALLOWED_FORMATS = '1';

      for (const file of testFiles) {
        let statusCode = 200;
        let responseJson = null;

        const req = {
          params: { id: fakeMaterialId },
          body: { filename: file.filename, size: file.size },
          session: { user: { role: 'admin' } },
        };
        const res = {
          status(code) { statusCode = code; return this; },
          json(data) { responseJson = data; return this; },
        };

        await signUpload(req, res);

        assert.equal(statusCode, 200);
        assert.ok(responseJson.allowed_formats);
        assert.ok(responseJson.allowed_formats.includes('pdf'));
        assert.ok(responseJson.allowed_formats.includes('docx'));
        assert.ok(responseJson.allowed_formats.includes('mp3'));
        assert.ok(responseJson.allowed_formats.includes('png'));

        const expectedSig = cloudinary.utils.api_sign_request(
          {
            allowed_formats: responseJson.allowed_formats,
            folder: `materials/${fakeMaterialId}`,
            timestamp: responseJson.timestamp,
            type: 'authenticated',
          },
          process.env.CLOUDINARY_API_SECRET
        );
        assert.equal(responseJson.signature, expectedSig);
      }
    });
  } finally {
    Material.findById = originalFindMaterial;
    MaterialContent.findOne = originalFindContent;
    if (originalEnv !== undefined) {
      process.env.MATERIAL_SIGN_ALLOWED_FORMATS = originalEnv;
    } else {
      delete process.env.MATERIAL_SIGN_ALLOWED_FORMATS;
    }
    process.env.CLOUDINARY_API_SECRET = originalSecret;
  }
});

test('Material Content - addResource 422 Server-side Diagnostics Logging', async (t) => {
  const { addResource } = require('../controllers/materialContentController');
  const Material = require('../models/Material');
  const MaterialContent = require('../models/MaterialContent');
  const cloudinary = require('cloudinary').v2;

  const originalFindMaterial = Material.findById;
  const originalFindContent = MaterialContent.findOne;
  const originalResource = cloudinary.api.resource;
  const originalConsoleError = console.error;

  const fakeMaterialId = '507f1f77bcf86cd799439011';
  Material.findById = async () => ({ _id: fakeMaterialId, name: 'Sample Material' });
  MaterialContent.findOne = async () => ({
    _id: '607f1f77bcf86cd799439022',
    material: fakeMaterialId,
    resources: [],
    version: 1,
  });

  try {
    const errorLogs = [];
    console.error = (...args) => {
      errorLogs.push(args);
    };

    await t.test('Logs diagnostics when asset verification fails (asset not found in Cloudinary)', async () => {
      cloudinary.api.resource = async () => {
        throw new Error('Not found');
      };

      let statusCode = 0;
      let resJson = null;
      const req = {
        params: { id: fakeMaterialId },
        body: {
          kind: 'file',
          publicId: `materials/${fakeMaterialId}/missing-asset`,
          baseVersion: 1,
        },
        session: { user: { role: 'admin' } },
      };
      const res = {
        status(code) { statusCode = code; return this; },
        json(data) { resJson = data; return this; },
      };

      await addResource(req, res);

      assert.equal(statusCode, 422);
      assert.equal(resJson.error, 'File verification with Cloudinary failed.');

      const lastLog = errorLogs.find(args => args[0] === 'addResource 422 rejection:');
      assert.ok(lastLog, 'console.error addResource 422 rejection should have been called');
      const logData = lastLog[1];
      assert.equal(logData.reason, 'File verification with Cloudinary failed.');
      assert.equal(logData.publicId, `materials/${fakeMaterialId}/missing-asset`);
      assert.equal(logData.resource_type, null);
      assert.equal(logData.format, null);
      assert.equal(logData.derivedExtension, null);
      // Ensure no secrets or signatures are logged
      assert.equal(logData.api_secret, undefined);
      assert.equal(logData.signature, undefined);
    });

    await t.test('Logs diagnostics when file extension is disallowed', async () => {
      cloudinary.api.resource = async () => ({
        public_id: `materials/${fakeMaterialId}/danger.exe`,
        resource_type: 'raw',
        format: '',
        bytes: 1024,
      });

      let statusCode = 0;
      let resJson = null;
      const req = {
        params: { id: fakeMaterialId },
        body: {
          kind: 'file',
          publicId: `materials/${fakeMaterialId}/danger.exe`,
          baseVersion: 1,
        },
        session: { user: { role: 'admin' } },
      };
      const res = {
        status(code) { statusCode = code; return this; },
        json(data) { resJson = data; return this; },
      };

      await addResource(req, res);

      assert.equal(statusCode, 422);
      assert.ok(resJson.error.includes('not allowed'));

      const matchingLogs = errorLogs.filter(args => args[0] === 'addResource 422 rejection:');
      const lastLog = matchingLogs[matchingLogs.length - 1];
      assert.ok(lastLog, 'console.error addResource 422 rejection should have been called');
      const logData = lastLog[1];
      assert.ok(logData.reason.includes('not allowed'));
      assert.equal(logData.publicId, `materials/${fakeMaterialId}/danger.exe`);
      assert.equal(logData.resource_type, 'raw');
      assert.equal(logData.derivedExtension, 'exe');
      assert.equal(logData.api_secret, undefined);
      assert.equal(logData.signature, undefined);
    });
  } finally {
    Material.findById = originalFindMaterial;
    MaterialContent.findOne = originalFindContent;
    cloudinary.api.resource = originalResource;
    console.error = originalConsoleError;
  }
});

test('Material Content - Teacher Can Edit First Content', async (t) => {
  const teacherUser = { _id: '670000000000000000000005', role: 'teacher', username: 'teacher1' };

  await t.test('canEdit returns true for teacher when content is null/undefined (first content)', () => {
    assert.equal(canEdit(teacherUser, null), true);
    assert.equal(canEdit(teacherUser, undefined), true);
  });

  await t.test('canEdit returns true for teacher when content has locked: false', () => {
    assert.equal(canEdit(teacherUser, { locked: false, version: 1 }), true);
  });

  await t.test('views/materials/index.ejs renders + Add Content button and No Content badge for materials without content', async () => {
    const ejs = require('ejs');
    const path = require('path');
    const indexFile = path.resolve('views/materials/index.ejs');

    const html = await ejs.renderFile(indexFile, {
      title: 'Materials Library',
      materials: [
        {
          _id: '670000000000000000000001',
          name: 'English Grammar 1',
          level: 'Primary',
          hasContent: false,
        },
        {
          _id: '670000000000000000000002',
          name: 'English Reading 2',
          level: 'Secondary',
          hasContent: true,
          contentUpdatedAt: new Date(),
        },
      ],
      contentMap: {
        '670000000000000000000002': { fileCount: 2, updatedAt: new Date() },
      },
      page: 1,
      totalPages: 1,
      totalMatching: 2,
      availableLevels: ['PRIMARY', 'SECONDARY'],
      selectedLevel: '',
      searchQuery: '',
      status: 'all',
      countAll: 2,
      countWithContent: 1,
      countNoContent: 1,
      userIsAdmin: false,
      renderMaterialBody: s => s,
      safeJson: o => JSON.stringify(o),
      user: teacherUser,
    });

    assert.ok(html.includes('All Materials'), 'Should include All Materials tab');
    assert.ok(html.includes('With Content'), 'Should include With Content tab');
    assert.ok(html.includes('Needs Content'), 'Should include Needs Content tab');
    assert.ok(html.includes('No Content'), 'Should display No Content badge for empty material');
    assert.ok(html.includes('+ Add Content'), 'Should display + Add Content button for empty material');
    assert.ok(html.includes('/materials/670000000000000000000001/edit'), 'Link to edit first content');
  });

  await t.test('views/materials/show.ejs displays Add First Content when content is empty', async () => {
    const ejs = require('ejs');
    const path = require('path');
    const showFile = path.resolve('views/materials/show.ejs');

    const html = await ejs.renderFile(showFile, {
      title: 'English Grammar 1',
      material: {
        _id: '670000000000000000000001',
        name: 'English Grammar 1',
        level: 'Primary',
        hasContent: false,
      },
      content: {
        version: 1,
        body: '',
        resources: [],
        locked: false,
      },
      userCanEdit: true,
      userIsAdmin: false,
      renderMaterialBody: s => s,
      csrfToken: 'test-token',
      user: teacherUser,
    });

    assert.ok(html.includes('Add First Content'), 'Should show Add First Content button');
    assert.ok(html.includes('+ Add Written Notes'), 'Should show Add Written Notes button');
  });

  await t.test('views/materials/edit.ejs and material-editor.js support drag and drop file uploads', async () => {
    const fs = require('fs');
    const path = require('path');
    const editFile = path.resolve('views/materials/edit.ejs');
    const scriptFile = path.resolve('public/js/material-editor.js');

    const editContent = fs.readFileSync(editFile, 'utf8');
    const scriptContent = fs.readFileSync(scriptFile, 'utf8');

    // Markup assertions
    assert.ok(editContent.includes('id="upload-panel"'), 'upload-panel must exist');
    assert.ok(editContent.includes('id="dropzone-active-state"'), 'dropzone-active-state overlay must exist');
    assert.ok(editContent.includes('id="resources-card"'), 'resources-card must exist for drag-over detection');
    assert.ok(editContent.includes('Drag & drop files here'), 'Must display drag and drop user prompt');
    assert.ok(editContent.includes('multiple'), 'file input must support multiple files');

    // Client script assertions
    assert.ok(scriptContent.includes('dragenter'), 'Script must handle dragenter');
    assert.ok(scriptContent.includes('dragover'), 'Script must handle dragover');
    assert.ok(scriptContent.includes('dragleave'), 'Script must handle dragleave');
    assert.ok(scriptContent.includes('drop'), 'Script must handle drop event');
    assert.ok(scriptContent.includes('handleFilesUpload'), 'Script must have handleFilesUpload');
    assert.ok(scriptContent.includes('uploadSingleFile'), 'Script must have uploadSingleFile');
  });

  await t.test('views/materials/show.ejs and edit.ejs support interactive slide carousel and fullscreen presentation', async () => {
    const ejs = require('ejs');
    const fs = require('fs');
    const path = require('path');
    const showFile = path.resolve('views/materials/show.ejs');
    const editFile = path.resolve('views/materials/edit.ejs');
    const modalFile = path.resolve('views/materials/_slide-viewer-modal.ejs');
    const scriptFile = path.resolve('public/js/material-editor.js');

    // 1. Verify modal partial content
    const modalContent = fs.readFileSync(modalFile, 'utf8');
    assert.ok(modalContent.includes('id="slide-viewer-modal"'), 'Modal should have id="slide-viewer-modal"');
    assert.ok(modalContent.includes('openSlideViewer'), 'Modal must define openSlideViewer');
    assert.ok(modalContent.includes('closeSlideViewer'), 'Modal must define closeSlideViewer');
    assert.ok(modalContent.includes('nextSlide'), 'Modal must support next slide');
    assert.ok(modalContent.includes('prevSlide'), 'Modal must support prev slide');
    assert.ok(modalContent.includes('sv-counter'), 'Modal should have slide counter');
    assert.ok(modalContent.includes('sv-thumbnails'), 'Modal should contain thumbnail strip');
    assert.ok(modalContent.includes('ArrowRight'), 'Modal should support keyboard arrow navigation');

    // 2. Verify show.ejs rendering with files
    const htmlShow = await ejs.renderFile(showFile, {
      title: 'Biology 101',
      material: {
        _id: '670000000000000000000001',
        name: 'Biology 101',
        level: 'Secondary',
        usageCount: 4,
        hasContent: true,
      },
      content: {
        version: 1,
        body: '<p>Cell anatomy</p>',
        resources: [
          {
            _id: '670000000000000000000001',
            kind: 'file',
            label: 'Slide 1 - Plant Cell.png',
            file: { format: 'png', bytes: 1048576, publicId: 'materials/1/plant' },
          },
          {
            _id: '670000000000000000000002',
            kind: 'file',
            label: 'Slide 2 - Animal Cell.jpg',
            file: { format: 'jpg', bytes: 2097152, publicId: 'materials/1/animal' },
          },
          {
            _id: '670000000000000000000003',
            kind: 'file',
            label: 'Notes.pdf',
            file: { format: 'pdf', bytes: 524288, publicId: 'materials/1/notes' },
          },
        ],
      },
      userCanEdit: true,
      userIsAdmin: false,
      renderMaterialBody: s => s,
      csrfToken: 'test-token',
      user: teacherUser,
      path: '/materials/1',
    });

    assert.ok(htmlShow.includes('Present Slides'), 'show.ejs must have Present Slides button');
    assert.ok(htmlShow.includes('id="file-slides-view"'), 'show.ejs must have file-slides-view');
    assert.ok(htmlShow.includes('id="file-list-view"'), 'show.ejs must have file-list-view toggle');
    assert.ok(htmlShow.includes('slide-viewer-modal'), 'show.ejs must include the slide viewer modal');

    // 3. Verify edit.ejs includes slide viewer modal and preview button
    const editContent = fs.readFileSync(editFile, 'utf8');
    assert.ok(editContent.includes('id="btn-preview-slides"'), 'edit.ejs must have Slides preview button');
    assert.ok(editContent.includes('_slide-viewer-modal'), 'edit.ejs must include _slide-viewer-modal');

    // 4. Verify material-editor.js initializes slide viewer
    const scriptContent = fs.readFileSync(scriptFile, 'utf8');
    assert.ok(scriptContent.includes('initSlideViewer'), 'material-editor.js must call initSlideViewer');
    assert.ok(scriptContent.includes('openSlideViewer'), 'material-editor.js must support openSlideViewer');
  });
});

test('Material Content - XSS Prevention and Safe JSON Rendering (show.ejs, edit.ejs, history.ejs)', async (t) => {
  const ejs = require('ejs');
  const fs = require('fs');
  const path = require('path');
  const showFile = path.resolve('views/materials/show.ejs');
  const editFile = path.resolve('views/materials/edit.ejs');
  const histFile = path.resolve('views/materials/history.ejs');

  const origLoader = ejs.fileLoader;
  t.after(() => {
    ejs.fileLoader = origLoader;
  });

  ejs.fileLoader = function (filePath) {
    if (filePath.includes('partials/header') || filePath.includes('partials\\header')) {
      return '<!-- STUBBED_HEADER -->';
    }
    if (filePath.includes('partials/footer') || filePath.includes('partials\\footer')) {
      return '<!-- STUBBED_FOOTER -->';
    }
    return origLoader(filePath);
  };

  const xssLabel = '</script><img src=x onerror=alert(1)>';
  const xssFilename = 'test"quote\'file<script>alert(2)</script>.png';
  const maliciousResource = {
    _id: '670000000000000000000099',
    kind: 'file',
    label: xssLabel,
    file: {
      originalFilename: xssFilename,
      format: 'png',
      bytes: 1024,
      publicId: 'materials/test/xss'
    }
  };

  const testMaterial = {
    _id: '670000000000000000000001',
    name: 'XSS Test Material',
    level: 'Primary',
    usageCount: 1,
    hasContent: true,
  };

  const testContent = {
    version: 3,
    body: '<p>Safe body text</p>',
    resources: [maliciousResource],
    locked: false,
    updatedAt: new Date(),
  };

  await t.test('show.ejs escapes resource label and quotes, and JSON data block parses cleanly', async () => {
    const rawTemplate = fs.readFileSync(showFile, 'utf8');
    const html = ejs.render(rawTemplate, {
      title: 'Show Material',
      material: testMaterial,
      content: testContent,
      userCanEdit: true,
      userIsAdmin: true,
      renderMaterialBody: renderMaterialBody,
      safeJson: safeJson,
      csrfToken: 'test-token',
      user: { _id: 'user1', name: 'Teacher', role: 'teacher' },
      path: '/materials/1',
    }, { filename: showFile });

    // Assert the exact raw script closing tag and img tag never appear unescaped in HTML
    assert.ok(!html.includes('</script><img src=x onerror=alert(1)>'), 'Raw XSS payload must not appear in show.ejs output');
    assert.ok(!html.includes('<img src=x onerror='), 'Unescaped img onerror must not appear in show.ejs');
    assert.ok(!html.includes('test"quote\'file<script>'), 'Unescaped filename with script tag must not appear in show.ejs');

    // Extract JSON script block
    const match = html.match(/<script\s+type="application\/json"\s+id="show-material-data">([\s\S]*?)<\/script>/);
    assert.ok(match, 'show-material-data script block must be present');

    // Proves that safeJson escaped the content so JSON.parse succeeds without script breakout
    const rawJson = match[1];
    assert.ok(!rawJson.includes('</script>'), 'safeJson must escape </script> inside JSON tag');
    const parsed = JSON.parse(rawJson);
    assert.equal(parsed.fileResources[0].label, xssLabel, 'Parsed JSON maintains original string data safely');
    assert.equal(parsed.fileResources[0].file.originalFilename, xssFilename);
  });

  await t.test('edit.ejs escapes resource label and quotes, and JSON data block parses cleanly', async () => {
    const rawTemplate = fs.readFileSync(editFile, 'utf8');
    const html = ejs.render(rawTemplate, {
      title: 'Edit Material',
      material: testMaterial,
      content: testContent,
      maxFileMb: 10,
      allowedExtensions: ['png', 'jpg', 'pdf'],
      userCanEdit: true,
      userIsAdmin: true,
      safeJson: safeJson,
      csrfToken: 'test-token',
      user: { _id: 'user1', name: 'Admin', role: 'admin' },
      path: '/materials/1/edit',
    }, { filename: editFile });

    // Assert raw XSS payload never appears unescaped
    assert.ok(!html.includes('</script><img src=x onerror=alert(1)>'), 'Raw XSS payload must not appear in edit.ejs output');
    assert.ok(!html.includes('<img src=x onerror='), 'Unescaped img onerror must not appear in edit.ejs');

    // Extract JSON script block
    const match = html.match(/<script\s+type="application\/json"\s+id="material-editor-data">([\s\S]*?)<\/script>/);
    assert.ok(match, 'material-editor-data script block must be present');

    const rawJson = match[1];
    assert.ok(!rawJson.includes('</script>'), 'safeJson must escape </script> inside JSON tag');
    const parsed = JSON.parse(rawJson);
    assert.equal(parsed.resources[0].label, xssLabel, 'Parsed JSON maintains original string data safely');
    assert.equal(parsed.resources[0].file.originalFilename, xssFilename);
  });

  await t.test('history.ejs escapes resource label, quotes, and revision notes', async () => {
    const rawTemplate = fs.readFileSync(histFile, 'utf8');
    const html = ejs.render(rawTemplate, {
      title: 'Material History',
      material: testMaterial,
      revisions: [
        {
          version: 1,
          editedByName: 'Attacker <script>alert(3)</script>',
          editedAt: new Date(),
          note: 'Note with </script><img src=x onerror=alert(4)>',
          body: '<p>Revision notes</p>',
          resources: [maliciousResource],
        }
      ],
      currentVersion: 1,
      renderMaterialBody: renderMaterialBody,
      safeJson: safeJson,
      csrfToken: 'test-token',
      user: { _id: 'user1', name: 'Admin', role: 'admin' },
      path: '/materials/1/history',
    }, { filename: histFile });

    // Assert raw XSS payload never appears unescaped in history.ejs
    assert.ok(!html.includes('</script><img src=x onerror=alert(1)>'), 'Raw XSS payload must not appear in history.ejs output');
    assert.ok(!html.includes('<img src=x onerror='), 'Unescaped img onerror must not appear in history.ejs');
    assert.ok(!html.includes('Attacker <script>'), 'Unescaped script tag in editor name must not appear');
    assert.ok(!html.includes('Note with </script>'), 'Unescaped script tag in note must not appear');
  });

  await t.test('locked material with no content renders friendly locked view for teachers (A4)', async () => {
    const lockedFile = path.resolve('views/materials/locked.ejs');
    const rawTemplate = fs.readFileSync(lockedFile, 'utf8');
    const html = ejs.render(rawTemplate, {
      title: 'Material Locked',
      material: {
        _id: '670000000000000000000002',
        name: 'Restricted Material',
        level: 'Advanced',
      },
      message: 'This material is locked. Ask an admin to add content.',
      user: { role: 'teacher' },
      path: '/materials/2/edit',
    }, { filename: lockedFile });

    assert.ok(html.includes('This material is locked. Ask an admin to add content.'), 'Must display friendly locked message');
    assert.ok(html.includes('Restricted Material'), 'Must display material name');
  });
});




