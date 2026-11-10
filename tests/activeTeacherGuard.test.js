'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIRS_TO_SCAN = ['controllers', 'services'];

/**
 * Allowlist for explicit exceptions where role: 'teacher' does NOT represent
 * an active teacher query (e.g. document inserts or explicit status queries).
 */
const ALLOWLIST = [
  {
    file: 'controllers/authController.js',
    reason: 'New teacher registration creates account with role teacher',
    pattern: /User\.create\([\s\S]*?role:\s*['"]teacher['"]/,
  },
  {
    file: 'controllers/adminController.js',
    reason: 'Explicit pending teachers counter for dashboard banner',
    pattern: /User\.countDocuments\(\{\s*role:\s*['"]teacher['"],\s*accountStatus:\s*['"]pending['"]\s*\}\)/,
  },
];

function getAllJsFiles(dir) {
  const fullPath = path.join(ROOT_DIR, dir);
  if (!fs.existsSync(fullPath)) return [];
  const entries = fs.readdirSync(fullPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const res = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllJsFiles(res));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(res.replace(/\\/g, '/'));
    }
  }
  return files;
}

describe('Active Teacher Query Static Guard', () => {
  test('all teacher queries in controllers/ and services/ must use activeUserFilter', () => {
    const violations = [];

    const files = DIRS_TO_SCAN.flatMap(getAllJsFiles);

    for (const relFile of files) {
      const absPath = path.join(ROOT_DIR, relFile);
      const content = fs.readFileSync(absPath, 'utf8');

      // Regex matching any role: 'teacher' or role: "teacher"
      const roleRegex = /role:\s*['"]teacher['"]/g;
      let match;

      while ((match = roleRegex.exec(content)) !== null) {
        const index = match.index;
        // Grab context around match (-120 to +120 chars)
        const start = Math.max(0, index - 120);
        const end = Math.min(content.length, index + 120);
        const snippet = content.slice(start, end);

        // Check if covered by activeUserFilter
        const isFiltered = snippet.includes('activeUserFilter');

        // Check if covered by allowlist
        const isAllowlisted = ALLOWLIST.some(entry => {
          if (entry.file !== relFile) return false;
          return entry.pattern.test(snippet) || entry.pattern.test(content);
        });

        if (!isFiltered && !isAllowlisted) {
          // Compute line number
          const lineNumber = content.slice(0, index).split('\n').length;
          violations.push({
            file: relFile,
            line: lineNumber,
            snippet: snippet.trim().replace(/\s+/g, ' '),
          });
        }
      }
    }

    if (violations.length > 0) {
      const msg = violations
        .map(v => `  - ${v.file}:${v.line} -> "${v.snippet}"`)
        .join('\n');
      assert.fail(`Found direct 'role: teacher' query without activeUserFilter():\n${msg}\n\nWrap the query with activeUserFilter({ role: 'teacher', ... }) or add an explicit allowlist entry.`);
    }

    assert.equal(violations.length, 0);
  });
});

