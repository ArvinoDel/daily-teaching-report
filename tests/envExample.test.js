'use strict';
/**
 * tests/envExample.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Verification guards for .env.example:
 *   1. Committed .env.example equals generator output (pure function in scripts/generateEnvExample.js)
 *   2. Every ENV_REGISTRY name appears exactly once
 *   3. No line contains a real-looking secret (no long random strings, only known placeholders)
 *   4. .gitignore contains .env and .env.local, and .env.example is tracked (not ignored)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { ENV_REGISTRY } = require('../services/systemHealthService');
const { generateEnvExample } = require('../scripts/generateEnvExample');

const ROOT = path.resolve(__dirname, '..');
const ENV_EXAMPLE_PATH = path.join(ROOT, '.env.example');
const GITIGNORE_PATH = path.join(ROOT, '.gitignore');

test('.env.example matches generator output', () => {
  assert.ok(fs.existsSync(ENV_EXAMPLE_PATH), '.env.example must exist — run npm run env:example');
  const committed = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');
  const generated = generateEnvExample(ENV_REGISTRY);

  assert.strictEqual(
    committed,
    generated,
    'Run npm run env:example'
  );
});

test('Every registry name appears exactly once in .env.example', () => {
  assert.ok(fs.existsSync(ENV_EXAMPLE_PATH), '.env.example must exist');
  const content = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');

  for (const entry of ENV_REGISTRY) {
    // Check that entry appears as an assignment line (KEY=) exactly once
    const assignmentMatches = content.match(new RegExp(`^${entry.name}=`, 'm')) || [];
    assert.strictEqual(
      assignmentMatches.length,
      1,
      `Expected ${entry.name}= to appear exactly once as assignment line in .env.example, found ${assignmentMatches.length}`
    );

    // Check that entry name does not appear duplicated elsewhere in the file
    const wordMatches = content.match(new RegExp(`\\b${entry.name}\\b`, 'g')) || [];
    assert.strictEqual(
      wordMatches.length,
      1,
      `Expected variable name ${entry.name} to appear exactly once in .env.example, found ${wordMatches.length}`
    );
  }
});

test('No line contains a real-looking secret and only known placeholders are used', () => {
  assert.ok(fs.existsSync(ENV_EXAMPLE_PATH), '.env.example must exist');
  const content = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');
  const lines = content.split(/\r?\n/);

  const registryMap = new Map(ENV_REGISTRY.map(e => [e.name, e]));
  const knownPlaceholders = new Set(ENV_REGISTRY.map(e => e.placeholder));

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx];
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const eqIdx = line.indexOf('=');
    assert.ok(eqIdx > 0, `Line ${idx + 1} is not a valid assignment: ${line}`);

    const key = line.slice(0, eqIdx).trim();
    const val = line.slice(eqIdx + 1).trim();

    const regEntry = registryMap.get(key);
    assert.ok(regEntry, `Variable ${key} on line ${idx + 1} is not registered in ENV_REGISTRY`);

    // Verify placeholder matches known safe placeholder
    assert.ok(
      knownPlaceholders.has(val),
      `Line ${idx + 1} (${key}): Value "${val}" is not in the known safe placeholder set`
    );
    assert.strictEqual(
      val,
      regEntry.placeholder,
      `Line ${idx + 1} (${key}): Placeholder must match registry placeholder`
    );

    // Assert that placeholder cannot be mistaken for a real secret:
    // No raw random hex (32+ chars)
    assert.ok(
      !/^[0-9a-f]{32,}$/i.test(val),
      `Line ${idx + 1} (${key}) contains what looks like a real random hex secret: ${val}`
    );
    // No raw base64 secret tokens (32+ continuous alphanumeric/plus/slash/equal without dashes or words)
    assert.ok(
      !/^[A-Za-z0-9+/=]{32,}$/.test(val),
      `Line ${idx + 1} (${key}) contains what looks like a real random base64 secret: ${val}`
    );
    // No common secret token prefixes
    assert.ok(
      !/^(sk-|ghp_|gho_|xoxb-|xoxp-|AIzaSy)/.test(val),
      `Line ${idx + 1} (${key}) contains a real API key prefix: ${val}`
    );
  }
});

test('.gitignore contains .env and .env.local and does not ignore .env.example', () => {
  assert.ok(fs.existsSync(GITIGNORE_PATH), '.gitignore must exist');
  const gitignoreContent = fs.readFileSync(GITIGNORE_PATH, 'utf8');
  const lines = gitignoreContent.split(/\r?\n/).map(l => l.trim());

  assert.ok(
    lines.includes('.env'),
    '.gitignore must contain an explicit .env entry'
  );
  assert.ok(
    lines.includes('.env.local'),
    '.gitignore must contain an explicit .env.local entry'
  );

  // Check git ignore status using git check-ignore
  // A non-zero exit code (1) means the file is NOT ignored by git.
  const checkExample = spawnSync('git', ['check-ignore', '.env.example'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.strictEqual(
    checkExample.status,
    1,
    `.env.example must NOT be ignored by git (exit code was ${checkExample.status})`
  );

  // Check that .env is ignored
  const checkEnv = spawnSync('git', ['check-ignore', '.env'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.strictEqual(
    checkEnv.status,
    0,
    `.env must be ignored by git (exit code was ${checkEnv.status})`
  );

  // Check that .env.local is ignored
  const checkEnvLocal = spawnSync('git', ['check-ignore', '.env.local'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.strictEqual(
    checkEnvLocal.status,
    0,
    `.env.local must be ignored by git (exit code was ${checkEnvLocal.status})`
  );
});
