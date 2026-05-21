const zlib     = require('zlib');
const cloudinary = require('cloudinary').v2;

const User     = require('../models/User');
const Report   = require('../models/Report');
const Group    = require('../models/Group');
const AuditLog = require('../models/AuditLog');
const Feedback = require('../models/Feedback');
const Backup   = require('../models/Backup');

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

    // Pre-format for the template
    const backupsFormatted = backups.map(b => {
      const obj = b.toObject({ virtuals: true });
      obj.fileSizeFormatted = formatBytes(b.fileSizeBytes);
      obj.totalRecords = b.recordCounts
        ? Object.values(b.recordCounts).reduce((s, n) => s + n, 0)
        : 0;
      return obj;
    });

    const successBackups = backups.filter(b => b.status === 'success');
    const totalSizeBytes = successBackups.reduce((s, b) => s + (b.fileSizeBytes || 0), 0);

    res.render('admin/backups/index', {
      backups: backupsFormatted,
      flashMessage,
      totalSize:     formatBytes(totalSizeBytes),
      totalBackups:  backups.length,
      successCount:  successBackups.length,
      lastBackup:    successBackups[0] || null,
    });
  } catch (err) {
    console.error(err);
    res.render('error', { message: 'Failed to load backups.' });
  }
};

/* ═══════════════════════════════════════════════
   POST /admin/backups  — create new backup
═══════════════════════════════════════════════ */
exports.createBackup = async (req, res) => {
  try {
    // Fetch all collections
    const [users, reports, groups, auditLogs, feedbacks] = await Promise.all([
      User.find().lean(),
      Report.find().lean(),
      Group.find().lean(),
      AuditLog.find().lean(),
      Feedback.find().lean(),
    ]);

    const recordCounts = {
      users:     users.length,
      reports:   reports.length,
      groups:    groups.length,
      auditLogs: auditLogs.length,
      feedbacks: feedbacks.length,
    };

    const backupPayload = {
      exportedAt: new Date().toISOString(),
      appName:    'daily-teaching-report',
      recordCounts,
      collections: { users, reports, groups, auditLogs, feedbacks },
    };

    // Compress
    const jsonBuffer = Buffer.from(JSON.stringify(backupPayload), 'utf8');
    const gzipped    = zlib.gzipSync(jsonBuffer);

    // Upload to Cloudinary as raw file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const publicId  = `daily-teaching-report/backups/backup-${timestamp}`;

    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { resource_type: 'raw', public_id: publicId, use_filename: false },
        (err, result) => (err ? reject(err) : resolve(result))
      );
      stream.end(gzipped);
    });

    await Backup.create({
      initiatedBy:     req.session.user._id,
      initiatedByName: req.session.user.displayName || req.session.user.username,
      status:          'success',
      fileUrl:         uploadResult.secure_url,
      cloudinaryId:    uploadResult.public_id,
      fileSizeBytes:   uploadResult.bytes || gzipped.length,
      recordCounts,
    });

    req.session.flash = `Backup created! ${Object.values(recordCounts).reduce((s, n) => s + n, 0)} records exported.`;
    res.redirect('/admin/backups');

  } catch (err) {
    console.error('Backup error:', err);
    // Record failure
    await Backup.create({
      initiatedBy:     req.session.user._id,
      initiatedByName: req.session.user.displayName || req.session.user.username,
      status:          'failed',
      errorMessage:    err.message,
      recordCounts:    {},
    }).catch(() => {});
    req.session.flash = `Backup failed: ${err.message}`;
    res.redirect('/admin/backups');
  }
};

/* ═══════════════════════════════════════════════
   DELETE /admin/backups/:id  — remove a record
═══════════════════════════════════════════════ */
exports.deleteBackup = async (req, res) => {
  try {
    const backup = await Backup.findById(req.params.id);
    if (!backup) return res.status(404).json({ error: 'Backup not found.' });

    // Delete from Cloudinary if it exists
    if (backup.cloudinaryId) {
      try {
        await cloudinary.uploader.destroy(backup.cloudinaryId, { resource_type: 'raw' });
      } catch (e) {
        console.error('Cloudinary raw delete error:', e);
        // Non-fatal — still remove the DB record
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