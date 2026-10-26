'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BACKUP_COLLECTIONS, EXCLUDED_MODELS } = require('../services/backupService');

test('Backup Registry Guard - all models in models/*.js must be in BACKUP_COLLECTIONS or EXCLUDED_MODELS', async (t) => {
  const modelsDir = path.join(__dirname, '..', 'models');
  const modelFiles = fs.readdirSync(modelsDir).filter(f => f.endsWith('.js'));
  assert.ok(modelFiles.length > 0, 'Should find model files in models directory');

  const registeredModelNames = new Set(BACKUP_COLLECTIONS.map(entry => entry.modelName || (entry.model && entry.model.modelName)));
  const registeredKeys = new Set(BACKUP_COLLECTIONS.map(entry => entry.key));

  // 1. Check all model files in models/*.js
  const unhandledModels = [];

  for (const file of modelFiles) {
    const baseName = path.basename(file, '.js');
    const isExcluded = Boolean(EXCLUDED_MODELS[baseName]);
    const isRegistered = registeredModelNames.has(baseName);

    if (isExcluded) {
      assert.ok(
        typeof EXCLUDED_MODELS[baseName] === 'string' && EXCLUDED_MODELS[baseName].trim().length > 10,
        `Excluded model ${baseName} must have a documented reason string of at least 10 characters`
      );
    }

    if (!isExcluded && !isRegistered) {
      unhandledModels.push(file);
    }
  }

  assert.deepEqual(
    unhandledModels,
    [],
    `Found models in models/*.js that are neither in BACKUP_COLLECTIONS nor documented in EXCLUDED_MODELS: ${unhandledModels.join(', ')}`
  );

  // 2. Ensure all expected collections are registered
  const expectedKeys = [
    'users',
    'reports',
    'groups',
    'auditLogs',
    'feedbacks',
    'materials',
    'materialAliases',
    'materialContents',
    'materialContentRevisions',
    'salaries',
    'students',
    'acTransactions',
    'notifications',
  ];

  for (const key of expectedKeys) {
    assert.ok(registeredKeys.has(key), `Expected collection key "${key}" to be in BACKUP_COLLECTIONS`);
  }

  assert.equal(BACKUP_COLLECTIONS.length, 13, 'Expected exactly 13 collections in BACKUP_COLLECTIONS');

  // 3. Ensure Backup is explicitly excluded with documented rationale
  assert.ok(EXCLUDED_MODELS.Backup, 'models/Backup.js must be documented in EXCLUDED_MODELS');

  // 4. Guard test: verify that an unregistered new model fails validation
  await t.test('Guard fails when an unknown model is encountered', () => {
    const fakeModelFiles = [...modelFiles, 'FutureUnregisteredModel.js'];
    const fakeUnhandled = fakeModelFiles.filter(f => {
      const name = path.basename(f, '.js');
      return !registeredModelNames.has(name) && !EXCLUDED_MODELS[name];
    });
    assert.deepEqual(fakeUnhandled, ['FutureUnregisteredModel.js']);
  });
});
