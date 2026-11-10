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
 * Pure decision maker for account moderation status transitions.
 *
 * Rules:
 *   - Applies isModeratable(actor, target, { superadminCount }) first.
 *   - Nobody moderates themselves.
 *   - Teachers cannot moderate anyone.
 *   - Admins can only moderate teachers.
 *   - Superadmins can moderate teachers and admins.
 *   - The last remaining superadmin can NEVER be moderated.
 *   - Admin and superadmin targets can only be suspended/reactivated by a superadmin and never rejected or approved.
 *   - Allowed source statuses:
 *       approve: from 'pending' or 'rejected'
 *       reject: from 'pending' only
 *       suspend: from 'active' only (reason required)
 *       reactivate: from 'suspended' only
 *   - Treats missing target.accountStatus as 'active'.
 *
 * @param {Object} actor - The acting user ({ _id, role })
 * @param {Object} target - The target user ({ _id, role, accountStatus })
 * @param {'approve'|'reject'|'suspend'|'reactivate'} action
 * @param {Object} [options={}]
 * @param {number} [options.superadminCount]
 * @param {string} [options.reason]
 * @returns {{ ok: boolean, status: number, code: string, targetStatus?: string, message: string }}
 */
function planStatusChange(actor, target, action, options = {}) {
  if (!actor || !target) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_user',
      message: 'Invalid actor or target user.',
    };
  }

  // 1. Role-based moderation authority check
  const modCheck = isModeratable(actor, target, options);
  if (!modCheck.ok) {
    return {
      ok: false,
      status: 403,
      code: 'forbidden',
      message: modCheck.reason || 'You do not have permission to moderate this user.',
    };
  }

  // 2. Admin & superadmin targets cannot be approved or rejected
  if (target.role === 'admin' || target.role === 'superadmin') {
    if (action === 'approve' || action === 'reject') {
      return {
        ok: false,
        status: 403,
        code: 'forbidden',
        message: 'Admin and superadmin accounts cannot be approved or rejected.',
      };
    }
  }

  // Treat missing accountStatus as 'active'
  const currentStatus = target.accountStatus || ACCOUNT_STATUSES.ACTIVE;

  // 3. Action-specific validation and transition planning
  switch (action) {
    case 'approve': {
      if (currentStatus !== ACCOUNT_STATUSES.PENDING && currentStatus !== ACCOUNT_STATUSES.REJECTED) {
        return {
          ok: false,
          status: 400,
          code: 'invalid_status',
          message: `Cannot approve an account with '${currentStatus}' status. Only pending or rejected accounts can be approved.`,
        };
      }
      return {
        ok: true,
        status: 200,
        code: ACCOUNT_STATUSES.ACTIVE,
        targetStatus: ACCOUNT_STATUSES.ACTIVE,
        message: 'Account approved.',
      };
    }

    case 'reject': {
      if (currentStatus !== ACCOUNT_STATUSES.PENDING) {
        return {
          ok: false,
          status: 400,
          code: 'invalid_status',
          message: `Cannot reject an account with '${currentStatus}' status. Only pending accounts can be rejected.`,
        };
      }
      return {
        ok: true,
        status: 200,
        code: ACCOUNT_STATUSES.REJECTED,
        targetStatus: ACCOUNT_STATUSES.REJECTED,
        message: 'Account rejected.',
      };
    }

    case 'suspend': {
      const reason = typeof options.reason === 'string' ? options.reason.trim() : '';
      if (!reason) {
        return {
          ok: false,
          status: 400,
          code: 'reason_required',
          message: 'Suspension reason is required.',
        };
      }
      if (currentStatus !== ACCOUNT_STATUSES.ACTIVE) {
        return {
          ok: false,
          status: 400,
          code: 'invalid_status',
          message: `Cannot suspend an account with '${currentStatus}' status. Only active accounts can be suspended.`,
        };
      }
      return {
        ok: true,
        status: 200,
        code: ACCOUNT_STATUSES.SUSPENDED,
        targetStatus: ACCOUNT_STATUSES.SUSPENDED,
        message: 'Account suspended.',
      };
    }

    case 'reactivate': {
      if (currentStatus !== ACCOUNT_STATUSES.SUSPENDED) {
        return {
          ok: false,
          status: 400,
          code: 'invalid_status',
          message: `Cannot reactivate an account with '${currentStatus}' status. Only suspended accounts can be reactivated.`,
        };
      }
      return {
        ok: true,
        status: 200,
        code: ACCOUNT_STATUSES.ACTIVE,
        targetStatus: ACCOUNT_STATUSES.ACTIVE,
        message: 'Account reactivated.',
      };
    }

    default:
      return {
        ok: false,
        status: 400,
        code: 'invalid_action',
        message: `Unknown action '${action}'.`,
      };
  }
}

/**
 * Returns a MongoDB/Mingo filter for atomic account status changes.
 * Matches expected source status(es).
 * If 'active' is one of the allowed statuses, it also matches documents where
 * accountStatus is missing (legacy accounts) or null.
 *
 * @param {string|Array<string>} [id] - Single user ID or array of user IDs
 * @param {string|Array<string>} fromStatuses - Allowed current status(es)
 * @param {Object} [extra={}] - Additional query constraints
 * @returns {Object}
 */
function buildStatusChangeFilter(id, fromStatuses, extra = {}) {
  const statuses = Array.isArray(fromStatuses) ? fromStatuses : [fromStatuses];
  const includesActive = statuses.includes(ACCOUNT_STATUSES.ACTIVE);

  const filter = { ...extra };
  if (id !== undefined && id !== null) {
    filter._id = Array.isArray(id) ? { $in: id } : id;
  }

  if (includesActive) {
    filter.$or = [
      { accountStatus: { $in: statuses } },
      { accountStatus: { $exists: false } },
      { accountStatus: null },
    ];
  } else {
    filter.accountStatus = statuses.length === 1 ? statuses[0] : { $in: statuses };
  }

  return filter;
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
  planStatusChange,
  buildStatusChangeFilter,
  decideRegistration,
  isJsonRequest,
  checkSessionUser,
};

