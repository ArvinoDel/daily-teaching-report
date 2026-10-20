const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AuditLog = require('../models/AuditLog');

test('AuditLog Enum Guard - all actions in controllers/*.js must be valid AuditLog enum values', async (t) => {
  const enumValues = AuditLog.schema.path('action').enumValues;
  assert.ok(Array.isArray(enumValues) && enumValues.length > 0, 'AuditLog enum values should be defined');
  const validSet = new Set(enumValues);

  // Read all *.js files in controllers directory
  const controllersDir = path.join(__dirname, '..', 'controllers');
  const controllerFiles = fs.readdirSync(controllersDir).filter(f => f.endsWith('.js'));
  assert.ok(controllerFiles.length > 0, 'Should find controller files');

  const detectedActions = [];

  for (const file of controllerFiles) {
    const fullPath = path.join(controllersDir, file);
    const content = fs.readFileSync(fullPath, 'utf8');

    // 1. Match logAudit(..., '<action>', ...)
    // Excludes function declaration `async function logAudit(...)` because second param has no quotes
    const logAuditRegex = /\blogAudit\s*\(\s*[^,]+,\s*['"`]([a-zA-Z0-9_]+)['"`]/g;
    let match;
    while ((match = logAuditRegex.exec(content)) !== null) {
      detectedActions.push({
        file,
        action: match[1],
        source: match[0],
      });
    }

    // 2. Match direct AuditLog.create(...) calls
    const searchStr = 'AuditLog.create(';
    let pos = 0;
    while ((pos = content.indexOf(searchStr, pos)) !== -1) {
      let depth = 0;
      let start = pos + searchStr.length - 1; // start at '('
      let end = start;
      for (let i = start; i < content.length; i++) {
        if (content[i] === '(') depth++;
        else if (content[i] === ')') {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      const callBody = content.slice(start, end + 1);
      // Find top-level action: '<action>'
      const actionMatch = /\baction\s*:\s*['"`]([a-zA-Z0-9_]+)['"`]/.exec(callBody);
      if (actionMatch) {
        detectedActions.push({
          file,
          action: actionMatch[1],
          source: callBody.replace(/\s+/g, ' ').slice(0, 80),
        });
      }
      pos = end + 1;
    }
  }

  // We should have detected several actions across controllers
  assert.ok(detectedActions.length >= 10, `Expected to detect >= 10 action usages, got ${detectedActions.length}`);

  // Ensure 'group_student_rename' is among the detected actions
  const renameAction = detectedActions.find(a => a.action === 'group_student_rename');
  assert.ok(renameAction, 'Expected to detect group_student_rename action in controllers');

  // Assert every detected action is present in the AuditLog enum
  const missing = detectedActions.filter(item => !validSet.has(item.action));
  assert.deepEqual(
    missing,
    [],
    `Found actions used in controllers that are missing from AuditLog enum: ${JSON.stringify(missing)}`
  );

  // Guard test must fail if an action is missing from the enum:
  await t.test('Guard assertion fails when an action is not in enum', () => {
    const fakeAction = 'unregistered_dummy_action';
    assert.equal(validSet.has(fakeAction), false);
    const mockDetected = [{ file: 'mockController.js', action: fakeAction }];
    const mockMissing = mockDetected.filter(item => !validSet.has(item.action));
    assert.equal(mockMissing.length, 1);
  });
});
