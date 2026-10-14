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
 * Safely parse HTML checkbox input.
 * Returns true ONLY for 'true', 'on', true, '1'.
 * Everything else (undefined, '', 'false', false, null, 0, etc.) returns false.
 *
 * @param {any} value
 * @returns {boolean}
 */
function parseCheckbox(value) {
  return value === true || value === 'true' || value === 'on' || value === '1';
}

/**
 * Pure helper to compute cutoff date (earliest createdAt among materials).
 * Returns null if materials is empty or no valid createdAt.
 *
 * @param {Array<{ createdAt?: any }>} materials
 * @returns {Date|null}
 */
function getUnlinkedCutoff(materials = []) {
  if (!materials || materials.length === 0) return null;
  let earliest = null;
  for (const m of materials) {
    if (m && m.createdAt) {
      const d = new Date(m.createdAt);
      if (!earliest || d < earliest) earliest = d;
    }
  }
  return earliest;
}

/**
 * Pure helper to build the MongoDB filter query for unlinked reports given a cutoff date.
 * Returns null if cutoff is not provided.
 *
 * @param {Date|string|null} cutoff
 * @returns {Object|null}
 */
function buildUnlinkedReportsFilter(cutoff) {
  if (!cutoff) return null;
  return {
    date: { $gte: new Date(cutoff) },
    subject: { $exists: true, $ne: '' },
    $or: [{ material: null }, { material: { $exists: false } }],
  };
}

/**
 * Counts reports that have a non-empty subject but no linked material.
 * Only counts reports whose date is on or after the cutoff
 * (the earliest createdAt among existing Materials).
 * If there are no materials, the count is 0.
 *
 * @param {Object} [options] Optional dependency injection for unit tests
 * @param {any} [options.MaterialModel]
 * @param {any} [options.ReportModel]
 * @param {Date|string|null} [options.cutoff]
 * @returns {Promise<number>}
 */
async function countUnlinkedReports(options = {}) {
  const MaterialModel = (options && options.MaterialModel) || Material;
  const ReportModel   = (options && options.ReportModel) || Report;

  try {
    let cutoff = options && options.cutoff;
    if (cutoff === undefined) {
      const earliest = await MaterialModel.findOne().sort({ createdAt: 1 }).select('createdAt').lean();
      if (!earliest || !earliest.createdAt) {
        return 0;
      }
      cutoff = earliest.createdAt;
    }

    if (!cutoff) {
      return 0;
    }

    const filter = buildUnlinkedReportsFilter(cutoff);
    return await ReportModel.countDocuments(filter);
  } catch (err) {
    console.error('countUnlinkedReports error:', err);
    return 0;
  }
}

/**
 * Pre-builds lookup indices from material and alias collections for fast in-memory resolution.
 *
 * @param {Array<Object>} materials
 * @param {Array<Object>} aliases
 */
function buildBackfillMaps(materials = [], aliases = []) {
  const materialsByKey  = new Map(); // `${nameNormalized}|||${level}` -> Material
  const aliasesByKey    = new Map(); // `${nameNormalized}|||${level}` -> MaterialAlias
  const materialsByName = new Map(); // `${nameNormalized}` -> [Material, ...]
  const aliasesByName   = new Map(); // `${nameNormalized}` -> [MaterialAlias, ...]
  const materialsById   = new Map(); // `${_id}` -> Material

  for (const m of materials) {
    const lvl  = (m.level || '').trim().toUpperCase();
    const norm = (m.nameNormalized || '').trim().toLowerCase();
    const key  = `${norm}|||${lvl}`;
    materialsByKey.set(key, m);
    materialsById.set(String(m._id), m);

    if (!materialsByName.has(norm)) materialsByName.set(norm, []);
    materialsByName.get(norm).push(m);
  }

  for (const a of aliases) {
    const lvl  = (a.level || '').trim().toUpperCase();
    const norm = (a.nameNormalized || '').trim().toLowerCase();
    const key  = `${norm}|||${lvl}`;
    aliasesByKey.set(key, a);

    if (!aliasesByName.has(norm)) aliasesByName.set(norm, []);
    aliasesByName.get(norm).push(a);
  }

  return { materialsByKey, aliasesByKey, materialsByName, aliasesByName, materialsById };
}

/**
 * Backfill matching order:
 *   1. Exact (nameNormalized, level)
 *   2. Alias (nameNormalized, level)
 *   3. Name-only fallback (unless options.strict === true):
 *      - 'name-unique': exactly one Material (or all aliases/materials point to 1 Material)
 *      - 'name-ambiguous': multiple distinct Materials share the name at different levels:
 *         -> if options.linkAmbiguous === true: link the one with highest usageCount (ties broken by latest lastUsedAt)
 *         -> otherwise: do not link (materialId: null)
 *
 * @param {string} nameNorm
 * @param {string} level
 * @param {Object} maps
 * @param {{ strict?: boolean, linkAmbiguous?: boolean }} [options]
 * @returns {{ materialId: any|null, via: 'exact'|'alias'|'name-unique'|'name-ambiguous'|null, candidates?: Array<Object>, ambiguousLinked?: boolean }}
 */
function resolveForBackfill(nameNorm, level, maps, options = {}) {
  const norm = (nameNorm || '').trim().toLowerCase();
  const lvl  = (level || '').trim().toUpperCase();
  if (!norm) return { materialId: null, via: null };

  const strict        = options && options.strict === true;
  const linkAmbiguous = options && options.linkAmbiguous === true;

  const bMaps = (maps && maps.materialsByKey)
    ? maps
    : buildBackfillMaps(maps && maps.materials ? maps.materials : [], maps && maps.aliases ? maps.aliases : []);

  const exactKey = `${norm}|||${lvl}`;

  // 1. Exact match on (name, level)
  const exactMat = bMaps.materialsByKey.get(exactKey);
  if (exactMat) {
    return { materialId: exactMat._id, via: 'exact', material: exactMat };
  }

  // 2. Alias match on (name, level)
  const alias = bMaps.aliasesByKey.get(exactKey);
  if (alias) {
    const targetId = (typeof alias.material === 'object' && alias.material) ? alias.material._id : alias.material;
    const targetMat = bMaps.materialsById.get(String(targetId));
    return { materialId: targetId, via: 'alias', material: targetMat };
  }

  // Strict mode: disable name-only fallback
  if (strict) {
    return { materialId: null, via: null };
  }

  // 3. Name-only fallback: find all candidate canonical materials
  const candidateMaterialIds  = new Set();
  const candidateMaterialsMap = new Map();

  const nameMats = bMaps.materialsByName.get(norm) || [];
  for (const m of nameMats) {
    const idStr = String(m._id);
    candidateMaterialIds.add(idStr);
    candidateMaterialsMap.set(idStr, m);
  }

  const nameAliases = bMaps.aliasesByName.get(norm) || [];
  for (const a of nameAliases) {
    const targetId = (typeof a.material === 'object' && a.material) ? a.material._id : a.material;
    if (targetId) {
      const idStr = String(targetId);
      candidateMaterialIds.add(idStr);
      if (!candidateMaterialsMap.has(idStr)) {
        const foundMat = bMaps.materialsById.get(idStr);
        if (foundMat) candidateMaterialsMap.set(idStr, foundMat);
      }
    }
  }

  if (candidateMaterialIds.size === 0) {
    return { materialId: null, via: null };
  }

  if (candidateMaterialIds.size === 1) {
    const [uniqueId] = candidateMaterialIds;
    const mat = candidateMaterialsMap.get(uniqueId);
    return {
      materialId: mat ? mat._id : uniqueId,
      via: 'name-unique',
      material: mat,
    };
  }

  // Multiple candidates -> name-ambiguous
  const candidates = [...candidateMaterialsMap.values()];
  candidates.sort((a, b) => {
    const countA = a.usageCount || 0;
    const countB = b.usageCount || 0;
    if (countB !== countA) return countB - countA;
    const dateA = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
    const dateB = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
    if (dateB !== dateA) return dateB - dateA;
    return String(a._id).localeCompare(String(b._id));
  });

  if (linkAmbiguous) {
    return {
      materialId: candidates[0]._id,
      via: 'name-ambiguous',
      material: candidates[0],
      candidates,
      ambiguousLinked: true,
    };
  }

  return {
    materialId: null,
    via: 'name-ambiguous',
    material: null,
    candidates,
    ambiguousLinked: false,
  };
}

/**
 * Pure helper to plan usage count and date updates from report aggregation rows.
 *
 * - When isTargeted is true (or targetedIds given): every targeted ID is updated (set to 0 if not in aggRows).
 * - When full recount (no targetedIds):
 *     - Materials with linked reports (in aggRows) are updated.
 *     - Materials with zero reports are UNTOUCHED by default, unless options.zeroUnused is true.
 *
 * @param {Array<{ _id: any, count: number, lastUsedAt: any }>} aggRows
 * @param {Array<any>} [allMaterialIds]
 * @param {{ zeroUnused?: boolean, isTargeted?: boolean }} [options]
 * @returns {Array<{ id: any, usageCount: number, lastUsedAt: any }>}
 */
function planRecountUpdates(aggRows = [], allMaterialIds = [], options = {}) {
  const zeroUnused = options && options.zeroUnused === true;
  const isTargeted = options && options.isTargeted === true;

  const aggMap = new Map();
  for (const r of (aggRows || [])) {
    aggMap.set(String(r._id), {
      id: r._id,
      usageCount: r.count,
      lastUsedAt: r.lastUsedAt || null,
    });
  }

  const updates = [];

  if (isTargeted) {
    for (const id of (allMaterialIds || [])) {
      const rawId = (id && id._id) ? id._id : id;
      const strId = String(rawId);
      const agg = aggMap.get(strId);
      updates.push({
        id: rawId,
        usageCount: agg ? agg.usageCount : 0,
        lastUsedAt: agg ? agg.lastUsedAt : null,
      });
    }
  } else {
    // Full recount:
    // Update materials that have at least one linked report
    for (const agg of aggMap.values()) {
      updates.push(agg);
    }

    // Only zero out unused materials if zeroUnused is explicitly true
    if (zeroUnused && Array.isArray(allMaterialIds)) {
      for (const id of allMaterialIds) {
        const rawId = (id && id._id) ? id._id : id;
        const strId = String(rawId);
        if (!aggMap.has(strId)) {
          updates.push({
            id: rawId,
            usageCount: 0,
            lastUsedAt: null,
          });
        }
      }
    }
  }

  return updates;
}

/**
 * Recount usageCount and lastUsedAt for specified materials, or for all materials if no ids given.
 * - Targeted recount (with ids): always sets usageCount (0 if no reports left).
 * - Full recount (no ids): ONLY updates materials that have at least one linked report.
 *   Materials with zero reports retain their current usageCount and lastUsedAt unless options.zeroUnused === true.
 *
 * @param {Array<string|mongoose.Types.ObjectId>|string|mongoose.Types.ObjectId} [materialIds]
 * @param {{ zeroUnused?: boolean }} [options]
 * @returns {Promise<void>}
 */
async function recountMaterialUsage(materialIds, options = {}) {
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

      const planned = planRecountUpdates(agg, ids, { isTargeted: true });
      const bulkOps = planned.map(u => ({
        updateOne: {
          filter: { _id: u.id },
          update: {
            $set: {
              usageCount: u.usageCount,
              lastUsedAt: u.lastUsedAt,
            },
          },
        },
      }));

      if (bulkOps.length > 0) {
        await Material.bulkWrite(bulkOps);
      }
    } else {
      // Full recount of ALL materials
      const zeroUnused = options && options.zeroUnused === true;

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

      if (zeroUnused) {
        const allMaterials = await Material.find().select('_id').lean();
        const allIds = allMaterials.map(m => m._id);
        const planned = planRecountUpdates(agg, allIds, { zeroUnused: true });
        const bulkOps = planned.map(u => ({
          updateOne: {
            filter: { _id: u.id },
            update: {
              $set: {
                usageCount: u.usageCount,
                lastUsedAt: u.lastUsedAt,
              },
            },
          },
        }));
        if (bulkOps.length > 0) {
          await Material.bulkWrite(bulkOps);
        }
      } else {
        // Safe default: ONLY update materials with at least one linked report
        const planned = planRecountUpdates(agg, null, { zeroUnused: false });
        if (planned.length > 0) {
          const bulkOps = planned.map(u => ({
            updateOne: {
              filter: { _id: u.id },
              update: {
                $set: {
                  usageCount: u.usageCount,
                  lastUsedAt: u.lastUsedAt,
                },
              },
            },
          }));
          await Material.bulkWrite(bulkOps);
        }
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
  parseCheckbox,
  countUnlinkedReports,
  buildBackfillMaps,
  resolveForBackfill,
  planRecountUpdates,
  getUnlinkedCutoff,
  buildUnlinkedReportsFilter,
};
