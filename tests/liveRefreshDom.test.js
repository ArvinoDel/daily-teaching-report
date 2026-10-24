const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const liveRefreshScript = fs.readFileSync(
  path.resolve(__dirname, '../public/js/live-refresh.js'),
  'utf8'
);

function createEnvironment(initialHtml, url = 'http://localhost:3000/reports?page=2&filter=active') {
  const virtualConsole = new VirtualConsole();
  let reloaded = false;

  virtualConsole.on('error', () => {});
  virtualConsole.on('warn', () => {});
  virtualConsole.on('jsdomError', (err) => {
    if (err && err.message && err.message.includes('Not implemented: navigation')) {
      reloaded = true;
    }
  });

  const dom = new JSDOM(initialHtml, {
    url,
    runScripts: 'dangerously',
    virtualConsole
  });

  const { window } = dom;
  window.scrollTo = () => {};

  // Inject LiveRefresh script into window
  window.eval(liveRefreshScript);

  return { dom, window, isReloaded: () => reloaded };
}

test('LiveRefresh - swaps target section innerHTML and preserves untargeted DOM', async () => {
  const initialHtml = `
    <!DOCTYPE html>
    <html>
      <body>
        <header id="site-header">Header Content</header>
        <div data-live-section="section-a">Old Section A</div>
        <div data-live-section="section-b">Old Section B</div>
      </body>
    </html>
  `;

  const { window } = createEnvironment(initialHtml);
  let capturedUrl = null;
  let capturedOptions = null;
  let refreshedEventDetail = null;

  window.document.addEventListener('live:refreshed', (e) => {
    refreshedEventDetail = e.detail;
  });

  window.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return {
      ok: true,
      url,
      text: async () => `
        <html>
          <body>
            <div data-live-section="section-a">New Section A Updated!</div>
            <div data-live-section="section-b">New Section B Updated!</div>
          </body>
        </html>
      `
    };
  };

  await window.LiveRefresh.refresh('section-a');

  // Verify fetch details
  assert.strictEqual(capturedUrl, 'http://localhost:3000/reports?page=2&filter=active');
  assert.ok(capturedOptions && capturedOptions.headers);
  assert.strictEqual(capturedOptions.headers['X-Requested-With'], 'XMLHttpRequest');

  // Verify DOM swap
  const sectionA = window.document.querySelector('[data-live-section="section-a"]');
  const sectionB = window.document.querySelector('[data-live-section="section-b"]');
  const header = window.document.getElementById('site-header');

  assert.strictEqual(sectionA.innerHTML, 'New Section A Updated!');
  assert.strictEqual(sectionB.innerHTML, 'Old Section B');
  assert.strictEqual(header.innerHTML, 'Header Content');

  // Verify custom event
  assert.ok(refreshedEventDetail);
  assert.deepStrictEqual(Array.from(refreshedEventDetail.sections), ['section-a']);
});

test('LiveRefresh - swaps multiple sections when an array is passed', async () => {
  const initialHtml = `
    <!DOCTYPE html>
    <html>
      <body>
        <div data-live-section="sec-1">Initial 1</div>
        <div data-live-section="sec-2">Initial 2</div>
      </body>
    </html>
  `;

  const { window } = createEnvironment(initialHtml);
  let refreshedEventDetail = null;

  window.document.addEventListener('live:refreshed', (e) => {
    refreshedEventDetail = e.detail;
  });

  window.fetch = async (url) => ({
    ok: true,
    url,
    text: async () => `
      <div data-live-section="sec-1">Replaced 1</div>
      <div data-live-section="sec-2">Replaced 2</div>
    `
  });

  await window.LiveRefresh.refresh(['sec-1', 'sec-2']);

  assert.strictEqual(window.document.querySelector('[data-live-section="sec-1"]').innerHTML, 'Replaced 1');
  assert.strictEqual(window.document.querySelector('[data-live-section="sec-2"]').innerHTML, 'Replaced 2');
  assert.deepStrictEqual(Array.from(refreshedEventDetail.sections), ['sec-1', 'sec-2']);
});

test('LiveRefresh - falls back to window.location.reload on network failure', async () => {
  const initialHtml = `<div data-live-section="sec-1">Old</div>`;
  const { window, isReloaded } = createEnvironment(initialHtml);

  window.fetch = async () => {
    throw new Error('Network error');
  };

  await window.LiveRefresh.refresh('sec-1');
  assert.strictEqual(isReloaded(), true);
});

test('LiveRefresh - falls back to window.location.reload on non-200 HTTP status', async () => {
  const initialHtml = `<div data-live-section="sec-1">Old</div>`;
  const { window, isReloaded } = createEnvironment(initialHtml);

  window.fetch = async (url) => ({
    ok: false,
    status: 500,
    url,
    text: async () => 'Internal Server Error'
  });

  await window.LiveRefresh.refresh('sec-1');
  assert.strictEqual(isReloaded(), true);
});

test('LiveRefresh - falls back to window.location.reload when redirected to login', async () => {
  const initialHtml = `<div data-live-section="sec-1">Old</div>`;
  const { window, isReloaded } = createEnvironment(initialHtml);

  window.fetch = async () => ({
    ok: true,
    url: 'http://localhost:3000/auth/login',
    text: async () => '<html>Login page</html>'
  });

  await window.LiveRefresh.refresh('sec-1');
  assert.strictEqual(isReloaded(), true);
});

test('LiveRefresh - falls back to window.location.reload when section is missing in current DOM', async () => {
  const initialHtml = `<div data-live-section="other-section">Old</div>`;
  const { window, isReloaded } = createEnvironment(initialHtml);

  window.fetch = async (url) => ({
    ok: true,
    url,
    text: async () => '<div data-live-section="missing-section">New</div>'
  });

  await window.LiveRefresh.refresh('missing-section');
  assert.strictEqual(isReloaded(), true);
});

test('LiveRefresh - falls back to window.location.reload when section is missing in fetched response', async () => {
  const initialHtml = `<div data-live-section="sec-1">Old</div>`;
  const { window, isReloaded } = createEnvironment(initialHtml);

  window.fetch = async (url) => ({
    ok: true,
    url,
    text: async () => '<div data-live-section="other-section">New</div>'
  });

  await window.LiveRefresh.refresh('sec-1');
  assert.strictEqual(isReloaded(), true);
});

test('LiveRefresh - in-flight guard avoids duplicate concurrent fetch requests', async () => {
  const initialHtml = `<div data-live-section="sec-1">Old</div>`;
  const { window } = createEnvironment(initialHtml);
  let fetchCount = 0;

  window.fetch = () => {
    fetchCount++;
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          ok: true,
          url: 'http://localhost:3000/reports',
          text: async () => '<div data-live-section="sec-1">Refreshed</div>'
        });
      }, 50);
    });
  };

  const p1 = window.LiveRefresh.refresh('sec-1');
  const p2 = window.LiveRefresh.refresh('sec-1');

  await Promise.all([p1, p2]);

  assert.strictEqual(fetchCount, 1);
  assert.strictEqual(window.document.querySelector('[data-live-section="sec-1"]').innerHTML, 'Refreshed');
});
