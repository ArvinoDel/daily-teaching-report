'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

const {
  ENV_REGISTRY,
  IGNORED_ENV_VARS,
  evaluateEnv,
  computeCronHealth,
  evaluateSystemHealth,
  formatWib,
  formatAge,
  formatBytes,
  formatUptime,
} = require('../services/systemHealthService');

const { recordCronRun, sanitizeError, sanitizeSummary } = require('../services/cronRunService');
const adminRouter = require('../routes/admin');
const { requireSuperAdmin } = require('../middleware/adminAuth');
const systemCtrl = require('../controllers/adminSystemController');

/* ══════════════════════════════════════════════════════════════
   1. ENV_REGISTRY EVALUATION TESTS (Missing, Set, Invalid)
══════════════════════════════════════════════════════════════ */
test('ENV_REGISTRY - Pure evaluation with fake environments', async (t) => {
  await t.test('All registry variables report Missing when environment is empty', () => {
    const evaluated = evaluateEnv(ENV_REGISTRY, {});
    assert.equal(evaluated.length, ENV_REGISTRY.length);
    for (const item of evaluated) {
      assert.equal(item.status, 'Missing', `${item.name} should be Missing`);
      assert.equal(typeof item.required, 'boolean');
      assert.equal(typeof item.group, 'string');
    }
  });

  await t.test('MONGO_URI validation: mongodb:// or mongodb+srv://', () => {
    const valid1 = evaluateEnv(ENV_REGISTRY, { MONGO_URI: 'mongodb://localhost:27017/dtr' });
    assert.equal(valid1.find(i => i.name === 'MONGO_URI').status, 'Set');

    const valid2 = evaluateEnv(ENV_REGISTRY, { MONGO_URI: 'mongodb+srv://cluster.mongodb.net/dtr' });
    assert.equal(valid2.find(i => i.name === 'MONGO_URI').status, 'Set');

    const invalid = evaluateEnv(ENV_REGISTRY, { MONGO_URI: 'http://localhost:27017/dtr' });
    assert.equal(invalid.find(i => i.name === 'MONGO_URI').status, 'Set but invalid');
  });

  await t.test('SESSION_SECRET validation: at least 32 characters', () => {
    const valid = evaluateEnv(ENV_REGISTRY, { SESSION_SECRET: '12345678901234567890123456789012' });
    assert.equal(valid.find(i => i.name === 'SESSION_SECRET').status, 'Set');

    const invalid = evaluateEnv(ENV_REGISTRY, { SESSION_SECRET: 'short_secret_only_24_ch' });
    assert.equal(invalid.find(i => i.name === 'SESSION_SECRET').status, 'Set but invalid');
  });

  await t.test('CRON_SECRET validation: at least 16 characters', () => {
    const valid = evaluateEnv(ENV_REGISTRY, { CRON_SECRET: 'secret_cron_16_ch' });
    assert.equal(valid.find(i => i.name === 'CRON_SECRET').status, 'Set');

    const invalid = evaluateEnv(ENV_REGISTRY, { CRON_SECRET: 'short_cron_sec' });
    assert.equal(invalid.find(i => i.name === 'CRON_SECRET').status, 'Set but invalid');
  });

  await t.test('APP_BASE_URL validation: valid https URL', () => {
    const valid = evaluateEnv(ENV_REGISTRY, { APP_BASE_URL: 'https://teaching-report.vercel.app' });
    assert.equal(valid.find(i => i.name === 'APP_BASE_URL').status, 'Set');

    const invalidHttp = evaluateEnv(ENV_REGISTRY, { APP_BASE_URL: 'http://insecure.example.com' });
    assert.equal(invalidHttp.find(i => i.name === 'APP_BASE_URL').status, 'Set but invalid');

    const invalidUrl = evaluateEnv(ENV_REGISTRY, { APP_BASE_URL: 'not-a-url' });
    assert.equal(invalidUrl.find(i => i.name === 'APP_BASE_URL').status, 'Set but invalid');
  });

  await t.test('Composite Gemini API key matches any candidate variable', () => {
    const candidates = ['GOOGLE_GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_KEY', 'GEMINI_API_KEY'];
    for (const cand of candidates) {
      const env = { [cand]: 'dummy-gemini-key' };
      const res = evaluateEnv(ENV_REGISTRY, env);
      assert.equal(res.find(i => i.name === 'GEMINI_API_KEY').status, 'Set', `Should be Set when ${cand} is set`);
    }

    const resNone = evaluateEnv(ENV_REGISTRY, {});
    assert.equal(resNone.find(i => i.name === 'GEMINI_API_KEY').status, 'Missing');
  });

  await t.test('Numeric tunables validation: positive numbers', () => {
    const valid = evaluateEnv(ENV_REGISTRY, {
      MAX_FUNCTION_MS: '60000',
      BACKUP_RETENTION_DAYS: '30',
      MATERIAL_MAX_FILE_MB: '15',
      REPORT_GAP_PATTERN_WEEKS: '8',
    });
    assert.equal(valid.find(i => i.name === 'MAX_FUNCTION_MS').status, 'Set');
    assert.equal(valid.find(i => i.name === 'BACKUP_RETENTION_DAYS').status, 'Set');
    assert.equal(valid.find(i => i.name === 'MATERIAL_MAX_FILE_MB').status, 'Set');
    assert.equal(valid.find(i => i.name === 'REPORT_GAP_PATTERN_WEEKS').status, 'Set');

    const invalid = evaluateEnv(ENV_REGISTRY, {
      MAX_FUNCTION_MS: '-10',
      BACKUP_RETENTION_DAYS: 'abc',
    });
    assert.equal(invalid.find(i => i.name === 'MAX_FUNCTION_MS').status, 'Set but invalid');
    assert.equal(invalid.find(i => i.name === 'BACKUP_RETENTION_DAYS').status, 'Set but invalid');
  });
});

/* ══════════════════════════════════════════════════════════════
   2. LEAK TEST: NEVER EXPOSE VALUES OR 8+ CHAR SUBSTRINGS IN HTML
══════════════════════════════════════════════════════════════ */
test('LEAK TEST - Rendering /admin/system never exposes secret values or 8+ char substrings', async () => {
  const templatePath = path.join(__dirname, '..', 'views', 'admin', 'system', 'index.ejs');

  // Create unique, high-entropy fake secrets for every variable (each >= 8 characters)
  const fakeSecrets = {
    MONGO_URI: 'mongodb+srv://user_secret_xyz12345:pass_secret_abc67890@cluster0.fake.mongodb.net/testdb',
    SESSION_SECRET: 'secret_session_key_99887766554433221100_long_entropy',
    CRON_SECRET: 'secret_cron_token_3344556677889900_token',
    CLOUDINARY_CLOUD_NAME: 'fake_cloud_name_secret_unique_9988',
    CLOUDINARY_API_KEY: 'fake_api_key_secret_8877665544332211',
    CLOUDINARY_API_SECRET: 'fake_api_secret_secret_aabbccddeeff0011',
    APP_BASE_URL: 'https://secret-app-custom-domain-44332211.example.com',
    GOOGLE_GEMINI_API_KEY: 'secret_google_gemini_token_value_77889900',
    MAX_FUNCTION_MS: '88776655',
    BACKUP_RETENTION_DAYS: '99887766',
    MATERIAL_MAX_FILE_MB: '77665544',
    REPORT_GAP_PATTERN_WEEKS: '66554433',
  };

  const envItems = evaluateEnv(ENV_REGISTRY, fakeSecrets);

  const mockViewData = {
    title: 'System Health',
    csrfToken: 'csrf_dummy_token_123',
    currentUser: {
      _id: '650000000000000000000001',
      role: 'superadmin',
      displayName: 'Super Admin',
      joinDate: new Date('2024-01-01'),
      lastActiveAt: new Date(),
    },
    unreadNotificationCount: 0,
    health: {
      status: 'OK',
      reasons: [],
    },
    backups: {
      totalCount: 5,
      pinnedCount: 1,
      expiringSoonCount: 0,
      totalSizeBytes: 1048576,
      totalSizeFormatted: '1 MB',
      nextBackupDate: new Date(Date.now() + 86400000),
      nextBackupFormatted: 'Sun 1 Nov 2026, 02:00 WIB',
      lastSuccess: {
        timeFormatted: 'Sun 25 Oct 2026, 02:00 WIB',
        age: '5 days ago',
        sizeFormatted: '1.2 MB',
        format: 'JSON Gzip',
        hasChecksum: true,
        isPrivate: true,
      },
      lastFailed: null,
    },
    cronStatus: {
      backup: {
        startedAtFormatted: 'Sun 25 Oct 2026, 02:00 WIB',
        age: '5 days ago',
        trigger: 'vercel-cron',
        ok: true,
        durationMs: 1420,
        summary: { recordCounts: { users: 10 } },
      },
      cleanup: {
        startedAtFormatted: 'Fri 30 Oct 2026, 02:00 WIB',
        age: '10 hours ago',
        trigger: 'vercel-cron',
        ok: true,
        durationMs: 410,
        summary: { expiredCount: 0 },
      },
      prune: null,
      backupOverdue: false,
      cleanupOverdue: false,
    },
    envItems,
    runtime: {
      nodeEnv: 'production',
      vercelEnv: 'production',
      region: 'sin1',
      shortCommit: 'abcdef1',
      nodeVersion: process.version,
      serverTimeFormatted: 'Fri 30 Oct 2026, 17:00 WIB',
      uptimeFormatted: '1d 4h 20m',
      dbConnected: true,
      dbPingMs: 12,
    },
  };

  const renderedHtml = await ejs.renderFile(templatePath, mockViewData);
  assert.ok(renderedHtml.includes('System health'));
  assert.ok(renderedHtml.includes('System status is healthy'));

  // Test every secret: no full value and no substring of 8+ characters appears anywhere in renderedHtml
  for (const [key, secretVal] of Object.entries(fakeSecrets)) {
    const valStr = String(secretVal);
    assert.equal(
      renderedHtml.includes(valStr),
      false,
      `Full secret value of ${key} must never appear in rendered HTML`
    );

    // For substring leak check, exclude standard static protocol prefixes
    const stripped = valStr.replace(/^(https:\/\/|mongodb:\/\/|mongodb\+srv:\/\/)/, '');
    if (stripped.length >= 8) {
      for (let i = 0; i <= stripped.length - 8; i++) {
        const sub = stripped.slice(i, i + 8);
        assert.equal(
          renderedHtml.includes(sub),
          false,
          `8-char substring "${sub}" of ${key} leaked in rendered HTML!`
        );
      }
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   3. OVERALL SYSTEM HEALTH EVALUATOR
══════════════════════════════════════════════════════════════ */
test('evaluateSystemHealth - Rules for OK vs Needs attention', async (t) => {
  const baseValidEnvItems = evaluateEnv(ENV_REGISTRY, {
    MONGO_URI: 'mongodb://localhost:27017/dtr',
    SESSION_SECRET: '12345678901234567890123456789012',
    CRON_SECRET: '1234567890123456',
    CLOUDINARY_CLOUD_NAME: 'testcloud',
    CLOUDINARY_API_KEY: 'testkey',
    CLOUDINARY_API_SECRET: 'testsecret',
    APP_BASE_URL: 'https://test.example.com',
  });

  const now = new Date('2026-10-30T12:00:00Z');
  const freshBackupDate = new Date('2026-10-28T12:00:00Z'); // 2 days ago

  await t.test('Returns OK when all rules are satisfied', () => {
    const result = evaluateSystemHealth({
      envItems: baseValidEnvItems,
      lastSuccessBackup: { createdAt: freshBackupDate, cloudinaryType: 'authenticated' },
      lastBackup: { status: 'success', createdAt: freshBackupDate },
      cronStatus: { backupOverdue: false, cleanupOverdue: false },
      dbConnected: true,
      now,
    });

    assert.equal(result.status, 'OK');
    assert.deepEqual(result.reasons, []);
  });

  await t.test('Rule 1: Required env missing or invalid triggers Needs attention', () => {
    const invalidEnvItems = evaluateEnv(ENV_REGISTRY, {
      MONGO_URI: 'http://invalid', // invalid
      // SESSION_SECRET missing
    });
    const result = evaluateSystemHealth({
      envItems: invalidEnvItems,
      lastSuccessBackup: { createdAt: freshBackupDate, cloudinaryType: 'authenticated' },
      lastBackup: { status: 'success' },
      cronStatus: {},
      dbConnected: true,
      now,
    });

    assert.equal(result.status, 'Needs attention');
    assert.ok(result.reasons.some(r => r.includes('MONGO_URI')));
    assert.ok(result.reasons.some(r => r.includes('SESSION_SECRET')));
  });

  await t.test('Rule 2: No successful backup in 8 days triggers Needs attention', () => {
    const oldBackupDate = new Date('2026-10-20T12:00:00Z'); // 10 days ago
    const result = evaluateSystemHealth({
      envItems: baseValidEnvItems,
      lastSuccessBackup: { createdAt: oldBackupDate, cloudinaryType: 'authenticated' },
      lastBackup: { status: 'success' },
      cronStatus: {},
      dbConnected: true,
      now,
    });

    assert.equal(result.status, 'Needs attention');
    assert.ok(result.reasons.some(r => r.includes('last 8 days')));
  });

  await t.test('Rule 3: Overdue cron triggers Needs attention', () => {
    const result = evaluateSystemHealth({
      envItems: baseValidEnvItems,
      lastSuccessBackup: { createdAt: freshBackupDate, cloudinaryType: 'authenticated' },
      lastBackup: { status: 'success' },
      cronStatus: { backupOverdue: true, cleanupOverdue: false },
      dbConnected: true,
      now,
    });

    assert.equal(result.status, 'Needs attention');
    assert.ok(result.reasons.some(r => r.includes('Weekly backup cron is overdue')));
  });

  await t.test('Rule 4: Last backup failed triggers Needs attention', () => {
    const result = evaluateSystemHealth({
      envItems: baseValidEnvItems,
      lastSuccessBackup: { createdAt: freshBackupDate, cloudinaryType: 'authenticated' },
      lastBackup: { status: 'failed', createdAt: now },
      cronStatus: {},
      dbConnected: true,
      now,
    });

    assert.equal(result.status, 'Needs attention');
    assert.ok(result.reasons.some(r => r.includes('most recent database backup run failed')));
  });

  await t.test('Rule 5: Last backup not private triggers Needs attention', () => {
    const result = evaluateSystemHealth({
      envItems: baseValidEnvItems,
      lastSuccessBackup: { createdAt: freshBackupDate, cloudinaryType: 'upload' }, // public upload!
      lastBackup: { status: 'success' },
      cronStatus: {},
      dbConnected: true,
      now,
    });

    assert.equal(result.status, 'Needs attention');
    assert.ok(result.reasons.some(r => r.includes('not stored privately')));
  });

  await t.test('Rule 6: Database disconnected triggers Needs attention', () => {
    const result = evaluateSystemHealth({
      envItems: baseValidEnvItems,
      lastSuccessBackup: { createdAt: freshBackupDate, cloudinaryType: 'authenticated' },
      lastBackup: { status: 'success' },
      cronStatus: {},
      dbConnected: false,
      now,
    });

    assert.equal(result.status, 'Needs attention');
    assert.ok(result.reasons.some(r => r.includes('database is currently disconnected')));
  });
});

/* ══════════════════════════════════════════════════════════════
   4. CRON OVERDUE COMPUTATION WITH FIXED CLOCKS
══════════════════════════════════════════════════════════════ */
test('computeCronHealth - Overdue calculation with fixed clocks', () => {
  const now = new Date('2026-10-30T12:00:00Z');

  // Backup: overdue if last success > 8 days
  // Cleanup: overdue if last success > 36 hours
  const runs1 = {
    backup: { lastSuccessStartedAt: new Date('2026-10-23T12:00:00Z') }, // 7 days ago (< 8 days)
    'backup-cleanup': { lastSuccessStartedAt: new Date('2026-10-29T12:00:00Z') }, // 24 hours ago (< 36 hours)
  };
  const health1 = computeCronHealth(runs1, now);
  assert.equal(health1.backupOverdue, false, '7 days ago backup is not overdue');
  assert.equal(health1.cleanupOverdue, false, '24h ago cleanup is not overdue');

  const runs2 = {
    backup: { lastSuccessStartedAt: new Date('2026-10-21T12:00:00Z') }, // 9 days ago (> 8 days)
    'backup-cleanup': { lastSuccessStartedAt: new Date('2026-10-28T20:00:00Z') }, // 40 hours ago (> 36 hours)
  };
  const health2 = computeCronHealth(runs2, now);
  assert.equal(health2.backupOverdue, true, '9 days ago backup is overdue');
  assert.equal(health2.cleanupOverdue, true, '40h ago cleanup is overdue');

  const runsEmpty = {};
  const healthEmpty = computeCronHealth(runsEmpty, now);
  assert.equal(healthEmpty.backupOverdue, true, 'Missing backup run is overdue');
  assert.equal(healthEmpty.cleanupOverdue, true, 'Missing cleanup run is overdue');
});

/* ══════════════════════════════════════════════════════════════
   5. recordCronRun WITH FAKES (ok, throwing job, logging failure)
══════════════════════════════════════════════════════════════ */
test('recordCronRun - Handles ok, throwing job, and logging failure', async (t) => {
  const CronRun = require('../models/CronRun');
  const originalCreate = CronRun.create;

  t.afterEach(() => {
    CronRun.create = originalCreate;
  });

  await t.test('Successful execution logs ok: true and returns result', async () => {
    let savedDoc = null;
    CronRun.create = async (doc) => {
      savedDoc = doc;
      return doc;
    };

    const result = await recordCronRun('backup', 'vercel-cron', async () => {
      return { ok: true, fileSizeBytes: 2048, recordCounts: { users: 5 } };
    });

    assert.equal(result.ok, true);
    assert.equal(result.fileSizeBytes, 2048);
    assert.ok(savedDoc, 'Should have called CronRun.create');
    assert.equal(savedDoc.job, 'backup');
    assert.equal(savedDoc.trigger, 'vercel-cron');
    assert.equal(savedDoc.ok, true);
    assert.equal(typeof savedDoc.durationMs, 'number');
    assert.equal(savedDoc.summary.fileSizeBytes, 2048);
  });

  await t.test('Throwing job logs ok: false, error message, and rethrows original error', async () => {
    let savedDoc = null;
    CronRun.create = async (doc) => {
      savedDoc = doc;
      return doc;
    };

    const targetErr = new Error('Database dump failed');
    await assert.rejects(
      async () => {
        await recordCronRun('backup', 'vercel-cron', async () => {
          throw targetErr;
        });
      },
      (err) => err === targetErr
    );

    assert.ok(savedDoc, 'Should have logged the failure');
    assert.equal(savedDoc.job, 'backup');
    assert.equal(savedDoc.ok, false);
    assert.equal(savedDoc.error, 'Database dump failed');
  });

  await t.test('Logging failure never breaks or crashes the job execution', async () => {
    CronRun.create = async () => {
      throw new Error('MongoDB write error during cron log');
    };

    // Job returns normally even if CronRun.create fails
    const result = await recordCronRun('backup-cleanup', 'scheduler', async () => {
      return { expiredCount: 3 };
    });

    assert.deepEqual(result, { expiredCount: 3 });
  });

  await t.test('Sanitizes error string: trims to 300 chars and removes stack traces', () => {
    const longErr = new Error('A'.repeat(500));
    const sanitized = sanitizeError(longErr);
    assert.ok(sanitized.length <= 300);
    assert.equal(sanitized.includes('at '), false);
  });
});

/* ══════════════════════════════════════════════════════════════
   6. REGISTRY-VS-SOURCE TEST (Scan all process.env in code)
══════════════════════════════════════════════════════════════ */
test('Registry vs Source - Every process.env reference in code must be registered or ignored', () => {
  const rootDir = path.join(__dirname, '..');
  const known = new Set(IGNORED_ENV_VARS);
  ENV_REGISTRY.forEach(e => {
    known.add(e.name);
    if (e.aliases) e.aliases.forEach(a => known.add(a));
  });

  function walk(dir) {
    let files = [];
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'tests', 'test', 'dist', 'public'].includes(item.name)) continue;
      const p = path.join(dir, item.name);
      if (item.isDirectory()) files.push(...walk(p));
      else if (item.name.endsWith('.js')) files.push(p);
    }
    return files;
  }

  const envRefs = new Set();
  const files = walk(rootDir);
  const regex = /process\.env\.([A-Z0-9_]+)|process\.env\[['"]([A-Z0-9_]+)['"]\]/g;

  for (const f of files) {
    const content = fs.readFileSync(f, 'utf8');
    let m;
    while ((m = regex.exec(content)) !== null) {
      const name = m[1] || m[2];
      envRefs.add(name);
    }
  }

  const missing = [...envRefs].filter(name => !known.has(name));
  assert.deepEqual(
    missing,
    [],
    `Found process.env references in code that are neither in ENV_REGISTRY nor IGNORED_ENV_VARS: ${missing.join(', ')}`
  );
});

/* ══════════════════════════════════════════════════════════════
   7. ROUTER PERMISSION TEST (/admin/system routes superadmin only)
══════════════════════════════════════════════════════════════ */
test('Router Permissions - /admin/system routes require superadmin', () => {
  const systemRoutes = adminRouter.stack.filter(layer => {
    return layer.route && layer.route.path && layer.route.path.startsWith('/system');
  });

  assert.ok(systemRoutes.length >= 3, `Expected at least 3 system routes, found ${systemRoutes.length}`);

  for (const layer of systemRoutes) {
    const handlers = layer.route.stack.map(s => s.handle);
    const hasSuperAdminGuard = handlers.includes(requireSuperAdmin);
    assert.equal(
      hasSuperAdminGuard,
      true,
      `Route ${layer.route.path} must be protected with requireSuperAdmin middleware`
    );
  }
});

/* ══════════════════════════════════════════════════════════════
   8. SYSTEM CONTROLLER - RATE LIMITING & DIAGNOSTIC ENDPOINTS
══════════════════════════════════════════════════════════════ */
test('System Controller - Rate limiting & generic messages', async (t) => {
  const cloudinary = require('cloudinary').v2;
  const AuditLog = require('../models/AuditLog');
  const backupService = require('../services/backupService');

  const origAuditCreate = AuditLog.create;
  const origCloudinaryPing = cloudinary.api.ping;
  const origPrune = backupService.pruneExpiredBackups;

  t.beforeEach(() => {
    systemCtrl._resetRateLimits();
    AuditLog.create = async () => ({ _id: 'fake_audit_id' });
    cloudinary.api.ping = async () => ({ status: 'ok' });
    backupService.pruneExpiredBackups = async () => ({ expiredCount: 2, orphanCount: 1, wouldDeleteCount: 3 });
  });

  t.afterEach(() => {
    AuditLog.create = origAuditCreate;
    cloudinary.api.ping = origCloudinaryPing;
    backupService.pruneExpiredBackups = origPrune;
  });

  function createMockRes() {
    return {
      statusCode: 200,
      headers: {},
      body: null,
      set(k, v) { this.headers[k] = v; return this; },
      status(c) { this.statusCode = c; return this; },
      json(p) { this.body = p; return this; },
      render(view, data) { this.renderedView = view; this.viewData = data; return this; },
    };
  }

  await t.test('systemHealthIndex sets Cache-Control: no-store', async () => {
    const req = { session: { user: { role: 'superadmin' } } };
    const res = createMockRes();
    await systemCtrl.systemHealthIndex(req, res);
    assert.equal(res.headers['Cache-Control'], 'no-store');
  });

  await t.test('testCloudinary enforces 1-minute rate limiting', async () => {
    const req = {
      session: { user: { _id: '650000000000000000000001', displayName: 'Super' } },
      ip: '127.0.0.1',
    };
    const res1 = createMockRes();

    // Call 1: passes rate limit
    await systemCtrl.testCloudinary(req, res1);

    // Call 2: immediately afterwards triggers 429
    const res2 = createMockRes();
    await systemCtrl.testCloudinary(req, res2);

    assert.equal(res2.statusCode, 429);
    assert.equal(res2.body.ok, false);
    assert.ok(res2.body.message.includes('Please wait'));
  });

  await t.test('cleanupPreview enforces 1-minute rate limiting', async () => {
    const req = {
      session: { user: { _id: '650000000000000000000001', displayName: 'Super' } },
      ip: '127.0.0.1',
    };
    const res1 = createMockRes();

    // Call 1
    await systemCtrl.cleanupPreview(req, res1);

    // Call 2 immediately triggers 429
    const res2 = createMockRes();
    await systemCtrl.cleanupPreview(req, res2);

    assert.equal(res2.statusCode, 429);
    assert.equal(res2.body.ok, false);
    assert.ok(res2.body.message.includes('Please wait'));
  });
});
