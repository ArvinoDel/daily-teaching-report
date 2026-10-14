'use strict';

/**
 * controllers/materialContentController.js
 *
 * Handles Material library, viewer, editor, revisions, locking,
 * and Cloudinary signed direct uploads/streaming.
 */

const cloudinary = require('cloudinary').v2;
const Material = require('../models/Material');
const MaterialContent = require('../models/MaterialContent');
const MaterialContentRevision = require('../models/MaterialContentRevision');
const AuditLog = require('../models/AuditLog');
const { invalidateMaterialsCache } = require('../services/materialService');
const {
  getAllowedExtensions,
  getMaxFileBytes,
  sanitizeMaterialHtml,
  computeHasContent,
  validateResource,
  validateLink,
  canEdit,
  checkVersionConflict,
  MAX_RESOURCES,
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
      filter.name = { $regex: q.trim(), $options: 'i' };
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
      csrfToken: req.csrfToken ? req.csrfToken() : '',
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
    const material = await Material.findById(req.params.id);
    if (!material) {
      return res.status(404).json({ error: 'Material not found.' });
    }

    let content = await MaterialContent.findOne({ material: material._id });
    const user = req.session.user;

    if (!canEdit(user, content)) {
      return res.status(403).json({ error: 'This material is locked for editing.' });
    }

    const { body, resources, note, baseVersion } = req.body;

    // Check version conflict
    if (content && checkVersionConflict(baseVersion, content.version)) {
      return res.status(409).json({ message: 'Someone else saved changes. Reload to merge.' });
    }

    // Sanitize body
    const sanitizedBody = sanitizeMaterialHtml(body || '');

    // Validate resources if passed
    let validatedResources = content ? [...content.resources] : [];
    if (Array.isArray(resources)) {
      if (resources.length > MAX_RESOURCES) {
        return res.status(422).json({ error: `Maximum ${MAX_RESOURCES} resources allowed.` });
      }
      // Re-order or update labels based on resources array
      const mapped = [];
      for (const item of resources) {
        if (!item || !item.kind) continue;
        const validRes = validateResource(item, material._id);
        if (!validRes.valid) {
          return res.status(422).json({ error: validRes.error || 'Invalid resource.' });
        }
        mapped.push(item);
      }
      validatedResources = mapped;
    }

    const currentVersion = content ? (content.version || 1) : 0;
    const newVersion = currentVersion + 1;
    const now = new Date();
    const userName = user.displayName || user.name || user.username || 'User';

    if (!content) {
      content = new MaterialContent({
        material: material._id,
        body: sanitizedBody,
        resources: validatedResources,
        version: newVersion,
        updatedBy: user._id,
        updatedByName: userName,
      });
    } else {
      content.body = sanitizedBody;
      content.resources = validatedResources;
      content.version = newVersion;
      content.updatedBy = user._id;
      content.updatedByName = userName;
    }

    await content.save();

    // Snapshot revision
    await MaterialContentRevision.create({
      material: material._id,
      version: newVersion,
      body: sanitizedBody,
      resources: content.resources,
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
    const hasContent = computeHasContent(sanitizedBody, content.resources);
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
      csrfToken: req.csrfToken ? req.csrfToken() : '',
    });
  } catch (err) {
    console.error('getHistory error:', err);
    res.render('error', { message: 'Failed to load history.' });
  }
};

exports.restoreRevision = async (req, res) => {
  try {
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
    }).lean();

    if (!revision) {
      return res.status(404).json({ error: 'Revision not found.' });
    }

    let content = await MaterialContent.findOne({ material: material._id });
    const currentVersion = content ? (content.version || 1) : 0;
    const newVersion = currentVersion + 1;
    const user = req.session.user;
    const userName = user.displayName || user.username || 'Admin';
    const now = new Date();

    if (!content) {
      content = new MaterialContent({
        material: material._id,
        body: revision.body,
        resources: revision.resources || [],
        version: newVersion,
        updatedBy: user._id,
        updatedByName: userName,
      });
    } else {
      content.body = revision.body;
      content.resources = revision.resources || [];
      content.version = newVersion;
      content.updatedBy = user._id;
      content.updatedByName = userName;
    }

    await content.save();

    // Create a NEW revision record (never rewrite history)
    await MaterialContentRevision.create({
      material: material._id,
      version: newVersion,
      body: content.body,
      resources: content.resources,
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
    const hasContent = computeHasContent(content.body, content.resources);
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
    const material = await Material.findById(req.params.id);
    if (!material) {
      return res.status(404).json({ error: 'Material not found.' });
    }

    const content = await MaterialContent.findOne({ material: material._id });
    if (!canEdit(req.session.user, content)) {
      return res.status(403).json({ error: 'Editing is not permitted.' });
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

    const paramsToSign = {
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
    const material = await Material.findById(req.params.id);
    if (!material) {
      return res.status(404).json({ error: 'Material not found.' });
    }

    let content = await MaterialContent.findOne({ material: material._id });
    if (!canEdit(req.session.user, content)) {
      return res.status(403).json({ error: 'Editing is not permitted.' });
    }

    if (!content) {
      content = new MaterialContent({
        material: material._id,
        version: 1,
      });
    }

    if (content.resources.length >= MAX_RESOURCES) {
      return res.status(422).json({ error: `Maximum ${MAX_RESOURCES} resources reached.` });
    }

    const { kind, label, publicId, resourceType, deliveryType, url } = req.body;
    let resourceToSave;

    if (kind === 'file') {
      if (!publicId || typeof publicId !== 'string') {
        return res.status(422).json({ error: 'File publicId is required.' });
      }

      // Verify asset exists in Cloudinary Admin API
      let asset;
      try {
        asset = await cloudinary.api.resource(publicId, {
          type: deliveryType || 'authenticated',
          resource_type: resourceType || 'auto',
        });
      } catch (cloudErr) {
        // Try raw if auto was used
        try {
          asset = await cloudinary.api.resource(publicId, {
            type: deliveryType || 'authenticated',
            resource_type: 'raw',
          });
        } catch (_) {
          return res.status(422).json({ error: 'File verification with Cloudinary failed.' });
        }
      }

      if (!asset) {
        return res.status(422).json({ error: 'Asset not found on cloud storage.' });
      }

      const expectedPrefix = `materials/${material._id}/`;
      if (!asset.public_id.startsWith(expectedPrefix)) {
        return res.status(422).json({ error: 'File public_id does not belong to this material.' });
      }

      if (asset.bytes > getMaxFileBytes()) {
        return res.status(422).json({ error: 'File size exceeds maximum limit.' });
      }

      const format = (asset.format || '').toLowerCase();
      const ext = format || (asset.original_filename ? asset.original_filename.split('.').pop().toLowerCase() : '');
      const allowed = getAllowedExtensions();
      if (ext && !allowed.includes(ext)) {
        return res.status(422).json({ error: `File format .${ext} is not allowed.` });
      }

      resourceToSave = {
        kind: 'file',
        label: label ? String(label).trim().slice(0, 100) : (asset.original_filename || 'Attachment'),
        file: {
          publicId: asset.public_id,
          resourceType: asset.resource_type || resourceType || 'auto',
          deliveryType: deliveryType || 'authenticated',
          format: asset.format || ext || '',
          bytes: asset.bytes || 0,
          originalFilename: asset.original_filename || '',
        },
        addedBy: req.session.user._id,
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
        addedBy: req.session.user._id,
        addedAt: new Date(),
      };
    } else {
      return res.status(422).json({ error: 'Invalid resource kind.' });
    }

    content.resources.push(resourceToSave);
    await content.save();

    material.hasContent = true;
    material.contentUpdatedAt = new Date();
    await material.save();
    invalidateMaterialsCache();

    const created = content.resources[content.resources.length - 1];
    return res.json({ ok: true, resource: created });
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
    const material = await Material.findById(req.params.id);
    if (!material) {
      return res.status(404).json({ error: 'Material not found.' });
    }

    const content = await MaterialContent.findOne({ material: material._id });
    if (!content) {
      return res.status(404).json({ error: 'Content not found.' });
    }

    if (!canEdit(req.session.user, content)) {
      return res.status(403).json({ error: 'Editing is not permitted.' });
    }

    const initialLen = content.resources.length;
    content.resources = content.resources.filter(r => String(r._id) !== req.params.rid);

    if (content.resources.length === initialLen) {
      return res.status(404).json({ error: 'Resource not found.' });
    }

    // Do NOT destroy Cloudinary asset — older revisions may reference it
    await content.save();

    const hasContent = computeHasContent(content.body, content.resources);
    material.hasContent = hasContent;
    material.contentUpdatedAt = new Date();
    await material.save();
    invalidateMaterialsCache();

    return res.json({ ok: true });
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
    const content = await MaterialContent.findOne({ material: req.params.id }).lean();
    if (!content) {
      return res.status(404).render('error', { message: 'Material content not found.' });
    }

    const resource = (content.resources || []).find(r => String(r._id) === req.params.rid);
    if (!resource) {
      return res.status(404).render('error', { message: 'Resource not found.' });
    }

    if (resource.kind === 'link') {
      return res.redirect(resource.url);
    }

    if (resource.kind === 'file') {
      const isDownload = req.query.download === '1';
      const signedUrl = cloudinary.url(resource.file.publicId, {
        type: resource.file.deliveryType || 'authenticated',
        resource_type: resource.file.resourceType || 'auto',
        format: resource.file.format,
        sign_url: true,
        secure: true,
        attachment: isDownload,
      });

      return res.redirect(302, signedUrl);
    }

    return res.status(404).render('error', { message: 'Resource type unknown.' });
  } catch (err) {
    console.error('openResource error:', err);
    return res.status(500).render('error', { message: 'Failed to open resource.' });
  }
};
