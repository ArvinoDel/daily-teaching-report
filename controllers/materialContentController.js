'use strict';

/**
 * controllers/materialContentController.js
 *
 * Handles Material library, viewer, editor, revisions, locking,
 * and Cloudinary signed direct uploads/streaming.
 */

const cloudinary = require('cloudinary').v2;
const mongoose = require('mongoose');
const User = require('../models/User');
const Material = require('../models/Material');
const MaterialContent = require('../models/MaterialContent');
const MaterialContentRevision = require('../models/MaterialContentRevision');
const AuditLog = require('../models/AuditLog');
const { invalidateMaterialsCache } = require('../services/materialService');
const {
  getAllowedExtensions,
  getMaxFileBytes,
  sanitizeMaterialHtml,
  renderMaterialBody,
  safeJson,
  computeHasContent,
  validateResource,
  validateLink,
  canEdit,
  checkVersionConflict,
  deriveFileExtension,
  buildSignedFileUrl,
  parseBaseVersion,
  escapeRegex,
  MAX_RESOURCES,
  MAX_BODY_BYTES,
} = require('../services/materialContentService');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function isAdminUser(req) {
  const role = req.session?.user?.role;
  return role === 'admin' || role === 'superadmin';
}

/* ─────────────────────────────────────────────────────────────────────
 *  1. Library View: GET /materials
 * ───────────────────────────────────────────────────────────────────── */
exports.materialsLibrary = async (req, res) => {
  try {
    const { q, level } = req.query;
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 12;

    const filter = { hasContent: true };
    if (q && q.trim()) {
      filter.name = { $regex: escapeRegex(q.trim()), $options: 'i' };
    }
    if (level && level.trim()) {
      filter.level = level.trim().toUpperCase();
    }

    const [totalMatching, materials, distinctLevels] = await Promise.all([
      Material.countDocuments(filter),
      Material.find(filter)
        .sort({ name: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Material.distinct('level', { hasContent: true }),
    ]);

    const totalPages = Math.max(1, Math.ceil(totalMatching / limit));

    // Fetch file counts for materials on current page
    const matIds = materials.map(m => m._id);
    const contents = await MaterialContent.find({ material: { $in: matIds } })
      .select('material resources updatedAt')
      .lean();

    const contentMap = {};
    for (const c of contents) {
      const fileCount = (c.resources || []).filter(r => r.kind === 'file').length;
      contentMap[String(c.material)] = {
        fileCount,
        updatedAt: c.updatedAt,
      };
    }

    const availableLevels = distinctLevels.filter(Boolean).map(l => l.toUpperCase()).sort();

    res.render('materials/index', {
      title: 'Materials Library',
      materials,
      contentMap,
      page,
      totalPages,
      totalMatching,
      availableLevels,
      selectedLevel: level || '',
      searchQuery:   q || '',
      userIsAdmin:   isAdminUser(req),
      renderMaterialBody,
      safeJson,
    });
  } catch (err) {
    console.error('materialsLibrary error:', err);
    res.render('error', { message: 'Failed to load materials library.' });
  }
};

/* ─────────────────────────────────────────────────────────────────────
 *  2. Read View: GET /materials/:id
 * ───────────────────────────────────────────────────────────────────── */
exports.showMaterial = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).render('error', { message: 'Material not found.' });
    }

    const material = await Material.findById(req.params.id).lean();
    if (!material) {
      return res.status(404).render('error', { message: 'Material not found.' });
    }

    const content = await MaterialContent.findOne({ material: material._id }).lean();
    const user = req.session.user;
    const userCanEdit = canEdit(user, content);
    const userIsAdmin = isAdminUser(req);

    res.render('materials/show', {
      title: `${material.name} — Material`,
      material,
      content: content || { body: '', resources: [], locked: false, version: 1 },
      userCanEdit,
      userIsAdmin,
      renderMaterialBody,
      safeJson,
      csrfToken: (req.session && req.session.csrfToken) || (res.locals && res.locals.csrfToken) || '',
    });
  } catch (err) {
    console.error('showMaterial error:', err);
    res.render('error', { message: 'Failed to load material.' });
  }
};

/* ─────────────────────────────────────────────────────────────────────
 *  3. Editor View: GET /materials/:id/edit
 * ───────────────────────────────────────────────────────────────────── */
exports.editMaterial = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).render('error', { message: 'Material not found.' });
    }

    const material = await Material.findById(req.params.id).lean();
    if (!material) {
      return res.status(404).render('error', { message: 'Material not found.' });
    }

    const content = await MaterialContent.findOne({ material: material._id }).lean();
    const user = req.session.user;
    if (!canEdit(user, content)) {
      req.session.flashError = 'This material is locked for editing.';
      return res.redirect(`/materials/${material._id}`);
    }

    res.render('materials/edit', {
      title: `Edit ${material.name}`,
      material,
      content: content || { body: '', resources: [], locked: false, version: 1 },
      userIsAdmin: isAdminUser(req),
      maxFileMb: parseInt(process.env.MATERIAL_MAX_FILE_MB, 10) || 10,
      allowedExtensions: getAllowedExtensions(),
      renderMaterialBody,
      safeJson,
      csrfToken: (req.session && req.session.csrfToken) || (res.locals && res.locals.csrfToken) || '',
    });
  } catch (err) {
    console.error('editMaterial error:', err);
    res.render('error', { message: 'Failed to load editor.' });
  }
};

/* ─────────────────────────────────────────────────────────────────────
 *  4. Save Content: POST /materials/:id
 * ───────────────────────────────────────────────────────────────────── */
exports.saveMaterial = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: 'Material not found.' });
    }

    const { body, resources, note } = req.body;
    const baseVersion = parseBaseVersion(req.body?.baseVersion);
    if (baseVersion === null) {
      return res.status(400).json({ error: 'baseVersion is required.' });
    }

    // Body size validation: do not truncate, return 422
    if (body && typeof body === 'string' && Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      return res.status(422).json({ error: 'Content body exceeds 200 KB limit.' });
    }

    const material = await Material.findById(req.params.id);
    if (!material) {
      return res.status(404).json({ error: 'Material not found.' });
    }

    let content = await MaterialContent.findOne({ material: material._id });
    const user = req.session.user;

    if (!canEdit(user, content)) {
      return res.status(403).json({ error: 'This material is locked for editing.' });
    }

    // Sanitize body
    const sanitizedBody = sanitizeMaterialHtml(body || '');

    // Server-side resource integrity:
    // Build saved resources ONLY from existing stored resources.
    // Client may send [{ _id, label }] in desired order.
    let savedResources = [];
    if (content) {
      savedResources = [...content.resources];
    }

    if (resources !== undefined) {
      if (!Array.isArray(resources)) {
        return res.status(422).json({ error: 'Resources must be an array.' });
      }
      if (resources.length > MAX_RESOURCES) {
        return res.status(422).json({ error: `Maximum ${MAX_RESOURCES} resources allowed.` });
      }

      const existingMap = new Map();
      if (content && Array.isArray(content.resources)) {
        for (const r of content.resources) {
          existingMap.set(String(r._id), r);
        }
      }

      const mapped = [];
      const seenIds = new Set();
      for (const item of resources) {
        if (!item || typeof item !== 'object' || !item._id) {
          return res.status(422).json({ error: 'Resource item must include _id.' });
        }
        const idStr = String(item._id);
        if (seenIds.has(idStr)) {
          return res.status(422).json({ error: 'Duplicate resource _id.' });
        }
        seenIds.add(idStr);

        const existing = existingMap.get(idStr);
        if (!existing) {
          return res.status(422).json({ error: `Unknown resource _id: ${idStr}` });
        }

        const resObj = existing.toObject ? existing.toObject() : { ...existing };
        resObj.label = item.label !== undefined ? String(item.label).trim().slice(0, 100) : (resObj.label || '');
        mapped.push(resObj);
      }
      savedResources = mapped;
    }

    const now = new Date();
    const userName = user.displayName || user.name || user.username || 'User';
    let updatedContent;
    let newVersion;

    if (content) {
      const currentVersion = Number(baseVersion);
      newVersion = currentVersion + 1;

      const versionFilter = currentVersion === 1
        ? { _id: content._id, $or: [{ version: 1 }, { version: { $exists: false } }, { version: null }] }
        : { _id: content._id, version: currentVersion };

      updatedContent = await MaterialContent.findOneAndUpdate(
        versionFilter,
        {
          $set: {
            body: sanitizedBody,
            resources: savedResources,
            version: newVersion,
            updatedBy: user._id,
            updatedByName: userName,
          },
        },
        { new: true }
      );

      if (!updatedContent) {
        return res.status(409).json({ message: 'Someone else saved changes. Reload to merge.' });
      }
    } else {
      newVersion = 1;
      try {
        updatedContent = await MaterialContent.create({
          material: material._id,
          body: sanitizedBody,
          resources: savedResources,
          version: newVersion,
          updatedBy: user._id,
          updatedByName: userName,
        });
      } catch (err) {
        if (err.code === 11000) {
          return res.status(409).json({ message: 'Someone else saved changes. Reload to merge.' });
        }
        throw err;
      }
    }

    // Snapshot revision
    await MaterialContentRevision.create({
      material: material._id,
      version: newVersion,
      body: sanitizedBody,
      resources: updatedContent.resources,
      note: note ? String(note).trim().slice(0, 200) : '',
      editedBy: user._id,
      editedByName: userName,
      editedAt: now,
    });

    // Prune revisions (keep latest 30 per material)
    const oldRevs = await MaterialContentRevision.find({ material: material._id })
      .sort({ version: -1 })
      .select('_id')
      .skip(30)
      .lean();

    if (oldRevs.length > 0) {
      await MaterialContentRevision.deleteMany({ _id: { $in: oldRevs.map(r => r._id) } });
    }

    // Update Material.hasContent
    const hasContent = computeHasContent(sanitizedBody, updatedContent.resources);
    material.hasContent = hasContent;
    material.contentUpdatedAt = now;
    await material.save();

    invalidateMaterialsCache();

    // Audit log
    await AuditLog.create({
      admin: user._id,
      adminName: userName,
      action: 'update',
      targetType: 'material',
      targetId: material._id,
      targetLabel: material.name,
      meta: { contentVersion: newVersion, note: note || '' },
    }).catch(() => {});

    return res.json({ ok: true, version: newVersion });
  } catch (err) {
    console.error('saveMaterial error:', err);
    return res.status(500).json({ error: 'Failed to save material content.' });
  }
};

/* ─────────────────────────────────────────────────────────────────────
 *  5. Lock Toggle: POST /materials/:id/lock (Admin only)
 * ───────────────────────────────────────────────────────────────────── */
exports.toggleLock = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.status(404).json({ error: 'Material not found.' });
      }
      return res.status(404).render('error', { message: 'Material not found.' });
    }

    if (!isAdminUser(req)) {
      return res.status(403).json({ error: 'Admin permission required.' });
    }

    const material = await Material.findById(req.params.id);
    if (!material) {
      return res.status(404).json({ error: 'Material not found.' });
    }

    let content = await MaterialContent.findOne({ material: material._id });
    if (!content) {
      content = new MaterialContent({
        material: material._id,
        locked: true,
        version: 1,
      });
    } else {
      content.locked = !content.locked;
    }

    await content.save();

    const user = req.session.user;
    await AuditLog.create({
      admin: user._id,
      adminName: user.displayName || user.username || 'Admin',
      action: 'update',
      targetType: 'material',
      targetId: material._id,
      targetLabel: material.name,
      meta: { locked: content.locked },
    }).catch(() => {});

    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.json({ ok: true, locked: content.locked });
    }
    return res.redirect(`/materials/${material._id}`);
  } catch (err) {
    console.error('toggleLock error:', err);
    return res.status(500).json({ error: 'Failed to toggle lock status.' });
  }
};

/* ─────────────────────────────────────────────────────────────────────
 *  6. History & Restore: Admin only
 * ───────────────────────────────────────────────────────────────────── */
exports.getHistory = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).render('error', { message: 'Material not found.' });
    }

    if (!isAdminUser(req)) {
      req.session.flashError = 'Admin permission required.';
      return res.redirect(`/materials/${req.params.id}`);
    }

    const material = await Material.findById(req.params.id).lean();
    if (!material) {
      return res.status(404).render('error', { message: 'Material not found.' });
    }

    const revisions = await MaterialContentRevision.find({ material: material._id })
      .sort({ version: -1 })
      .lean();

    const currentContent = await MaterialContent.findOne({ material: material._id }).lean();

    res.render('materials/history', {
      title: `${material.name} — Revision History`,
      material,
      revisions,
      currentVersion: currentContent ? currentContent.version : 1,
      renderMaterialBody,
      safeJson,
      csrfToken: (req.session && req.session.csrfToken) || (res.locals && res.locals.csrfToken) || '',
    });
  } catch (err) {
    console.error('getHistory error:', err);
    res.render('error', { message: 'Failed to load history.' });
  }
};

exports.restoreRevision = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.status(404).json({ error: 'Material not found.' });
      }
      return res.status(404).render('error', { message: 'Material not found.' });
    }

    if (!isAdminUser(req)) {
      return res.status(403).json({ error: 'Admin permission required.' });
    }

    const material = await Material.findById(req.params.id);
    if (!material) {
      return res.status(404).json({ error: 'Material not found.' });
    }

    const targetVer = Number(req.params.version);
    const revision = await MaterialContentRevision.findOne({
      material: material._id,
      version: targetVer,
    }).sort({ version: -1 }).lean();

    if (!revision) {
      return res.status(404).json({ error: 'Revision not found.' });
    }

    // Sanitize restored body before saving
    const sanitizedBody = sanitizeMaterialHtml(revision.body || '');
    if (Buffer.byteLength(sanitizedBody, 'utf8') > MAX_BODY_BYTES) {
      return res.status(422).json({ error: 'Restored body exceeds 200 KB limit.' });
    }

    let content = await MaterialContent.findOne({ material: material._id });
    const user = req.session.user;
    const userName = user.displayName || user.username || 'Admin';
    const now = new Date();
    let updatedContent;
    let newVersion;

    if (content) {
      const currentVersion = content.version;
      newVersion = currentVersion + 1;

      updatedContent = await MaterialContent.findOneAndUpdate(
        { _id: content._id, version: currentVersion },
        {
          $set: {
            body: sanitizedBody,
            resources: revision.resources || [],
            version: newVersion,
            updatedBy: user._id,
            updatedByName: userName,
          },
        },
        { new: true }
      );

      if (!updatedContent) {
        return res.status(409).json({ message: 'Someone else saved changes. Reload to merge.' });
      }
    } else {
      newVersion = 1;
      try {
        updatedContent = await MaterialContent.create({
          material: material._id,
          body: sanitizedBody,
          resources: revision.resources || [],
          version: newVersion,
          updatedBy: user._id,
          updatedByName: userName,
        });
      } catch (err) {
        if (err.code === 11000) {
          return res.status(409).json({ message: 'Someone else saved changes. Reload to merge.' });
        }
        throw err;
      }
    }

    // Create a NEW revision record (never rewrite history)
    await MaterialContentRevision.create({
      material: material._id,
      version: newVersion,
      body: sanitizedBody,
      resources: updatedContent.resources,
      note: `Restored version ${targetVer}`,
      editedBy: user._id,
      editedByName: userName,
      editedAt: now,
    });

    // Prune revisions
    const oldRevs = await MaterialContentRevision.find({ material: material._id })
      .sort({ version: -1 })
      .select('_id')
      .skip(30)
      .lean();

    if (oldRevs.length > 0) {
      await MaterialContentRevision.deleteMany({ _id: { $in: oldRevs.map(r => r._id) } });
    }

    // Update Material
    const hasContent = computeHasContent(sanitizedBody, updatedContent.resources);
    material.hasContent = hasContent;
    material.contentUpdatedAt = now;
    await material.save();

    invalidateMaterialsCache();

    await AuditLog.create({
      admin: user._id,
      adminName: userName,
      action: 'update',
      targetType: 'material',
      targetId: material._id,
      targetLabel: material.name,
      meta: { restoredVersion: targetVer, newVersion },
    }).catch(() => {});

    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.json({ ok: true, version: newVersion });
    }
    return res.redirect(`/materials/${material._id}`);
  } catch (err) {
    console.error('restoreRevision error:', err);
    return res.status(500).json({ error: 'Failed to restore revision.' });
  }
};

/* ─────────────────────────────────────────────────────────────────────
 *  7. Signed Upload Payload: POST /materials/:id/uploads/sign
 * ───────────────────────────────────────────────────────────────────── */
exports.signUpload = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: 'Material not found.' });
    }

    const material = await Material.findById(req.params.id);
    if (!material) {
      return res.status(404).json({ error: 'Material not found.' });
    }

    const content = await MaterialContent.findOne({ material: material._id });
    if (!canEdit(req.session.user, content)) {
      return res.status(403).json({ error: 'Editing is not permitted.' });
    }

    if (content && Array.isArray(content.resources) && content.resources.length >= MAX_RESOURCES) {
      return res.status(422).json({ error: `Maximum ${MAX_RESOURCES} resources reached.` });
    }

    const { filename, size } = req.body;
    if (!filename || typeof filename !== 'string') {
      return res.status(422).json({ error: 'Filename is required.' });
    }

    const ext = filename.split('.').pop().toLowerCase();
    const allowed = getAllowedExtensions();
    if (!allowed.includes(ext)) {
      return res.status(422).json({ error: `File type .${ext} is not allowed.` });
    }

    const numSize = Number(size || 0);
    const maxBytes = getMaxFileBytes();
    if (numSize > maxBytes) {
      return res.status(422).json({
        error: `File size exceeds the limit of ${Math.round(maxBytes / (1024 * 1024))} MB.`,
      });
    }

    const timestamp = Math.round(Date.now() / 1000);
    const folder = `materials/${material._id}`;
    const type = 'authenticated';
    const allowedFormatsStr = allowed.join(',');

    const paramsToSign = {
      allowed_formats: allowedFormatsStr,
      folder,
      timestamp,
      type,
    };

    const signature = cloudinary.utils.api_sign_request(
      paramsToSign,
      process.env.CLOUDINARY_API_SECRET
    );

    return res.json({
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey:    process.env.CLOUDINARY_API_KEY,
      timestamp,
      signature,
      folder,
      type,
      allowed_formats: allowedFormatsStr,
    });
  } catch (err) {
    console.error('signUpload error:', err);
    return res.status(500).json({ error: 'Failed to generate upload signature.' });
  }
};

/* ─────────────────────────────────────────────────────────────────────
 *  8. Attach Resource: POST /materials/:id/resources
 * ───────────────────────────────────────────────────────────────────── */
exports.addResource = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: 'Material not found.' });
    }

    const material = await Material.findById(req.params.id);
    if (!material) {
      return res.status(404).json({ error: 'Material not found.' });
    }

    let content = await MaterialContent.findOne({ material: material._id });
    const user = req.session.user;
    if (!canEdit(user, content)) {
      return res.status(403).json({ error: 'Editing is not permitted.' });
    }

    if (content && content.resources.length >= MAX_RESOURCES) {
      return res.status(422).json({ error: `Maximum ${MAX_RESOURCES} resources reached.` });
    }

    const baseVersion = parseBaseVersion(
      req.body?.baseVersion !== undefined ? req.body.baseVersion : req.query.baseVersion
    );
    if (baseVersion === null) {
      return res.status(400).json({ error: 'baseVersion is required.' });
    }

    const { kind, label, publicId, resourceType, deliveryType, url } = req.body;
    let resourceToSave;

    if (kind === 'file') {
      if (!publicId || typeof publicId !== 'string') {
        return res.status(422).json({ error: 'File publicId is required.' });
      }

      // If the same publicId is already attached to this material, reject with 422
      if (content && Array.isArray(content.resources)) {
        const isDuplicate = content.resources.some(r => {
          if (r.kind !== 'file') return false;
          const existingPid = r.file?.publicId || r.publicId;
          return existingPid === publicId;
        });
        if (isDuplicate) {
          return res.status(422).json({ error: 'This file is already attached to this material.' });
        }
      }

      // Verify asset exists in Cloudinary Admin API:
      // Call the Admin API with a real resource type: if client sends image/raw/video use it,
      // otherwise try image, then video, then raw; never send 'auto' to the Admin API.
      let asset;
      const initialDeliveryType = deliveryType || 'authenticated';
      const validResourceTypes = ['image', 'raw', 'video'];
      if (validResourceTypes.includes(resourceType)) {
        try {
          asset = await cloudinary.api.resource(publicId, {
            type: initialDeliveryType,
            resource_type: resourceType,
          });
        } catch (_) {}
      } else {
        const fallbackOrder = ['image', 'video', 'raw'];
        for (const rt of fallbackOrder) {
          try {
            asset = await cloudinary.api.resource(publicId, {
              type: initialDeliveryType,
              resource_type: rt,
            });
            if (asset) break;
          } catch (_) {}
        }
      }

      if (!asset) {
        return res.status(422).json({ error: 'File verification with Cloudinary failed.' });
      }

      const expectedPrefix = `materials/${material._id}/`;
      if (!asset.public_id || !asset.public_id.startsWith(expectedPrefix)) {
        return res.status(422).json({ error: 'File public_id does not belong to this material.' });
      }

      if (asset.bytes > getMaxFileBytes()) {
        return res.status(422).json({ error: 'File size exceeds maximum limit.' });
      }

      // Store resourceType and deliveryType from the asset returned by Cloudinary (asset.resource_type, asset.type)
      const assetResourceType = asset.resource_type;
      const assetDeliveryType = asset.type || initialDeliveryType;

      const ext = deriveFileExtension({
        publicId: asset.public_id,
        format: asset.format,
        originalFilename: asset.original_filename,
        resourceType: assetResourceType,
      });

      // If the extension cannot be determined for a raw file, reject with 422 "Cannot determine the file type."
      if (assetResourceType === 'raw' && !ext) {
        return res.status(422).json({ error: 'Cannot determine the file type.' });
      }

      const allowed = getAllowedExtensions();
      if (!ext || !allowed.includes(ext)) {
        return res.status(422).json({ error: `File format .${ext || ''} is not allowed.` });
      }

      resourceToSave = {
        kind: 'file',
        label: label ? String(label).trim().slice(0, 100) : (asset.original_filename || 'Attachment'),
        file: {
          publicId: asset.public_id,
          resourceType: assetResourceType,
          deliveryType: assetDeliveryType,
          format: ext,
          bytes: asset.bytes || 0,
          originalFilename: asset.original_filename || '',
        },
        addedBy: user._id,
        addedAt: new Date(),
      };
    } else if (kind === 'link') {
      const linkCheck = validateLink(url);
      if (!linkCheck.valid) {
        return res.status(422).json({ error: linkCheck.error });
      }

      resourceToSave = {
        kind: 'link',
        label: label ? String(label).trim().slice(0, 100) : 'Link',
        url: linkCheck.cleanUrl,
        addedBy: user._id,
        addedAt: new Date(),
      };
    } else {
      return res.status(422).json({ error: 'Invalid resource kind.' });
    }

    const now = new Date();
    const userName = user.displayName || user.name || user.username || 'User';
    let updatedContent;
    let newVersion;

    if (content) {
      const currentVersion = baseVersion;
      newVersion = currentVersion + 1;

      const versionFilter = currentVersion === 1
        ? { _id: content._id, $or: [{ version: 1 }, { version: { $exists: false } }, { version: null }] }
        : { _id: content._id, version: currentVersion };

      updatedContent = await MaterialContent.findOneAndUpdate(
        versionFilter,
        {
          $push: { resources: resourceToSave },
          $set: {
            version: newVersion,
            updatedBy: user._id,
            updatedByName: userName,
          },
        },
        { new: true }
      );

      if (!updatedContent) {
        return res.status(409).json({ message: 'Someone else saved changes. Reload to merge.' });
      }
    } else {
      newVersion = 1;
      try {
        updatedContent = await MaterialContent.create({
          material: material._id,
          resources: [resourceToSave],
          version: newVersion,
          updatedBy: user._id,
          updatedByName: userName,
        });
      } catch (err) {
        if (err.code === 11000) {
          return res.status(409).json({ message: 'Someone else saved changes. Reload to merge.' });
        }
        throw err;
      }
    }

    const created = updatedContent.resources[updatedContent.resources.length - 1];
    const note = kind === 'file' ? `Added file: ${created.label}` : `Added link: ${created.label}`;

    // Record revision
    await MaterialContentRevision.create({
      material: material._id,
      version: newVersion,
      body: updatedContent.body,
      resources: updatedContent.resources,
      note,
      editedBy: user._id,
      editedByName: userName,
      editedAt: now,
    });

    // Prune revisions
    const oldRevs = await MaterialContentRevision.find({ material: material._id })
      .sort({ version: -1 })
      .select('_id')
      .skip(30)
      .lean();

    if (oldRevs.length > 0) {
      await MaterialContentRevision.deleteMany({ _id: { $in: oldRevs.map(r => r._id) } });
    }

    material.hasContent = true;
    material.contentUpdatedAt = now;
    await material.save();
    invalidateMaterialsCache();

    // Audit log
    await AuditLog.create({
      admin: user._id,
      adminName: userName,
      action: 'update',
      targetType: 'material',
      targetId: material._id,
      targetLabel: material.name,
      meta: { contentVersion: newVersion, note },
    }).catch(() => {});

    return res.json({ ok: true, version: newVersion, resource: created });
  } catch (err) {
    console.error('addResource error:', err);
    return res.status(500).json({ error: 'Failed to add resource.' });
  }
};

/* ─────────────────────────────────────────────────────────────────────
 *  9. Remove Resource: DELETE /materials/:id/resources/:rid
 * ───────────────────────────────────────────────────────────────────── */
exports.removeResource = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.rid)) {
      return res.status(404).json({ error: 'Material not found.' });
    }

    const material = await Material.findById(req.params.id);
    if (!material) {
      return res.status(404).json({ error: 'Material not found.' });
    }

    const content = await MaterialContent.findOne({ material: material._id });
    if (!content) {
      return res.status(404).json({ error: 'Content not found.' });
    }

    const user = req.session.user;
    if (!canEdit(user, content)) {
      return res.status(403).json({ error: 'Editing is not permitted.' });
    }

    const toRemove = content.resources.find(r => String(r._id) === String(req.params.rid));
    if (!toRemove) {
      return res.status(404).json({ error: 'Resource not found.' });
    }

    const baseVersion = parseBaseVersion(
      req.body?.baseVersion !== undefined ? req.body.baseVersion : req.query.baseVersion
    );
    if (baseVersion === null) {
      return res.status(400).json({ error: 'baseVersion is required.' });
    }

    const currentVersion = baseVersion;
    const newVersion = currentVersion + 1;
    const now = new Date();
    const userName = user.displayName || user.name || user.username || 'User';

    const versionFilter = currentVersion === 1
      ? { _id: content._id, $or: [{ version: 1 }, { version: { $exists: false } }, { version: null }] }
      : { _id: content._id, version: currentVersion };

    const updatedContent = await MaterialContent.findOneAndUpdate(
      versionFilter,
      {
        $pull: { resources: { _id: toRemove._id } },
        $set: {
          version: newVersion,
          updatedBy: user._id,
          updatedByName: userName,
        },
      },
      { new: true }
    );

    if (!updatedContent) {
      return res.status(409).json({ message: 'Someone else saved changes. Reload to merge.' });
    }

    const note = `Removed: ${toRemove.label || 'Resource'}`;

    // Record revision
    await MaterialContentRevision.create({
      material: material._id,
      version: newVersion,
      body: updatedContent.body,
      resources: updatedContent.resources,
      note,
      editedBy: user._id,
      editedByName: userName,
      editedAt: now,
    });

    // Prune revisions
    const oldRevs = await MaterialContentRevision.find({ material: material._id })
      .sort({ version: -1 })
      .select('_id')
      .skip(30)
      .lean();

    if (oldRevs.length > 0) {
      await MaterialContentRevision.deleteMany({ _id: { $in: oldRevs.map(r => r._id) } });
    }

    const hasContent = computeHasContent(updatedContent.body, updatedContent.resources);
    material.hasContent = hasContent;
    material.contentUpdatedAt = now;
    await material.save();
    invalidateMaterialsCache();

    // Audit log
    await AuditLog.create({
      admin: user._id,
      adminName: userName,
      action: 'update',
      targetType: 'material',
      targetId: material._id,
      targetLabel: material.name,
      meta: { contentVersion: newVersion, note },
    }).catch(() => {});

    return res.json({ ok: true, version: newVersion });
  } catch (err) {
    console.error('removeResource error:', err);
    return res.status(500).json({ error: 'Failed to remove resource.' });
  }
};

/* ─────────────────────────────────────────────────────────────────────
 *  10. Open Resource: GET /materials/:id/resources/:rid/open
 * ───────────────────────────────────────────────────────────────────── */
exports.openResource = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.rid)) {
      return res.status(404).render('error', { message: 'Resource not found.' });
    }

    const content = await MaterialContent.findOne({ material: req.params.id }).lean();
    let resource = content ? (content.resources || []).find(r => String(r._id) === req.params.rid) : null;

    // Non-admin users may only open resources that exist in the CURRENT MaterialContent.
    // Admins may also open resources found only in revisions (needed for the history page).
    if (!resource && isAdminUser(req)) {
      const ridQueries = [
        { 'resources._id': req.params.rid },
        { 'resources._id': new mongoose.Types.ObjectId(req.params.rid) },
      ];
      const rev = await MaterialContentRevision.findOne({
        material: req.params.id,
        $or: ridQueries,
      }).sort({ version: -1 }).lean();
      if (rev && Array.isArray(rev.resources)) {
        resource = rev.resources.find(r => String(r._id) === req.params.rid);
      }
    }

    if (!resource) {
      return res.status(404).render('error', { message: 'Resource not found.' });
    }

    if (resource.kind === 'link') {
      res.set('Cache-Control', 'no-store');
      return res.redirect(resource.url);
    }

    if (resource.kind === 'file') {
      const isDownload = req.query.download === '1';
      // Note: Signed Cloudinary URLs do not expire unless token-based authentication is configured on the account.
      const signedUrl = buildSignedFileUrl(resource.file, { download: isDownload });
      res.set('Cache-Control', 'no-store');
      return res.redirect(302, signedUrl);
    }

    return res.status(404).render('error', { message: 'Resource type unknown.' });
  } catch (err) {
    console.error('openResource error:', err);
    return res.status(500).render('error', { message: 'Failed to open resource.' });
  }
};
