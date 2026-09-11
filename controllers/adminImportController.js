const multer  = require('multer');
const Group   = require('../models/Group');
const Student = require('../models/Student');
const AuditLog = require('../models/AuditLog');
const {
  parseGroupsCsvFromString,
  parsePrivateCsvFromString,
  buildGroupRecords,
} = require('../scripts/lib/parseRoster');
const { matchOrCreateStudent } = require('../services/studentService');
const { normalizeName }        = require('../models/Student');

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
  { name: 'groupsCsv',  maxCount: 1 },
  { name: 'privateCsv', maxCount: 1 },
]);

/* ── Helpers ────────────────────────────────────────────────────── */

function validateRecords(records) {
  const errors = [];
  const docs = records.map((r, i) => {
    const group_name = (r.group_name || '').trim();
    const type       = r.type === 'PRIVATE' ? 'PRIVATE' : 'GROUP';
    const level      = (r.level || '').trim();
    const students   = (r.students || []).map(s => s.trim()).filter(Boolean);

    if (!group_name)            errors.push(`Record #${i}: missing group_name`);
    if (group_name.length > 100) errors.push(`Record #${i} ("${group_name}"): name exceeds 100 chars`);
    if (level.length > 50)       errors.push(`Record #${i} ("${group_name}"): level exceeds 50 chars`);
    if (students.length === 0)   errors.push(`Record #${i} ("${group_name}"): no students`);
    if (students.length > 200)   errors.push(`Record #${i} ("${group_name}"): exceeds 200 students`);
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
      admin:       req.session.user._id,
      adminName:   req.session.user.displayName || req.session.user.username,
      action,
      targetType:  'group',
      targetId:    null,
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
   POST /admin/groups/import — handle upload + NON-DESTRUCTIVE import
═════════════════════════════════════════════════════════════════════ */
exports.importExecute = (req, res) => {
  upload(req, res, async (uploadErr) => {
    try {
      if (uploadErr) {
        return res.status(400).json({ ok: false, error: uploadErr.message });
      }

      // --- Extract uploaded files ---
      const groupsFile  = req.files && req.files.groupsCsv  && req.files.groupsCsv[0];
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
      let groupRaw   = [];
      let privateRaw = [];

      if (groupsFile)  groupRaw   = parseGroupsCsvFromString(groupsFile.buffer.toString('utf8'));
      if (privateFile) privateRaw = parsePrivateCsvFromString(privateFile.buffer.toString('utf8'));

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
        totalParsed:  docs.length,
        groupCount:   docs.filter(d => d.type === 'GROUP').length,
        privateCount: docs.filter(d => d.type === 'PRIVATE').length,
        studentSlots: docs.reduce((sum, d) => sum + d.students.length, 0),
      };

      if (dryRun) {
        // Count how many students would be NEW vs existing
        let wouldCreate  = 0;
        let wouldRetain  = 0;
        const seen = new Set();
        for (const doc of docs) {
          for (const rawName of doc.students) {
            const key = normalizeName(rawName);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            const exists = await Student.findOne({ normalized_name: key });
            if (exists) wouldRetain++;
            else        wouldCreate++;
          }
        }
        const sample = docs.slice(0, 10).map(d => ({
          name:         d.group_name,
          type:         d.type,
          level:        d.level,
          studentCount: d.students.length,
        }));
        return res.json({
          ok: true, dryRun: true, summary,
          preview: { wouldCreate, wouldRetain },
          sample,
        });
      }

      // ══════════════════════════════════════════════════════════
      //  NON-DESTRUCTIVE LIVE IMPORT
      // ══════════════════════════════════════════════════════════
      let newStudentsAdded      = 0;
      let existingStudentsKept  = 0;
      let groupsCreated         = 0;
      let groupsUpdated         = 0;

      for (const doc of docs) {
        // ── 1. Resolve Student identity for each student name ────
        const studentIds  = [];
        const studentNames = [];

        for (const rawName of doc.students) {
          const result = await matchOrCreateStudent(rawName);
          if (!result) continue;
          const { student, created } = result;
          if (created) newStudentsAdded++;
          else         existingStudentsKept++;
          studentIds.push(student._id);
          studentNames.push(rawName); // keep original string for backward compat
        }

        // ── 2. Upsert the Group (match by group_name) ────────────
        const existingGroup = await Group.findOne({ group_name: doc.group_name });

        if (existingGroup) {
          // Merge students (add any not already present)
          const currentStrings = new Set(existingGroup.students.map(s => normalizeName(s)));
          const newStrings = studentNames.filter(n => !currentStrings.has(normalizeName(n)));
          const currentIds = new Set(existingGroup.student_ids.map(id => String(id)));
          const newIds     = studentIds.filter(id => !currentIds.has(String(id)));

          if (newStrings.length || newIds.length) {
            existingGroup.students   = [...existingGroup.students, ...newStrings];
            existingGroup.student_ids = [...existingGroup.student_ids, ...newIds];
            // Also sync level if it changed
            if (doc.level) existingGroup.level = doc.level;
            await existingGroup.save();
          }
          groupsUpdated++;
        } else {
          // Create brand-new group
          await Group.create({
            group_name:  doc.group_name,
            type:        doc.type,
            level:       doc.level || '',
            students:    studentNames,
            student_ids: studentIds,
          });
          groupsCreated++;
        }
      }

      summary.newStudentsAdded     = newStudentsAdded;
      summary.existingStudentsKept  = existingStudentsKept;
      summary.groupsCreated        = groupsCreated;
      summary.groupsUpdated        = groupsUpdated;

      // Audit log
      await logAudit(req, 'import_groups', {
        newStudentsAdded,
        existingStudentsKept,
        groupsCreated,
        groupsUpdated,
      });

      return res.json({ ok: true, dryRun: false, summary });
    } catch (err) {
      console.error('Import error:', err);
      return res.status(500).json({ ok: false, error: err.message || 'Internal server error.' });
    }
  });
};
