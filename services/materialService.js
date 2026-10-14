'use strict';
const mongoose = require('mongoose');
const Material = require('../models/Material');
const MaterialAlias = require('../models/MaterialAlias');
const Report = require('../models/Report');
const Group = require('../models/Group');
const { normalizeMaterialName, formatMaterialDisplayName } = require('../models/Material');

/* ─────────────────────────────────────────────────────────────────────
 *  Cache logic for materials
 * ───────────────────────────────────────────────────────────────────── */
const MATERIALS_CACHE_TTL = 60 * 1000;
let _materialsCache     = null;
let _materialsCacheTime = 0;

function invalidateMaterialsCache() {
  _materialsCache     = null;
  _materialsCacheTime = 0;
}

function safeJsonForHtml(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

async function getMaterialsJson() {
  if (_materialsCache && Date.now() - _materialsCacheTime < MATERIALS_CACHE_TTL) {
    return _materialsCache;
  }
  try {
    const materials = await Material.find()
      .select('name level usageCount')
      .sort({ usageCount: -1, name: 1 })
      .lean();
    _materialsCache = safeJsonForHtml(materials.map(function(m) {
      return {
        _id:        String(m._id),
        name:       m.name,
        level:      m.level || '',
        usageCount: m.usageCount || 0,
      };
    }));
    _materialsCacheTime = Date.now();
    return _materialsCache;
  } catch (e) {
    console.error('getMaterialsJson error:', e);
    return '[]';
  }
}

/* ─────────────────────────────────────────────────────────────────────
 *  Group level resolution
 * ───────────────────────────────────────────────────────────────────── */
async function resolveGroupLevel(className, sessionType) {
  if (sessionType === 'competition') return '';
  if (!className || !className.trim()) return '';
  try {
    const escaped = className.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const group = await Group.findOne({
      group_name: { $regex: '^' + escaped + '$', $options: 'i' },
    }).select('level').lean();
    if (!group || !group.level) return '';
    return group.level.trim().toUpperCase();
  } catch (e) {
    console.error('resolveGroupLevel error:', e);
    return '';
  }
}

/* ─────────────────────────────────────────────────────────────────────
 *  Pure resolution helper (for unit testing & memory lookups)
 * ───────────────────────────────────────────────────────────────────── */
/**
 * Resolves canonical material given in-memory lists of materials and aliases.
 * Rule: Material wins over alias at the same (nameNormalized, level) key.
 *
 * @param {Array<{ _id: any, nameNormalized: string, level: string }>} materials
 * @param {Array<{ _id: any, nameNormalized: string, level: string, material: any }>} aliases
 * @param {string} nameNorm
 * @param {string} level
 * @returns {any|null} canonical material document or id, or null
 */
function findCanonicalMaterial(materials, aliases, nameNorm, level) {
  if (!nameNorm) return null;
  const lvl = (level || '').trim().toUpperCase();

  // (1) Check Material first (Material wins over alias)
  const mat = materials.find(
    m => m.nameNormalized === nameNorm && ((m.level || '').trim().toUpperCase()) === lvl
  );
  if (mat) return mat;

  // (2) Check MaterialAlias
  const alias = aliases.find(
    a => a.nameNormalized === nameNorm && ((a.level || '').trim().toUpperCase()) === lvl
  );
  if (alias && alias.material) {
    // If alias.material is an object (populated), return it; else find in materials list if possible
    if (typeof alias.material === 'object' && alias.material._id) {
      return alias.material;
    }
    const targetMat = materials.find(m => String(m._id) === String(alias.material));
    return targetMat || alias.material;
  }

  // (3) Else null
  return null;
}

/* ─────────────────────────────────────────────────────────────────────
 *  Pure Planning Helpers (for Merge & Rename unit testing & controllers)
 * ───────────────────────────────────────────────────────────────────── */
/**
 * Plan aliases to create, re-point, or delete when merging source into target.
 *
 * Rules:
 * 1. Source's own (nameNormalized, level) maps to target.
 *    - If it matches target's own key, skip.
 *    - If an alias already exists for that key, re-point it to target.
 *    - Otherwise, create a new alias for that key pointing to target.
 * 2. Any existing alias pointing to source:
 *    - If its key matches target's own key, remove it / skip (target is canonical).
 *    - Otherwise, re-point it to target.
 */
function planMergeAliases(source, target, existingAliases) {
  const targetKey = `${sourceNorm(target.nameNormalized)}|||${levelNorm(target.level)}`;
  const sourceKey = `${sourceNorm(source.nameNormalized)}|||${levelNorm(source.level)}`;

  const aliasesToCreate = [];
  const aliasesToRepoint = [];
  const aliasesToDelete = [];
  const skipped = [];

  function sourceNorm(s) { return (s || '').trim().toLowerCase(); }
  function levelNorm(l) { return (l || '').trim().toUpperCase(); }

  // 1. Source's own key
  if (sourceKey === targetKey) {
    skipped.push({ key: sourceKey, reason: 'matches_target_key' });
  } else {
    const existingAliasForSource = existingAliases.find(
      a => `${sourceNorm(a.nameNormalized)}|||${levelNorm(a.level)}` === sourceKey
    );
    if (existingAliasForSource) {
      aliasesToRepoint.push({
        _id: existingAliasForSource._id,
        nameNormalized: source.nameNormalized,
        level: levelNorm(source.level),
        material: target._id,
      });
    } else {
      aliasesToCreate.push({
        nameNormalized: source.nameNormalized,
        level: levelNorm(source.level),
        material: target._id,
      });
    }
  }

  // 2. Existing aliases pointing to source
  const pointingToSource = existingAliases.filter(
    a => String(a.material) === String(source._id) &&
         `${sourceNorm(a.nameNormalized)}|||${levelNorm(a.level)}` !== sourceKey
  );

  for (const a of pointingToSource) {
    const aKey = `${sourceNorm(a.nameNormalized)}|||${levelNorm(a.level)}`;
    if (aKey === targetKey) {
      aliasesToDelete.push({ _id: a._id, key: aKey });
      skipped.push({ key: aKey, reason: 'matches_target_key' });
    } else {
      aliasesToRepoint.push({
        _id: a._id,
        nameNormalized: a.nameNormalized,
        level: levelNorm(a.level),
        material: target._id,
      });
    }
  }

  return { aliasesToCreate, aliasesToRepoint, aliasesToDelete, skipped };
}

/**
 * Plan renaming a material, checking collisions with Materials and Aliases.
 */
function planRename(material, newName, newLevel, existingMaterials, existingAliases) {
  const cleanName = formatMaterialDisplayName(newName);
  const newNorm   = normalizeMaterialName(cleanName);
  const validatedLevel = (newLevel || '').trim().toUpperCase();

  if (!newNorm) {
    return { ok: false, error: 'Invalid material name.' };
  }

  const newKey = `${newNorm}|||${validatedLevel}`;
  const oldKey = `${material.nameNormalized}|||${(material.level || '').trim().toUpperCase()}`;

  // 1. Collision check against other materials
  const matCollision = existingMaterials.find(
    m => String(m._id) !== String(material._id) &&
         `${m.nameNormalized}|||${(m.level || '').trim().toUpperCase()}` === newKey
  );
  if (matCollision) {
    return {
      ok: false,
      collisionType: 'material',
      error: `A material named "${matCollision.name}" with level "${validatedLevel || 'No level'}" already exists.`,
    };
  }

  // 2. Collision check against aliases pointing to OTHER materials
  const aliasCollision = existingAliases.find(
    a => `${a.nameNormalized}|||${(a.level || '').trim().toUpperCase()}` === newKey
  );
  if (aliasCollision && String(aliasCollision.material) !== String(material._id)) {
    return {
      ok: false,
      collisionType: 'alias',
      error: `A material alias with level "${validatedLevel || 'No level'}" already exists.`,
    };
  }

  // If key changed, plan alias for old key
  let aliasToCreate = null;
  let aliasToDelete = null;

  // If an alias already existed for newKey pointing to this material, delete it (material now holds the key)
  if (aliasCollision && String(aliasCollision.material) === String(material._id)) {
    aliasToDelete = { _id: aliasCollision._id, key: newKey };
  }

  if (newKey !== oldKey) {
    aliasToCreate = {
      nameNormalized: material.nameNormalized,
      level: (material.level || '').trim().toUpperCase(),
      material: material._id,
    };
  }

  return {
    ok: true,
    cleanName,
    newNorm,
    validatedLevel,
    aliasToCreate,
    aliasToDelete,
  };
}

/* ─────────────────────────────────────────────────────────────────────
 *  Database Resolution & Recording
 * ───────────────────────────────────────────────────────────────────── */
/**
 * Look up canonical Material by (nameNormalized, level).
 * 1. Find Material by (nameNormalized, level)
 * 2. Else find MaterialAlias by (nameNormalized, level) and load its Material
 * 3. Else null
 *
 * @param {string} nameNorm
 * @param {string} level
 * @returns {Promise<Material|null>}
 */
async function resolveMaterial(nameNorm, level) {
  if (!nameNorm) return null;
  const lvl = (level || '').trim().toUpperCase();

  // (1) Material wins over alias
  const mat = await Material.findOne({ nameNormalized: nameNorm, level: lvl });
  if (mat) return mat;

  // (2) MaterialAlias
  const alias = await MaterialAlias.findOne({ nameNormalized: nameNorm, level: lvl }).populate('material');
  if (alias && alias.material) {
    return alias.material;
  }

  // (3) Not found
  return null;
}

/**
 * Record (upsert) a material when a report is saved or edited.
 * - Resolves canonical material via resolveMaterial.
 * - If found: $inc usageCount, $set lastUsedAt on canonical Material.
 * - If not found: creates new Material with E11000 retry.
 * - Returns canonical Material _id or null.
 * - NEVER throws (never-throws guarantee).
 *
 * @param {{ subject: string, className: string, sessionType: string, teacherId?: any }} opts
 * @returns {Promise<mongoose.Types.ObjectId|null>}
 */
async function recordMaterial(opts) {
  opts = opts || {};
  const subject     = opts.subject;
  const className   = opts.className;
  const sessionType = opts.sessionType;
  const teacherId   = opts.teacherId;

  try {
    if (!subject || !subject.trim()) return null;
    const displayName = formatMaterialDisplayName(subject);
    const nameNorm    = normalizeMaterialName(displayName);
    if (!nameNorm) return null;

    const level = await resolveGroupLevel(className, sessionType);

    // Resolve through resolveMaterial
    const existing = await resolveMaterial(nameNorm, level);
    if (existing) {
      const updated = await Material.findByIdAndUpdate(
        existing._id,
        {
          $inc: { usageCount: 1 },
          $set: { lastUsedAt: new Date() },
        },
        { new: true }
      );
      invalidateMaterialsCache();
      return updated ? updated._id : existing._id;
    }

    // Otherwise create it
    const upsertFn = async () => {
      return Material.findOneAndUpdate(
        { nameNormalized: nameNorm, level: level },
        {
          $setOnInsert: { name: displayName, createdBy: teacherId || null },
          $inc:         { usageCount: 1 },
          $set:         { lastUsedAt: new Date() },
        },
        { upsert: true, new: true }
      );
    };

    let saved = null;
    try {
      saved = await upsertFn();
    } catch (e) {
      // E11000 race condition: another write created it
      if (e.code === 11000) {
        // Retry: now it exists or alias exists
        const resaved = await resolveMaterial(nameNorm, level);
        if (resaved) {
          const updated = await Material.findByIdAndUpdate(
            resaved._id,
            {
              $inc: { usageCount: 1 },
              $set: { lastUsedAt: new Date() },
            },
            { new: true }
          );
          saved = updated || resaved;
        } else {
          saved = await upsertFn();
        }
      } else {
        throw e;
      }
    }

    invalidateMaterialsCache();
    return saved ? saved._id : null;
  } catch (err) {
    console.error('recordMaterial error (non-fatal):', err);
    return null;
  }
}

/**
 * Resolves canonical Material id for auto-generated/linked reports.
 * Does NOT create new Material or increment usageCount.
 *
 * @param {string} subject
 * @param {string} className
 * @param {string} sessionType
 * @returns {Promise<mongoose.Types.ObjectId|null>}
 */
async function resolveMaterialId(subject, className, sessionType) {
  try {
    if (!subject || !subject.trim()) return null;
    const displayName = formatMaterialDisplayName(subject);
    const nameNorm    = normalizeMaterialName(displayName);
    if (!nameNorm) return null;

    const level = await resolveGroupLevel(className, sessionType);
    const mat   = await resolveMaterial(nameNorm, level);
    return mat ? mat._id : null;
  } catch (err) {
    console.error('resolveMaterialId error (non-fatal):', err);
    return null;
  }
}

/**
 * Recount usageCount and lastUsedAt for specified materials, or for all materials if no ids given.
 * - usageCount: count of reports referencing material._id that are NOT auto-generated.
 * - lastUsedAt: maximum report date (or null).
 *
 * @param {Array<string|mongoose.Types.ObjectId>|string|mongoose.Types.ObjectId} [materialIds]
 * @returns {Promise<void>}
 */
async function recountMaterialUsage(materialIds) {
  try {
    if (materialIds !== undefined && materialIds !== null) {
      let ids = Array.isArray(materialIds) ? materialIds : [materialIds];
      ids = ids.filter(Boolean).map(id => (typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id));
      if (ids.length === 0) return;

      const agg = await Report.aggregate([
        {
          $match: {
            material: { $in: ids },
            is_auto_generated: { $ne: true },
          },
        },
        {
          $group: {
            _id: '$material',
            count: { $sum: 1 },
            lastUsedAt: { $max: '$date' },
          },
        },
      ]);

      const aggMap = new Map();
      for (const r of agg) {
        aggMap.set(String(r._id), { count: r.count, lastUsedAt: r.lastUsedAt || null });
      }

      const bulkOps = ids.map(id => {
        const strId = String(id);
        const data = aggMap.get(strId) || { count: 0, lastUsedAt: null };
        return {
          updateOne: {
            filter: { _id: id },
            update: {
              $set: {
                usageCount: data.count,
                lastUsedAt: data.lastUsedAt,
              },
            },
          },
        };
      });

      if (bulkOps.length > 0) {
        await Material.bulkWrite(bulkOps);
      }
    } else {
      // Full recount of ALL materials
      const agg = await Report.aggregate([
        {
          $match: {
            material: { $ne: null },
            is_auto_generated: { $ne: true },
          },
        },
        {
          $group: {
            _id: '$material',
            count: { $sum: 1 },
            lastUsedAt: { $max: '$date' },
          },
        },
      ]);

      const activeIds = agg.map(r => r._id);

      // Reset materials not in aggregation to 0 usage and null lastUsedAt
      await Material.updateMany(
        { _id: { $nin: activeIds } },
        { $set: { usageCount: 0, lastUsedAt: null } }
      );

      // Set usageCount and lastUsedAt for active materials
      if (agg.length > 0) {
        const bulkOps = agg.map(r => ({
          updateOne: {
            filter: { _id: r._id },
            update: {
              $set: {
                usageCount: r.count,
                lastUsedAt: r.lastUsedAt || null,
              },
            },
          },
        }));
        await Material.bulkWrite(bulkOps);
      }
    }

    invalidateMaterialsCache();
  } catch (err) {
    console.error('recountMaterialUsage error (non-fatal):', err);
  }
}

module.exports = {
  resolveMaterial,
  recordMaterial,
  resolveMaterialId,
  recountMaterialUsage,
  resolveGroupLevel,
  getMaterialsJson,
  invalidateMaterialsCache,
  findCanonicalMaterial,
  planMergeAliases,
  planRename,
};
