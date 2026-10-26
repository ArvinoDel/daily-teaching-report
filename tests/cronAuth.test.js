'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyCronSecret } = require('../controllers/cronController');

test('Cron Authentication - verifyCronSecret', async (t) => {
  const originalSecret = process.env.CRON_SECRET;

  t.afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalSecret;
    }
  });

  function createMockRes() {
    return {
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
    };
  }

  await t.test('1. Returns 503 when CRON_SECRET is not configured or empty', () => {
    delete process.env.CRON_SECRET;
    const req = { headers: { authorization: 'Bearer some_token' } };
    const res = createMockRes();

    const allowed = verifyCronSecret(req, res);
    assert.equal(allowed, false);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { ok: false, message: 'Cron not configured' });
  });

  await t.test('2. Returns 401 when Authorization header is missing or malformed', () => {
    process.env.CRON_SECRET = 'super-secret-123';
    const res1 = createMockRes();
    const allowed1 = verifyCronSecret({ headers: {} }, res1);
    assert.equal(allowed1, false);
    assert.equal(res1.statusCode, 401);

    const res2 = createMockRes();
    const allowed2 = verifyCronSecret({ headers: { authorization: 'Basic xyz' } }, res2);
    assert.equal(allowed2, false);
    assert.equal(res2.statusCode, 401);
  });

  await t.test('3. Returns 401 when token length or value does not match', () => {
    process.env.CRON_SECRET = 'correct-secret-456';

    const resDiffLen = createMockRes();
    const allowedDiff = verifyCronSecret({ headers: { authorization: 'Bearer short' } }, resDiffLen);
    assert.equal(allowedDiff, false);
    assert.equal(resDiffLen.statusCode, 401);

    const resSameLenWrongVal = createMockRes();
    const allowedWrong = verifyCronSecret({ headers: { authorization: 'Bearer wrong-secret-456' } }, resSameLenWrongVal);
    assert.equal(allowedWrong, false);
    assert.equal(resSameLenWrongVal.statusCode, 401);
  });

  await t.test('4. Allows request when valid token is provided', () => {
    process.env.CRON_SECRET = 'correct-secret-456';
    const req = { headers: { authorization: 'Bearer correct-secret-456' } };
    const res = createMockRes();

    const allowed = verifyCronSecret(req, res);
    assert.equal(allowed, true);
    assert.equal(res.statusCode, null);
  });
});
