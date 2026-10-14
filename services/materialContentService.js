'use strict';

/**
 * services/materialContentService.js
 *
 * Core service & helpers for Material Content:
 * - HTML sanitization (xss with strict allowlist, escaping unknown tags)
 * - Safe JSON rendering for views
 * - Resource validation (links & files)
 * - Permission checking (admin vs teacher vs lock)
 * - Revision management & versioning
 * - Content merge planning
 */

const xss = require('xss');

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
 *  1. Sanitization (Whitelist-based via xss, Pure CommonJS)
 * ───────────────────────────────────────────────────────────────────── */
function decodeHtmlEntities(str) {
  let decoded = str;
  for (let i = 0; i < 3; i++) {
    const next = decoded
      .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => {
        try { return String.fromCharCode(parseInt(hex, 16)); } catch (_) { return ''; }
      })
      .replace(/&#([0-9]+);?/gi, (_, dec) => {
        try { return String.fromCharCode(parseInt(dec, 10)); } catch (_) { return ''; }
      })
      .replace(/&colon;?/gi, ':')
      .replace(/&tab;?/gi, '')
      .replace(/&newline;?/gi, '');
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function isSafeHref(val) {
  if (!val || typeof val !== 'string') return false;
  const decoded = decodeHtmlEntities(val);
  const normalized = decoded.replace(/[\x00-\x20\x7f-\x9f\s]/g, '').toLowerCase();

  // Reject protocol-relative links (//evil.com or \\evil.com)
  if (normalized.startsWith('//') || normalized.startsWith('\\\\')) {
    return false;
  }

  // Must have a scheme starting with http:, https:, or mailto:
  const colonIndex = normalized.indexOf(':');
  if (colonIndex === -1) {
    return false;
  }
  const scheme = normalized.slice(0, colonIndex + 1);
  if (scheme === 'http:' || scheme === 'https:' || scheme === 'mailto:') {
    return true;
  }
  return false;
}

const materialHtmlFilter = new xss.FilterXSS({
  whiteList: {
    h1: [], h2: [], h3: [], h4: [],
    p: [], br: [],
    strong: [], em: [], u: [], s: [],
    ul: [], ol: [], li: [],
    blockquote: [],
    a: ['href'],
    code: [], pre: [],
    hr: [],
  },
  stripIgnoreTagBody: ['script', 'style', 'iframe', 'object', 'embed'],
  onIgnoreTag: (tag, html, options) => {
    // Non-whitelisted tags are escaped as text (never silently removed)
    return xss.escapeHtml(html);
  },
  onTagAttr: (tag, name, value, isWhiteAttr) => {
    if (tag === 'a' && name === 'href') {
      if (!isSafeHref(value)) {
        return '';
      }
      return `href="${xss.escapeAttrValue(value)}" rel="noopener noreferrer" target="_blank"`;
    }
  },
});

/**
 * Normalizes Quill 2 internal list markup to standard HTML lists before sanitization.
 * In Quill 2, all lists are internally represented as <ol><li data-list="bullet|ordered|..."><span class="ql-ui"...></span>text</li></ol>.
 *
 * NOTE: String/regex transformation is acceptable ONLY because the resulting HTML
 * strictly passes through the whitelist-based xss filter immediately afterwards.
 * Non-whitelisted tags and attributes are always escaped or stripped by xss.
 */
function normalizeQuillLists(html) {
  if (!html || typeof html !== 'string') return '';

  // 1. Remove Quill UI spans (<span class="ql-ui"...>...</span>)
  let clean = html.replace(/<span\b[^>]*class=["'][^"']*\bql-ui\b[^"']*["'][^>]*>[\s\S]*?<\/span>/gi, '');

  // 2. Convert <ol> elements containing data-list attributes into appropriate <ul> or <ol> lists
  clean = clean.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (match, listContent) => {
    if (!/data-list\s*=/i.test(listContent)) {
      return match;
    }

    const liRegex = /<li\b([^>]*)>([\s\S]*?)<\/li>/gi;
    let liMatch;
    const items = [];

    while ((liMatch = liRegex.exec(listContent)) !== null) {
      const attrs = liMatch[1];
      const inner = liMatch[2];
      const dataListMatch = attrs.match(/data-list\s*=\s*(["'])(.*?)\1/i) || attrs.match(/data-list\s*=\s*([^\s>]+)/i);
      const listType = dataListMatch ? dataListMatch[2].toLowerCase() : 'ordered';
      const cleanAttrs = attrs.replace(/\s*data-list\s*=\s*(["']).*?\1/gi, '').replace(/\s*data-list\s*=\s*[^\s>]+/gi, '').trim();
      const openTag = cleanAttrs ? `<li ${cleanAttrs}>` : '<li>';
      items.push({
        type: (listType === 'bullet' || listType === 'checked' || listType === 'unchecked') ? 'bullet' : 'ordered',
        html: `${openTag}${inner}</li>`,
      });
    }

    if (items.length === 0) {
      return match;
    }

    const groups = [];
    let currentGroup = null;

    for (const item of items) {
      if (!currentGroup || currentGroup.type !== item.type) {
        currentGroup = { type: item.type, items: [item.html] };
        groups.push(currentGroup);
      } else {
        currentGroup.items.push(item.html);
      }
    }

    return groups.map(g => {
      const tag = g.type === 'bullet' ? 'ul' : 'ol';
      return `<${tag}>${g.items.join('')}</${tag}>`;
    }).join('');
  });

  return clean;
}

function sanitizeMaterialHtml(dirtyHtml) {
  if (!dirtyHtml || typeof dirtyHtml !== 'string') return '';
  const normalized = normalizeQuillLists(dirtyHtml);
  return materialHtmlFilter.process(normalized);
}

function renderMaterialBody(html) {
  if (!html || typeof html !== 'string') return '';
  return sanitizeMaterialHtml(html);
}

function safeJson(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
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
  renderMaterialBody,
  safeJson,
  computeHasContent,
  validateLink,
  validateResource,
  canEdit,
  checkVersionConflict,
  planContentMerge,
  normalizeQuillLists,
};
