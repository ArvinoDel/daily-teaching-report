'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeMaterialHtml,
  validateResource,
  validateLink,
  canEdit,
  checkVersionConflict,
  planContentMerge,
  computeHasContent,
} = require('../services/materialContentService');

test('Material Content - Sanitization Helper', async (t) => {
  await t.test('strips <script> tags and malicious event handlers', () => {
    const input = '<h1>Title</h1><script>alert("xss")</script><p onclick="evil()">Click me</p>';
    const output = sanitizeMaterialHtml(input);
    assert.ok(!output.includes('<script>'));
    assert.ok(!output.includes('alert'));
    assert.ok(!output.includes('onclick'));
    assert.ok(!output.includes('evil'));
    assert.ok(output.includes('<h1>Title</h1>'));
    assert.ok(output.includes('<p>Click me</p>'));
  });

  await t.test('strips <iframe> and <img> tags', () => {
    const input = '<p>Text</p><iframe src="https://evil.com"></iframe><img src="pic.jpg" onerror="alert(1)">';
    const output = sanitizeMaterialHtml(input);
    assert.ok(!output.includes('iframe'));
    assert.ok(!output.includes('img'));
    assert.ok(!output.includes('onerror'));
    assert.ok(output.includes('<p>Text</p>'));
  });

  await t.test('strips javascript: and data: links', () => {
    const input = '<a href="javascript:alert(1)">Evil</a><a href="data:text/html,evil">Data</a>';
    const output = sanitizeMaterialHtml(input);
    assert.ok(!output.includes('javascript:'));
    assert.ok(!output.includes('data:'));
  });

  await t.test('preserves allowed tags: h1-h4, p, br, strong, em, u, s, ul, ol, li, blockquote, a, code, pre, hr', () => {
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

  // Admin & Superadmin can always edit
  assert.equal(canEdit(admin, unlocked), true);
  assert.equal(canEdit(admin, locked), true);
  assert.equal(canEdit(admin, noContentDoc), true);

  assert.equal(canEdit(superadmin, unlocked), true);
  assert.equal(canEdit(superadmin, locked), true);
  assert.equal(canEdit(superadmin, noContentDoc), true);

  // Teacher can edit unlocked or non-existent content, but NOT locked content
  assert.equal(canEdit(teacher, unlocked), true);
  assert.equal(canEdit(teacher, noContentDoc), true);
  assert.equal(canEdit(teacher, locked), false);

  // Other roles or unauthenticated cannot edit
  assert.equal(canEdit(student, unlocked), false);
  assert.equal(canEdit(null, unlocked), false);
  assert.equal(canEdit(undefined, unlocked), false);
});

test('Material Content - Version Conflict Check', () => {
  // If no baseVersion passed or current is null, no conflict
  assert.equal(checkVersionConflict(null, 1), false);
  assert.equal(checkVersionConflict(undefined, 1), false);
  assert.equal(checkVersionConflict(1, null), false);

  // Matching version: no conflict
  assert.equal(checkVersionConflict(2, 2), false);
  assert.equal(checkVersionConflict('2', 2), false);

  // Mismatched version: conflict!
  assert.equal(checkVersionConflict(1, 2), true);
  assert.equal(checkVersionConflict('1', 2), true);
});

test('Material Content - Content Merge Planning', () => {
  const sourceEmpty = { body: '', resources: [] };
  const sourceFilled = { body: '<p>Chapter 1</p>', resources: [{ kind: 'link', url: 'https://ex.com' }] };
  const targetEmpty = { body: '', resources: [] };
  const targetFilled = { body: '<p>Existing</p>', resources: [] };

  // 1. Source empty -> skip source
  const plan1 = planContentMerge(sourceEmpty, targetFilled, 'Source Mat');
  assert.equal(plan1.action, 'skip_source');
  assert.equal(plan1.needsWarning, false);

  // 2. Target empty, source has content -> move source to target
  const plan2 = planContentMerge(sourceFilled, targetEmpty, 'Source Mat');
  assert.equal(plan2.action, 'move_source_to_target');
  assert.equal(plan2.needsWarning, false);

  // 3. Both have content -> keep target, snapshot source as revision with warning
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
