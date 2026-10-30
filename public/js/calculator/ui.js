(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define(['ScoreEngine', 'CalculatorConfig', 'CalculatorTables'], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./engine'),
      require('./tests-config'),
      {
        'ielts-listening': require('./tables/ielts-listening'),
        'ielts-reading-center': require('./tables/ielts-reading-center'),
        'toefl-itp': require('./tables/toefl-itp'),
        'toeic-lr': require('./tables/toeic-lr')
      }
    );
  } else {
    root.CalculatorUI = factory(root.ScoreEngine, root.CalculatorConfig, root.CalculatorTables);
  }
}(typeof self !== 'undefined' ? self : this, function (engine, config, tables) {
  'use strict';

  var currentEngine = engine;
  var currentConfig = config;
  var currentTables = tables || {};

  function getDoc() {
    if (typeof document !== 'undefined') return document;
    if (typeof window !== 'undefined' && window.document) return window.document;
    if (typeof global !== 'undefined' && global.window && global.window.document) return global.window.document;
    return null;
  }

  function resolveTables() {
    var win = typeof window !== 'undefined' ? window : (typeof global !== 'undefined' && global.window ? global.window : null);
    if (win) {
      if (win.CalculatorTables) currentTables = win.CalculatorTables;
      if (win.ScoreEngine) currentEngine = win.ScoreEngine;
      if (win.CalculatorConfig) currentConfig = win.CalculatorConfig;
    }
  }

  /* ── Tab Switching ─────────────────────────────────────────── */
  function switchTab(tabId) {
    var doc = getDoc();
    if (!doc) return;

    var panels = doc.querySelectorAll('.panel');
    panels.forEach(function (p) {
      p.classList.add('hidden');
    });

    var tabButtons = doc.querySelectorAll('[data-calc-tab]');
    tabButtons.forEach(function (b) {
      b.classList.remove('bg-white', 'shadow-sm', 'text-slate-800');
      b.classList.add('text-slate-500');
    });

    var activePanel = doc.getElementById('panel-' + tabId);
    if (activePanel) {
      activePanel.classList.remove('hidden');
    }

    var activeBtn = doc.querySelector('[data-calc-tab="' + tabId + '"]');
    if (activeBtn) {
      activeBtn.classList.add('bg-white', 'shadow-sm', 'text-slate-800');
      activeBtn.classList.remove('text-slate-500');
    }
  }

  /* ══════════════════════════════════════════════════════════ */
  /* RP Score UI                                                */
  /* ══════════════════════════════════════════════════════════ */
  function addRpTopic(card) {
    var doc = getDoc();
    if (!doc) return;
    var tpl = doc.getElementById('rp-topic-tpl');
    if (!tpl) return;
    var pill = tpl.content.cloneNode(true).querySelector('.topic-pill');
    var list = card.querySelector('.topics-list');

    function relabel() {
      list.querySelectorAll('.topic-label').forEach(function (el, i) {
        el.textContent = 'T' + (i + 1);
      });
    }

    pill.querySelector('.remove-topic-btn').addEventListener('click', function () {
      pill.remove();
      relabel();
      rpRecalc(card);
    });

    var input = pill.querySelector('.topic-input');
    var scoreSpan = pill.querySelector('.topic-score');
    input.addEventListener('input', function () {
      var v = input.value.trim();
      scoreSpan.textContent = (v !== '' && !isNaN(+v)) ? '→ ' + currentEngine.mistakesToScore(+v) : '';
      rpRecalc(card);
    });

    list.appendChild(pill);
    relabel();
  }

  function rpRecalc(card) {
    var mistakes = [];
    card.querySelectorAll('.topic-input').forEach(function (inp) {
      var v = inp.value.trim();
      if (v !== '' && !isNaN(+v)) {
        mistakes.push(+v);
      }
    });

    var calcEl = card.querySelector('.calc-string');
    var scoreEl = card.querySelector('.final-score');
    var badgeEl = card.querySelector('.grade-badge');

    if (!mistakes.length) {
      calcEl.textContent = '—';
      scoreEl.textContent = '—';
      badgeEl.classList.add('hidden');
      return;
    }

    var result = currentEngine.calculateRp(mistakes);
    if (!result) return;

    calcEl.textContent = result.scores.length === 1
      ? result.mistakes[0] + ' mistakes → ' + result.scores[0].toFixed(1)
      : result.mistakes.join(' + ') + ' → ' + result.scores.map(function (s) { return s.toFixed(0); }).join(' + ') + ' = ' + result.sum + ' ÷ ' + result.scores.length + ' = ' + result.rounded.toFixed(1);

    scoreEl.textContent = result.rounded.toFixed(1);
    var g = currentEngine.rpGradeInfo(result.rounded);
    badgeEl.textContent = g.label;
    badgeEl.className = 'grade-badge text-xs font-semibold px-2.5 py-1 rounded-full ' + g.cls;
    badgeEl.classList.remove('hidden');
  }

  function addRpStudent() {
    var doc = getDoc();
    if (!doc) return null;
    var tpl = doc.getElementById('rp-student-tpl');
    if (!tpl) return null;
    var card = tpl.content.cloneNode(true).querySelector('.student-card');
    var avatar = card.querySelector('.avatar');
    var nameInput = card.querySelector('.name-input');

    nameInput.addEventListener('input', function () {
      avatar.textContent = nameInput.value.trim() ? nameInput.value.trim()[0].toUpperCase() : '?';
    });

    card.querySelector('.remove-btn').addEventListener('click', function () {
      card.remove();
    });

    var addTopicBtn = card.querySelector('.add-topic-btn');
    if (addTopicBtn) {
      addTopicBtn.addEventListener('click', function () {
        addRpTopic(card);
      });
    }

    var container = doc.getElementById('rp-students-container');
    if (container) {
      container.appendChild(card);
      addRpTopic(card);
      addRpTopic(card);
      nameInput.focus();
    }
    return card;
  }

  /* ══════════════════════════════════════════════════════════ */
  /* General Score UI                                           */
  /* ══════════════════════════════════════════════════════════ */
  function addGenTopic(card) {
    var doc = getDoc();
    if (!doc) return;
    var tpl = doc.getElementById('gen-topic-tpl');
    if (!tpl) return;
    var pill = tpl.content.cloneNode(true).querySelector('.topic-pill');
    var list = card.querySelector('.topics-list');

    function relabel() {
      list.querySelectorAll('.topic-label').forEach(function (el, i) {
        el.textContent = 'T' + (i + 1);
      });
    }

    pill.querySelector('.remove-topic-btn').addEventListener('click', function () {
      pill.remove();
      relabel();
      genRecalc(card);
    });

    var correctInput = pill.querySelector('.correct-input');
    var totalInput = pill.querySelector('.total-input');
    var scoreSpan = pill.querySelector('.topic-score');

    function updateScore() {
      var c = parseFloat(correctInput.value);
      var t = parseFloat(totalInput.value);
      scoreSpan.textContent = (!isNaN(c) && !isNaN(t) && t > 0) ? '→ ' + ((c / t) * 10).toFixed(1) : '';
      genRecalc(card);
    }

    correctInput.addEventListener('input', updateScore);
    totalInput.addEventListener('input', updateScore);
    list.appendChild(pill);
    relabel();
  }

  function genRecalc(card) {
    var topics = [];
    card.querySelectorAll('.topic-pill').forEach(function (pill) {
      var c = parseFloat(pill.querySelector('.correct-input').value);
      var t = parseFloat(pill.querySelector('.total-input').value);
      if (!isNaN(c) && !isNaN(t) && t > 0) {
        topics.push({ correct: c, total: t });
      }
    });

    var calcEl = card.querySelector('.calc-string');
    var scoreEl = card.querySelector('.final-score');
    var badgeEl = card.querySelector('.grade-badge');

    if (!topics.length) {
      calcEl.textContent = '—';
      scoreEl.textContent = '—';
      badgeEl.classList.add('hidden');
      return;
    }

    var result = currentEngine.calculateGeneral(topics);
    if (!result) return;

    calcEl.textContent = result.scores.length === 1
      ? result.parts[0]
      : result.parts.join(',  ') + '  =  avg ' + result.rounded.toFixed(1);

    scoreEl.textContent = result.rounded.toFixed(1);
    var g = currentEngine.generalGradeInfo(result.rounded);
    badgeEl.textContent = g.label;
    badgeEl.className = 'grade-badge text-xs font-semibold px-2.5 py-1 rounded-full ' + g.cls;
    badgeEl.classList.remove('hidden');
  }

  function addGenStudent() {
    var doc = getDoc();
    if (!doc) return null;
    var tpl = doc.getElementById('gen-student-tpl');
    if (!tpl) return null;
    var card = tpl.content.cloneNode(true).querySelector('.student-card');
    var avatar = card.querySelector('.avatar');
    var nameInput = card.querySelector('.name-input');

    nameInput.addEventListener('input', function () {
      avatar.textContent = nameInput.value.trim() ? nameInput.value.trim()[0].toUpperCase() : '?';
    });

    card.querySelector('.remove-btn').addEventListener('click', function () {
      card.remove();
    });

    var addTopicBtn = card.querySelector('.add-topic-btn');
    if (addTopicBtn) {
      addTopicBtn.addEventListener('click', function () {
        addGenTopic(card);
      });
    }

    var container = doc.getElementById('gen-students-container');
    if (container) {
      container.appendChild(card);
      addGenTopic(card);
      addGenTopic(card);
      nameInput.focus();
    }
    return card;
  }

  /* ══════════════════════════════════════════════════════════ */
  /* IELTS UI (Unified 4 Skills)                                */
  /* ══════════════════════════════════════════════════════════ */
  function ieltsRecalc(card) {
    resolveTables();
    var listeningTable = currentTables['ielts-listening'];
    var readingTable = currentTables['ielts-reading-center'];

    var listeningInp = card.querySelector('[data-skill="listening"]');
    var readingInp = card.querySelector('[data-skill="reading"]');
    var writingInp = card.querySelector('[data-skill="writing"]');
    var speakingInp = card.querySelector('[data-skill="speaking"]');

    var lSpan = card.querySelector('[data-skill-display="listening"]');
    var rSpan = card.querySelector('[data-skill-display="reading"]');
    var wSpan = card.querySelector('[data-skill-display="writing"]');
    var sSpan = card.querySelector('[data-skill-display="speaking"]');

    var lNote = card.querySelector('[data-below-table="listening"]');
    var rNote = card.querySelector('[data-below-table="reading"]');

    var enteredBands = [];
    var parts = [];

    // 1. Listening
    var lVal = listeningInp ? listeningInp.value.trim() : '';
    if (lVal !== '' && !isNaN(+lVal) && +lVal >= 0 && +lVal <= 40) {
      var lLookup = currentEngine.lookupBand(listeningTable, +lVal);
      if (lLookup) {
        enteredBands.push(lLookup.band);
        parts.push('L: ' + lLookup.band.toFixed(1));
        if (lSpan) lSpan.textContent = '→ ' + lLookup.band.toFixed(1);
        if (lNote) {
          if (lLookup.belowTable) {
            lNote.textContent = 'below the conversion table, counted as ' + lLookup.band.toFixed(1);
            lNote.classList.remove('hidden');
          } else {
            lNote.classList.add('hidden');
          }
        }
      }
    } else {
      if (lSpan) lSpan.textContent = lVal !== '' ? '→ ?' : '';
      if (lNote) lNote.classList.add('hidden');
    }

    // 2. Reading
    var rVal = readingInp ? readingInp.value.trim() : '';
    if (rVal !== '' && !isNaN(+rVal) && +rVal >= 0 && +rVal <= 40) {
      var rLookup = currentEngine.lookupBand(readingTable, +rVal);
      if (rLookup) {
        enteredBands.push(rLookup.band);
        parts.push('R: ' + rLookup.band.toFixed(1));
        if (rSpan) rSpan.textContent = '→ ' + rLookup.band.toFixed(1);
        if (rNote) {
          if (rLookup.belowTable) {
            rNote.textContent = 'below the conversion table, counted as ' + rLookup.band.toFixed(1);
            rNote.classList.remove('hidden');
          } else {
            rNote.classList.add('hidden');
          }
        }
      }
    } else {
      if (rSpan) rSpan.textContent = rVal !== '' ? '→ ?' : '';
      if (rNote) rNote.classList.add('hidden');
    }

    // 3. Writing (direct band)
    var wVal = writingInp ? writingInp.value.trim() : '';
    if (wVal !== '' && !isNaN(+wVal) && +wVal >= 0 && +wVal <= 9) {
      var wBand = Math.round(+wVal * 2) / 2;
      enteredBands.push(wBand);
      parts.push('W: ' + wBand.toFixed(1));
      if (wSpan) wSpan.textContent = '→ ' + wBand.toFixed(1);
    } else {
      if (wSpan) wSpan.textContent = wVal !== '' ? '→ ?' : '';
    }

    // 4. Speaking (direct band)
    var sVal = speakingInp ? speakingInp.value.trim() : '';
    if (sVal !== '' && !isNaN(+sVal) && +sVal >= 0 && +sVal <= 9) {
      var sBand = Math.round(+sVal * 2) / 2;
      enteredBands.push(sBand);
      parts.push('S: ' + sBand.toFixed(1));
      if (sSpan) sSpan.textContent = '→ ' + sBand.toFixed(1);
    } else {
      if (sSpan) sSpan.textContent = sVal !== '' ? '→ ?' : '';
    }

    var calcEl = card.querySelector('.calc-string');
    var scoreEl = card.querySelector('.final-score');
    var badgeEl = card.querySelector('.grade-badge');

    if (!enteredBands.length) {
      calcEl.textContent = '—';
      scoreEl.textContent = '—';
      badgeEl.classList.add('hidden');
      return;
    }

    var overall = currentEngine.ieltsOverall(enteredBands);
    scoreEl.textContent = overall.toFixed(1);

    var skillsCountLabel = ' (based on ' + enteredBands.length + ' of 4 skills)';
    calcEl.textContent = parts.join(', ') + '  =  band ' + overall.toFixed(1) + skillsCountLabel;

    var g = currentEngine.ieltsBandInfo(overall);
    badgeEl.textContent = g.label;
    badgeEl.className = 'grade-badge text-xs font-semibold px-2.5 py-1 rounded-full ' + g.cls;
    badgeEl.classList.remove('hidden');
  }

  function addIeltsStudent() {
    var doc = getDoc();
    if (!doc) return null;
    var tpl = doc.getElementById('ielts-student-tpl');
    if (!tpl) return null;
    var card = tpl.content.cloneNode(true).querySelector('.student-card');
    var avatar = card.querySelector('.avatar');
    var nameInput = card.querySelector('.name-input');

    nameInput.addEventListener('input', function () {
      avatar.textContent = nameInput.value.trim() ? nameInput.value.trim()[0].toUpperCase() : '?';
    });

    card.querySelector('.remove-btn').addEventListener('click', function () {
      card.remove();
    });

    card.querySelectorAll('.skill-input').forEach(function (inp) {
      inp.addEventListener('input', function () {
        ieltsRecalc(card);
      });
    });

    var container = doc.getElementById('ielts-students-container');
    if (container) {
      container.appendChild(card);
      nameInput.focus();
    }
    return card;
  }

  /* ══════════════════════════════════════════════════════════ */
  /* TOEFL ITP UI                                               */
  /* ══════════════════════════════════════════════════════════ */
  function toeflRecalc(card) {
    var lInp = card.querySelector('[data-toefl-section="listening"]');
    var sInp = card.querySelector('[data-toefl-section="structure"]');
    var rInp = card.querySelector('[data-toefl-section="reading"]');

    var lVal = lInp ? lInp.value.trim() : '';
    var sVal = sInp ? sInp.value.trim() : '';
    var rVal = rInp ? rInp.value.trim() : '';

    var calcEl = card.querySelector('.calc-string');
    var scoreEl = card.querySelector('.final-score');
    var badgeEl = card.querySelector('.grade-badge');
    var goalEl = card.querySelector('.goal-gap');

    var l = Number(lVal);
    var s = Number(sVal);
    var r = Number(rVal);

    if (lVal === '' || sVal === '' || rVal === '' || isNaN(l) || isNaN(s) || isNaN(r)) {
      calcEl.textContent = 'Enter scaled scores for all 3 sections';
      scoreEl.textContent = '—';
      badgeEl.classList.add('hidden');
      if (goalEl) goalEl.textContent = '';
      return;
    }

    var valRes = currentEngine.validateToeflItp(l, s, r);
    if (!valRes.valid) {
      calcEl.textContent = valRes.errors.join(' ');
      scoreEl.textContent = '—';
      badgeEl.classList.add('hidden');
      if (goalEl) goalEl.textContent = '';
      return;
    }

    var total = currentEngine.toeflItpTotal(l, s, r);
    scoreEl.textContent = total;

    var goal = (currentConfig && currentConfig.goals && currentConfig.goals['toefl-itp']) || 550;
    var gap = currentEngine.calculateGoalGap(total, goal);

    calcEl.textContent = '(' + l + ' + ' + s + ' + ' + r + ') × 10 ÷ 3 = ' + total;

    if (gap.met) {
      badgeEl.textContent = 'Goal met (' + goal + ')';
      badgeEl.className = 'grade-badge text-xs font-semibold px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-700';
    } else {
      badgeEl.textContent = gap.message;
      badgeEl.className = 'grade-badge text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-100 text-amber-700';
    }
    badgeEl.classList.remove('hidden');
  }

  function addToeflStudent() {
    var doc = getDoc();
    if (!doc) return null;
    var tpl = doc.getElementById('toefl-itp-student-tpl');
    if (!tpl) return null;
    var card = tpl.content.cloneNode(true).querySelector('.student-card');
    var avatar = card.querySelector('.avatar');
    var nameInput = card.querySelector('.name-input');

    nameInput.addEventListener('input', function () {
      avatar.textContent = nameInput.value.trim() ? nameInput.value.trim()[0].toUpperCase() : '?';
    });

    card.querySelector('.remove-btn').addEventListener('click', function () {
      card.remove();
    });

    card.querySelectorAll('.toefl-input').forEach(function (inp) {
      inp.addEventListener('input', function () {
        toeflRecalc(card);
      });
    });

    var container = doc.getElementById('toefl-itp-students-container');
    if (container) {
      container.appendChild(card);
      nameInput.focus();
    }
    return card;
  }

  /* ══════════════════════════════════════════════════════════ */
  /* TOEIC UI                                                   */
  /* ══════════════════════════════════════════════════════════ */
  function toeicRecalc(card) {
    var lInp = card.querySelector('[data-toeic-section="listening"]');
    var rInp = card.querySelector('[data-toeic-section="reading"]');

    var lVal = lInp ? lInp.value.trim() : '';
    var rVal = rInp ? rInp.value.trim() : '';

    var calcEl = card.querySelector('.calc-string');
    var scoreEl = card.querySelector('.final-score');
    var badgeEl = card.querySelector('.grade-badge');

    var l = Number(lVal);
    var r = Number(rVal);

    if (lVal === '' || rVal === '' || isNaN(l) || isNaN(r)) {
      calcEl.textContent = 'Enter scaled scores for both sections (multiples of 5)';
      scoreEl.textContent = '—';
      badgeEl.classList.add('hidden');
      return;
    }

    var valRes = currentEngine.validateToeic(l, r);
    if (!valRes.valid) {
      calcEl.textContent = valRes.errors.join(' ');
      scoreEl.textContent = '—';
      badgeEl.classList.add('hidden');
      return;
    }

    var total = currentEngine.toeicTotal(l, r);
    scoreEl.textContent = total;

    var goal = (currentConfig && currentConfig.goals && currentConfig.goals.toeic) || 750;
    var gap = currentEngine.calculateGoalGap(total, goal);

    calcEl.textContent = 'L ' + l + ' + R ' + r + ' = ' + total;

    if (gap.met) {
      badgeEl.textContent = 'Goal met (' + goal + ')';
      badgeEl.className = 'grade-badge text-xs font-semibold px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-700';
    } else {
      badgeEl.textContent = gap.message;
      badgeEl.className = 'grade-badge text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-100 text-amber-700';
    }
    badgeEl.classList.remove('hidden');
  }

  function addToeicStudent() {
    var doc = getDoc();
    if (!doc) return null;
    var tpl = doc.getElementById('toeic-student-tpl');
    if (!tpl) return null;
    var card = tpl.content.cloneNode(true).querySelector('.student-card');
    var avatar = card.querySelector('.avatar');
    var nameInput = card.querySelector('.name-input');

    nameInput.addEventListener('input', function () {
      avatar.textContent = nameInput.value.trim() ? nameInput.value.trim()[0].toUpperCase() : '?';
    });

    card.querySelector('.remove-btn').addEventListener('click', function () {
      card.remove();
    });

    card.querySelectorAll('.toeic-input').forEach(function (inp) {
      inp.addEventListener('input', function () {
        toeicRecalc(card);
      });
    });

    var container = doc.getElementById('toeic-students-container');
    if (container) {
      container.appendChild(card);
      nameInput.focus();
    }
    return card;
  }

  /* ══════════════════════════════════════════════════════════ */
  /* Generic Student Adder & UI Initialization                   */
  /* ══════════════════════════════════════════════════════════ */
  function addStudent(testId) {
    if (testId === 'rp') return addRpStudent();
    if (testId === 'general') return addGenStudent();
    if (testId === 'ielts') return addIeltsStudent();
    if (testId === 'toefl-itp') return addToeflStudent();
    if (testId === 'toeic') return addToeicStudent();
    return null;
  }

  function init() {
    var doc = getDoc();
    if (!doc) return;

    resolveTables();

    // Attach click listeners to all tab buttons
    var tabButtons = doc.querySelectorAll('[data-calc-tab]');
    tabButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tabId = btn.getAttribute('data-calc-tab');
        if (tabId) {
          switchTab(tabId);
        }
      });
    });

    // Attach click listeners to all "Add Student" buttons
    var addButtons = doc.querySelectorAll('[data-add-student]');
    addButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var testId = btn.getAttribute('data-add-student');
        if (testId) {
          addStudent(testId);
        }
      });
    });

    // Add initial student for each test
    addRpStudent();
    addGenStudent();
    addIeltsStudent();
    addToeflStudent();
    addToeicStudent();
  }

  var doc = getDoc();
  if (doc) {
    if (doc.readyState === 'loading') {
      doc.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  return {
    init: init,
    switchTab: switchTab,
    addStudent: addStudent,
    addRpStudent: addRpStudent,
    addGenStudent: addGenStudent,
    addIeltsStudent: addIeltsStudent,
    addToeflStudent: addToeflStudent,
    addToeicStudent: addToeicStudent,
    rpRecalc: rpRecalc,
    genRecalc: genRecalc,
    ieltsRecalc: ieltsRecalc,
    toeflRecalc: toeflRecalc,
    toeicRecalc: toeicRecalc
  };
}));
