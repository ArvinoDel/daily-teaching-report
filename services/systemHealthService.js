'use strict';
/**
 * systemHealthService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Diagnostic registry, health evaluators, and system metrics collectors.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const Backup = require('../models/Backup');
const CronRun = require('../models/CronRun');
const backupService = require('./backupService');

const APP_TIMEZONE = 'Asia/Jakarta';

/* ══════════════════════════════════════════════════════════════
   1. ENVIRONMENT REGISTRY
══════════════════════════════════════════════════════════════ */

const ENV_REGISTRY = [
  // Database
  {
    name: 'MONGO_URI',
    group: 'Database',
    required: true,
    validate: (v) => typeof v === 'string' && (v.startsWith('mongodb://') || v.startsWith('mongodb+srv://')),
  },
  // Security
  {
    name: 'SESSION_SECRET',
    group: 'Security',
    required: true,
    validate: (v) => typeof v === 'string' && v.trim().length >= 32,
  },
  {
    name: 'CRON_SECRET',
    group: 'Security',
    required: true,
    validate: (v) => typeof v === 'string' && v.trim().length >= 16,
  },
  {
    name: 'CSP_REPORT_ONLY',
    group: 'Security',
    required: false,
    validate: (v) => ['true', 'false', '1', '0'].includes(String(v).trim().toLowerCase()),
  },
  // Cloudinary
  {
    name: 'CLOUDINARY_CLOUD_NAME',
    group: 'Storage (Cloudinary)',
    required: true,
    validate: (v) => typeof v === 'string' && v.trim().length > 0,
  },
  {
    name: 'CLOUDINARY_API_KEY',
    group: 'Storage (Cloudinary)',
    required: true,
    validate: (v) => typeof v === 'string' && v.trim().length > 0,
  },
  {
    name: 'CLOUDINARY_API_SECRET',
    group: 'Storage (Cloudinary)',
    required: true,
    validate: (v) => typeof v === 'string' && v.trim().length > 0,
  },
  // Application
  {
    name: 'APP_BASE_URL',
    group: 'Application',
    required: true,
    validate: (v) => {
      if (typeof v !== 'string' || !v.trim()) return false;
      try {
        const u = new URL(v.trim());
        return u.protocol === 'https:';
      } catch {
        return false;
      }
    },
  },
  // AI / Gemini (Composite: GOOGLE_GEMINI_API_KEY, GOOGLE_API_KEY, GEMINI_KEY, GEMINI_API_KEY)
  {
    name: 'GEMINI_API_KEY',
    group: 'AI (Gemini)',
    required: false,
    isComposite: true,
    aliases: ['GOOGLE_GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_KEY', 'GEMINI_API_KEY'],
    validate: (_v, env = {}) => {
      const candidates = [
        env.GOOGLE_GEMINI_API_KEY,
        env.GOOGLE_API_KEY,
        env.GEMINI_KEY,
        env.GEMINI_API_KEY,
      ];
      return candidates.some(c => typeof c === 'string' && c.trim().length > 0);
    },
  },
  // Tunables: Platform
  {
    name: 'MAX_FUNCTION_MS',
    group: 'Tunables (Platform)',
    required: false,
    validate: (v) => !isNaN(Number(v)) && Number(v) > 0,
  },
  // Tunables: Backup
  {
    name: 'BACKUP_RETENTION_DAYS',
    group: 'Tunables (Backup)',
    required: false,
    validate: (v) => !isNaN(Number(v)) && Number(v) > 0,
  },
  {
    name: 'BACKUP_UPLOAD_TIMEOUT_MS',
    group: 'Tunables (Backup)',
    required: false,
    validate: (v) => !isNaN(Number(v)) && Number(v) > 0,
  },
  {
    name: 'BACKUP_SWEEP_ORPHANS',
    group: 'Tunables (Backup)',
    required: false,
    validate: (v) => ['true', 'false', '1', '0'].includes(String(v).trim().toLowerCase()),
  },
  {
    name: 'BACKUP_SWEEP_LEGACY',
    group: 'Tunables (Backup)',
    required: false,
    validate: (v) => ['true', 'false', '1', '0'].includes(String(v).trim().toLowerCase()),
  },
  // Tunables: Material
  {
    name: 'MATERIAL_MAX_FILE_MB',
    group: 'Tunables (Material)',
    required: false,
    validate: (v) => !isNaN(Number(v)) && Number(v) > 0,
  },
  {
    name: 'MATERIAL_ALLOWED_EXTENSIONS',
    group: 'Tunables (Material)',
    required: false,
    validate: (v) => typeof v === 'string' && v.trim().length > 0,
  },
  {
    name: 'MATERIAL_SIGN_ALLOWED_FORMATS',
    group: 'Tunables (Material)',
    required: false,
    validate: (v) => typeof v === 'string' && v.trim().length > 0,
  },
  // Tunables: Onboarding
  {
    name: 'ONBOARDING_LAUNCH_DATE',
    group: 'Tunables (Onboarding)',
    required: false,
    validate: (v) => !isNaN(Date.parse(v)),
  },
  {
    name: 'ONBOARDING_REMINDERS_START_DATE',
    group: 'Tunables (Onboarding)',
    required: false,
    validate: (v) => !isNaN(Date.parse(v)),
  },
  {
    name: 'ONBOARDING_REMINDER_FIRST_AFTER_DAYS',
    group: 'Tunables (Onboarding)',
    required: false,
    validate: (v) => !isNaN(Number(v)) && Number(v) > 0,
  },
  {
    name: 'ONBOARDING_REMINDER_INTERVAL_DAYS',
    group: 'Tunables (Onboarding)',
    required: false,
    validate: (v) => !isNaN(Number(v)) && Number(v) > 0,
  },
  {
    name: 'ONBOARDING_REMINDER_MAX',
    group: 'Tunables (Onboarding)',
    required: false,
    validate: (v) => !isNaN(Number(v)) && Number(v) > 0,
  },
  {
    name: 'ONBOARDING_REMINDER_LEGACY_INTERVAL_DAYS',
    group: 'Tunables (Onboarding)',
    required: false,
    validate: (v) => !isNaN(Number(v)) && Number(v) > 0,
  },
  {
    name: 'ONBOARDING_REMINDER_LEGACY_MAX',
    group: 'Tunables (Onboarding)',
    required: false,
    validate: (v) => !isNaN(Number(v)) && Number(v) > 0,
  },
  // Tunables: Report Gaps
  {
    name: 'REPORT_GAP_PATTERN_WEEKS',
    group: 'Tunables (Report Gaps)',
    required: false,
    validate: (v) => !isNaN(Number(v)) && Number(v) > 0,
  },
  {
    name: 'REPORT_GAP_PATTERN_MIN_WEEKS',
    group: 'Tunables (Report Gaps)',
    required: false,
    validate: (v) => !isNaN(Number(v)) && Number(v) > 0,
  },
  {
    name: 'REPORT_GAP_LOOKBACK_DAYS',
    group: 'Tunables (Report Gaps)',
    required: false,
    validate: (v) => !isNaN(Number(v)) && Number(v) > 0,
  },
  {
    name: 'REPORT_GAP_SILENT_DAYS',
    group: 'Tunables (Report Gaps)',
    required: false,
    validate: (v) => !isNaN(Number(v)) && Number(v) > 0,
  },
  {
    name: 'REPORT_GAP_SILENT_TEACHER_MIN_REPORTS',
    group: 'Tunables (Report Gaps)',
    required: false,
    validate: (v) => !isNaN(Number(v)) && Number(v) > 0,
  },
  {
    name: 'REPORT_GAP_SILENT_GROUP_MIN_REPORTS',
    group: 'Tunables (Report Gaps)',
    required: false,
    validate: (v) => !isNaN(Number(v)) && Number(v) > 0,
  },
];

const IGNORED_ENV_VARS = [
  'NODE_ENV',
  'PORT',
  'VERCEL',
  'VERCEL_ENV',
  'VERCEL_REGION',
  'VERCEL_GIT_COMMIT_SHA',
];

/**
 * Pure evaluator: evaluates environment variables against the registry.
 * NEVER returns or exposes actual values.
 *
 * @param {Array} [registry=ENV_REGISTRY]
 * @param {Object} [env=process.env]
 * @returns {Array<{ name: string, group: string, required: boolean, status: 'Set'|'Missing'|'Set but invalid' }>}
 */
function evaluateEnv(registry = ENV_REGISTRY, env = process.env) {
  return registry.map(entry => {
    let status = 'Missing';

    if (entry.isComposite) {
      const anySet = (entry.aliases || []).some(a => {
        const val = env[a];
        return val !== undefined && val !== null && String(val).trim() !== '';
      });
      if (anySet) {
        status = entry.validate(null, env) ? 'Set' : 'Set but invalid';
      } else {
        status = 'Missing';
      }
    } else {
      const val = env[entry.name];
      const isSet = val !== undefined && val !== null && String(val).trim() !== '';
      if (!isSet) {
        status = 'Missing';
      } else {
        status = entry.validate(val, env) ? 'Set' : 'Set but invalid';
      }
    }

    return {
      name: entry.name,
      group: entry.group,
      required: Boolean(entry.required),
      status,
    };
  });
}

/* ══════════════════════════════════════════════════════════════
   2. PURE HEALTH & OVERDUE EVALUATORS
══════════════════════════════════════════════════════════════ */

/**
 * Evaluates cron overdue status.
 *
 * @param {Object} latestRuns - Latest CronRun per job { backup, 'backup-cleanup', 'manual-prune' }
 * @param {Date} [now=new Date()]
 * @returns {Object}
 */
function computeCronHealth(latestRuns = {}, now = new Date()) {
  const eightDaysMs = 8 * 24 * 60 * 60 * 1000;
  const thirtySixHoursMs = 36 * 60 * 60 * 1000;

  const backupRun = latestRuns.backup || null;
  const cleanupRun = latestRuns['backup-cleanup'] || null;
  const pruneRun = latestRuns['manual-prune'] || null;

  let backupOverdue = false;
  if (!backupRun || !backupRun.lastSuccessStartedAt) {
    backupOverdue = true;
  } else {
    const age = now.getTime() - new Date(backupRun.lastSuccessStartedAt).getTime();
    if (age > eightDaysMs) {
      backupOverdue = true;
    }
  }

  let cleanupOverdue = false;
  if (!cleanupRun || !cleanupRun.lastSuccessStartedAt) {
    cleanupOverdue = true;
  } else {
    const age = now.getTime() - new Date(cleanupRun.lastSuccessStartedAt).getTime();
    if (age > thirtySixHoursMs) {
      cleanupOverdue = true;
    }
  }

  return {
    backup: backupRun,
    cleanup: cleanupRun,
    prune: pruneRun,
    backupOverdue,
    cleanupOverdue,
  };
}

/**
 * Pure evaluator for overall system health.
 * Rules for "Needs attention":
 *   1. A required env missing or invalid
 *   2. No successful backup in 8 days
 *   3. A cron overdue
 *   4. Last backup failed
 *   5. Last backup not private (cloudinaryType !== 'authenticated')
 *   6. Database not connected
 *
 * @param {Object} params
 * @param {Array} params.envItems
 * @param {Object} [params.lastSuccessBackup]
 * @param {Object} [params.lastBackup]
 * @param {Object} [params.cronStatus]
 * @param {boolean} [params.dbConnected=true]
 * @param {Date} [params.now=new Date()]
 * @returns {{ status: 'OK'|'Needs attention', reasons: string[] }}
 */
function evaluateSystemHealth({
  envItems = [],
  lastSuccessBackup = null,
  lastBackup = null,
  cronStatus = {},
  dbConnected = true,
  now = new Date(),
}) {
  const reasons = [];

  // 1. Required env missing or invalid
  for (const item of envItems) {
    if (item.required && item.status !== 'Set') {
      reasons.push(`Required environment variable ${item.name} is ${item.status.toLowerCase()}`);
    }
  }

  // 2. No successful backup in 8 days
  const eightDaysMs = 8 * 24 * 60 * 60 * 1000;
  if (!lastSuccessBackup) {
    reasons.push('No successful database backup found in history');
  } else {
    const successAgeMs = now.getTime() - new Date(lastSuccessBackup.createdAt).getTime();
    if (successAgeMs > eightDaysMs) {
      reasons.push('No successful database backup in the last 8 days');
    }
  }

  // 3. A cron overdue
  if (cronStatus.backupOverdue) {
    reasons.push('Weekly backup cron is overdue (> 8 days since last success)');
  }
  if (cronStatus.cleanupOverdue) {
    reasons.push('Daily backup cleanup cron is overdue (> 36 hours since last success)');
  }

  // 4. Last backup failed
  if (lastBackup && lastBackup.status === 'failed') {
    reasons.push('The most recent database backup run failed');
  }

  // 5. Last backup not private
  if (lastSuccessBackup && lastSuccessBackup.cloudinaryType !== 'authenticated') {
    reasons.push('The latest successful backup archive is not stored privately in authenticated cloud storage');
  }

  // 6. Database not connected
  if (!dbConnected) {
    reasons.push('MongoDB database is currently disconnected');
  }

  return {
    status: reasons.length > 0 ? 'Needs attention' : 'OK',
    reasons,
  };
}

/* ══════════════════════════════════════════════════════════════
   3. FORMATTING HELPERS
══════════════════════════════════════════════════════════════ */

function formatWib(date) {
  if (!date) return '—';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TIMEZONE,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d) + ' WIB';
}

function formatAge(date, now = new Date()) {
  if (!date) return 'never';
  const diffMs = Math.max(0, now.getTime() - new Date(date).getTime());
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin === 1) return '1 minute ago';
  if (diffMin < 60) return `${diffMin} minutes ago`;
  if (diffHours === 1) return '1 hour ago';
  if (diffHours < 24) return `${diffHours} hours ago`;
  if (diffDays === 1) return '1 day ago';
  return `${diffDays} days ago`;
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatUptime(seconds) {
  const s = Math.floor(seconds || 0);
  const days = Math.floor(s / (24 * 3600));
  const hours = Math.floor((s % (24 * 3600)) / 3600);
  const mins = Math.floor((s % 3600) / 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(' ');
}

/* ══════════════════════════════════════════════════════════════
   4. DATA ACCESS: GET FULL SYSTEM HEALTH DATA
══════════════════════════════════════════════════════════════ */

async function getSystemHealthData(now = new Date()) {
  const mongoose = require('mongoose');

  // 1. Database connection & ping
  let dbConnected = mongoose.connection.readyState === 1;
  let dbPingMs = null;
  if (dbConnected && mongoose.connection.db) {
    const t0 = Date.now();
    try {
      await mongoose.connection.db.command({ ping: 1 });
      dbPingMs = Date.now() - t0;
    } catch {
      dbConnected = false;
    }
  }

  // 2. Fetch Backups
  const retentionDays = parseInt(process.env.BACKUP_RETENTION_DAYS, 10) || backupService.DEFAULT_RETENTION_DAYS;
  const dayMs = 24 * 60 * 60 * 1000;
  const warningCutoff = new Date(now.getTime() + 7 * dayMs);

  let totalBackups = 0;
  let pinnedCount = 0;
  let lastBackupDoc = null;
  let lastSuccessBackupDoc = null;
  let lastFailedBackupDoc = null;
  let successBackupsList = [];

  if (dbConnected) {
    try {
      [
        totalBackups,
        pinnedCount,
        lastBackupDoc,
        lastSuccessBackupDoc,
        lastFailedBackupDoc,
        successBackupsList,
      ] = await Promise.all([
        Backup.countDocuments(),
        Backup.countDocuments({ pinned: true }),
        Backup.findOne().sort({ createdAt: -1 }).lean(),
        Backup.findOne({ status: 'success' }).sort({ createdAt: -1 }).lean(),
        Backup.findOne({ status: 'failed' }).sort({ createdAt: -1 }).lean(),
        Backup.find({ status: 'success' }).select('fileSizeBytes createdAt pinned').lean(),
      ]);
    } catch {
      dbConnected = false;
    }
  }

  const totalSizeBytes = successBackupsList.reduce((acc, b) => acc + (b.fileSizeBytes || 0), 0);

  // Expiring soon: calculate how many unpinned expire within 7 days
  let expiringSoonCount = 0;
  for (const b of successBackupsList) {
    if (b.pinned) continue;
    const expiresAt = new Date(new Date(b.createdAt).getTime() + retentionDays * dayMs);
    if (expiresAt <= warningCutoff && expiresAt > now) {
      expiringSoonCount++;
    }
  }

  const nextBackupDate = backupService.getNextBackupDate(now);

  const backupsData = {
    totalCount: totalBackups,
    pinnedCount,
    expiringSoonCount,
    totalSizeBytes,
    totalSizeFormatted: formatBytes(totalSizeBytes),
    nextBackupDate,
    nextBackupFormatted: formatWib(nextBackupDate),
    lastSuccess: lastSuccessBackupDoc ? {
      timeFormatted: formatWib(lastSuccessBackupDoc.createdAt),
      age: formatAge(lastSuccessBackupDoc.createdAt, now),
      sizeFormatted: formatBytes(lastSuccessBackupDoc.fileSizeBytes),
      format: (backupService.FORMAT_META[lastSuccessBackupDoc.format] || {}).label || lastSuccessBackupDoc.format || 'json_gz',
      hasChecksum: Boolean(lastSuccessBackupDoc.checksum),
      isPrivate: lastSuccessBackupDoc.cloudinaryType === 'authenticated',
    } : null,
    lastFailed: lastFailedBackupDoc ? {
      timeFormatted: formatWib(lastFailedBackupDoc.createdAt),
      age: formatAge(lastFailedBackupDoc.createdAt, now),
      errorMessage: lastFailedBackupDoc.errorMessage || 'Unknown error',
    } : null,
  };

  // 3. Fetch Cron Runs for all 3 jobs
  const jobs = ['backup', 'backup-cleanup', 'manual-prune'];
  const latestRuns = {};

  for (const job of jobs) {
    let latestRun = null;
    let lastSuccessRun = null;
    if (dbConnected) {
      try {
        [latestRun, lastSuccessRun] = await Promise.all([
          CronRun.findOne({ job }).sort({ startedAt: -1 }).lean(),
          CronRun.findOne({ job, ok: true }).sort({ startedAt: -1 }).lean(),
        ]);
      } catch {
        dbConnected = false;
      }
    }

    if (latestRun) {
      latestRuns[job] = {
        ...latestRun,
        startedAtFormatted: formatWib(latestRun.startedAt),
        age: formatAge(latestRun.startedAt, now),
        lastSuccessStartedAt: lastSuccessRun ? lastSuccessRun.startedAt : null,
      };
    } else {
      latestRuns[job] = null;
    }
  }

  const cronStatus = computeCronHealth(latestRuns, now);

  // 4. Evaluate Environment
  const envItems = evaluateEnv(ENV_REGISTRY, process.env);

  // 5. Evaluate Overall Status
  const health = evaluateSystemHealth({
    envItems,
    lastSuccessBackup: lastSuccessBackupDoc,
    lastBackup: lastBackupDoc,
    cronStatus,
    dbConnected,
    now,
  });

  // 6. Runtime metadata
  const runtime = {
    nodeEnv: process.env.NODE_ENV || 'development',
    vercelEnv: process.env.VERCEL_ENV || 'local / not set',
    region: process.env.VERCEL_REGION || 'local / not set',
    shortCommit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || 'local',
    nodeVersion: process.version,
    serverTimeFormatted: formatWib(now),
    uptimeFormatted: formatUptime(process.uptime()),
    dbConnected,
    dbPingMs,
  };

  return {
    health,
    backups: backupsData,
    cronStatus,
    envItems,
    runtime,
  };
}

module.exports = {
  ENV_REGISTRY,
  IGNORED_ENV_VARS,
  evaluateEnv,
  computeCronHealth,
  evaluateSystemHealth,
  formatWib,
  formatAge,
  formatBytes,
  formatUptime,
  getSystemHealthData,
};
