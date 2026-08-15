const cloudinary = require('cloudinary').v2;
const Backup   = require('../models/Backup');
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
    const backups = await Backup.find().sort({ createdAt: -1 }).limit(50);

    const flashMessage = req.session.flash || null;
    delete req.session.flash;

    const backupsFormatted = backups.map(b => {
      const obj = b.toObject({ virtuals: true });
      obj.fileSizeFormatted = formatBytes(b.fileSizeBytes);
      obj.totalRecords = b.recordCounts
        ? Object.values(b.recordCounts).reduce((s, n) => s + n, 0)
        : 0;
      obj.formatLabel = (backupService.FORMAT_META[b.format] || {}).label || b.format || 'JSON Gzip';
      return obj;
    });

    const successBackups = backups.filter(b => b.status === 'success');
    const totalSizeBytes = successBackups.reduce((s, b) => s + (b.fileSizeBytes || 0), 0);

    res.render('admin/backups/index', {
      backups: backupsFormatted,
      flashMessage,
      totalSize:      formatBytes(totalSizeBytes),
      totalBackups:   backups.length,
      successCount:   successBackups.length,
      lastBackup:     successBackups[0] || null,
      nextBackupDate: backupService.getNextBackupDate(),
      formatMeta:     backupService.FORMAT_META,
    });
  } catch (err) {
    console.error(err);
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

    const totalRecords = Object.values(backup.recordCounts).reduce((s, n) => s + n, 0);
    const meta = backupService.FORMAT_META[format];
    req.session.flash = `Backup created! ${totalRecords} records exported as ${meta.label}.`;
    res.redirect('/admin/backups');

  } catch (err) {
    console.error('Backup error:', err);
    const safeMessage = (err.message || 'Unknown error')
      .replace(/mongodb(\+srv)?:\/\/[^\s,]+/gi, '[REDACTED]')
      .replace(/https?:\/\/[^\s,]+/gi, '[REDACTED]')
      .replace(/[A-Z]:\\[^\s,]+/gi, '[REDACTED]')
      .substring(0, 200);
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
   — Instant direct download (no Cloudinary upload)
═══════════════════════════════════════════════ */
exports.exportDirect = async (req, res) => {
  try {
    const format = ['json_gz', 'json', 'bson_gz'].includes(req.query.format)
      ? req.query.format
      : 'json_gz';

    const meta = backupService.FORMAT_META[format];
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const filename = `backup-${dateStr}.${meta.ext}`;

    const { collections, recordCounts } = await backupService.fetchRawCollections();
    const buffer = backupService.serializeToFormat(format, collections, recordCounts);

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', meta.contentType);
    res.setHeader('Content-Length', buffer.length);
    return res.send(buffer);

  } catch (err) {
    console.error('Direct export error:', err);
    res.status(500).render('error', { message: 'Export failed. Please try again.' });
  }
};

/* ═══════════════════════════════════════════════
   DELETE /admin/backups/:id  — remove a record
═══════════════════════════════════════════════ */
exports.deleteBackup = async (req, res) => {
  try {
    const backup = await Backup.findById(req.params.id);
    if (!backup) return res.status(404).json({ error: 'Backup not found.' });

    if (backup.cloudinaryId) {
      try {
        await cloudinary.uploader.destroy(backup.cloudinaryId, { resource_type: 'raw' });
      } catch (e) {
        console.error('Cloudinary raw delete error:', e);
      }
    }

    await backup.deleteOne();

    if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.json({ ok: true });
    }
    res.redirect('/admin/backups');
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete backup.' });
  }
};

/* ═══════════════════════════════════════════════
   GET /admin/backups/:id/download  — proxy download
   Streams the file from Cloudinary through the server
   so the raw URL is never exposed to the browser.
═══════════════════════════════════════════════ */
exports.downloadBackup = async (req, res) => {
  try {
    const backup = await Backup.findById(req.params.id);
    if (!backup)    return res.status(404).render('error', { message: 'Backup not found.' });
    if (!backup.fileUrl) return res.status(404).render('error', { message: 'No file attached to this backup.' });

    const meta    = backupService.FORMAT_META[backup.format] || backupService.FORMAT_META['json_gz'];
    const dateStr = new Date(backup.createdAt)
      .toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const filename = `backup-${dateStr}.${meta.ext}`;

    const https  = require('https');
    const parsed = new URL(backup.fileUrl);

    https.get(parsed, (upstream) => {
      if (upstream.statusCode !== 200) {
        upstream.resume();
        return res.status(502).render('error', { message: 'Failed to fetch backup file from storage.' });
      }

      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', meta.contentType);
      if (upstream.headers['content-length']) {
        res.setHeader('Content-Length', upstream.headers['content-length']);
      }

      upstream.pipe(res);
    }).on('error', (err) => {
      console.error('Download proxy error:', err);
      res.status(502).render('error', { message: 'Failed to download backup file.' });
    });
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).render('error', { message: 'Failed to download backup.' });
  }
};