const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');

const engine = require('../public/js/calculator/engine');
const config = require('../public/js/calculator/tests-config');
const listeningTable = require('../public/js/calculator/tables/ielts-listening');
const readingTable = require('../public/js/calculator/tables/ielts-reading-center');
const toeflTable = require('../public/js/calculator/tables/toefl-itp');
const toeicTable = require('../public/js/calculator/tables/toeic-lr');

describe('Score Calculator Engine & Config Tests', () => {

  test('IELTS Rounding - exact arithmetic half-band rules', () => {
    // 6.125 -> 6.0
    assert.strictEqual(engine.ieltsOverall(6.125), 6.0);
    // 6.25 -> 6.5
    assert.strictEqual(engine.ieltsOverall(6.25), 6.5);
    // 6.75 -> 7.0
    assert.strictEqual(engine.ieltsOverall(6.75), 7.0);
    // 6.874 -> 7.0
    assert.strictEqual(engine.ieltsOverall(6.874), 7.0);

    // Skill arrays producing these averages
    // [6.0, 6.0, 6.5, 6.0] -> sum = 24.5 / 4 = 6.125 -> 6.0
    assert.strictEqual(engine.ieltsOverall([6.0, 6.0, 6.5, 6.0]), 6.0);
    // [6.0, 6.5, 6.5, 6.0] -> sum = 25.0 / 4 = 6.25 -> 6.5
    assert.strictEqual(engine.ieltsOverall([6.0, 6.5, 6.5, 6.0]), 6.5);
    // [6.5, 7.0, 7.0, 6.5] -> sum = 27.0 / 4 = 6.75 -> 7.0
    assert.strictEqual(engine.ieltsOverall([6.5, 7.0, 7.0, 6.5]), 7.0);
  });

  test('Low raw handling - 0, 3, 5 for Listening and Reading are included and flagged', () => {
    // Listening (published table starts at 4 -> 2.5)
    const l0 = engine.lookupBand(listeningTable, 0);
    assert.deepStrictEqual(l0, { band: 2.0, belowTable: true });

    const l3 = engine.lookupBand(listeningTable, 3);
    assert.deepStrictEqual(l3, { band: 2.0, belowTable: true });

    const l5 = engine.lookupBand(listeningTable, 5);
    assert.deepStrictEqual(l5, { band: 2.5, belowTable: false });

    // Reading (published table starts at 6 -> 2.5)
    const r0 = engine.lookupBand(readingTable, 0);
    assert.deepStrictEqual(r0, { band: 2.0, belowTable: true });

    const r3 = engine.lookupBand(readingTable, 3);
    assert.deepStrictEqual(r3, { band: 2.0, belowTable: true });

    const r5 = engine.lookupBand(readingTable, 5);
    assert.deepStrictEqual(r5, { band: 2.0, belowTable: true });

    const r6 = engine.lookupBand(readingTable, 6);
    assert.deepStrictEqual(r6, { band: 2.5, belowTable: false });
  });

  test('Partial skills - allows computing overall for 1, 2, 3 or 4 skills', () => {
    // 1 skill
    assert.strictEqual(engine.ieltsOverall([6.0]), 6.0);
    // 2 skills
    assert.strictEqual(engine.ieltsOverall([6.0, 7.0]), 6.5);
    // 3 skills
    assert.strictEqual(engine.ieltsOverall([6.0, 6.5, 7.0]), 6.5);
    // 4 skills (sum = 27, mean = 6.75 -> 7.0)
    assert.strictEqual(engine.ieltsOverall([6.0, 6.5, 7.0, 7.5]), 7.0);
  });

  test('Old inflation case - section with 4 correct no longer disappears', () => {
    // In old code, 4 correct in reading returned null and was skipped in calculation.
    // If student had raw scores [4, 30] (where 30 -> 6.0), 4 was skipped and overall was 6.0.
    const r4 = engine.lookupBand(readingTable, 4);
    assert.notStrictEqual(r4, null);
    assert.strictEqual(r4.band, 2.0);
    assert.strictEqual(r4.belowTable, true);

    const r30 = engine.lookupBand(readingTable, 30);
    assert.strictEqual(r30.band, 6.0);

    // With both sections included, overall is average of 2.0 and 6.0 = 4.0 (not inflated to 6.0)
    const overall = engine.ieltsOverall([r4.band, r30.band]);
    assert.strictEqual(overall, 4.0);
  });

  test('TOEFL ITP totals and range validation', () => {
    // 55 + 55 + 55 -> 550
    assert.strictEqual(engine.toeflItpTotal(55, 55, 55), 550);
    // 31 + 31 + 31 -> 310
    assert.strictEqual(engine.toeflItpTotal(31, 31, 31), 310);
    // 68 + 68 + 67 -> 677
    assert.strictEqual(engine.toeflItpTotal(68, 68, 67), 677);

    // Also supports array or object
    assert.strictEqual(engine.toeflItpTotal([55, 55, 55]), 550);
    assert.strictEqual(engine.toeflItpTotal({ listening: 55, structure: 55, reading: 55 }), 550);

    // Range validation
    assert.strictEqual(engine.validateToeflItp(55, 55, 55).valid, true);
    assert.strictEqual(engine.validateToeflItp(31, 31, 31).valid, true);
    assert.strictEqual(engine.validateToeflItp(68, 68, 67).valid, true);

    // Out of range: L < 31 or > 68
    assert.strictEqual(engine.validateToeflItp(30, 50, 50).valid, false);
    assert.strictEqual(engine.validateToeflItp(69, 50, 50).valid, false);

    // Out of range: S < 31 or > 68
    assert.strictEqual(engine.validateToeflItp(50, 30, 50).valid, false);
    assert.strictEqual(engine.validateToeflItp(50, 69, 50).valid, false);

    // Out of range: R < 31 or > 67
    assert.strictEqual(engine.validateToeflItp(50, 50, 30).valid, false);
    assert.strictEqual(engine.validateToeflItp(50, 50, 68).valid, false);
  });

  test('TOEIC totals and validation', () => {
    // Total = L + R
    assert.strictEqual(engine.toeicTotal(350, 350), 700);
    assert.strictEqual(engine.toeicTotal(5, 5), 10);
    assert.strictEqual(engine.toeicTotal(495, 495), 990);

    // Array and object support
    assert.strictEqual(engine.toeicTotal([350, 350]), 700);
    assert.strictEqual(engine.toeicTotal({ listening: 350, reading: 350 }), 700);

    // Validation
    assert.strictEqual(engine.validateToeic(350, 350).valid, true);
    assert.strictEqual(engine.validateToeic(5, 5).valid, true);
    assert.strictEqual(engine.validateToeic(495, 495).valid, true);

    // Invalid range
    assert.strictEqual(engine.validateToeic(0, 350).valid, false);
    assert.strictEqual(engine.validateToeic(500, 350).valid, false);
    assert.strictEqual(engine.validateToeic(350, 0).valid, false);
    assert.strictEqual(engine.validateToeic(350, 500).valid, false);

    // Invalid step (not multiple of 5)
    assert.strictEqual(engine.validateToeic(352, 350).valid, false);
    assert.strictEqual(engine.validateToeic(350, 353).valid, false);
  });

  test('RP and General results identical to old implementation for sample inputs', () => {
    // RP sample inputs
    const rpCases = [
      { input: [0], expectedScore: 10.0, expectedGrade: 'Excellent' },
      { input: [3], expectedScore: 9.0, expectedGrade: 'Excellent' },
      { input: [8], expectedScore: 8.0, expectedGrade: 'Good' },
      { input: [14], expectedScore: 7.0, expectedGrade: 'Good' },
      { input: [18], expectedScore: 6.0, expectedGrade: 'Fair' },
      { input: [22], expectedScore: 5.0, expectedGrade: 'Below standard' },
      { input: [30], expectedScore: 4.0, expectedGrade: 'Below standard' },
      { input: [2, 7], expectedScore: 8.5, expectedGrade: 'Good' },
      { input: [0, 26], expectedScore: 7.0, expectedGrade: 'Good' },
      { input: [12, 19, 28], expectedScore: 5.7, expectedGrade: 'Below standard' }
    ];

    for (const c of rpCases) {
      const res = engine.calculateRp(c.input);
      assert.strictEqual(res.rounded, c.expectedScore, `RP mismatch for input ${c.input}`);
      assert.strictEqual(res.grade.label, c.expectedGrade, `RP grade mismatch for input ${c.input}`);
    }

    // General sample inputs
    const genCases = [
      { input: [{ correct: 20, total: 25 }], expectedScore: 8.0, expectedGrade: 'Good' },
      { input: [{ correct: 9, total: 10 }], expectedScore: 9.0, expectedGrade: 'Excellent' },
      { input: [{ correct: 6, total: 10 }], expectedScore: 6.0, expectedGrade: 'Fair' },
      { input: [{ correct: 5, total: 10 }], expectedScore: 5.0, expectedGrade: 'Below standard' },
      { input: [{ correct: 20, total: 25 }, { correct: 18, total: 20 }], expectedScore: 8.5, expectedGrade: 'Good' }
    ];

    for (const c of genCases) {
      const res = engine.calculateGeneral(c.input);
      assert.strictEqual(res.rounded, c.expectedScore, `General mismatch for input ${JSON.stringify(c.input)}`);
      assert.strictEqual(res.grade.label, c.expectedGrade, `General grade mismatch for input ${JSON.stringify(c.input)}`);
    }
  });

  test('Table lookup boundaries', () => {
    // Listening Table Boundaries
    assert.strictEqual(engine.lookupBand(listeningTable, 40).band, 9.0);
    assert.strictEqual(engine.lookupBand(listeningTable, 39).band, 9.0);
    assert.strictEqual(engine.lookupBand(listeningTable, 38).band, 8.5);
    assert.strictEqual(engine.lookupBand(listeningTable, 37).band, 8.5);
    assert.strictEqual(engine.lookupBand(listeningTable, 36).band, 8.0);
    assert.strictEqual(engine.lookupBand(listeningTable, 35).band, 8.0);
    assert.strictEqual(engine.lookupBand(listeningTable, 12).band, 4.0);
    assert.strictEqual(engine.lookupBand(listeningTable, 10).band, 4.0);
    assert.strictEqual(engine.lookupBand(listeningTable, 9).band, 3.5);
    assert.strictEqual(engine.lookupBand(listeningTable, 8).band, 3.5);
    assert.strictEqual(engine.lookupBand(listeningTable, 7).band, 3.0);
    assert.strictEqual(engine.lookupBand(listeningTable, 6).band, 3.0);
    assert.strictEqual(engine.lookupBand(listeningTable, 5).band, 2.5);
    assert.strictEqual(engine.lookupBand(listeningTable, 4).band, 2.5);

    // Reading Table Boundaries
    assert.strictEqual(engine.lookupBand(readingTable, 40).band, 9.0);
    assert.strictEqual(engine.lookupBand(readingTable, 39).band, 8.5);
    assert.strictEqual(engine.lookupBand(readingTable, 38).band, 8.0);
    assert.strictEqual(engine.lookupBand(readingTable, 37).band, 8.0);
    assert.strictEqual(engine.lookupBand(readingTable, 8).band, 2.5);
    assert.strictEqual(engine.lookupBand(readingTable, 6).band, 2.5);

    // Out of bounds raw scores
    assert.strictEqual(engine.lookupBand(listeningTable, -1), null);
    assert.strictEqual(engine.lookupBand(listeningTable, 41), null);
    assert.strictEqual(engine.lookupBand(readingTable, -5), null);
    assert.strictEqual(engine.lookupBand(readingTable, 45), null);
  });

  test('Config validation - tables sorted descending by minRaw, no gaps, goals unified', () => {
    // Unified Goals object
    assert.strictEqual(config.goals.ielts, 6.5);
    assert.strictEqual(config.goals['toefl-itp'], 550);
    assert.strictEqual(config.goals.toeic, 750);

    const tablesToTest = [
      { name: 'ielts-listening', table: listeningTable },
      { name: 'ielts-reading-center', table: readingTable }
    ];

    for (const { name, table } of tablesToTest) {
      assert.ok(table.rows.length > 0, `${name} has empty rows`);
      let prevMin = null;

      for (let i = 0; i < table.rows.length; i++) {
        const [minRaw, band] = table.rows[i];
        assert.ok(typeof minRaw === 'number', `${name} row ${i} minRaw is not number`);
        assert.ok(typeof band === 'number', `${name} row ${i} band is not number`);

        if (prevMin !== null) {
          // Strictly descending
          assert.ok(minRaw < prevMin, `${name} row ${i} (${minRaw}) is not strictly less than prev (${prevMin})`);
          // No integer gaps between brackets
          // Previous row started at prevMin, so it covered down to prevMin.
          // This row covers up to prevMin - 1, starting at minRaw.
          // Therefore, minRaw must be <= prevMin - 1.
          assert.strictEqual(minRaw <= prevMin - 1, true, `${name} gap detected between ${minRaw} and ${prevMin}`);
        }
        prevMin = minRaw;
      }
    }
  });

  test('Render test - views/score-calculator.ejs has no inline event handlers and no inline script', async (t) => {
    const origLoader = ejs.fileLoader;
    t.after(() => {
      ejs.fileLoader = origLoader;
    });

    ejs.fileLoader = function (filePath) {
      if (filePath.includes('partials/header') || filePath.includes('partials\\header')) {
        return '<!DOCTYPE html><html><head><title>Test</title></head><body>';
      }
      if (filePath.includes('partials/footer') || filePath.includes('partials\\footer')) {
        return '</body></html>';
      }
      return origLoader(filePath);
    };

    const calcViewPath = path.resolve('views/score-calculator.ejs');
    const html = await ejs.renderFile(calcViewPath, {
      title: 'Calculator'
    });

    const dom = new JSDOM(html);
    const document = dom.window.document;

    // 1. Assert no attribute starting with "on" (e.g. onclick, oninput, onchange)
    const allElements = document.querySelectorAll('*');
    const onAttributesFound = [];

    allElements.forEach((el) => {
      for (const attr of el.attributes) {
        if (/^on/i.test(attr.name)) {
          onAttributesFound.push({
            tag: el.tagName.toLowerCase(),
            attribute: attr.name,
            value: attr.value
          });
        }
      }
    });

    assert.deepStrictEqual(
      onAttributesFound,
      [],
      `Found forbidden inline event handlers: ${JSON.stringify(onAttributesFound)}`
    );

    // 2. Assert no inline executable <script> tags (all scripts must have src)
    const scripts = document.querySelectorAll('script');
    const inlineScripts = [];

    scripts.forEach((script) => {
      const src = script.getAttribute('src');
      const text = script.textContent.trim();
      if (!src && text.length > 0) {
        inlineScripts.push(text);
      }
    });

    assert.deepStrictEqual(
      inlineScripts,
      [],
      `Found forbidden inline executable scripts: ${JSON.stringify(inlineScripts)}`
    );

    // 3. Verify that external script tags are loaded
    const scriptSrcs = Array.from(scripts).map(s => s.getAttribute('src')).filter(Boolean);
    assert.ok(scriptSrcs.includes('/js/calculator/engine.js'), 'engine.js missing from script src');
    assert.ok(scriptSrcs.includes('/js/calculator/tests-config.js'), 'tests-config.js missing from script src');
    assert.ok(scriptSrcs.includes('/js/calculator/ui.js'), 'ui.js missing from script src');
  });

  test('DOM Interaction test - tab switching and score calculation in UI', async (t) => {
    const origLoader = ejs.fileLoader;
    t.after(() => {
      ejs.fileLoader = origLoader;
    });

    ejs.fileLoader = function (filePath) {
      if (filePath.includes('partials/header') || filePath.includes('partials\\header')) {
        return '<!DOCTYPE html><html><head><title>Test</title></head><body>';
      }
      if (filePath.includes('partials/footer') || filePath.includes('partials\\footer')) {
        return '</body></html>';
      }
      return origLoader(filePath);
    };

    const calcViewPath = path.resolve('views/score-calculator.ejs');
    const html = await ejs.renderFile(calcViewPath, { title: 'Calculator' });

    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const { window } = dom;
    const { document } = window;

    // Attach globals to the simulated window
    window.ScoreEngine = engine;
    window.CalculatorConfig = config;
    window.CalculatorTables = {
      'ielts-listening': listeningTable,
      'ielts-reading-center': readingTable,
      'toefl-itp': toeflTable,
      'toeic-lr': toeicTable
    };

    global.window = window;
    global.document = document;
    t.after(() => {
      delete global.window;
      delete global.document;
    });

    const uiModule = require('../public/js/calculator/ui');
    // Initialize in window context
    uiModule.init();

    // 1. Verify all 5 student cards initialized
    assert.ok(document.querySelector('#rp-students-container .student-card'), 'RP initial student missing');
    assert.ok(document.querySelector('#gen-students-container .student-card'), 'General initial student missing');
    assert.ok(document.querySelector('#ielts-students-container .student-card'), 'IELTS initial student missing');
    assert.ok(document.querySelector('#toefl-itp-students-container .student-card'), 'TOEFL initial student missing');
    assert.ok(document.querySelector('#toeic-students-container .student-card'), 'TOEIC initial student missing');

    // 2. Tab switching
    const toeflTabBtn = document.querySelector('[data-calc-tab="toefl-itp"]');
    assert.ok(toeflTabBtn);
    toeflTabBtn.click();
    assert.strictEqual(document.getElementById('panel-toefl-itp').classList.contains('hidden'), false);
    assert.strictEqual(document.getElementById('panel-rp').classList.contains('hidden'), true);

    // 3. IELTS calculation with low scores & below-table flag
    const ieltsCard = document.querySelector('#ielts-students-container .student-card');
    const listeningInput = ieltsCard.querySelector('[data-skill="listening"]');
    const readingInput = ieltsCard.querySelector('[data-skill="reading"]');
    const writingInput = ieltsCard.querySelector('[data-skill="writing"]');

    // Set listening = 0 (below table)
    listeningInput.value = '0';
    listeningInput.dispatchEvent(new window.Event('input'));

    const lNote = ieltsCard.querySelector('[data-below-table="listening"]');
    assert.strictEqual(lNote.classList.contains('hidden'), false);
    assert.ok(lNote.textContent.includes('below the conversion table, counted as 2.0'));

    // Set reading = 4 (below table)
    readingInput.value = '4';
    readingInput.dispatchEvent(new window.Event('input'));

    const rNote = ieltsCard.querySelector('[data-below-table="reading"]');
    assert.strictEqual(rNote.classList.contains('hidden'), false);
    assert.ok(rNote.textContent.includes('below the conversion table, counted as 2.0'));

    // Set writing = 6.5
    writingInput.value = '6.5';
    writingInput.dispatchEvent(new window.Event('input'));

    // Bands: 2.0, 2.0, 6.5 -> mean = 10.5 / 3 = 3.5 -> overall 3.5
    const ieltsScore = ieltsCard.querySelector('.final-score');
    assert.strictEqual(ieltsScore.textContent, '3.5');

    const ieltsCalc = ieltsCard.querySelector('.calc-string');
    assert.ok(ieltsCalc.textContent.includes('based on 3 of 4 skills'));

    // 4. TOEFL ITP calculation
    const toeflCard = document.querySelector('#toefl-itp-students-container .student-card');
    const toeflL = toeflCard.querySelector('[data-toefl-section="listening"]');
    const toeflS = toeflCard.querySelector('[data-toefl-section="structure"]');
    const toeflR = toeflCard.querySelector('[data-toefl-section="reading"]');

    toeflL.value = '55';
    toeflS.value = '55';
    toeflR.value = '55';
    toeflL.dispatchEvent(new window.Event('input'));
    toeflS.dispatchEvent(new window.Event('input'));
    toeflR.dispatchEvent(new window.Event('input'));

    const toeflScore = toeflCard.querySelector('.final-score');
    assert.strictEqual(toeflScore.textContent, '550');
    const toeflBadge = toeflCard.querySelector('.grade-badge');
    assert.strictEqual(toeflBadge.textContent, 'Goal met (550)');

    // 5. TOEIC calculation
    const toeicCard = document.querySelector('#toeic-students-container .student-card');
    const toeicL = toeicCard.querySelector('[data-toeic-section="listening"]');
    const toeicR = toeicCard.querySelector('[data-toeic-section="reading"]');

    toeicL.value = '350';
    toeicR.value = '350';
    toeicL.dispatchEvent(new window.Event('input'));
    toeicR.dispatchEvent(new window.Event('input'));

    const toeicScore = toeicCard.querySelector('.final-score');
    assert.strictEqual(toeicScore.textContent, '700');
    const toeicBadge = toeicCard.querySelector('.grade-badge');
    assert.strictEqual(toeicBadge.textContent, '50 more points needed');
  });

});
