'use strict';
const Material    = require('../models/Material');
const AuditLog    = require('../models/AuditLog');
const { LEVELS, LEVEL_LABELS } = require('../models/Group');
const { normalizeMaterialName, formatMaterialDisplayName } = require('../models/Material');
const { invalidateMaterialsCache } = require('./reportsController');

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
    const { level, q } = req.query;
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

    const [
      totalMaterials,
      totalWithLevel,
      totalNoLevel,
      filteredCount,
      materials,
      usedLevels,
      allMaterialsForMerge,
    ] = await Promise.all([
      Material.countDocuments(),
      Material.countDocuments({ level: { $ne: '' } }),
      Material.countDocuments({ level: '' }),
      Material.countDocuments(filter),
      Material.find(filter)
        .sort({ usageCount: -1, name: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('createdBy', 'displayName username')
        .lean(),
      Material.distinct('level'),
      Material.find()
        .select('name level usageCount')
        .sort({ name: 1 })
        .lean(),
    ]);

    const totalPages = Math.max(1, Math.ceil(filteredCount / limit));

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
    })));

    const flashMessage = req.session.flash || null;
    const flashError   = req.session.flashError || null;
    delete req.session.flash;
    delete req.session.flashError;

    res.render('admin/materials/index', {
      title: 'Admin — Materials',
      materials,
      totalMaterials,
      totalWithLevel,
      totalNoLevel,
      filteredCount,
      page,
      totalPages,
      availableLevels,
      LEVELS,
      LEVEL_LABELS,
      materialsJson,
      selectedLevel: level || '',
      searchQuery:   q     || '',
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
    const collision = await Material.findOne({
      nameNormalized: nameNorm,
      level:          validatedLevel,
      _id:            { $ne: material._id },
    });

    if (collision) {
      req.session.flashError = `A material named "${collision.name}" with level "${validatedLevel || 'No level'}" already exists. You can use the Merge feature to combine them.`;
      return res.redirect('/admin/materials');
    }

    const oldName  = material.name;
    const oldLevel = material.level;

    material.name           = cleanName;
    material.nameNormalized = nameNorm;
    material.level          = validatedLevel;
    await material.save();

    if (typeof invalidateMaterialsCache === 'function') {
      invalidateMaterialsCache();
    }

    await logAudit(req, 'update', material._id, material.name, {
      oldName,
      oldLevel,
      newName: material.name,
      newLevel: material.level,
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

    // Combine usage count
    target.usageCount = (target.usageCount || 0) + sourceUsage;

    // Keep the latest lastUsedAt
    if (source.lastUsedAt) {
      if (!target.lastUsedAt || new Date(source.lastUsedAt) > new Date(target.lastUsedAt)) {
        target.lastUsedAt = source.lastUsedAt;
      }
    }

    await target.save();
    await source.deleteOne();

    if (typeof invalidateMaterialsCache === 'function') {
      invalidateMaterialsCache();
    }

    await logAudit(req, 'merge', target._id, target.name, {
      mergedFromId:    source._id,
      mergedFromName:  sourceName,
      mergedFromLevel: sourceLevel,
      transferredUsage: sourceUsage,
      newTotalUsage:   target.usageCount,
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

    await material.deleteOne();

    if (typeof invalidateMaterialsCache === 'function') {
      invalidateMaterialsCache();
    }

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
