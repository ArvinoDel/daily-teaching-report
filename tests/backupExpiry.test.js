'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planBackupExpiry } = require('../services/backupService');

test('Backup Expiry Planner - planBackupExpiry pure function', async (t) => {
  const now = new Date('2026-10-26T12:00:00.000Z');
  const dayMs = 24 * 60 * 60 * 1000;

  await t.test('1. Retains backups within 60 days', () => {
    const recent = [
      { _id: 'b1', createdAt: new Date(now.getTime() - 10 * dayMs), status: 'success' },
      { _id: 'b2', createdAt: new Date(now.getTime() - 30 * dayMs), status: 'success' },
      { _id: 'b3', createdAt: new Date(now.getTime() - 59 * dayMs), status: 'success' },
    ];

    const result = planBackupExpiry(recent, now, { retentionDays: 60 });
    assert.equal(result.expired.length, 0);
    assert.equal(result.protected.length, 3);
  });

  await t.test('2. Expires unpinned backups older than 60 days beyond top 2 newest', () => {
    const backups = [
      { _id: 'b-new1', createdAt: new Date(now.getTime() - 5 * dayMs), status: 'success' },
      { _id: 'b-new2', createdAt: new Date(now.getTime() - 15 * dayMs), status: 'success' },
      { _id: 'b-old1', createdAt: new Date(now.getTime() - 65 * dayMs), status: 'success' },
      { _id: 'b-old2', createdAt: new Date(now.getTime() - 90 * dayMs), status: 'success' },
    ];

    const result = planBackupExpiry(backups, now, { retentionDays: 60 });
    assert.equal(result.expired.length, 2);
    assert.deepEqual(result.expired.map(b => b._id), ['b-old1', 'b-old2']);
  });

  await t.test('3. Exact boundary condition (1ms)', () => {
    const exactCutoff = new Date(now.getTime() - 60 * dayMs);
    const justBeforeCutoff = new Date(exactCutoff.getTime() - 1); // 1ms older
    const justAfterCutoff = new Date(exactCutoff.getTime() + 1);  // 1ms newer

    // Add 2 newer backups so the cutoff items aren't protected by latest_successful
    const backups = [
      { _id: 'top1', createdAt: new Date(now.getTime() - 1 * dayMs), status: 'success' },
      { _id: 'top2', createdAt: new Date(now.getTime() - 2 * dayMs), status: 'success' },
      { _id: 'atCutoff', createdAt: exactCutoff, status: 'success' },
      { _id: 'afterCutoff', createdAt: justAfterCutoff, status: 'success' },
      { _id: 'beforeCutoff', createdAt: justBeforeCutoff, status: 'success' },
    ];

    const result = planBackupExpiry(backups, now, { retentionDays: 60 });
    const expiredIds = result.expired.map(b => b._id);
    assert.ok(expiredIds.includes('beforeCutoff'), '1ms older than cutoff must expire');
    assert.ok(!expiredIds.includes('atCutoff'), 'Exactly at cutoff must be retained');
    assert.ok(!expiredIds.includes('afterCutoff'), '1ms newer than cutoff must be retained');
  });

  await t.test('4. Pinned backups are NEVER expired regardless of age', () => {
    const backups = [
      { _id: 'top1', createdAt: new Date(now.getTime() - 1 * dayMs), status: 'success' },
      { _id: 'top2', createdAt: new Date(now.getTime() - 2 * dayMs), status: 'success' },
      { _id: 'pinnedAncient', createdAt: new Date(now.getTime() - 500 * dayMs), status: 'success', pinned: true },
      { _id: 'unpinnedOld', createdAt: new Date(now.getTime() - 500 * dayMs), status: 'success', pinned: false },
    ];

    const result = planBackupExpiry(backups, now, { retentionDays: 60 });
    const expiredIds = result.expired.map(b => b._id);
    assert.ok(!expiredIds.includes('pinnedAncient'), 'Pinned backup must not be expired');
    assert.ok(expiredIds.includes('unpinnedOld'), 'Unpinned ancient backup must be expired');

    const pinnedEntry = result.protected.find(p => p.id === 'pinnedAncient');
    assert.equal(pinnedEntry.reason, 'pinned');
  });

  await t.test('5. Protects 2 newest successful backups on inactive sites', () => {
    // Only 2 backups in the entire system, both 1 year old
    const backups = [
      { _id: 'ancient1', createdAt: new Date(now.getTime() - 365 * dayMs), status: 'success' },
      { _id: 'ancient2', createdAt: new Date(now.getTime() - 400 * dayMs), status: 'success' },
      { _id: 'ancient3', createdAt: new Date(now.getTime() - 450 * dayMs), status: 'success' },
    ];

    const result = planBackupExpiry(backups, now, { retentionDays: 60 });
    // ancient1 and ancient2 are the 2 newest successful backups
    const protectedIds = result.protected.map(p => p.id);
    assert.ok(protectedIds.includes('ancient1'));
    assert.ok(protectedIds.includes('ancient2'));
    assert.deepEqual(result.expired.map(b => b._id), ['ancient3']);

    const reasons = result.protected.map(p => p.reason);
    assert.deepEqual(reasons, ['latest_successful', 'latest_successful']);
  });

  await t.test('6. Failed backups expire after 60 days and are never protected by latest_successful', () => {
    const backups = [
      // Only 1 successful backup
      { _id: 'succ1', createdAt: new Date(now.getTime() - 100 * dayMs), status: 'success' },
      // Several failed backups
      { _id: 'failRecent', createdAt: new Date(now.getTime() - 10 * dayMs), status: 'failed' },
      { _id: 'failOld', createdAt: new Date(now.getTime() - 80 * dayMs), status: 'failed' },
      { _id: 'failPinned', createdAt: new Date(now.getTime() - 80 * dayMs), status: 'failed', pinned: true },
    ];

    const result = planBackupExpiry(backups, now, { retentionDays: 60 });
    const expiredIds = result.expired.map(b => b._id);

    assert.ok(!expiredIds.includes('succ1'), 'Top successful backup protected');
    assert.ok(!expiredIds.includes('failRecent'), 'Recent failed backup protected within retention');
    assert.ok(!expiredIds.includes('failPinned'), 'Pinned failed backup protected');
    assert.ok(expiredIds.includes('failOld'), 'Old unpinned failed backup expired');
  });

  await t.test('7. Automated and Manual backups are treated under the same retention rules', () => {
    const backups = [
      { _id: 'top1', createdAt: new Date(now.getTime() - 1 * dayMs), status: 'success', initiatedByName: 'System (Automated)' },
      { _id: 'top2', createdAt: new Date(now.getTime() - 2 * dayMs), status: 'success', initiatedByName: 'Admin User' },
      { _id: 'oldAuto', createdAt: new Date(now.getTime() - 70 * dayMs), status: 'success', initiatedByName: 'System (Automated)' },
      { _id: 'oldManual', createdAt: new Date(now.getTime() - 75 * dayMs), status: 'success', initiatedByName: 'Admin User' },
    ];

    const result = planBackupExpiry(backups, now, { retentionDays: 60 });
    assert.deepEqual(result.expired.map(b => b._id), ['oldAuto', 'oldManual']);
  });
});

test('Orphan Sweep Planner - planOrphanSweep pure function', async (t) => {
  const { planOrphanSweep } = require('../services/backupService');
  const now = new Date('2026-10-26T12:00:00.000Z');
  const dayMs = 24 * 60 * 60 * 1000;
  // Cutoff is 60 + 7 = 67 days ago
  const cutoffAge = 67 * dayMs;

  await t.test('1. Skips when knownIds is empty (guard a)', () => {
    const listed = [
      { public_id: 'daily-teaching-report/backups/production/backup-old', created_at: new Date(now.getTime() - 100 * dayMs) },
    ];
    const result = planOrphanSweep(listed, new Set(), now, { retentionDays: 60 });
    assert.equal(result.skippedReason, 'no_known_backups');
    assert.equal(result.toDelete.length, 0);
  });

  await t.test('2. Skips when no listed asset matches any known ID (guard b)', () => {
    const listed = [
      { public_id: 'daily-teaching-report/backups/staging/backup-old1', created_at: new Date(now.getTime() - 100 * dayMs) },
      { public_id: 'daily-teaching-report/backups/staging/backup-old2', created_at: new Date(now.getTime() - 100 * dayMs) },
    ];
    const knownIds = new Set(['daily-teaching-report/backups/production/backup-prod1']);

    const result = planOrphanSweep(listed, knownIds, now, { retentionDays: 60 });
    assert.equal(result.skippedReason, 'no_matching_environment_asset');
    assert.equal(result.toDelete.length, 0);
  });

  await t.test('3. Ignores files outside the backup- naming pattern', () => {
    const knownId = 'daily-teaching-report/backups/production/backup-valid';
    const listed = [
      { public_id: knownId, created_at: now },
      // Non-backup pattern files
      { public_id: 'daily-teaching-report/backups/production/report-export-old', created_at: new Date(now.getTime() - 100 * dayMs) },
      { public_id: 'daily-teaching-report/backups/production/user_avatar.jpg', created_at: new Date(now.getTime() - 100 * dayMs) },
    ];

    const result = planOrphanSweep(listed, [knownId], now, { retentionDays: 60 });
    assert.equal(result.skippedReason, null);
    assert.equal(result.toDelete.length, 0, 'Non-backup files must not be deleted as backup orphans');
  });

  await t.test('4. Keeps recent files within retention + 7 days', () => {
    const knownId = 'daily-teaching-report/backups/production/backup-valid';
    const listed = [
      { public_id: knownId, created_at: now },
      // Orphan within 67 days (e.g. 50 days old, 66 days old)
      { public_id: 'daily-teaching-report/backups/production/backup-orphan-recent', created_at: new Date(now.getTime() - 50 * dayMs) },
      { public_id: 'daily-teaching-report/backups/production/backup-orphan-boundary', created_at: new Date(now.getTime() - 66 * dayMs) },
    ];

    const result = planOrphanSweep(listed, [knownId], now, { retentionDays: 60 });
    assert.equal(result.skippedReason, null);
    assert.equal(result.toDelete.length, 0, 'Recent orphan files must be preserved');
  });

  await t.test('5. Identifies orphans older than retention + 7 days and respects cap', () => {
    const knownId = 'daily-teaching-report/backups/production/backup-valid';

    // 25 orphan files older than 67 days
    const listed = [
      { public_id: knownId, created_at: now },
    ];
    for (let i = 1; i <= 25; i++) {
      listed.push({
        public_id: `daily-teaching-report/backups/production/backup-orphan-${i}`,
        created_at: new Date(now.getTime() - 80 * dayMs),
        bytes: 1024,
      });
    }

    const result = planOrphanSweep(listed, [knownId], now, { retentionDays: 60, maxOrphanDeletes: 20 });
    assert.equal(result.skippedReason, null);
    assert.equal(result.toDelete.length, 20, 'Must cap deletions at maxOrphanDeletes (20)');
    assert.equal(result.remainingCount, 5, 'Must report remaining excess orphans');
    assert.equal(result.toDelete[0].public_id, 'daily-teaching-report/backups/production/backup-orphan-1');
  });
});

