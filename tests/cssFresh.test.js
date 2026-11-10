'use strict';
/**
 * tests/cssFresh.test.js
 *
 * CSS freshness guard: re-runs the Tailwind CLI with the same flags as
 * `npm run build:css` into a temporary file and fails when the output differs
 * from the committed public/css/tailwind.css.
 *
 * This prevents a workflow where a developer edits a view, adds new Tailwind
 * classes, but forgets to rebuild before committing — leading to invisible
 * styles in production.
 *
 * Failure message: "Run npm run build:css and commit public/css/tailwind.css"
 *
 * NOTE: this test spawns the Tailwind CLI and may take 1–3 seconds.
 */

const { test }   = require('node:test');
const assert     = require('node:assert');
const { spawnSync } = require('child_process');
const fs  = require('fs');
const os  = require('os');
const path = require('path');

const ROOT        = path.resolve(__dirname, '..');
const COMMITTED   = path.join(ROOT, 'public', 'css', 'tailwind.css');
const INPUT       = path.join(ROOT, 'public', 'css', 'input.css');
const CONFIG      = path.join(ROOT, 'tailwind.config.js');

test('public/css/tailwind.css is up to date with source', () => {
  // Sanity check — committed file must exist
  assert.ok(
    fs.existsSync(COMMITTED),
    'public/css/tailwind.css does not exist — run npm run build:css and commit it'
  );

  const tmpFile = path.join(os.tmpdir(), `tailwind-fresh-${Date.now()}.css`);

  try {
    // Mirror exactly what `npm run build:css` does:
    //   tailwindcss -i ./public/css/input.css -o ./public/css/tailwind.css --minify
    const result = spawnSync(
      'npx',
      [
        'tailwindcss',
        '-i', INPUT,
        '-o', tmpFile,
        '--minify',
        '--config', CONFIG,
      ],
      {
        cwd:      ROOT,
        encoding: 'utf8',
        timeout:  60_000, // 60 s max — first run downloads nothing (already installed)
        // On Windows, npx is a .cmd file and needs shell:true to be found
        shell: process.platform === 'win32',
      }
    );

    if (result.status !== 0) {
      throw new Error(
        `Tailwind CLI failed (exit ${result.status}):\n${result.stderr || result.stdout}`
      );
    }

    if (!fs.existsSync(tmpFile)) {
      throw new Error('Tailwind CLI exited 0 but did not create the output file.');
    }

    const fresh     = fs.readFileSync(tmpFile, 'utf8');
    const committed = fs.readFileSync(COMMITTED, 'utf8');

    assert.strictEqual(
      fresh,
      committed,
      'Run npm run build:css and commit public/css/tailwind.css'
    );
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});
