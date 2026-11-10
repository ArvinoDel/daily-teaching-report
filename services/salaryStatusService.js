'use strict';

/**
 * services/salaryStatusService.js
 *
 * Pure transition logic, generation action planning, date validation
 * in Asia/Jakarta timezone, and atomic transition filter builders
 * for salary slips.
 */

const SALARY_STATUSES = Object.freeze({
  DRAFT: 'draft',
  PUBLISHED: 'published',
  PAID: 'paid',
});

/**
 * Allowed status transitions matrix:
 *   draft     -> published (publish)
 *   published -> draft     (retract)
 *   published -> paid      (mark paid)
 *   paid      -> published (reopen payment)
 *
 * Everything else is refused.
 *
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
function canTransition(from, to) {
  if (!from || !to || from === to) return false;

  const valid = new Set(Object.values(SALARY_STATUSES));
  if (!valid.has(from) || !valid.has(to)) return false;

  if (from === SALARY_STATUSES.DRAFT && to === SALARY_STATUSES.PUBLISHED) return true;
  if (from === SALARY_STATUSES.PUBLISHED && to === SALARY_STATUSES.DRAFT) return true;
  if (from === SALARY_STATUSES.PUBLISHED && to === SALARY_STATUSES.PAID) return true;
  if (from === SALARY_STATUSES.PAID && to === SALARY_STATUSES.PUBLISHED) return true;

  return false;
}

/**
 * Plans the generation action for a teacher's salary record in a given period.
 *
 * Rules:
 *  - If no slip exists yet: 'create'
 *  - If slip exists and status is not 'draft': 'skip' (never overwrite published or paid slips)
 *  - If slip exists and status is 'draft':
 *      - preserveEdits === true  -> 'update_preserve'
 *      - preserveEdits === false -> 'overwrite_draft'
 *
 * @param {Object|null} existingSlip
 * @param {boolean} [preserveEdits=true]
 * @returns {'create' | 'update_preserve' | 'overwrite_draft' | 'skip'}
 */
function planGenerationAction(existingSlip, preserveEdits = true) {
  if (!existingSlip) {
    return 'create';
  }

  const status = existingSlip.status || SALARY_STATUSES.DRAFT;
  if (status !== SALARY_STATUSES.DRAFT) {
    return 'skip';
  }

  return preserveEdits ? 'update_preserve' : 'overwrite_draft';
}

/**
 * Formats a Date object into YYYY-MM-DD in Asia/Jakarta timezone.
 *
 * @param {Date|string|number} [date=new Date()]
 * @returns {string}
 */
function getJakartaDateString(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(d); // YYYY-MM-DD
}

/**
 * Converts a YYYY-MM-DD string into a Date representing 12:00:00 (noon) Asia/Jakarta.
 * Noon avoids midnight date shift across time zones.
 *
 * @param {string} dateStr YYYY-MM-DD
 * @returns {Date|null}
 */
function getJakartaNoonDate(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const isoWithOffset = `${dateStr}T12:00:00+07:00`;
  const d = new Date(isoWithOffset);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Formats a date into human-friendly string (e.g. "6 Nov 2026") in Asia/Jakarta.
 *
 * @param {Date|string} date
 * @returns {string}
 */
function formatDisplayDate(date) {
  if (!date) return '—';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '—';

  return d.toLocaleDateString('en-GB', {
    timeZone: 'Asia/Jakarta',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Validates paidAt date input against business rules:
 *   1. Must be valid YYYY-MM-DD.
 *   2. Cannot be more than 7 days in the future (relative to today in Asia/Jakarta).
 *   3. If publishedAt is provided, cannot be before publishedAt date.
 *
 * @param {string} paidAtStr
 * @param {Date|string|null} [publishedAt=null]
 * @param {Date} [now=new Date()]
 * @returns {{ ok: boolean, error?: string, noonDate?: Date }}
 */
function validatePaidDate(paidAtStr, publishedAt = null, now = new Date()) {
  if (!paidAtStr || !/^\d{4}-\d{2}-\d{2}$/.test(paidAtStr)) {
    return { ok: false, error: 'Payment date must be in YYYY-MM-DD format.' };
  }

  const noonDate = getJakartaNoonDate(paidAtStr);
  if (!noonDate) {
    return { ok: false, error: 'Invalid payment date.' };
  }

  const todayStr = getJakartaDateString(now);
  const todayNoon = getJakartaNoonDate(todayStr);

  // Maximum allowed is today + 7 days
  const maxFutureTime = todayNoon.getTime() + 7 * 24 * 60 * 60 * 1000;
  if (noonDate.getTime() > maxFutureTime) {
    return { ok: false, error: 'Payment date cannot be more than 7 days in the future.' };
  }

  if (publishedAt) {
    const publishedStr = getJakartaDateString(publishedAt);
    if (paidAtStr < publishedStr) {
      return { ok: false, error: `Payment date (${paidAtStr}) cannot be before the published date (${publishedStr}).` };
    }
  }

  return { ok: true, noonDate };
}

/**
 * Plans the "mark as paid" action for a list of candidate slips.
 *
 * @param {Object} params
 * @param {Array<Object>} params.slips
 * @param {string} params.paidAtStr
 * @param {string} [params.note='']
 * @param {Date} [params.now=new Date()]
 * @returns {{
 *   validDate: boolean,
 *   dateError?: string,
 *   paidAtNoonDate?: Date,
 *   eligible: Array<Object>,
 *   skipped: Array<{ id: string, name: string, reason: string, status: string }>
 * }}
 */
function planMarkPaid({ slips = [], paidAtStr, note = '', now = new Date() }) {
  const dateCheck = validatePaidDate(paidAtStr, null, now);
  if (!dateCheck.ok) {
    return {
      validDate: false,
      dateError: dateCheck.error,
      eligible: [],
      skipped: [],
    };
  }

  const eligible = [];
  const skipped = [];

  for (const s of slips) {
    const id = String(s._id || s.id);
    const name = s.teacher?.displayName || s.teacherName || 'Unknown Teacher';
    const status = s.status || SALARY_STATUSES.DRAFT;

    if (status === SALARY_STATUSES.PAID) {
      skipped.push({ id, name, reason: 'already_paid', status });
      continue;
    }

    if (status !== SALARY_STATUSES.PUBLISHED) {
      skipped.push({ id, name, reason: 'not_published', status });
      continue;
    }

    // Slip is published: check date against this slip's publishedAt
    const slipDateCheck = validatePaidDate(paidAtStr, s.publishedAt, now);
    if (!slipDateCheck.ok) {
      skipped.push({ id, name, reason: 'before_published_date', status });
      continue;
    }

    eligible.push(s);
  }

  return {
    validDate: true,
    paidAtNoonDate: dateCheck.noonDate,
    eligible,
    skipped,
  };
}

/**
 * Builds atomic database filters for status transitions.
 */
function buildPublishFilter(idOrIds, extra = {}) {
  const filter = {
    status: SALARY_STATUSES.DRAFT,
    ...extra,
  };
  if (idOrIds !== undefined && idOrIds !== null) {
    filter._id = Array.isArray(idOrIds) ? { $in: idOrIds } : idOrIds;
  }
  return filter;
}

function buildRetractFilter(id, extra = {}) {
  return {
    _id: id,
    status: SALARY_STATUSES.PUBLISHED,
    ...extra,
  };
}

function buildMarkPaidFilter(idOrIds, extra = {}) {
  const isArray = Array.isArray(idOrIds);
  return {
    _id: isArray ? { $in: idOrIds } : idOrIds,
    status: SALARY_STATUSES.PUBLISHED,
    ...extra,
  };
}

function buildReopenFilter(id, extra = {}) {
  return {
    _id: id,
    status: SALARY_STATUSES.PAID,
    ...extra,
  };
}

function buildDraftEditFilter(id, extra = {}) {
  return {
    _id: id,
    status: SALARY_STATUSES.DRAFT,
    ...extra,
  };
}

module.exports = {
  SALARY_STATUSES,
  canTransition,
  planGenerationAction,
  getJakartaDateString,
  getJakartaNoonDate,
  formatDisplayDate,
  validatePaidDate,
  planMarkPaid,
  buildPublishFilter,
  buildRetractFilter,
  buildMarkPaidFilter,
  buildReopenFilter,
  buildDraftEditFilter,
};

