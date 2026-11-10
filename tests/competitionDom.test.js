const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM, VirtualConsole } = require('jsdom');

test('Competition Report - DOM Regression in views/reports/new.ejs', async (t) => {
  const origLoader = ejs.fileLoader;
  t.after(() => {
    ejs.fileLoader = origLoader;
  });

  ejs.fileLoader = function (filePath) {
    if (filePath.includes('partials/header') || filePath.includes('partials\\header')) {
      return '<!-- STUBBED_HEADER -->';
    }
    if (filePath.includes('partials/footer') || filePath.includes('partials\\footer')) {
      return '<!-- STUBBED_FOOTER -->';
    }
    return origLoader(filePath);
  };

  const newReportPath = path.resolve('views/reports/new.ejs');
  const groupsMock = [
    { _id: 'g1', group_name: 'Robotics Alpha', students: ['Alice', 'Bob'], type: 'GROUP' },
    { _id: 'g2', group_name: 'Robotics Beta', students: ['Charlie', 'Dave'], type: 'GROUP' },
    { _id: 'g3', group_name: 'AI Club', students: ['Eve'], type: 'GROUP' }
  ];

  const templateData = {
    csrfToken: 'test-token',
    currentUser: { _id: '507f1f77bcf86cd799439011', displayName: 'Teacher John', username: 'john', role: 'teacher' },
    errors: [],
    formData: {},
    groupsJson: JSON.stringify(groupsMock),
    materialsJson: '[]',
    teachingTypes: ['Regular Teaching', 'Assistant Teacher', '1/2 Prime Teacher'],
    teachers: [],
    teachersJson: '[]'
  };

  const html = await ejs.renderFile(newReportPath, templateData);

  function createDomEnvironment(customHtml = html) {
    const virtualConsole = new VirtualConsole();
    // Silence jsdom's "Not implemented: navigation" console warnings
    virtualConsole.on('error', () => {});
    virtualConsole.on('warn', () => {});

    const fs = require('fs');
    const dom = new JSDOM(customHtml, {
      runScripts: 'dangerously',
      resources: 'usable',
      url: 'http://localhost:3000/reports/new',
      virtualConsole
    });

    const { window } = dom;
    window.Element.prototype.scrollIntoView = () => {};
    window.scrollIntoView = () => {};
    window.Swal = {
      fire: () => Promise.resolve({ isConfirmed: true })
    };

    // If externalized scripts are present, execute them in jsdom
    const scriptEls = dom.window.document.querySelectorAll('script[src]');
    scriptEls.forEach(s => {
      const src = s.getAttribute('src');
      if (src && src.startsWith('/js/')) {
        const filePath = path.resolve('public' + src);
        if (fs.existsSync(filePath)) {
          dom.window.eval(fs.readFileSync(filePath, 'utf8'));
        }
      }
    });

    return dom;
  }

  await t.test('(1) switching to competition and adding 2 groups leaves NO input named class_name and competition_groups contains both names', () => {
    const dom = createDomEnvironment();
    const doc = dom.window.document;

    // Switch to competition
    dom.window.setSessionType('competition');

    // Add 2 groups
    dom.window.addCompetitionGroup('g1');
    dom.window.addCompetitionGroup('g2');

    // Check no input named class_name exists
    const classInputs = doc.querySelectorAll('input[name="class_name"]');
    assert.strictEqual(classInputs.length, 0, 'There should be NO input named class_name in competition mode');

    // Check competition_groups hidden field
    const compHidden = doc.getElementById('competition_groups_hidden');
    assert.ok(compHidden, 'competition_groups_hidden input must exist');
    assert.strictEqual(compHidden.value, 'Robotics Alpha,Robotics Beta');
  });

  await t.test('(2) switching back to group leaves exactly one input named class_name and an empty competition_groups', () => {
    const dom = createDomEnvironment();
    const doc = dom.window.document;

    // Switch to competition and add 2 groups
    dom.window.setSessionType('competition');
    dom.window.addCompetitionGroup('g1');
    dom.window.addCompetitionGroup('g2');

    // Now switch back to group
    dom.window.setSessionType('group');

    // Check exactly one input named class_name exists
    const classInputs = doc.querySelectorAll('input[name="class_name"]');
    assert.strictEqual(classInputs.length, 1, 'There must be exactly one input named class_name in group mode');
    assert.strictEqual(classInputs[0].id, 'class_name', 'The input named class_name must be the main group input #class_name');

    // Check competition_groups hidden field is empty
    const compHidden = doc.getElementById('competition_groups_hidden');
    assert.ok(compHidden, 'competition_groups_hidden input must exist');
    assert.strictEqual(compHidden.value, '', 'competition_groups_hidden must be empty');
  });

  await t.test('(3) multi-report mode with a competition main report and 2 groups produces no "Class name is required" error; with 1 group the error is "Report 1: Select at least 2 groups for the competition."', async () => {
    const dom = createDomEnvironment();
    const doc = dom.window.document;

    // Switch to competition mode on main report
    dom.window.setSessionType('competition');

    // Add an extra report card via addBulkEntry
    dom.window.addBulkEntry();

    // Fill required fields on main report
    const mainType = doc.querySelector('[name="teaching_type"]');
    if (mainType) mainType.value = 'Regular Teaching';
    const mainDur = doc.querySelector('[name="duration"]');
    if (mainDur) mainDur.value = '60';

    // Fill required fields on extra card
    const extraCardId = dom.window._bulkIds[0];
    const extraClass = doc.getElementById('bulk-entry-' + extraCardId + '-class-name');
    if (extraClass) extraClass.value = 'Extra Group Class';
    const extraType = doc.getElementById('bulk-entry-' + extraCardId + '-teaching-type');
    if (extraType) extraType.value = 'Regular Teaching';
    const extraDur = doc.getElementById('bulk-entry-' + extraCardId + '-duration');
    if (extraDur) extraDur.value = '60';

    // Mock fetch to track network call when validation succeeds
    let fetchCalled = false;
    dom.window.fetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ ok: true }) };
    };

    // Case 3a: with 1 group selected
    dom.window.addCompetitionGroup('g1');

    await dom.window.submitBulkReports();

    const errList = doc.getElementById('bulk-error-list');
    assert.ok(errList, 'bulk-error-list element must exist');
    assert.ok(
      errList.textContent.includes('Report 1: Select at least 2 groups for the competition.'),
      'Must contain "Report 1: Select at least 2 groups for the competition."'
    );
    assert.ok(
      !errList.textContent.includes('Class name is required.'),
      'Must NOT say "Class name is required" for competition report'
    );
    assert.strictEqual(fetchCalled, false, 'fetch should not be called when validation fails');

    // Case 3b: add second group (now 2 groups)
    dom.window.addCompetitionGroup('g2');

    await dom.window.submitBulkReports();

    const errBox = doc.getElementById('bulk-errors');
    assert.ok(errBox.classList.contains('hidden'), 'bulk-errors container should be hidden on success');
    assert.strictEqual(errList.textContent, '', 'Error list should be empty when validation passes');
    assert.strictEqual(fetchCalled, true, 'fetch should be called when all reports are valid');
  });

  await t.test('(4) the extra card has no Competition button', () => {
    const dom = createDomEnvironment();
    const doc = dom.window.document;

    // Add an extra card
    dom.window.addBulkEntry();
    const extraCardId = dom.window._bulkIds[0];
    const extraCard = doc.getElementById('bulk-entry-' + extraCardId);
    assert.ok(extraCard, 'Extra report card should be created in DOM');

    // Assert there is no competition button
    const compBtn = doc.getElementById('bulk-entry-' + extraCardId + '-btn-competition');
    assert.strictEqual(compBtn, null, 'Extra card must NOT have a competition button');

    // Assert Group and Private buttons exist
    const groupBtn = doc.getElementById('bulk-entry-' + extraCardId + '-btn-group');
    const privateBtn = doc.getElementById('bulk-entry-' + extraCardId + '-btn-private');
    assert.ok(groupBtn, 'Extra card must have a Group button');
    assert.ok(privateBtn, 'Extra card must have a Private button');

    // Assert hint text exists
    assert.ok(
      extraCard.textContent.includes('Competition reports: use the main form (add other reports one at a time).'),
      'Extra card must contain the competition hint text'
    );
  });

  await t.test('single-report competition submit with fewer than 2 groups shows inline error and focuses search', () => {
    const dom = createDomEnvironment();
    const doc = dom.window.document;
    const form = doc.getElementById('report-form');

    dom.window.setSessionType('competition');

    let prevented = false;
    form.addEventListener('submit', (e) => {
      if (e.defaultPrevented) prevented = true;
    });

    // 0 groups, empty search input
    form.dispatchEvent(new dom.window.Event('submit', { cancelable: true, bubbles: true }));

    const errEl = doc.getElementById('competition-error');
    assert.ok(errEl, 'competition-error element must exist');
    assert.strictEqual(errEl.textContent, 'Select at least 2 groups for the competition.');
    assert.ok(!errEl.classList.contains('hidden'), 'Error element should not be hidden');

    // Text typed in search input but not selected
    const searchInp = doc.getElementById('competition-search');
    searchInp.value = 'Alpha';
    form.dispatchEvent(new dom.window.Event('submit', { cancelable: true, bubbles: true }));
    assert.strictEqual(errEl.textContent, 'Choose the group from the list.');
  });
});
