const { test, describe } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('http');
const cspReportRoutes = require('../routes/cspReport');

function makeRequest(app, options, body) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      const req = http.request({
        port,
        method: options.method || 'POST',
        path: options.path || '/csp-report',
        headers: options.headers || {}
      }, (res) => {
        let resBody = '';
        res.on('data', chunk => resBody += chunk);
        res.on('end', () => {
          server.close();
          resolve({ statusCode: res.statusCode, headers: res.headers, body: resBody });
        });
      });
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      if (body) req.write(body);
      req.end();
    });
  });
}

describe('POST /csp-report endpoint', () => {
  const app = express();
  app.use('/csp-report', cspReportRoutes);

  test('accepts application/csp-report payload and returns 204', async () => {
    const payload = JSON.stringify({
      'csp-report': {
        'document-uri': 'http://localhost:3000/reports',
        'violated-directive': 'script-src',
        'blocked-uri': 'http://example.com/malicious.js',
      }
    });

    const res = await makeRequest(app, {
      method: 'POST',
      path: '/csp-report',
      headers: { 'Content-Type': 'application/csp-report' }
    }, payload);

    assert.strictEqual(res.statusCode, 204);
  });

  test('accepts application/reports+json payload and returns 204', async () => {
    const payload = JSON.stringify([{
      type: 'csp-violation',
      body: {
        effectiveDirective: 'script-src',
        blockedURL: 'http://example.com/evil.js'
      }
    }]);

    const res = await makeRequest(app, {
      method: 'POST',
      path: '/csp-report',
      headers: { 'Content-Type': 'application/reports+json' }
    }, payload);

    assert.strictEqual(res.statusCode, 204);
  });

  test('rejects payload larger than 8 KB with 413 Payload Too Large', async () => {
    const largePayload = JSON.stringify({
      'csp-report': {
        'blocked-uri': 'a'.repeat(9000)
      }
    });

    const res = await makeRequest(app, {
      method: 'POST',
      path: '/csp-report',
      headers: { 'Content-Type': 'application/csp-report' }
    }, largePayload);

    assert.strictEqual(res.statusCode, 413);
  });
});
