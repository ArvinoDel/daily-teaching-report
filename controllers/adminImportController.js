const multer = require('multer');
const Group = require('../models/Group');
const AuditLog = require('../models/AuditLog');
const {
  parseGroupsCsvFromString,
  parsePrivateCsvFromString,
  buildGroupRecords,
} = require('../scripts/lib/parseRoster');

/* ── Multer: memory storage (no temp files — works on serverless) ── */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB per file
  fileFilter(_req, file, cb) {
    if (
      file.mimetype === 'text/csv' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      file.originalname.endsWith('.csv')
    ) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed.'));
    }
  },
}).fields([
  { name: 'groupsCsv', maxCount: 1 },
  { name: 'privateCsv', maxCount: 1 },
]);

/* ── Helpers ────────────────────────────────────────────────────── */

function validateRecords(records) {
  const errors = [];
  const docs = records.map((r, i) => {
    const group_name = (r.group_name || '').trim();
    const type = r.type === 'PRIVATE' ? 'PRIVATE' : 'GROUP';
    const level = (r.level || '').trim();
    const students = (r.students || []).map(s => s.trim()).filter(Boolean);

    if (!group_name) errors.push(`Record #${i}: missing group_name`);
    if (group_name.length > 100) errors.push(`Record #${i} ("${group_name}"): name exceeds 100 chars`);
    if (level.length > 50) errors.push(`Record #${i} ("${group_name}"): level exceeds 50 chars`);
    if (students.length === 0) errors.push(`Record #${i} ("${group_name}"): no students`);
    if (students.length > 200) errors.push(`Record #${i} ("${group_name}"): exceeds 200 students`);
    students.forEach(s => {
      if (s.length > 100) errors.push(`Record #${i} ("${group_name}"): student name "${s}" exceeds 100 chars`);
    });

    return { group_name, type, level, students };
  });

  return { docs, errors };
}

async function logAudit(req, action, meta = {}) {
  try {
    await AuditLog.create({
      admin: req.session.user._id,
      adminName: req.session.user.displayName || req.session.user.username,
      action,
      targetType: 'group',
      targetId: null,
      targetLabel: 'CSV Import',
      meta,
    });
  } catch (e) {
    console.error('Audit log error:', e);
  }
}

/* ═══════════════════════════════════════════════════════════════════
   GET /admin/groups/import — render the import page
═════════════════════════════════════════════════════════════════════ */
exports.importPage = (_req, res) => {
  res.render('admin/groups/import');
};

/* ═══════════════════════════════════════════════════════════════════
   POST /admin/groups/import — handle upload + import (JSON response)
═════════════════════════════════════════════════════════════════════ */
exports.importExecute = (req, res) => {
  upload(req, res, async (uploadErr) => {
    try {
      if (uploadErr) {
        return res.status(400).json({ ok: false, error: uploadErr.message });
      }

      // --- Extract uploaded files ---
      const groupsFile = req.files && req.files.groupsCsv && req.files.groupsCsv[0];
      const privateFile = req.files && req.files.privateCsv && req.files.privateCsv[0];

      if (!groupsFile && !privateFile) {
        return res.status(400).json({ ok: false, error: 'Please upload at least one CSV file.' });
      }

      // --- CSRF check (multipart skips the global middleware) ---
      const csrfToken = req.body._csrf || req.headers['x-csrf-token'];
      if (!csrfToken || csrfToken !== req.session.csrfToken) {
        return res.status(403).json({ ok: false, error: 'Invalid security token. Please refresh and try again.' });
      }

      // --- Parse CSVs ---
      let groupRaw = [];
      let privateRaw = [];

      if (groupsFile) {
        const csvString = groupsFile.buffer.toString('utf8');
        groupRaw = parseGroupsCsvFromString(csvString);
      }

      if (privateFile) {
        const csvString = privateFile.buffer.toString('utf8');
        privateRaw = parsePrivateCsvFromString(csvString);
      }

      const allRecords = buildGroupRecords([...groupRaw, ...privateRaw]);
      const { docs, errors } = validateRecords(allRecords);

      if (errors.length) {
        return res.status(400).json({
          ok: false,
          error: `Validation failed with ${errors.length} error(s).`,
          validationErrors: errors,
        });
      }

      const dryRun = req.body.dryRun === 'true' || req.body.dryRun === '1';

      // --- Summary for preview ---
      const summary = {
        totalParsed: docs.length,
        groupCount: docs.filter(d => d.type === 'GROUP').length,
        privateCount: docs.filter(d => d.type === 'PRIVATE').length,
        studentSlots: docs.reduce((sum, d) => sum + d.students.length, 0),
      };

      if (dryRun) {
        const sample = docs.slice(0, 10).map(d => ({
          name: d.group_name,
          type: d.type,
          level: d.level,
          studentCount: d.students.length,
        }));

        return res.json({ ok: true, dryRun: true, summary, sample });
      }

      // --- Live import ---
      const existing = await Group.find({}).lean();
      summary.existingCount = existing.length;

      // 1. Backup — store as JSON in audit log meta (lightweight)
      const backupSnapshot = existing.map(g => ({
        _id: g._id,
        group_name: g.group_name,
        type: g.type,
        level: g.level,
        students: g.students,
      }));

      // 2. Delete all existing groups
      const delResult = await Group.deleteMany({});
      summary.deletedCount = delResult.deletedCount;

      // 3. Insert new groups
      const insertResult = await Group.insertMany(docs, { ordered: true });
      summary.insertedCount = insertResult.length;

      // 4. Audit log
      await logAudit(req, 'import_groups', {
        deletedCount: summary.deletedCount,
        insertedCount: summary.insertedCount,
        backupCount: backupSnapshot.length,
      });

      return res.json({ ok: true, dryRun: false, summary });
    } catch (err) {
      console.error('Import error:', err);
      return res.status(500).json({ ok: false, error: err.message || 'Internal server error.' });
    }
  });
};
