'use strict';

const https        = require('https');
const cloudinary   = require('cloudinary').v2;
const Backup       = require('../models/Backup');
const backupService = require('../services/backupService');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + ' ' + sizes[i];
}

/* ═══════════════════════════════════════════════
   GET /admin/backups  — list history
═══════════════════════════════════════════════ */
exports.backupsList = async (req, res) => {
  try {
    const backups = await Backup.find().sort({ createdAt: -1 }).limit(100);

    const flashMessage = req.session.flash || null;
    delete req.session.flash;

    const retentionDays = parseInt(process.env.BACKUP_RETENTION_DAYS, 10) || backupService.DEFAULT_RETENTION_DAYS;
    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;
    const warningCutoff = new Date(now.getTime() + 7 * dayMs);

    let expiringSoonCount = 0;

    const backupsFormatted = backups.map(b => {
      const obj = b.toObject({ virtuals: true });
      obj.fileSizeFormatted = formatBytes(b.fileSizeBytes);
      obj.totalRecords = b.recordCounts
        ? Object.values(b.recordCounts).reduce((s, n) => s + (typeof n === 'number' ? n : 0), 0)
        : 0;
      obj.formatLabel = (backupService.FORMAT_META[b.format] || {}).label || b.format || 'JSON Gzip';

      const createdAtDate = new Date(b.createdAt);
      obj.expiresAt = new Date(createdAtDate.getTime() + retentionDays * dayMs);
      obj.isExpiringSoon = !b.pinned && b.status === 'success' && obj.expiresAt <= warningCutoff && obj.expiresAt > now;
      if (obj.isExpiringSoon) {
        expiringSoonCount++;
      }

      return obj;
    });

    const successBackups = backups.filter(b => b.status === 'success');
    const totalSizeBytes = successBackups.reduce((s, b) => s + (b.fileSizeBytes || 0), 0);

    // Freshness check: Has an automated backup succeeded in the last 8 days?
    const eightDaysAgo = new Date(now.getTime() - 8 * dayMs);
    const hasRecentAutomated = successBackups.some(b =>
      b.initiatedByName &&
      b.initiatedByName.includes('Automated') &&
      new Date(b.createdAt) >= eightDaysAgo
    );

    res.render('admin/backups/index', {
      backups:            backupsFormatted,
      flashMessage,
      totalSize:          formatBytes(totalSizeBytes),
      totalBackups:       backups.length,
      successCount:       successBackups.length,
      lastBackup:         successBackups[0] || null,
      nextBackupDate:     backupService.getNextBackupDate(),
      formatMeta:         backupService.FORMAT_META,
      retentionDays,
      expiringSoonCount,
      hasRecentAutomated,
    });
  } catch (err) {
    console.error('Backups list error:', err);
    res.render('error', { message: 'Failed to load backups.' });
  }
};

/* ═══════════════════════════════════════════════
   POST /admin/backups  — create new backup (cloud)
═══════════════════════════════════════════════ */
exports.createBackup = async (req, res) => {
  try {
    const format = ['json_gz', 'json', 'bson_gz'].includes(req.body.format)
      ? req.body.format
      : 'json_gz';

    const backup = await backupService.performBackup(
      req.session.user._id,
      req.session.user.displayName || req.session.user.username,
      format
    );

    const totalRecords = Object.values(backup.recordCounts).reduce((s, n) => s + (typeof n === 'number' ? n : 0), 0);
    const meta = backupService.FORMAT_META[format];
    req.session.flash = `Backup created! ${totalRecords} records exported as ${meta.label}.`;
    res.redirect('/admin/backups');

  } catch (err) {
    console.error('Backup error:', err);
    const safeMessage = backupService.sanitizeErrorMessage(err.message);
    await Backup.create({
      initiatedBy:     req.session.user._id,
      initiatedByName: req.session.user.displayName || req.session.user.username,
      status:          'failed',
      errorMessage:    safeMessage,
      recordCounts:    {},
    }).catch(() => {});
    req.session.flash = 'Backup failed. Please try again or contact the system administrator.';
    res.redirect('/admin/backups');
  }
};

/* ═══════════════════════════════════════════════
   GET /admin/backups/export?format=json_gz|json|bson_gz
   — Instant direct download (Incremental streaming, no Cloudinary upload)
═══════════════════════════════════════════════ */
exports.exportDirect = async (req, res) => {
  try {
    const format = ['json_gz', 'json', 'bson_gz'].includes(req.query.format)
      ? req.query.format
      : 'json_gz';

    const meta = backupService.FORMAT_META[format];
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const filename = `backup-${dateStr}.${meta.ext}`;

    const recordCounts = await backupService.getRecordCounts(backupService.BACKUP_COLLECTIONS);
    const { stream } = backupService.createBackupStream({
      format,
      recordCounts,
      registry: backupService.BACKUP_COLLECTIONS,
    });

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', meta.contentType);

    stream.on('error', (err) => {
      console.error('Direct export stream error:', err);
      if (!res.headersSent) {
        res.status(500).render('error', { message: 'Export streaming error.' });
      }
    });

    return stream.pipe(res);

  } catch (err) {
    console.error('Direct export error:', err);
    if (!res.headersSent) {
      res.status(500).render('error', { message: 'Export failed. Please try again.' });
    }
  }
};

/* ═══════════════════════════════════════════════
   DELETE /admin/backups/:id  — remove a record
═══════════════════════════════════════════════ */
exports.deleteBackup = async (req, res) => {
  try {
    const backup = await Backup.findById(req.params.id);
    if (!backup) {
      if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
        return res.status(404).json({ error: 'Backup not found.' });
      }
      return res.status(404).render('error', { message: 'Backup not found.' });
    }

    const delResult = await backupService.deleteBackupFile(backup);
    if (!delResult.ok) {
      const errMsg = delResult.error ? delResult.error.message : 'Storage deletion failed';
      console.error(`Failed to delete Cloudinary file for backup ${backup._id}:`, errMsg);

      await Backup.findByIdAndUpdate(backup._id, {
        deletionFailedAt: new Date(),
        deletionError: backupService.sanitizeErrorMessage(errMsg),
      }).catch(() => {});

      if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
        return res.status(502).json({ error: 'Failed to delete backup file from storage.' });
      }
      req.session.flash = 'Failed to delete backup file from cloud storage. Database record preserved for retry.';
      return res.redirect('/admin/backups');
    }

    await backup.deleteOne();

    if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.json({ ok: true });
    }
    req.session.flash = 'Backup deleted successfully.';
    res.redirect('/admin/backups');
  } catch (err) {
    console.error('Delete backup error:', err);
    if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.status(500).json({ error: 'Failed to delete backup.' });
    }
    res.status(500).render('error', { message: 'Failed to delete backup.' });
  }
};

/* ═══════════════════════════════════════════════
   POST /admin/backups/:id/pin — toggle pinned status
═══════════════════════════════════════════════ */
exports.togglePinBackup = async (req, res) => {
  try {
    const backup = await Backup.findById(req.params.id);
    if (!backup) {
      if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
        return res.status(404).json({ error: 'Backup not found.' });
      }
      return res.status(404).render('error', { message: 'Backup not found.' });
    }

    backup.pinned = !backup.pinned;
    await backup.save();

    if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.json({ ok: true, pinned: backup.pinned });
    }
    req.session.flash = `Backup ${backup.pinned ? 'pinned' : 'unpinned'} successfully.`;
    res.redirect('/admin/backups');
  } catch (err) {
    console.error('Toggle pin error:', err);
    if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.status(500).json({ error: 'Failed to toggle pin.' });
    }
    res.status(500).render('error', { message: 'Failed to toggle pin.' });
  }
};

/* ═══════════════════════════════════════════════
   POST /admin/backups/prune — manual prune expired
═══════════════════════════════════════════════ */
exports.pruneBackupsManual = async (req, res) => {
  try {
    const summary = await backupService.pruneExpiredBackups();

    if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.json({
        ok: true,
        summary: {
          deletedCount:       summary.deletedCount,
          freedBytes:         summary.freedBytes,
          freedBytesFormatted: formatBytes(summary.freedBytes),
          failedCount:        summary.failedCount,
          orphanDeletedCount: summary.orphanDeletedCount,
        },
      });
    }

    req.session.flash = `Prune complete: deleted ${summary.deletedCount} backup(s), freed ${formatBytes(summary.freedBytes)}.`;
    res.redirect('/admin/backups');
  } catch (err) {
    console.error('Manual prune error:', err);
    if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.status(500).json({ error: 'Failed to prune backups: ' + err.message });
    }
    req.session.flash = 'Failed to prune backups. Please check server logs.';
    res.redirect('/admin/backups');
  }
};

/* ═══════════════════════════════════════════════
   GET /admin/backups/:id/download  — proxy download
   Streams the file from Cloudinary through the server
   so the raw URL is never exposed to the browser.
   Uses signed URLs for authenticated assets.
═══════════════════════════════════════════════ */
exports.downloadBackup = async (req, res) => {
  try {
    const backup = await Backup.findById(req.params.id);
    if (!backup) return res.status(404).render('error', { message: 'Backup not found.' });
    if (!backup.fileUrl && !backup.cloudinaryId) {
      return res.status(404).render('error', { message: 'No file attached to this backup.' });
    }

    const meta    = backupService.FORMAT_META[backup.format] || backupService.FORMAT_META['json_gz'];
    const dateStr = new Date(backup.createdAt)
      .toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const filename = `backup-${dateStr}.${meta.ext}`;

    let targetUrl;
    if (backup.cloudinaryType === 'authenticated' && backup.cloudinaryId) {
      targetUrl = cloudinary.url(backup.cloudinaryId, {
        resource_type: 'raw',
        type:          'authenticated',
        sign_url:      true,
        secure:        true,
      });
    } else {
      targetUrl = backup.fileUrl;
    }

    const parsed = new URL(targetUrl);

    const clientReq = https.get(parsed, (upstream) => {
      if (upstream.statusCode !== 200) {
        upstream.resume();
        if (!res.headersSent) {
          return res.status(502).render('error', {
            message: `Failed to fetch backup file from storage (HTTP ${upstream.statusCode}).`,
          });
        }
        return;
      }

      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', meta.contentType);
      if (upstream.headers['content-length']) {
        res.setHeader('Content-Length', upstream.headers['content-length']);
      }

      upstream.pipe(res);
    });

    clientReq.setTimeout(30000, () => {
      clientReq.destroy();
      if (!res.headersSent) {
        res.status(504).render('error', { message: 'Download timed out from cloud storage.' });
      }
    });

    clientReq.on('error', (err) => {
      console.error('Download proxy error:', err);
      if (!res.headersSent) {
        res.status(502).render('error', { message: 'Failed to download backup file.' });
      }
    });
  } catch (err) {
    console.error('Download error:', err);
    if (!res.headersSent) {
      res.status(500).render('error', { message: 'Failed to download backup.' });
    }
  }
};