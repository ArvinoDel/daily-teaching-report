'use strict';
/**
 * services/userAccountService.js
 *
 * Pure business logic and database helpers for user account status lifecycle,
 * registration throttling/guards, permission checks, and per-request session checks.
 */

const ACCOUNT_STATUSES = Object.freeze({
  PENDING: 'pending',
  ACTIVE: 'active',
  REJECTED: 'rejected',
  SUSPENDED: 'suspended',
});

const NON_ACTIVE_STATUSES = Object.freeze([
  ACCOUNT_STATUSES.PENDING,
  ACCOUNT_STATUSES.REJECTED,
  ACCOUNT_STATUSES.SUSPENDED,
]);

/**
 * Evaluates whether a user account is allowed to log in.
 * Note: Existing documents lacking the accountStatus field are treated as active.
 *
 * @param {Object|null} user
 * @returns {{ ok: boolean, code: 'active'|'pending'|'rejected'|'suspended'|'not_found', message: string }}
 */
function canLogin(user) {
  if (!user) {
    return { ok: false, code: 'not_found', message: 'Invalid username or password.' };
  }

  const status = user.accountStatus;
  if (status === ACCOUNT_STATUSES.PENDING) {
    return {
      ok: false,
      code: ACCOUNT_STATUSES.PENDING,
      message: 'Your account is waiting for approval.',
    };
  }

  if (status === ACCOUNT_STATUSES.REJECTED) {
    return {
      ok: false,
      code: ACCOUNT_STATUSES.REJECTED,
      message: 'Your registration was not approved. Please contact the admin.',
    };
  }

  if (status === ACCOUNT_STATUSES.SUSPENDED) {
    return {
      ok: false,
      code: ACCOUNT_STATUSES.SUSPENDED,
      message: 'This account is suspended. Please contact the admin.',
    };
  }

  // Active or missing field (defaults to active)
  return { ok: true, code: ACCOUNT_STATUSES.ACTIVE, message: '' };
}

/**
 * Returns a MongoDB/Mingo filter that excludes non-active accounts.
 * Treats documents without an accountStatus field as active.
 *
 * @param {Object} [extra={}] Additional query constraints (e.g. { role: 'teacher' })
 * @returns {Object}
 */
function activeUserFilter(extra = {}) {
  return {
    ...extra,
    accountStatus: { $nin: Array.from(NON_ACTIVE_STATUSES) },
  };
}

/**
 * Determines whether actor has permission to moderate target account.
 * Rules:
 *   - Nobody moderates themselves.
 *   - Teachers cannot moderate anyone.
 *   - Admins can only moderate teachers.
 *   - Superadmins can moderate teachers and admins.
 *   - The last remaining superadmin can NEVER be suspended or deleted.
 *
 * @param {Object} actor - The acting user ({ _id, role })
 * @param {Object} target - The target user ({ _id, role, accountStatus })
 * @param {Object} [options={}]
 * @param {number} [options.superadminCount] - Total number of superadmins in the system
 * @returns {{ ok: boolean, reason: string|null }}
 */
function isModeratable(actor, target, options = {}) {
  if (!actor || !target) {
    return { ok: false, reason: 'Invalid actor or target user.' };
  }

  const actorId = String(actor._id || actor.id || '');
  const targetId = String(target._id || target.id || '');

  if (actorId && targetId && actorId === targetId) {
    return { ok: false, reason: 'Cannot moderate your own account.' };
  }

  if (actor.role === 'teacher') {
    return { ok: false, reason: 'Teachers cannot moderate accounts.' };
  }

  if (actor.role === 'admin' && target.role !== 'teacher') {
    return { ok: false, reason: 'Admins can only moderate teachers.' };
  }

  // Last remaining superadmin protection
  if (target.role === 'superadmin') {
    const count = typeof options.superadminCount === 'number' ? options.superadminCount : null;
    if (count !== null && count <= 1) {
      return { ok: false, reason: 'Cannot moderate the last remaining superadmin.' };
    }
  }

  return { ok: true, reason: null };
}

/**
 * Pure decision maker for registration requests.
 * Evaluates mode ('approval' vs 'closed') and pending queue cap (50).
 *
 * @param {Object} params
 * @param {string} [params.mode='approval']
 * @param {number} [params.pendingCount=0]
 * @returns {{ allowed: boolean, code: 'open'|'closed'|'cap_exceeded', error: string|null }}
 */
function decideRegistration({ mode = 'approval', pendingCount = 0 } = {}) {
  const normalizedMode = String(mode || 'approval').toLowerCase().trim();
  if (normalizedMode === 'closed') {
    return {
      allowed: false,
      code: 'closed',
      error: 'Registration is closed.',
    };
  }

  if (typeof pendingCount === 'number' && pendingCount >= 50) {
    return {
      allowed: false,
      code: 'cap_exceeded',
      error: 'Registration is temporarily at capacity. Please try again later.',
    };
  }

  return {
    allowed: true,
    code: 'open',
    error: null,
  };
}

/**
 * Checks whether an incoming Express request expects JSON or is an XHR/fetch.
 *
 * @param {Object} req
 * @returns {boolean}
 */
function isJsonRequest(req) {
  if (!req) return false;
  if (req.xhr) return true;
  const headers = req.headers || {};
  if (headers['x-requested-with'] === 'XMLHttpRequest') return true;
  const accept = headers.accept || '';
  if (accept.includes('application/json')) return true;
  const contentType = headers['content-type'] || '';
  if (contentType.includes('application/json')) return true;
  return false;
}

/**
 * Pure helper for per-request session validation.
 * Checks whether session user document exists and can log in.
 *
 * @param {Object|null} user - Fresh user document from database
 * @param {Object} req - Express request object
 * @returns {{ ok: boolean, code: string, status?: number, redirect?: string, flash?: string, json?: Object }}
 */
function checkSessionUser(user, req) {
  if (!user) {
    // User was deleted
    if (isJsonRequest(req)) {
      return {
        ok: false,
        code: 'deleted',
        status: 401,
        json: { ok: false, message: 'Session ended' },
      };
    }
    return {
      ok: false,
      code: 'deleted',
      status: 302,
      redirect: '/auth/login',
      flash: 'Session ended',
    };
  }

  const loginCheck = canLogin(user);
  if (!loginCheck.ok) {
    if (isJsonRequest(req)) {
      return {
        ok: false,
        code: loginCheck.code,
        status: 401,
        json: { ok: false, message: 'Session ended' },
      };
    }
    return {
      ok: false,
      code: loginCheck.code,
      status: 302,
      redirect: '/auth/login',
      flash: loginCheck.message,
    };
  }

  return { ok: true, code: 'active' };
}

module.exports = {
  ACCOUNT_STATUSES,
  NON_ACTIVE_STATUSES,
  canLogin,
  activeUserFilter,
  isModeratable,
  decideRegistration,
  isJsonRequest,
  checkSessionUser,
};

