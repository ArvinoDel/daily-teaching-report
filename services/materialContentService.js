'use strict';

/**
 * services/materialContentService.js
 *
 * Core service & helpers for Material Content:
 * - HTML sanitization (sanitize-html with strict allowlist)
 * - Resource validation (links & files)
 * - Permission checking (admin vs teacher vs lock)
 * - Revision management & pruning (keep latest 30)
 * - Content merge planning
 */

const DEFAULT_ALLOWED_EXTENSIONS = [
  'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx',
  'jpg', 'jpeg', 'png', 'mp3', 'm4a', 'wav', 'mp4',
];

const MAX_BODY_BYTES = 200 * 1024; // 200 KB
const MAX_RESOURCES = 20;

function getAllowedExtensions() {
  if (process.env.MATERIAL_ALLOWED_EXTENSIONS) {
    return process.env.MATERIAL_ALLOWED_EXTENSIONS
      .split(',')
      .map(ext => ext.trim().toLowerCase())
      .filter(Boolean);
  }
  return DEFAULT_ALLOWED_EXTENSIONS;
}

function getMaxFileBytes() {
  const mb = parseInt(process.env.MATERIAL_MAX_FILE_MB, 10);
  return (isNaN(mb) || mb <= 0 ? 10 : mb) * 1024 * 1024;
}

/* ─────────────────────────────────────────────────────────────────────
 *  1. Sanitization (Pure CommonJS — zero external ESM dependencies)
 * ───────────────────────────────────────────────────────────────────── */
const ALLOWED_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4',
  'p', 'br',
  'strong', 'em', 'u', 's',
  'ul', 'ol', 'li',
  'blockquote',
  'a',
  'code', 'pre',
  'hr',
]);

function sanitizeMaterialHtml(dirtyHtml) {
  if (!dirtyHtml || typeof dirtyHtml !== 'string') return '';
  if (Buffer.byteLength(dirtyHtml, 'utf8') > MAX_BODY_BYTES) {
    dirtyHtml = dirtyHtml.slice(0, MAX_BODY_BYTES);
  }

  // 1. Remove dangerous blocks entirely including contents
  let clean = dirtyHtml
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*>[\s\S]*?<\/embed>/gi, '');

  let openLinks = 0;

  // 2. Tokenize tags
  clean = clean.replace(/<(\/)?([a-zA-Z0-9]+)([^>]*)>/gi, (match, isClosing, tagName, attrsStr) => {
    const tag = tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      return ''; // Strip disallowed tag entirely
    }

    if (isClosing) {
      if (tag === 'a') {
        if (openLinks > 0) {
          openLinks--;
          return '</a>';
        }
        return '';
      }
      return `</${tag}>`;
    }

    if (tag === 'br' || tag === 'hr') {
      return `<${tag}>`;
    }

    if (tag === 'a') {
      // Extract href attribute
      const hrefMatch = attrsStr.match(/href\s*=\s*(["'])(.*?)\1/i) || attrsStr.match(/href\s*=\s*([^"'\s>]+)/i);
      if (hrefMatch) {
        const rawHref = (hrefMatch[2] || hrefMatch[1] || '').trim();
        const lowerHref = rawHref.toLowerCase();
        // Disallow dangerous schemes
        if (
          lowerHref.startsWith('javascript:') ||
          lowerHref.startsWith('data:') ||
          lowerHref.startsWith('vbscript:') ||
          lowerHref.includes('javascript&')
        ) {
          return '';
        }
        // Must start with http://, https://, mailto:, /, or #
        if (
          lowerHref.startsWith('http://') ||
          lowerHref.startsWith('https://') ||
          lowerHref.startsWith('mailto:') ||
          lowerHref.startsWith('/') ||
          lowerHref.startsWith('#')
        ) {
          const safeHref = rawHref.replace(/"/g, '&quot;');
          openLinks++;
          return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">`;
        }
      }
      return '';
    }

    // For all other allowed tags, strip all attributes (no event handlers, style, class, etc.)
    return `<${tag}>`;
  });

  return clean;
}

/* ─────────────────────────────────────────────────────────────────────
 *  2. Content & Resource Helpers
 * ───────────────────────────────────────────────────────────────────── */
function computeHasContent(body, resources) {
  const textOnly = (body || '').replace(/<[^>]*>/g, '').trim();
  const hasText = textOnly.length > 0;
  const hasResources = Array.isArray(resources) && resources.length > 0;
  return hasText || hasResources;
}

function validateLink(url) {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'Link URL is required.' };
  }
  if (url.length > 500) {
    return { valid: false, error: 'Link URL exceeds 500 characters.' };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return { valid: false, error: 'Invalid URL format.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: 'Only http and https links are allowed.' };
  }
  if (parsed.username || parsed.password) {
    return { valid: false, error: 'URLs with credentials are not allowed.' };
  }
  return { valid: true, cleanUrl: parsed.toString() };
}

function validateResource(resource, materialId) {
  if (!resource || typeof resource !== 'object') {
    return { valid: false, error: 'Invalid resource.' };
  }
  if (resource.label && typeof resource.label === 'string' && resource.label.length > 100) {
    return { valid: false, error: 'Resource label cannot exceed 100 characters.' };
  }

  if (resource.kind === 'link') {
    return validateLink(resource.url);
  }

  if (resource.kind === 'file') {
    const file = resource.file || {};
    const publicId = file.publicId || resource.publicId;
    if (!publicId || typeof publicId !== 'string') {
      return { valid: false, error: 'File publicId is required.' };
    }
    if (materialId) {
      const expectedPrefix = `materials/${String(materialId)}/`;
      if (!publicId.startsWith(expectedPrefix)) {
        return { valid: false, error: `File publicId must start with ${expectedPrefix}` };
      }
    }
    const bytes = Number(file.bytes || resource.bytes || 0);
    const maxBytes = getMaxFileBytes();
    if (bytes > maxBytes) {
      return { valid: false, error: `File size exceeds the limit of ${Math.round(maxBytes / (1024 * 1024))} MB.` };
    }
    const format = (file.format || resource.format || '').toLowerCase().trim();
    const allowed = getAllowedExtensions();
    if (format && !allowed.includes(format)) {
      return { valid: false, error: `File format ".${format}" is not allowed.` };
    }
    return { valid: true };
  }

  return { valid: false, error: 'Invalid resource kind. Must be "file" or "link".' };
}

/* ─────────────────────────────────────────────────────────────────────
 *  3. Authorization Matrix
 * ───────────────────────────────────────────────────────────────────── */
function canEdit(user, content) {
  if (!user) return false;
  const role = user.role;
  if (role === 'admin' || role === 'superadmin') return true;
  if (role === 'teacher') {
    return !content || !content.locked;
  }
  return false;
}

/* ─────────────────────────────────────────────────────────────────────
 *  4. Version Conflict Check
 * ───────────────────────────────────────────────────────────────────── */
function checkVersionConflict(baseVersion, currentVersion) {
  if (currentVersion == null) return false;
  if (baseVersion === undefined || baseVersion === null) return false;
  return Number(baseVersion) !== Number(currentVersion);
}

/* ─────────────────────────────────────────────────────────────────────
 *  5. Merge Content Plan
 * ───────────────────────────────────────────────────────────────────── */
function planContentMerge(sourceContent, targetContent, sourceName) {
  const sourceHas = sourceContent && computeHasContent(sourceContent.body, sourceContent.resources);
  const targetHas = targetContent && computeHasContent(targetContent.body, targetContent.resources);

  if (!sourceHas) {
    return {
      action: 'skip_source',
      note: 'Source has no content.',
      needsWarning: false,
    };
  }

  if (!targetHas) {
    return {
      action: 'move_source_to_target',
      note: 'Moving source content to target.',
      needsWarning: false,
    };
  }

  // Both have content: keep target content as current, store source as a revision
  return {
    action: 'keep_target_and_snapshot_source',
    note: `Merged from ${sourceName || 'source'}`,
    needsWarning: true,
  };
}

module.exports = {
  DEFAULT_ALLOWED_EXTENSIONS,
  MAX_BODY_BYTES,
  MAX_RESOURCES,
  getAllowedExtensions,
  getMaxFileBytes,
  sanitizeMaterialHtml,
  computeHasContent,
  validateLink,
  validateResource,
  canEdit,
  checkVersionConflict,
  planContentMerge,
};
