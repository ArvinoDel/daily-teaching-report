const { test } = require('node:test');
const assert = require('node:assert');
const authController = require('../controllers/authController');

test('authController.heartbeat - returns unreadCount and isOnline for authenticated user', () => {
  const req = {
    session: {
      user: { _id: 'user123', username: 'teacher1', role: 'teacher' }
    }
  };
  let responseStatus = null;
  let responseJson = null;
  const res = {
    locals: {
      unreadNotificationCount: 5
    },
    status(code) {
      responseStatus = code;
      return this;
    },
    json(payload) {
      responseJson = payload;
      return this;
    }
  };

  authController.heartbeat(req, res);

  assert.strictEqual(responseStatus, 200);
  assert.deepStrictEqual(responseJson, {
    ok: true,
    isOnline: true,
    unreadCount: 5
  });
});

test('authController.heartbeat - returns isOnline false and unreadCount 0 when unauthenticated', () => {
  const req = {
    session: {}
  };
  let responseStatus = null;
  let responseJson = null;
  const res = {
    locals: {},
    status(code) {
      responseStatus = code;
      return this;
    },
    json(payload) {
      responseJson = payload;
      return this;
    }
  };

  authController.heartbeat(req, res);

  assert.strictEqual(responseStatus, 200);
  assert.deepStrictEqual(responseJson, {
    ok: true,
    isOnline: false,
    unreadCount: 0
  });
});

test('authController.heartbeat - handles missing session gracefully', () => {
  const req = {};
  let responseStatus = null;
  let responseJson = null;
  const res = {
    locals: {},
    status(code) {
      responseStatus = code;
      return this;
    },
    json(payload) {
      responseJson = payload;
      return this;
    }
  };

  authController.heartbeat(req, res);

  assert.strictEqual(responseStatus, 200);
  assert.deepStrictEqual(responseJson, {
    ok: true,
    isOnline: false,
    unreadCount: 0
  });
});
