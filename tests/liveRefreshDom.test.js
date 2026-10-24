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

test('LiveRefresh - two calls in quick succession: trailing fetch updates with second response data', async () => {
  const initialHtml = `<div data-live-section="sec-1">Initial</div>`;
  const { window } = createEnvironment(initialHtml);
  let fetchCount = 0;

  window.fetch = () => {
    fetchCount++;
    const currentCount = fetchCount;
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          ok: true,
          url: 'http://localhost:3000/reports',
          text: async () => `<div data-live-section="sec-1">Update ${currentCount}</div>`
        });
      }, 30);
    });
  };

  const p1 = window.LiveRefresh.refresh('sec-1');
  const p2 = window.LiveRefresh.refresh('sec-1');

  await Promise.all([p1, p2]);

  assert.strictEqual(fetchCount, 2);
  assert.strictEqual(window.document.querySelector('[data-live-section="sec-1"]').innerHTML, 'Update 2');
});

test('LiveRefresh - five calls during one flight trigger exactly one trailing fetch for union of sections', async () => {
  const initialHtml = `
    <div data-live-section="sec-1">Old 1</div>
    <div data-live-section="sec-2">Old 2</div>
    <div data-live-section="sec-3">Old 3</div>
    <div data-live-section="sec-4">Old 4</div>
    <div data-live-section="sec-5">Old 5</div>
  `;
  const { window } = createEnvironment(initialHtml);
  let fetchCount = 0;

  window.fetch = () => {
    fetchCount++;
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          ok: true,
          url: 'http://localhost:3000/reports',
          text: async () => `
            <div data-live-section="sec-1">New 1</div>
            <div data-live-section="sec-2">New 2</div>
            <div data-live-section="sec-3">New 3</div>
            <div data-live-section="sec-4">New 4</div>
            <div data-live-section="sec-5">New 5</div>
          `
        });
      }, 30);
    });
  };

  const p1 = window.LiveRefresh.refresh('sec-1');
  const p2 = window.LiveRefresh.refresh('sec-2');
  const p3 = window.LiveRefresh.refresh('sec-3');
  const p4 = window.LiveRefresh.refresh('sec-2');
  const p5 = window.LiveRefresh.refresh('sec-4');
  const p6 = window.LiveRefresh.refresh('sec-5');

  await Promise.all([p1, p2, p3, p4, p5, p6]);

  assert.strictEqual(fetchCount, 2);
  assert.strictEqual(window.document.querySelector('[data-live-section="sec-1"]').innerHTML, 'New 1');
  assert.strictEqual(window.document.querySelector('[data-live-section="sec-2"]').innerHTML, 'New 2');
  assert.strictEqual(window.document.querySelector('[data-live-section="sec-3"]').innerHTML, 'New 3');
  assert.strictEqual(window.document.querySelector('[data-live-section="sec-4"]').innerHTML, 'New 4');
  assert.strictEqual(window.document.querySelector('[data-live-section="sec-5"]').innerHTML, 'New 5');
});

test('LiveRefresh - both promises from calls 1 and 2 resolve after trailing refresh', async () => {
  const initialHtml = `<div data-live-section="sec-1">Initial</div>`;
  const { window } = createEnvironment(initialHtml);
  let fetchCount = 0;

  window.fetch = () => {
    fetchCount++;
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          ok: true,
          url: 'http://localhost:3000/reports',
          text: async () => `<div data-live-section="sec-1">Done ${fetchCount}</div>`
        });
      }, 30);
    });
  };

  let p1Resolved = false;
  let p2Resolved = false;

  const p1 = window.LiveRefresh.refresh('sec-1').then(() => {
    p1Resolved = true;
  });
  const p2 = window.LiveRefresh.refresh('sec-1').then(() => {
    p2Resolved = true;
  });

  await Promise.all([p1, p2]);

  assert.strictEqual(p1Resolved, true);
  assert.strictEqual(p2Resolved, true);
  assert.strictEqual(fetchCount, 2);
});

test('LiveRefresh - empty 200 response triggers reload fallback and does not block later refresh', async () => {
  const initialHtml = `<div data-live-section="sec-1">Initial</div>`;
  const { window, isReloaded } = createEnvironment(initialHtml);

  // First call returns whitespace 200 response
  window.fetch = async () => ({
    ok: true,
    status: 200,
    url: 'http://localhost:3000/reports',
    text: async () => '   \n\t  '
  });

  await window.LiveRefresh.refresh('sec-1');
  assert.strictEqual(isReloaded(), true);

  // Later call should work because guard was reset
  window.fetch = async () => ({
    ok: true,
    status: 200,
    url: 'http://localhost:3000/reports',
    text: async () => '<div data-live-section="sec-1">Recovered</div>'
  });

  await window.LiveRefresh.refresh('sec-1');
  assert.strictEqual(window.document.querySelector('[data-live-section="sec-1"]').innerHTML, 'Recovered');
});

test('LiveRefresh - fetch rejects, then later refresh works', async () => {
  const initialHtml = `<div data-live-section="sec-1">Initial</div>`;
  const { window, isReloaded } = createEnvironment(initialHtml);

  window.fetch = async () => {
    throw new Error('Network timeout');
  };

  await window.LiveRefresh.refresh('sec-1');
  assert.strictEqual(isReloaded(), true);

  window.fetch = async () => ({
    ok: true,
    status: 200,
    url: 'http://localhost:3000/reports',
    text: async () => '<div data-live-section="sec-1">Recovered After Reject</div>'
  });

  await window.LiveRefresh.refresh('sec-1');
  assert.strictEqual(window.document.querySelector('[data-live-section="sec-1"]').innerHTML, 'Recovered After Reject');
});

test('LiveRefresh - no trailing refresh happens after a fallback reload', async () => {
  const initialHtml = `
    <div data-live-section="sec-1">Initial 1</div>
    <div data-live-section="sec-2">Initial 2</div>
  `;
  const { window, isReloaded } = createEnvironment(initialHtml);
  let fetchCount = 0;

  window.fetch = () => {
    fetchCount++;
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        reject(new Error('Fetch failure on flight 1'));
      }, 30);
    });
  };

  const p1 = window.LiveRefresh.refresh('sec-1');
  const p2 = window.LiveRefresh.refresh('sec-2');

  await Promise.all([p1, p2]);

  assert.strictEqual(isReloaded(), true);
  assert.strictEqual(fetchCount, 1);
});

test('LiveRefresh - fetch options include cache: no-store, same-origin credentials, and XMLHttpRequest header', async () => {
  const initialHtml = `<div data-live-section="sec-1">Initial</div>`;
  const { window } = createEnvironment(initialHtml);
  let capturedOptions = null;

  window.fetch = async (url, options) => {
    capturedOptions = options;
    return {
      ok: true,
      url,
      text: async () => '<div data-live-section="sec-1">Updated</div>'
    };
  };

  await window.LiveRefresh.refresh('sec-1');

  assert.ok(capturedOptions);
  assert.strictEqual(capturedOptions.cache, 'no-store');
  assert.strictEqual(capturedOptions.credentials, 'same-origin');
  assert.strictEqual(capturedOptions.headers['X-Requested-With'], 'XMLHttpRequest');
});


