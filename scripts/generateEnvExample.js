'use strict';
/**
 * scripts/generateEnvExample.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Generates .env.example from ENV_REGISTRY in services/systemHealthService.js.
 *
 * Can be imported as a pure function:
 *   const { generateEnvExample } = require('./scripts/generateEnvExample');
 *
 * Or executed via CLI:
 *   node scripts/generateEnvExample.js
 *   npm run env:example
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs = require('node:fs');
const path = require('node:path');
const { ENV_REGISTRY } = require('../services/systemHealthService');

/**
 * Pure generator function: takes an environment registry array and returns
 * formatted .env.example file contents.
 *
 * @param {Array} [registry=ENV_REGISTRY]
 * @returns {string}
 */
function generateEnvExample(registry = ENV_REGISTRY) {
  const groups = new Map();
  for (const entry of registry) {
    const groupName = entry.group || 'Other';
    if (!groups.has(groupName)) {
      groups.set(groupName, []);
    }
    groups.get(groupName).push(entry);
  }

  const lines = [
    '# =============================================================================',
    '# Daily Teaching Report - Environment Configuration Template',
    '# Generated automatically from ENV_REGISTRY in services/systemHealthService.js',
    '# Run "npm run env:example" to regenerate.',
    '# =============================================================================',
    '',
  ];

  for (const [groupName, entries] of groups.entries()) {
    lines.push('# ─────────────────────────────────────────────────────────────────────────────');
    lines.push(`# Group: ${groupName}`);
    lines.push('# ─────────────────────────────────────────────────────────────────────────────');
    lines.push('');

    for (const entry of entries) {
      const reqText = entry.required ? 'Required in production' : 'Optional';
      const desc = entry.description || 'No description provided';
      const format = entry.formatRule || 'format validated by application';
      lines.push(`# ${reqText}. ${desc}. Format: ${format}.`);
      lines.push(`${entry.name}=${entry.placeholder}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

if (require.main === module) {
  const targetPath = path.resolve(__dirname, '..', '.env.example');
  const content = generateEnvExample();
  fs.writeFileSync(targetPath, content, 'utf8');
  console.log(`Generated .env.example at ${targetPath}`);
}

module.exports = {
  generateEnvExample,
};

