'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { Query } = require('mingo');

const {
  ACCOUNT_STATUSES,
  canLogin,
  activeUserFilter,
  isModeratable,
  planStatusChange,
  buildStatusChangeFilter,
  decideRegistration,
  checkSessionUser,
} = require('../services/userAccountService');

describe('userAccountService - canLogin()', () => {
  test('returns not_found for null or undefined user', () => {
    assert.deepEqual(canLogin(null), {
      ok: false,
      code: 'not_found',
      message: 'Invalid username or password.',
    });
    assert.deepEqual(canLogin(undefined), {
      ok: false,
      code: 'not_found',
      message: 'Invalid username or password.',
    });
  });

  test('returns ok for active user', () => {
    const res = canLogin({ username: 'alice', accountStatus: 'active' });
    assert.equal(res.ok, true);
    assert.equal(res.code, 'active');
  });

  test('returns ok for legacy user document missing accountStatus field', () => {
    const res = canLogin({ username: 'legacy_teacher', role: 'teacher' });
    assert.equal(res.ok, true);
    assert.equal(res.code, 'active');
  });

  test('returns pending for pending account', () => {
    const res = canLogin({ username: 'bob', accountStatus: 'pending' });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'pending');
    assert.equal(res.message, 'Your account is waiting for approval.');
  });

  test('returns rejected for rejected account', () => {
    const res = canLogin({ username: 'carol', accountStatus: 'rejected' });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'rejected');
    assert.equal(res.message, 'Your registration was not approved. Please contact the admin.');
  });

  test('returns suspended for suspended account', () => {
    const res = canLogin({ username: 'dave', accountStatus: 'suspended' });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'suspended');
    assert.equal(res.message, 'This account is suspended. Please contact the admin.');
  });
});

describe('userAccountService - activeUserFilter() & Mingo Evaluation', () => {
  test('generates expected MongoDB query object', () => {
    const filter = activeUserFilter({ role: 'teacher' });
    assert.deepEqual(filter, {
      role: 'teacher',
      accountStatus: { $nin: ['pending', 'rejected', 'suspended'] },
    });
  });

  test('mingo evaluation matches legacy (missing status) and explicit active documents', () => {
    const dataset = [
      { _id: 1, username: 'legacy', role: 'teacher' }, // missing accountStatus
      { _id: 2, username: 'active_explicit', role: 'teacher', accountStatus: 'active' },
      { _id: 3, username: 'pending_user', role: 'teacher', accountStatus: 'pending' },
      { _id: 4, username: 'suspended_user', role: 'teacher', accountStatus: 'suspended' },
      { _id: 5, username: 'rejected_user', role: 'teacher', accountStatus: 'rejected' },
      { _id: 6, username: 'admin_user', role: 'admin', accountStatus: 'active' },
    ];

    const filter = activeUserFilter({ role: 'teacher' });
    const query = new Query(filter);
    const cursor = query.find(dataset);
    const matched = cursor.all();

    assert.equal(matched.length, 2);
    assert.deepEqual(matched.map(u => u.username).sort(), ['active_explicit', 'legacy']);
  });
});

describe('userAccountService - decideRegistration()', () => {
  test('allows registration when mode is approval and queue is below 50', () => {
    const res1 = decideRegistration({ mode: 'approval', pendingCount: 0 });
    assert.deepEqual(res1, { allowed: true, code: 'open', error: null });

    const res2 = decideRegistration({ mode: 'approval', pendingCount: 49 });
    assert.deepEqual(res2, { allowed: true, code: 'open', error: null });
  });

  test('blocks registration when pending count reaches 50', () => {
    const res = decideRegistration({ mode: 'approval', pendingCount: 50 });
    assert.equal(res.allowed, false);
    assert.equal(res.code, 'cap_exceeded');
    assert.match(res.error, /capacity|pending/i);
  });

  test('blocks registration when mode is closed regardless of count', () => {
    const res = decideRegistration({ mode: 'closed', pendingCount: 0 });
    assert.equal(res.allowed, false);
    assert.equal(res.code, 'closed');
    assert.match(res.error, /registration is closed/i);
  });
});

describe('userAccountService - isModeratable()', () => {
  test('nobody moderates themselves', () => {
    const actor = { _id: 'u1', role: 'superadmin' };
    const target = { _id: 'u1', role: 'superadmin' };
    const res = isModeratable(actor, target);
    assert.equal(res.ok, false);
    assert.match(res.reason, /own account/i);
  });

  test('teachers cannot moderate anyone', () => {
    const actor = { _id: 'u1', role: 'teacher' };
    const target = { _id: 'u2', role: 'teacher' };
    const res = isModeratable(actor, target);
    assert.equal(res.ok, false);
    assert.match(res.reason, /teachers cannot/i);
  });

  test('admins can only moderate teachers', () => {
    const admin = { _id: 'u1', role: 'admin' };
    const teacher = { _id: 'u2', role: 'teacher' };
    const otherAdmin = { _id: 'u3', role: 'admin' };
    const superadmin = { _id: 'u4', role: 'superadmin' };

    assert.equal(isModeratable(admin, teacher).ok, true);
    assert.equal(isModeratable(admin, otherAdmin).ok, false);
    assert.equal(isModeratable(admin, superadmin).ok, false);
  });

  test('superadmins can moderate teachers and admins', () => {
    const sa = { _id: 'u1', role: 'superadmin' };
    const teacher = { _id: 'u2', role: 'teacher' };
    const admin = { _id: 'u3', role: 'admin' };

    assert.equal(isModeratable(sa, teacher).ok, true);
    assert.equal(isModeratable(sa, admin).ok, true);
  });

  test('superadmins can moderate other superadmins only if superadminCount > 1', () => {
    const sa1 = { _id: 'u1', role: 'superadmin' };
    const sa2 = { _id: 'u2', role: 'superadmin' };

    // With multiple superadmins: allowed
    assert.equal(isModeratable(sa1, sa2, { superadminCount: 2 }).ok, true);

    // If target is the last remaining superadmin: denied
    const lastCheck = isModeratable(sa1, sa2, { superadminCount: 1 });
    assert.equal(lastCheck.ok, false);
    assert.match(lastCheck.reason, /last remaining superadmin/i);
  });
});

describe('userAccountService - checkSessionUser()', () => {
  function makeReq(isJson = false) {
    return {
      headers: isJson ? { accept: 'application/json' } : {},
      xhr: isJson,
      session: {
        flash: null,
      },
    };
  }

  test('allows active user through', () => {
    const req = makeReq(false);
    const user = { username: 'test', accountStatus: 'active' };
    const decision = checkSessionUser(user, req);
    assert.equal(decision.ok, true);
    assert.equal(decision.code, 'active');
  });

  test('allows legacy user without accountStatus through', () => {
    const req = makeReq(false);
    const user = { username: 'legacy_user' };
    const decision = checkSessionUser(user, req);
    assert.equal(decision.ok, true);
    assert.equal(decision.code, 'active');
  });

  test('flags pending user with 302 redirect for page request', () => {
    const req = makeReq(false);
    const user = { username: 'pending_user', accountStatus: 'pending' };
    const decision = checkSessionUser(user, req);

    assert.equal(decision.ok, false);
    assert.equal(decision.status, 302);
    assert.equal(decision.redirect, '/auth/login');
    assert.match(decision.flash, /waiting for approval/i);
  });

  test('flags suspended user with 401 JSON for API request', () => {
    const req = makeReq(true);
    const user = { username: 'suspended_user', accountStatus: 'suspended' };
    const decision = checkSessionUser(user, req);

    assert.equal(decision.ok, false);
    assert.equal(decision.status, 401);
    assert.equal(decision.json.ok, false);
    assert.match(decision.json.message, /session ended/i);
  });

  test('flags deleted user with 401 JSON for API request', () => {
    const req = makeReq(true);
    const decision = checkSessionUser(null, req);

    assert.equal(decision.ok, false);
    assert.equal(decision.status, 401);
    assert.equal(decision.json.ok, false);
  });
});

describe('EJS XSS Escaping for Pending & User Views', () => {
  test('views/auth/pending.ejs escapes malicious HTML in displayName', async () => {
    const templatePath = path.resolve(__dirname, '../views/auth/pending.ejs');
    const maliciousName = '<script>alert("xss")</script>';

    const html = await ejs.renderFile(templatePath, {
      displayName: maliciousName,
      title: 'Registration Pending',
    });

    // Must NOT contain raw unescaped script tag
    assert.ok(!html.includes('<script>alert("xss")</script>'));
    // Must contain escaped representation
    assert.ok(html.includes('&lt;script&gt;alert(&#34;xss&#34;)&lt;/script&gt;') || html.includes('&lt;script&gt;'));
  });
});

describe('userAccountService - planStatusChange() Matrix', () => {
  const roles = ['teacher', 'admin', 'superadmin'];
  const actions = ['approve', 'reject', 'suspend', 'reactivate'];
  const statuses = [undefined, 'active', 'pending', 'rejected', 'suspended'];

  test('exhaustive matrix of actor role x target role x action x current status', () => {
    for (const actorRole of roles) {
      for (const targetRole of roles) {
        for (const action of actions) {
          for (const currentStatus of statuses) {
            const actor = { _id: 'actor_1', role: actorRole };
            const target = {
              _id: 'target_2',
              role: targetRole,
              ...(currentStatus ? { accountStatus: currentStatus } : {}),
            };

            const options = {
              superadminCount: 2,
              reason: 'Valid policy reason',
            };

            const plan = planStatusChange(actor, target, action, options);

            // 1. Teachers can never moderate anyone
            if (actorRole === 'teacher') {
              assert.equal(plan.ok, false, `Teacher cannot moderate ${targetRole}`);
              assert.equal(plan.status, 403);
              assert.equal(plan.code, 'forbidden');
              continue;
            }

            // 2. Admins can ONLY moderate teachers
            if (actorRole === 'admin' && targetRole !== 'teacher') {
              assert.equal(plan.ok, false, `Admin cannot moderate ${targetRole}`);
              assert.equal(plan.status, 403);
              assert.equal(plan.code, 'forbidden');
              continue;
            }

            // 3. Admin / Superadmin targets can NEVER be approved or rejected
            if ((targetRole === 'admin' || targetRole === 'superadmin') && (action === 'approve' || action === 'reject')) {
              assert.equal(plan.ok, false, `${targetRole} cannot be ${action}d`);
              assert.equal(plan.status, 403);
              assert.equal(plan.code, 'forbidden');
              continue;
            }

            // Source status checks (missing is treated as active)
            const effectiveStatus = currentStatus || 'active';

            if (action === 'approve') {
              if (effectiveStatus === 'pending' || effectiveStatus === 'rejected') {
                assert.equal(plan.ok, true, `${actorRole} can approve ${targetRole} from ${effectiveStatus}`);
                assert.equal(plan.status, 200);
                assert.equal(plan.code, 'active');
              } else {
                assert.equal(plan.ok, false, `Cannot approve from ${effectiveStatus}`);
                assert.equal(plan.status, 400);
                assert.equal(plan.code, 'invalid_status');
              }
            } else if (action === 'reject') {
              if (effectiveStatus === 'pending') {
                assert.equal(plan.ok, true, `${actorRole} can reject ${targetRole} from ${effectiveStatus}`);
                assert.equal(plan.status, 200);
                assert.equal(plan.code, 'rejected');
              } else {
                assert.equal(plan.ok, false, `Cannot reject from ${effectiveStatus}`);
                assert.equal(plan.status, 400);
                assert.equal(plan.code, 'invalid_status');
              }
            } else if (action === 'suspend') {
              if (effectiveStatus === 'active') {
                assert.equal(plan.ok, true, `${actorRole} can suspend ${targetRole} from ${effectiveStatus}`);
                assert.equal(plan.status, 200);
                assert.equal(plan.code, 'suspended');
              } else {
                assert.equal(plan.ok, false, `Cannot suspend from ${effectiveStatus}`);
                assert.equal(plan.status, 400);
                assert.equal(plan.code, 'invalid_status');
              }
            } else if (action === 'reactivate') {
              if (effectiveStatus === 'suspended') {
                assert.equal(plan.ok, true, `${actorRole} can reactivate ${targetRole} from ${effectiveStatus}`);
                assert.equal(plan.status, 200);
                assert.equal(plan.code, 'active');
              } else {
                assert.equal(plan.ok, false, `Cannot reactivate from ${effectiveStatus}`);
                assert.equal(plan.status, 400);
                assert.equal(plan.code, 'invalid_status');
              }
            }
          }
        }
      }
    }
  });

  test('nobody moderates themselves across any action', () => {
    for (const role of roles) {
      for (const action of actions) {
        const user = { _id: 'same_user', role, accountStatus: 'active' };
        const plan = planStatusChange(user, user, action, { superadminCount: 5, reason: 'test' });
        assert.equal(plan.ok, false);
        assert.equal(plan.status, 403);
        assert.equal(plan.code, 'forbidden');
      }
    }
  });

  test('last remaining superadmin cannot be moderated', () => {
    const actor = { _id: 'sa1', role: 'superadmin' };
    const target = { _id: 'sa2', role: 'superadmin', accountStatus: 'active' };

    const plan = planStatusChange(actor, target, 'suspend', { superadminCount: 1, reason: 'test' });
    assert.equal(plan.ok, false);
    assert.equal(plan.status, 403);
    assert.equal(plan.code, 'forbidden');
  });

  test('suspend requires a non-empty reason', () => {
    const actor = { _id: 'sa', role: 'superadmin' };
    const target = { _id: 't', role: 'teacher', accountStatus: 'active' };

    const noReason = planStatusChange(actor, target, 'suspend', { superadminCount: 2 });
    assert.equal(noReason.ok, false);
    assert.equal(noReason.status, 400);
    assert.equal(noReason.code, 'reason_required');

    const emptyReason = planStatusChange(actor, target, 'suspend', { superadminCount: 2, reason: '   ' });
    assert.equal(emptyReason.ok, false);
    assert.equal(emptyReason.status, 400);
    assert.equal(emptyReason.code, 'reason_required');

    const withReason = planStatusChange(actor, target, 'suspend', { superadminCount: 2, reason: 'Violation' });
    assert.equal(withReason.ok, true);
    assert.equal(withReason.status, 200);
  });
});

describe('userAccountService - buildStatusChangeFilter() (Mingo Evaluation)', () => {
  const docs = [
    { _id: 'missing', username: 'legacy_doc' }, // missing accountStatus field
    { _id: 'active', username: 'active_doc', accountStatus: 'active' },
    { _id: 'pending', username: 'pending_doc', accountStatus: 'pending' },
    { _id: 'rejected', username: 'rejected_doc', accountStatus: 'rejected' },
    { _id: 'suspended', username: 'suspended_doc', accountStatus: 'suspended' },
  ];

  test('filter with active matches documents with active status AND missing field', () => {
    const filter = buildStatusChangeFilter(undefined, 'active');
    const matched = new Query(filter).find(docs).all().map(d => d._id);
    assert.deepEqual(matched.sort(), ['active', 'missing']);
  });

  test('filter with pending matches only pending document', () => {
    const filter = buildStatusChangeFilter(undefined, 'pending');
    const matched = new Query(filter).find(docs).all().map(d => d._id);
    assert.deepEqual(matched, ['pending']);
  });

  test('filter with rejected matches only rejected document', () => {
    const filter = buildStatusChangeFilter(undefined, 'rejected');
    const matched = new Query(filter).find(docs).all().map(d => d._id);
    assert.deepEqual(matched, ['rejected']);
  });

  test('filter with suspended matches only suspended document', () => {
    const filter = buildStatusChangeFilter(undefined, 'suspended');
    const matched = new Query(filter).find(docs).all().map(d => d._id);
    assert.deepEqual(matched, ['suspended']);
  });

  test('filter with [pending, rejected] matches pending and rejected documents', () => {
    const filter = buildStatusChangeFilter(undefined, ['pending', 'rejected']);
    const matched = new Query(filter).find(docs).all().map(d => d._id);
    assert.deepEqual(matched.sort(), ['pending', 'rejected']);
  });

  test('filter with specific _id constrains query to that id', () => {
    const filterActiveMissing = buildStatusChangeFilter('missing', 'active');
    assert.deepEqual(new Query(filterActiveMissing).find(docs).all().map(d => d._id), ['missing']);

    const filterActiveExplicit = buildStatusChangeFilter('active', 'active');
    assert.deepEqual(new Query(filterActiveExplicit).find(docs).all().map(d => d._id), ['active']);

    const filterPending = buildStatusChangeFilter('pending', 'pending');
    assert.deepEqual(new Query(filterPending).find(docs).all().map(d => d._id), ['pending']);

    const filterMismatch = buildStatusChangeFilter('suspended', 'active');
    assert.deepEqual(new Query(filterMismatch).find(docs).all().map(d => d._id), []);
  });
});

describe('Handler-level moderation and atomic transitions', () => {
  const User = require('../models/User');
  const AuditLog = require('../models/AuditLog');
  const adminController = require('../controllers/adminController');
  const notificationService = require('../services/notificationService');

  function makeFakeReqRes({ actor, targetId, body = {}, isJson = true }) {
    const req = {
      session: { user: actor, flash: null },
      params: { id: targetId },
      body,
      headers: isJson ? { accept: 'application/json' } : {},
      xhr: isJson,
    };
    const res = {
      statusCode: 200,
      jsonPayload: null,
      rendered: null,
      redirectedTo: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.jsonPayload = payload;
        return this;
      },
      render(view, data) {
        this.rendered = { view, data };
        return this;
      },
      redirect(url) {
        this.redirectedTo = url;
        return this;
      },
    };
    return { req, res };
  }

  test('admin cannot reject superadmin or another admin and target is untouched', async () => {
    const origFindById = User.findById;
    const origCountDocuments = User.countDocuments;
    const origFindOneAndUpdate = User.findOneAndUpdate;
    const origAuditLogCreate = AuditLog.create;

    let updateCalled = false;
    User.countDocuments = async () => 2;
    User.findOneAndUpdate = async () => {
      updateCalled = true;
      return null;
    };
    AuditLog.create = async () => {};

    try {
      const adminActor = { _id: '507f191e810c19729de860e1', role: 'admin', displayName: 'Admin One', username: 'admin1' };
      const superadminTarget = { _id: '507f191e810c19729de860e2', role: 'superadmin', accountStatus: 'active', displayName: 'Super User', username: 'superuser' };
      const otherAdminTarget = { _id: '507f191e810c19729de860e3', role: 'admin', accountStatus: 'active', displayName: 'Admin Bob', username: 'adminbob' };

      // Attempt 1: Admin rejects Superadmin
      User.findById = async (id) => {
        if (id === '507f191e810c19729de860e2') return superadminTarget;
        return null;
      };

      const { req: req1, res: res1 } = makeFakeReqRes({ actor: adminActor, targetId: '507f191e810c19729de860e2' });
      await adminController.userReject(req1, res1);

      assert.equal(res1.statusCode, 403, 'Admin rejecting superadmin must return 403');
      assert.equal(updateCalled, false, 'Database update must not be called');
      assert.equal(superadminTarget.accountStatus, 'active', 'Target document must remain active');

      // Attempt 2: Admin rejects other Admin
      User.findById = async (id) => {
        if (id === '507f191e810c19729de860e3') return otherAdminTarget;
        return null;
      };

      const { req: req2, res: res2 } = makeFakeReqRes({ actor: adminActor, targetId: '507f191e810c19729de860e3' });
      await adminController.userReject(req2, res2);

      assert.equal(res2.statusCode, 403, 'Admin rejecting other admin must return 403');
      assert.equal(updateCalled, false, 'Database update must not be called');
      assert.equal(otherAdminTarget.accountStatus, 'active', 'Target document must remain active');

      // Attempt 3: Admin rejects self
      User.findById = async (id) => {
        if (id === '507f191e810c19729de860e1') return adminActor;
        return null;
      };

      const { req: req3, res: res3 } = makeFakeReqRes({ actor: adminActor, targetId: '507f191e810c19729de860e1' });
      await adminController.userReject(req3, res3);

      assert.equal(res3.statusCode, 403, 'Admin rejecting self must return 403');
      assert.equal(updateCalled, false, 'Database update must not be called');
    } finally {
      User.findById = origFindById;
      User.countDocuments = origCountDocuments;
      User.findOneAndUpdate = origFindOneAndUpdate;
      AuditLog.create = origAuditLogCreate;
    }
  });

  test('double approval sends only one welcome notification', async () => {
    const origFindById = User.findById;
    const origCountDocuments = User.countDocuments;
    const origFindOneAndUpdate = User.findOneAndUpdate;
    const origNotifyWelcome = notificationService.notifyTeacherWelcome;
    const origAuditLogCreate = AuditLog.create;

    let welcomeNotificationsCount = 0;
    notificationService.notifyTeacherWelcome = async () => {
      welcomeNotificationsCount++;
    };
    AuditLog.create = async () => {};

    const adminId = '507f191e810c19729de860e1';
    const teacherId = '507f191e810c19729de860e2';

    // Represents the DB state
    let dbStatus = 'pending';
    let dbDoc = {
      _id: teacherId,
      role: 'teacher',
      accountStatus: 'pending',
      displayName: 'Jane Doe',
      username: 'janedoe',
      onboarding: {},
    };

    User.countDocuments = async () => 2;
    // Both simultaneous requests initially read the user as pending
    User.findById = async () => ({ ...dbDoc, accountStatus: dbStatus });

    // Atomic findOneAndUpdate: only succeeds if DB status is pending or rejected
    User.findOneAndUpdate = async (filter, update) => {
      if (dbStatus !== 'pending' && dbStatus !== 'rejected') {
        return null; // Concurrency conflict: already updated by previous operation
      }
      dbStatus = 'active';
      dbDoc = {
        ...dbDoc,
        accountStatus: 'active',
        onboarding: { startedAt: update.$set['onboarding.startedAt'] || new Date() },
      };
      return dbDoc;
    };

    try {
      const adminActor = { _id: adminId, role: 'admin', displayName: 'Admin One', username: 'adminone' };

      // Request 1: First approval
      const { req: req1, res: res1 } = makeFakeReqRes({ actor: adminActor, targetId: teacherId });
      await adminController.userApprove(req1, res1);

      assert.equal(res1.statusCode, 200);
      assert.equal(welcomeNotificationsCount, 1, 'First approval must send welcome notification');
      assert.ok(dbDoc.onboarding.startedAt, 'onboarding.startedAt must be set');

      // Request 2: Concurrent double-click or simultaneous second approval
      const { req: req2, res: res2 } = makeFakeReqRes({ actor: adminActor, targetId: teacherId });
      await adminController.userApprove(req2, res2);

      assert.equal(welcomeNotificationsCount, 1, 'Second approval must NOT send duplicate welcome notification');
    } finally {
      User.findById = origFindById;
      User.countDocuments = origCountDocuments;
      User.findOneAndUpdate = origFindOneAndUpdate;
      notificationService.notifyTeacherWelcome = origNotifyWelcome;
      AuditLog.create = origAuditLogCreate;
    }
  });
});
