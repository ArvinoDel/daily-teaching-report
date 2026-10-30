'use strict';
/**
 * cronRunService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Execution wrapper and telemetry recorder for background cron & maintenance jobs.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const CronRun = require('../models/CronRun');

/**
 * Sanitizes summary objects so only small count/numeric/string primitives are stored.
 * Never stores arrays of documents, file contents, or sensitive attributes.
 */
function sanitizeSummary(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const clean = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'number' || typeof v === 'boolean') {
      clean[k] = v;
    } else if (typeof v === 'string' && v.length <= 100) {
      clean[k] = v;
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nested = {};
      for (const [nk, nv] of Object.entries(v)) {
        if (typeof nv === 'number' || typeof nv === 'boolean' || (typeof nv === 'string' && nv.length <= 60)) {
          nested[nk] = nv;
        }
      }
      clean[k] = nested;
    }
  }
  return clean;
}

/**
 * Strips stack traces, credentials, and sensitive tokens from error messages.
 * Truncates to max 300 characters.
 */
function sanitizeError(err) {
  if (!err) return null;
  const msg = typeof err === 'string' ? err : (err.message || 'Unknown error');
  const firstLine = msg.split(/\r?\n/)[0].trim();
  const sanitized = firstLine
    .replace(/(mongodb(?:\+srv)?:\/\/[^:]+:)[^@]+(@)/gi, '$1***$2')
    .replace(/(?:bearer|token|secret|key)\s+[a-zA-Z0-9_\-\.]+/gi, '[REDACTED]')
    .slice(0, 300);
  return sanitized;
}

/**
 * Wraps job execution, recording a CronRun document regardless of success or failure.
 * - On success: records ok: true, durationMs, summary counts, returns result unchanged.
 * - On failure: records ok: false, durationMs, sanitized error, then rethrows error.
 * - Never lets a database or logging failure break the job or throw outside.
 *
 * @param {'backup'|'backup-cleanup'|'manual-prune'} job
 * @param {'vercel-cron'|'scheduler'|'manual'} trigger
 * @param {Function} fn - Async job worker function
 * @returns {Promise<any>} Original result from fn
 */
async function recordCronRun(job, trigger, fn) {
  const startedAt = new Date();
  const startTime = Date.now();
  let ok = true;
  let errorStr = null;
  let summary = {};
  let result;

  try {
    result = await fn();

    // Extract summary counts if returned
    if (result && typeof result === 'object') {
      if (result.summary && typeof result.summary === 'object') {
        summary = result.summary;
      } else if (result.recordCounts || result.deletedCount !== undefined || result.expiredCount !== undefined) {
        summary = result;
      } else if (result.result && typeof result.result === 'object') {
        summary = result.result;
      }
    }
    return result;
  } catch (err) {
    ok = false;
    errorStr = sanitizeError(err);
    throw err;
  } finally {
    const finishedAt = new Date();
    const durationMs = Date.now() - startTime;
    try {
      await CronRun.create({
        job,
        trigger,
        startedAt,
        finishedAt,
        ok,
        durationMs,
        summary: sanitizeSummary(summary),
        error: errorStr,
      });
    } catch (logErr) {
      console.error('[cronRun] Non-fatal error recording cron run:', logErr.message);
    }
  }
}

module.exports = {
  recordCronRun,
  sanitizeSummary,
  sanitizeError,
};

