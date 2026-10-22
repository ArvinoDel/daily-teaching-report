'use strict';

/**
 * Parses raw group input (comma-separated string or array of strings) into a clean list:
 * - Trims whitespace
 * - Drops empty strings
 * - De-duplicates case-insensitively while preserving original casing and order
 *
 * @param {string|string[]} raw
 * @returns {string[]}
 */
function parseGroupList(raw) {
  if (!raw) return [];

  let items = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === 'string') {
    items = raw.split(',');
  } else {
    items = [String(raw)];
  }

  const result = [];
  const seen = new Set();

  for (const item of items) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      result.push(trimmed);
    }
  }

  return result;
}

/**
 * Builds the derived class_name for competition reports:
 * - Joins groups with ", "
 * - If result exceeds max characters, formats as "<first group> +N more" (N = remaining groups),
 *   shortening the first name with an ellipsis so the whole label is at most max characters.
 * - Never exceeds max.
 *
 * @param {string[]} groups
 * @param {number} [max=50]
 * @returns {string}
 */
function buildCompetitionClassName(groups, max = 50) {
  if (!groups || groups.length === 0) return '';

  const joined = groups.join(', ');
  if (joined.length <= max) return joined;

  const remaining = groups.length - 1;
  if (remaining <= 0) {
    if (groups[0].length <= max) return groups[0];
    const keep = Math.max(0, max - 3);
    const shortened = groups[0].slice(0, keep) + '...';
    return shortened.length <= max ? shortened : shortened.slice(0, max);
  }

  const suffix = ` +${remaining} more`;
  const available = max - suffix.length;

  let first = groups[0] || '';
  if (first.length > available) {
    const keep = Math.max(0, available - 3);
    first = first.slice(0, keep) + '...';
  }

  let result = first + suffix;
  if (result.length > max) {
    result = result.slice(0, max);
  }
  return result;
}

/**
 * Validates competition reports. Returns error messages if invalid.
 * Returns empty array for non-competition session types.
 *
 * @param {object} param
 * @param {string} [param.session_type]
 * @param {string[]} [param.competition_groups]
 * @returns {string[]}
 */
function validateCompetition({ session_type, competition_groups } = {}) {
  if (session_type !== 'competition') return [];

  const errors = [];
  const groups = competition_groups || [];

  if (groups.length < 2) {
    errors.push('Select at least 2 groups for a competition.');
  }
  if (groups.length > 10) {
    errors.push('A competition can have at most 10 groups.');
  }
  if (groups.some(g => typeof g === 'string' && g.length > 50)) {
    errors.push('Group name max 50 characters.');
  }

  return errors;
}

/**
 * Normalizes class_name and competition_groups based on session_type:
 * - For competition: derives class_name using buildCompetitionClassName(groups) and ignores
 *   any client-sent class_name. Returns { class_name, competition_groups: groups }.
 * - For group/private: returns single string class_name (if an array arrives, uses last non-empty string)
 *   and empty competition_groups [].
 *
 * @param {object} param
 * @param {string} [param.session_type]
 * @param {string|string[]} [param.class_name]
 * @param {string|string[]} [param.competition_groups]
 * @returns {{ class_name: string, competition_groups: string[] }}
 */
function normalizeClassFields({ session_type, class_name, competition_groups } = {}) {
  if (session_type === 'competition') {
    const groups = parseGroupList(competition_groups);
    return {
      class_name: buildCompetitionClassName(groups),
      competition_groups: groups,
    };
  }

  let resolvedClassName = '';
  if (Array.isArray(class_name)) {
    const nonEmpties = class_name.filter(s => typeof s === 'string' && s.trim().length > 0);
    resolvedClassName = nonEmpties.length > 0 ? nonEmpties[nonEmpties.length - 1].trim() : '';
  } else if (typeof class_name === 'string') {
    resolvedClassName = class_name.trim();
  } else if (class_name !== null && class_name !== undefined) {
    resolvedClassName = String(class_name).trim();
  }

  return {
    class_name: resolvedClassName,
    competition_groups: [],
  };
}

module.exports = {
  parseGroupList,
  buildCompetitionClassName,
  validateCompetition,
  normalizeClassFields,
};
