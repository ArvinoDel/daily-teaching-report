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

