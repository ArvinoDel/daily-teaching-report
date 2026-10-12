const mongoose = require('mongoose');
const multer   = require('multer');
const Group    = require('../models/Group');
const Student  = require('../models/Student');
const AuditLog = require('../models/AuditLog');
const {
  parseGroupsCsvFromString,
  parsePrivateCsvFromString,
  buildGroupRecords,
} = require('../scripts/lib/parseRoster');
const { matchOrCreateStudent } = require('../services/studentService');
const { normalizeName }        = require('../models/Student');
const { computeRosterDiff }    = require('../services/groupImportDiffService');

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
        // Fetch existing DB groups and existing students
        const [existingGroups, existingStudents] = await Promise.all([
          Group.find({}).lean(),
          Student.find({}, { _id: 1, normalized_name: 1, raw_name: 1, full_name: 1 }).lean(),
        ]);

        // Student identity counts (wouldCreate, wouldRetain)
        const seenNorms = new Set();
        const allStudentNorms = [];
        for (const doc of docs) {
          for (const rawName of doc.students) {
            const key = normalizeName(rawName);
            if (key && !seenNorms.has(key)) {
              seenNorms.add(key);
              allStudentNorms.push(key);
            }
          }
        }

        const existingStudentNorms = new Set(existingStudents.map(s => s.normalized_name));
        let wouldCreate = 0;
        let wouldRetain = 0;
        for (const key of allStudentNorms) {
          if (existingStudentNorms.has(key)) wouldRetain++;
          else                              wouldCreate++;
        }

        // Run group-based roster diff
        const diffResult = computeRosterDiff(docs, existingGroups, existingStudents);

        return res.json({
          ok: true,
          dryRun: true,
          summary,
          preview: { wouldCreate, wouldRetain },
          changedGroups: diffResult.changedGroups,
          summaryChips: diffResult.summaryChips,
        });
      }

      // ══════════════════════════════════════════════════════════
      //  LIVE IMPORT WITH ADMIN DECISIONS
      // ══════════════════════════════════════════════════════════
      // Fetch fresh DB groups and students to recompute authoritative diff
      const [existingGroups, existingStudents] = await Promise.all([
        Group.find({}),
        Student.find({}, { _id: 1, normalized_name: 1, raw_name: 1, full_name: 1 }).lean(),
      ]);

      const diffResult = computeRosterDiff(docs, existingGroups, existingStudents);

      // Parse admin decisions from multipart form
      let clientRemovals = [];
      let clientRenames  = [];
      if (req.body.decisions) {
        try {
          const parsed = typeof req.body.decisions === 'string'
            ? JSON.parse(req.body.decisions)
            : req.body.decisions;
          if (Array.isArray(parsed.removals)) clientRemovals = parsed.removals;
          if (Array.isArray(parsed.renames))  clientRenames  = parsed.renames;
        } catch (e) {
          console.warn('Failed to parse import decisions JSON:', e);
        }
      }

      // ── 1. Validate and apply approved renames ────────────────
      const renamedGroupMap = new Map(); // csvGroupName -> Group doc
      let renamedCount = 0;
      let invalidRenamesCount = 0;

      for (const ren of clientRenames) {
        const { groupId, newName } = ren;
        if (!groupId || !newName || !mongoose.Types.ObjectId.isValid(groupId)) {
          invalidRenamesCount++;
          continue;
        }

        // Check against freshly recomputed authoritative renames
        const expectedDbId = diffResult.authoritativeRenames.get(newName);
        if (expectedDbId && expectedDbId === String(groupId)) {
          const grp = await Group.findById(groupId);
          if (grp) {
            grp.group_name = newName;
            const csvDoc = docs.find(d => d.group_name === newName);
            if (csvDoc && csvDoc.level) grp.level = csvDoc.level;
            if (csvDoc && csvDoc.type)  grp.type  = csvDoc.type;
            await grp.save();
            renamedGroupMap.set(newName, grp);
            renamedCount++;
          }
        } else {
          invalidRenamesCount++;
        }
      }

      // ── 2. Validate client removals against recomputed diff ──
      const confirmedRemovalsByGroup = new Map();
      let invalidRemovalsCount = 0;

      for (const rem of clientRemovals) {
        const { groupId, studentId, studentKey } = rem;
        if (!groupId || !mongoose.Types.ObjectId.isValid(groupId)) {
          invalidRemovalsCount++;
          continue;
        }

        const allowedMap = diffResult.allowedRemovalsByGroup.get(String(groupId));
        if (!allowedMap) {
          invalidRemovalsCount++;
          continue;
        }

        let matchRem = null;
        if (studentKey && allowedMap.has(studentKey)) {
          matchRem = allowedMap.get(studentKey);
        } else if (studentId && allowedMap.has(`id:${studentId}`)) {
          matchRem = allowedMap.get(`id:${studentId}`);
        } else {
          for (const item of allowedMap.values()) {
            if (studentId && item.studentId === String(studentId)) {
              matchRem = item;
              break;
            }
          }
        }

        if (matchRem) {
          if (!confirmedRemovalsByGroup.has(String(groupId))) {
            confirmedRemovalsByGroup.set(String(groupId), new Set());
          }
          confirmedRemovalsByGroup.get(String(groupId)).add(matchRem.key);
          if (matchRem.studentId) {
            confirmedRemovalsByGroup.get(String(groupId)).add(`id:${matchRem.studentId}`);
          }
          if (matchRem.normKey) {
            confirmedRemovalsByGroup.get(String(groupId)).add(`norm:${matchRem.normKey}`);
          }
        } else {
          invalidRemovalsCount++;
        }
      }

      // ── 3. Apply group updates, additions & confirmed removals ─
      let newStudentsAdded     = 0;
      let existingStudentsKept = 0;
      let groupsCreated        = 0;
      let groupsUpdated        = 0;
      let removedFromGroups    = 0;
      let movedCount           = 0;

      for (const doc of docs) {
        const studentIds   = [];
        const studentNames = [];

        for (const rawName of doc.students) {
          const result = await matchOrCreateStudent(rawName);
          if (!result) continue;
          const { student, created } = result;
          if (created) newStudentsAdded++;
          else         existingStudentsKept++;
          studentIds.push(student._id);
          studentNames.push(rawName);
        }

        // Check if matched DB group exists (either renamed or matched by name)
        let targetGroup = renamedGroupMap.get(doc.group_name);
        if (!targetGroup) {
          targetGroup = await Group.findOne({ group_name: doc.group_name });
        }

        if (targetGroup) {
          // Merge additions
          const currentStrings = new Set(targetGroup.students.map(s => normalizeName(s)));
          const newStrings = studentNames.filter(n => !currentStrings.has(normalizeName(n)));
          const currentIds = new Set(targetGroup.student_ids.map(id => String(id)));
          const newIds     = studentIds.filter(id => !currentIds.has(String(id)));

          let modified = false;
          if (newStrings.length || newIds.length) {
            targetGroup.students    = [...targetGroup.students, ...newStrings];
            targetGroup.student_ids = [...targetGroup.student_ids, ...newIds];
            modified = true;
          }

          // Apply confirmed removals for this group
          const targetIdStr = String(targetGroup._id);
          if (confirmedRemovalsByGroup.has(targetIdStr)) {
            const removalsForGroup = confirmedRemovalsByGroup.get(targetIdStr);
            const filteredStrings = [];
            const filteredIds     = [];
            let groupRemovedCount = 0;

            for (let i = 0; i < targetGroup.students.length; i++) {
              const str = targetGroup.students[i];
              const sId = targetGroup.student_ids[i] ? String(targetGroup.student_ids[i]) : null;
              const norm = normalizeName(str);

              const shouldRemove = (sId && removalsForGroup.has(`id:${sId}`)) ||
                                   (norm && removalsForGroup.has(`norm:${norm}`));

              if (shouldRemove) {
                groupRemovedCount++;
                const remMeta = diffResult.allowedRemovalsByGroup.get(targetIdStr)?.get(sId ? `id:${sId}` : `norm:${norm}`);
                if (remMeta && remMeta.status === 'MOVED_OUT') {
                  movedCount++;
                }
              } else {
                filteredStrings.push(str);
                if (targetGroup.student_ids[i]) filteredIds.push(targetGroup.student_ids[i]);
              }
            }

            if (groupRemovedCount > 0) {
              targetGroup.students    = filteredStrings;
              targetGroup.student_ids = filteredIds;
              removedFromGroups      += groupRemovedCount;
              modified = true;
            }
          }

          if (doc.level && doc.level !== targetGroup.level) {
            targetGroup.level = doc.level;
            modified = true;
          }
          if (doc.type && doc.type !== targetGroup.type) {
            targetGroup.type = doc.type;
            modified = true;
          }

          if (modified || renamedGroupMap.has(doc.group_name)) {
            await targetGroup.save();
            groupsUpdated++;
          }
        } else {
          // Brand-new group
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
      summary.existingStudentsKept = existingStudentsKept;
      summary.groupsCreated        = groupsCreated;
      summary.groupsUpdated        = groupsUpdated;
      summary.removedFromGroups    = removedFromGroups;
      summary.moved                = movedCount;
      summary.renamed              = renamedCount;

      // Audit log
      await logAudit(req, 'import_groups', {
        newStudentsAdded,
        existingStudentsKept,
        groupsCreated,
        groupsUpdated,
        removedFromGroups,
        moved: movedCount,
        renamed: renamedCount,
        invalidRemovals: invalidRemovalsCount,
        invalidRenames: invalidRenamesCount,
      });

      return res.json({ ok: true, dryRun: false, summary });
    } catch (err) {
      console.error('Import error:', err);
      return res.status(500).json({ ok: false, error: err.message || 'Internal server error.' });
    }
  });
};
