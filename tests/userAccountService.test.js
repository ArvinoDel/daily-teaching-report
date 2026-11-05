'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { Query } = require('mingo');

const {
  canLogin,
  activeUserFilter,
  isModeratable,
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
