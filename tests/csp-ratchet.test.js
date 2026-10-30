const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const VIEWS_DIR = path.join(ROOT_DIR, 'views');
const ALLOWLIST_PATH = path.join(__dirname, 'csp-allowlist.json');

function getEjsFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      getEjsFiles(filePath, fileList);
    } else if (file.endsWith('.ejs')) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');

  // Strip EJS tags (<% ... %>) so JS variables in EJS scriptlets don't get matched
  const withoutEjs = content.replace(/<%[\s\S]*?%>/g, '');

  // 1. Inline event handlers: on<event>=
  // Matches inline event handler attributes like onclick=, onchange=, onsubmit=, etc.
  const eventRegex = /\s+on(click|change|submit|input|keydown|keyup|keypress|focus|blur|dragover|dragleave|drop|mouseenter|mouseleave|mouseover|mouseout|load|error|reset|select|contextmenu|scroll|resize)\s*=/gi;
  const eventMatches = withoutEjs.match(eventRegex) || [];
  const eventHandlers = eventMatches.length;

  // 2. Executable inline script blocks: <script> without src and type != 'application/json'
  const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let inlineScripts = 0;
  let m;
  while ((m = scriptRegex.exec(content)) !== null) {
    const attrs = m[1] || '';
    const hasSrc = /\bsrc\s*=/i.test(attrs);
    const isJson = /\btype\s*=\s*['"]application\/json['"]/i.test(attrs);
    if (!hasSrc && !isJson) {
      inlineScripts++;
    }
  }

  // 3. javascript: URLs
  const jsUrlRegex = /\b(?:href|action|src)\s*=\s*['"]\s*javascript:[^'"]*['"]/gi;
  const jsUrlMatches = withoutEjs.match(jsUrlRegex) || [];
  const javascriptUrls = jsUrlMatches.length;

  return {
    eventHandlers,
    inlineScripts,
    javascriptUrls
  };
}

function collectMetrics() {
  const allFiles = getEjsFiles(VIEWS_DIR);
  const metrics = {};

  for (const f of allFiles) {
    const rel = path.relative(ROOT_DIR, f).replace(/\\/g, '/');
    if (rel.includes('calculator')) continue; // Calculator views handled separately

    const fileMetrics = scanFile(f);
    if (fileMetrics.eventHandlers > 0 || fileMetrics.inlineScripts > 0 || fileMetrics.javascriptUrls > 0) {
      metrics[rel] = fileMetrics;
    }
  }

  return metrics;
}

// CLI utility: node tests/csp-ratchet.test.js --update
if (process.argv.includes('--update') || process.argv.includes('--generate')) {
  const current = collectMetrics();
  fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(current, null, 2) + '\n', 'utf8');
  console.log(`Updated ${ALLOWLIST_PATH} with current metrics for ${Object.keys(current).length} files.`);
  process.exit(0);
}

describe('CSP Ratchet Guard', () => {
  test('scans views/**/*.ejs and asserts counts do not exceed allowlist', () => {
    let allowlist = {};
    if (fs.existsSync(ALLOWLIST_PATH)) {
      allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
    }

    const currentMetrics = collectMetrics();
    const violations = [];

    // Check existing files and check for rises
    for (const [file, current] of Object.entries(currentMetrics)) {
      const allowed = allowlist[file];
      if (!allowed) {
        violations.push(
          `NEW FILE with nonzero counts: ${file} (eventHandlers: ${current.eventHandlers}, inlineScripts: ${current.inlineScripts}, javascriptUrls: ${current.javascriptUrls})`
        );
        continue;
      }

      if (current.eventHandlers > allowed.eventHandlers) {
        violations.push(
          `${file}: eventHandlers rose from ${allowed.eventHandlers} to ${current.eventHandlers}`
        );
      }
      if (current.inlineScripts > allowed.inlineScripts) {
        violations.push(
          `${file}: inlineScripts rose from ${allowed.inlineScripts} to ${current.inlineScripts}`
        );
      }
      if (current.javascriptUrls > allowed.javascriptUrls) {
        violations.push(
          `${file}: javascriptUrls rose from ${allowed.javascriptUrls} to ${current.javascriptUrls}`
        );
      }
    }

    assert.strictEqual(
      violations.length,
      0,
      `CSP Ratchet failed with ${violations.length} violations:\n${violations.join('\n')}`
    );
  });
});

module.exports = { scanFile, collectMetrics };
