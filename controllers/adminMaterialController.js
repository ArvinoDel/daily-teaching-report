const cloudinary      = require('cloudinary').v2;
const mongoose        = require('mongoose');
const Material        = require('../models/Material');
const MaterialAlias   = require('../models/MaterialAlias');
const MaterialContent = require('../models/MaterialContent');
const MaterialContentRevision = require('../models/MaterialContentRevision');
const Report          = require('../models/Report');
const AuditLog        = require('../models/AuditLog');
const { LEVELS, LEVEL_LABELS } = require('../models/Group');
const { normalizeMaterialName, formatMaterialDisplayName } = require('../models/Material');
const {
  invalidateMaterialsCache,
  recountMaterialUsage,
  planMergeAliases,
  parseCheckbox,
  countUnlinkedReports,
} = require('../services/materialService');
const { computeHasContent } = require('../services/materialContentService');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function safeJson(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

async function logAudit(req, action, targetId, targetLabel, meta = {}) {
  try {
    await AuditLog.create({
      admin:       req.session.user._id,
      adminName:   req.session.user.displayName || req.session.user.username,
      action,
      targetType:  'material',
      targetId,
      targetLabel: String(targetLabel || ''),
      meta,
    });
  } catch (e) {
    console.error('Audit log error for material:', e);
  }
}

/* ═══════════════════════════════════════════════════════════════
   List   GET /admin/materials
   ═══════════════════════════════════════════════════════════════ */
exports.materialsList = async (req, res) => {
  try {
    const { level, q, noContent, sort } = req.query;
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 25;

    const filter = {};
    if (level === 'NONE') {
      filter.level = '';
    } else if (level && level.trim()) {
      filter.level = level.trim().toUpperCase();
    }

    if (q && q.trim()) {
      filter.name = { $regex: q.trim(), $options: 'i' };
    }

    if (noContent === '1') {
      filter.hasContent = false;
    }

    let sortOption = { usageCount: -1, name: 1 };
    if (sort === 'name') {
      sortOption = { name: 1, usageCount: -1 };
    } else if (sort === 'usage_asc') {
      sortOption = { usageCount: 1, name: 1 };
    }

    const [
      totalMaterials,
      totalWithLevel,
      totalNoLevel,
      totalWithContent,
      filteredCount,
      materials,
      usedLevels,
      allMaterialsForMerge,
      unlinkedReportsCount,
      recentEdits,
    ] = await Promise.all([
      Material.countDocuments(),
      Material.countDocuments({ level: { $ne: '' } }),
      Material.countDocuments({ level: '' }),
      Material.countDocuments({ hasContent: true }),
      Material.countDocuments(filter),
      Material.find(filter)
        .sort(sortOption)
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('createdBy', 'displayName username')
        .lean(),
      Material.distinct('level'),
      Material.find()
        .select('name level usageCount hasContent')
        .sort({ name: 1 })
        .lean(),
      countUnlinkedReports(),
      MaterialContentRevision.find()
        .sort({ editedAt: -1 })
        .limit(20)
        .populate('material', 'name level')
        .lean(),
    ]);

    const totalPages = Math.max(1, Math.ceil(filteredCount / limit));

    // Fetch page contents to determine badge ("No content" / "n files" / "Text only")
    const pageMatIds = materials.map(m => m._id);
    const pageContents = await MaterialContent.find({ material: { $in: pageMatIds } })
      .select('material body resources')
      .lean();

    const contentStatusMap = {};
    for (const c of pageContents) {
      const fileCount = (c.resources || []).filter(r => r.kind === 'file').length;
      const hasText = (c.body || '').replace(/<[^>]*>/g, '').trim().length > 0;
      if (fileCount > 0) {
        contentStatusMap[String(c.material)] = { label: `${fileCount} file${fileCount > 1 ? 's' : ''}`, type: 'files' };
      } else if (hasText) {
        contentStatusMap[String(c.material)] = { label: 'Text only', type: 'text' };
      } else {
        contentStatusMap[String(c.material)] = { label: 'No content', type: 'none' };
      }
    }

    // Build available levels in canonical order (empty string excluded)
    const validUsed = usedLevels.filter(Boolean).map(l => l.toUpperCase());
    const availableLevels = [
      ...LEVELS.filter(l => validUsed.includes(l)),
      ...validUsed.filter(l => !LEVELS.includes(l)).sort(),
    ];

    const materialsJson = safeJson(allMaterialsForMerge.map(m => ({
      _id:        String(m._id),
      name:       m.name,
      level:      m.level || '',
      usageCount: m.usageCount || 0,
      hasContent: Boolean(m.hasContent),
    })));

    const flashMessage = req.session.flash || null;
    const flashError   = req.session.flashError || null;
    delete req.session.flash;
    delete req.session.flashError;

    res.render('admin/materials/index', {
      title: 'Admin — Materials',
      materials,
      contentStatusMap,
      totalMaterials,
      totalWithLevel,
      totalNoLevel,
      totalWithContent,
      filteredCount,
      page,
      totalPages,
      availableLevels,
      LEVELS,
      LEVEL_LABELS,
      materialsJson,
      selectedLevel: level || '',
      searchQuery:   q     || '',
      noContentFilter: noContent === '1',
      sortQuery:     sort || '',
      unlinkedReportsCount: unlinkedReportsCount || 0,
      recentEdits,
      flashMessage,
      flashError,
    });
  } catch (err) {
    console.error('adminMaterialController.materialsList error:', err);
    res.render('error', { message: 'Failed to load materials.' });
  }
};

/* ═══════════════════════════════════════════════════════════════
   Update / Rename   POST or PUT /admin/materials/:id
   ═══════════════════════════════════════════════════════════════ */
exports.materialUpdate = async (req, res) => {
  try {
    const material = await Material.findById(req.params.id);
    if (!material) {
      req.session.flashError = 'Material not found.';
      return res.redirect('/admin/materials');
    }

    const rawName  = req.body.name || '';
    const rawLevel = (req.body.level || '').trim().toUpperCase();

    if (!rawName.trim()) {
      req.session.flashError = 'Material name is required.';
      return res.redirect('/admin/materials');
    }
    if (rawName.trim().length > 100) {
      req.session.flashError = 'Material name max 100 characters.';
      return res.redirect('/admin/materials');
    }

    const cleanName = formatMaterialDisplayName(rawName);
    const nameNorm  = normalizeMaterialName(cleanName);
    if (!nameNorm) {
      req.session.flashError = 'Invalid material name.';
      return res.redirect('/admin/materials');
    }

    // Level validation: accept empty or valid Group.LEVELS
    const validatedLevel = (rawLevel && (LEVELS.includes(rawLevel) || rawLevel.length <= 50)) ? rawLevel : '';

    // Check collision with another existing material
    const matCollision = await Material.findOne({
      nameNormalized: nameNorm,
      level:          validatedLevel,
      _id:            { $ne: material._id },
    });

    if (matCollision) {
      req.session.flashError = `A material named "${matCollision.name}" with level "${validatedLevel || 'No level'}" already exists. You can use the Merge feature to combine them.`;
      return res.redirect('/admin/materials');
    }

    // Check collision with an existing alias pointing to a DIFFERENT material
    const aliasCollision = await MaterialAlias.findOne({
      nameNormalized: nameNorm,
      level:          validatedLevel,
      material:       { $ne: material._id },
    });

    if (aliasCollision) {
      req.session.flashError = `A material alias with level "${validatedLevel || 'No level'}" already exists. You can use the Merge feature to combine them.`;
      return res.redirect('/admin/materials');
    }

    const oldName           = material.name;
    const oldNameNormalized = material.nameNormalized;
    const oldLevel          = material.level;

    // If an alias existed for this new key that was pointing to this material, remove it (material directly holds it now)
    await MaterialAlias.deleteOne({
      nameNormalized: nameNorm,
      level:          validatedLevel,
      material:       material._id,
    });

    // If normalized name or level changed, create an alias for the OLD normalized name at old level
    if (oldNameNormalized !== nameNorm || oldLevel !== validatedLevel) {
      await MaterialAlias.findOneAndUpdate(
        { nameNormalized: oldNameNormalized, level: oldLevel },
        { $set: { material: material._id } },
        { upsert: true }
      );
    }

    material.name           = cleanName;
    material.nameNormalized = nameNorm;
    material.level          = validatedLevel;
    await material.save();

    // Checkbox: Also update the material name on existing reports (default ON)
    const updateReports = parseCheckbox(req.body.updateReportsSubject);
    if (updateReports) {
      await Report.updateMany(
        { material: material._id },
        { $set: { subject: material.name } }
      );
    }

    invalidateMaterialsCache();

    await logAudit(req, 'update', material._id, material.name, {
      oldName,
      oldLevel,
      newName: material.name,
      newLevel: material.level,
      updateReports,
    });

    req.session.flash = `Material "${material.name}" updated successfully!`;
    res.redirect('/admin/materials');
  } catch (err) {
    console.error('adminMaterialController.materialUpdate error:', err);
    req.session.flashError = 'Failed to update material.';
    res.redirect('/admin/materials');
  }
};

/* ═══════════════════════════════════════════════════════════════
   Merge   POST /admin/materials/:id/merge
   ═══════════════════════════════════════════════════════════════ */
exports.materialMerge = async (req, res) => {
  try {
    const sourceId = req.params.id;
    const targetId = req.body.targetId;

    if (!targetId || targetId === sourceId) {
      req.session.flashError = 'Please select a different target material to merge into.';
      return res.redirect('/admin/materials');
    }

    const [source, target] = await Promise.all([
      Material.findById(sourceId),
      Material.findById(targetId),
    ]);

    if (!source || !target) {
      req.session.flashError = 'Source or target material not found.';
      return res.redirect('/admin/materials');
    }

    const sourceName  = source.name;
    const sourceLevel = source.level;
    const sourceUsage = source.usageCount || 0;

    const existingAliases = await MaterialAlias.find({
      $or: [
        { material: source._id },
        { nameNormalized: source.nameNormalized, level: source.level },
      ],
    }).lean();

    const [sourceContent, targetContent] = await Promise.all([
      MaterialContent.findOne({ material: source._id }),
      MaterialContent.findOne({ material: target._id }),
    ]);

    const plan = planMergeAliases(source, target, existingAliases);

    const updateReports = parseCheckbox(req.body.updateReportsSubject);

    const reportUpdateDoc = updateReports
      ? { material: target._id, subject: target.name }
      : { material: target._id };

    // Run changes in safe order:
    // 1. Create/re-point aliases
    // 2. Re-point reports
    // 3. Move usage and lastUsedAt on target
    // 4. Merge content & revisions
    // 5. Delete source last
    const executeOperations = async (session = null) => {
      const opts = session ? { session } : {};

      // Create new aliases
      for (const item of plan.aliasesToCreate) {
        await MaterialAlias.findOneAndUpdate(
          { nameNormalized: item.nameNormalized, level: item.level },
          { $set: { material: target._id } },
          { upsert: true, ...opts }
        );
      }

      // Re-point existing aliases
      for (const item of plan.aliasesToRepoint) {
        await MaterialAlias.findByIdAndUpdate(item._id, { $set: { material: target._id } }, opts);
      }

      // Delete colliding aliases
      for (const item of plan.aliasesToDelete) {
        await MaterialAlias.findByIdAndDelete(item._id, opts);
      }

      // Re-point reports
      await Report.updateMany({ material: source._id }, reportUpdateDoc, opts);

      // Move usage count and lastUsedAt atomically (never mutate target.usageCount in memory)
      const targetUpdate = { $inc: { usageCount: sourceUsage } };
      if (source.lastUsedAt) {
        targetUpdate.$max = { lastUsedAt: source.lastUsedAt };
      }
      await Material.updateOne({ _id: target._id }, targetUpdate, opts);

      // Content merge logic
      const sourceHas = sourceContent && computeHasContent(sourceContent.body, sourceContent.resources);
      const targetHas = targetContent && computeHasContent(targetContent.body, targetContent.resources);

      if (sourceHas) {
        if (!targetHas) {
          // Target has no content -> move source's content and revisions to target
          if (targetContent) {
            await MaterialContent.deleteOne({ _id: targetContent._id }, opts);
          }
          sourceContent.material = target._id;
          await sourceContent.save(opts);
          await MaterialContentRevision.updateMany(
            { material: source._id },
            { $set: { material: target._id } },
            opts
          );
          await Material.updateOne(
            { _id: target._id },
            { $set: { hasContent: true, contentUpdatedAt: sourceContent.updatedAt || new Date() } },
            opts
          );
        } else {
          // Both have content -> KEEP target's content and store source's content as revision of target
          const nextVersion = (targetContent.version || 1) + 1;
          targetContent.version = nextVersion;
          await targetContent.save(opts);

          await MaterialContentRevision.create([{
            material: target._id,
            version: nextVersion,
            body: sourceContent.body,
            resources: sourceContent.resources || [],
            note: `Merged from ${sourceName}`,
            editedBy: req.session.user._id,
            editedByName: req.session.user.displayName || req.session.user.username || '',
            editedAt: new Date(),
          }], opts);

          await MaterialContentRevision.updateMany(
            { material: source._id },
            { $set: { material: target._id } },
            opts
          );

          await MaterialContent.deleteOne({ _id: sourceContent._id }, opts);
        }
      } else if (sourceContent) {
        await MaterialContent.deleteOne({ _id: sourceContent._id }, opts);
      }

      // Delete source
      await source.deleteOne(opts);
    };

    try {
      const session = await mongoose.startSession();
      try {
        session.startTransaction();
        await executeOperations(session);
        await session.commitTransaction();
      } catch (txErr) {
        await session.abortTransaction();
        throw txErr;
      } finally {
        session.endSession();
      }
    } catch (txErr) {
      const isTxUnsupported = /Transaction numbers are only allowed/.test(txErr.message) ||
                              /transactions are not supported/.test(txErr.message) ||
                              txErr.codeName === 'OperationNotSupportedInTransaction' ||
                              txErr.code === 20;
      if (isTxUnsupported) {
        await executeOperations();
      } else {
        throw txErr;
      }
    }

    // Call recountMaterialUsage ONLY if countUnlinkedReports() is 0;
    // otherwise keep the transferred value so legacy reports aren't lost from usage
    const unlinkedCount = await countUnlinkedReports();
    if (unlinkedCount === 0) {
      await recountMaterialUsage([target._id]);
    }

    invalidateMaterialsCache();

    const newTotalUsage = (target.usageCount || 0) + sourceUsage;

    await logAudit(req, 'merge', target._id, target.name, {
      mergedFromId:     source._id,
      mergedFromName:   sourceName,
      mergedFromLevel:  sourceLevel,
      transferredUsage: sourceUsage,
      newTotalUsage,
      updateReports,
    });

    req.session.flash = `Merged "${sourceName}" into "${target.name}" successfully! (${sourceUsage} usage points transferred)`;
    res.redirect('/admin/materials');
  } catch (err) {
    console.error('adminMaterialController.materialMerge error:', err);
    req.session.flashError = 'Failed to merge materials.';
    res.redirect('/admin/materials');
  }
};

/* ═══════════════════════════════════════════════════════════════
   Delete   DELETE /admin/materials/:id
   ═══════════════════════════════════════════════════════════════ */
exports.materialDelete = async (req, res) => {
  try {
    const material = await Material.findById(req.params.id);
    if (!material) {
      if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
        return res.status(404).json({ error: 'Material not found.' });
      }
      req.session.flashError = 'Material not found.';
      return res.redirect('/admin/materials');
    }

    const label      = material.name;
    const level      = material.level;
    const usageCount = material.usageCount;

    // Reports keep their subject text, set Report.material = null
    await Report.updateMany({ material: material._id }, { $set: { material: null } });

    // Delete aliases pointing to it
    await MaterialAlias.deleteMany({ material: material._id });

    // Delete content and revisions
    await Promise.all([
      MaterialContent.deleteMany({ material: material._id }),
      MaterialContentRevision.deleteMany({ material: material._id }),
    ]);

    // Best-effort and non-fatal: destroy Cloudinary assets of that material
    try {
      const cloudRes = await cloudinary.api.delete_resources_by_prefix(`materials/${material._id}/`, {
        type: 'authenticated',
      });
      const delCount = cloudRes && cloudRes.deleted ? Object.keys(cloudRes.deleted).length : 0;
      console.log(`Destroyed ${delCount} Cloudinary assets for material ${material._id}`);
    } catch (cErr) {
      console.error('Non-fatal error destroying Cloudinary assets for material:', cErr.message);
    }

    // Delete the material
    await material.deleteOne();

    invalidateMaterialsCache();

    await logAudit(req, 'delete', material._id, label, { level, usageCount });

    if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.status(200).json({ ok: true });
    }

    req.session.flash = `Material "${label}" deleted successfully!`;
    res.redirect('/admin/materials');
  } catch (err) {
    console.error('adminMaterialController.materialDelete error:', err);
    if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.status(500).json({ error: 'Failed to delete material.' });
    }
    req.session.flashError = 'Failed to delete material.';
    res.redirect('/admin/materials');
  }
};

/* ═══════════════════════════════════════════════════════════════
   Recalculate Usage   POST /admin/materials/recalculate-usage
   ═══════════════════════════════════════════════════════════════ */
exports.materialRecalculateUsage = async (req, res) => {
  try {
    await recountMaterialUsage();
    const unlinkedCount = await countUnlinkedReports();
    await logAudit(req, 'update', null, 'All Materials', { action: 'recalculate_usage', unlinkedCount });
    if (unlinkedCount > 0) {
      req.session.flash = `All material usage counts and dates have been recalculated successfully. Note: ${unlinkedCount} reports are not linked to a material yet.`;
    } else {
      req.session.flash = 'All material usage counts and dates have been recalculated successfully!';
    }
    res.redirect('/admin/materials');
  } catch (err) {
    console.error('adminMaterialController.materialRecalculateUsage error:', err);
    req.session.flashError = 'Failed to recalculate material usage.';
    res.redirect('/admin/materials');
  }
};
