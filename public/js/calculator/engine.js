(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ScoreEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Pure rounding function: Round half-up to the nearest integer.
   * Ties (.5) round up towards +infinity.
   * @param {number} n
   * @returns {number}
   */
  function roundHalfUp(n) {
    if (typeof n !== 'number' || isNaN(n)) return NaN;
    return Math.floor(n + 0.5 + 1e-12);
  }

  /**
   * Look up a band score from a conversion table.
   * Table rows must be sorted descending by minRaw: [[minRaw, band], ...].
   * If raw is below the lowest minRaw, returns configured floor band with belowTable: true.
   * @param {Object} table
   * @param {number|string} raw
   * @param {Object} [options]
   * @returns {{ band: number, belowTable: boolean }|null}
   */
  function lookupBand(table, raw, options) {
    if (!table || !Array.isArray(table.rows) || table.rows.length === 0) return null;
    if (raw === null || raw === undefined || raw === '') return null;
    var num = Number(raw);
    if (isNaN(num)) return null;
    num = Math.round(num);
    if (num < 0) return null;
    if (typeof table.maxRaw === 'number' && num > table.maxRaw) return null;

    var rows = table.rows;
    for (var i = 0; i < rows.length; i++) {
      var minRaw = rows[i][0];
      var band = rows[i][1];
      if (num >= minRaw) {
        return { band: band, belowTable: false };
      }
    }

    var defaultFloor = 2.0;
    var floorBand = (options && typeof options.belowTableBand === 'number')
      ? options.belowTableBand
      : (typeof table.belowTableBand === 'number' ? table.belowTableBand : defaultFloor);

    return { band: floorBand, belowTable: true };
  }

  /**
   * Arithmetic mean of an array of band numbers.
   * @param {Array<number|{band: number}>} bands
   * @returns {number|null}
   */
  function averageBands(bands) {
    if (!bands) return null;
    var list = [];
    if (Array.isArray(bands)) {
      for (var i = 0; i < bands.length; i++) {
        var item = bands[i];
        var val = (typeof item === 'object' && item !== null && typeof item.band === 'number')
          ? item.band
          : Number(item);
        if (!isNaN(val) && val >= 0) {
          list.push(val);
        }
      }
    }
    if (list.length === 0) return null;
    var sum = list.reduce(function (a, b) { return a + b; }, 0);
    return sum / list.length;
  }

  /**
   * IELTS Overall Band Score calculation.
   * Computes the mean of the skill bands and rounds to nearest 0.5 using exact arithmetic:
   * x.25 goes up to x.5, x.75 up to next whole band (6.125 -> 6.0, 6.25 -> 6.5, 6.75 -> 7.0, 6.874 -> 7.0).
   * Supports both an array of bands/skills or an already calculated mean number.
   * @param {Array<number|{band: number}>|number} bands
   * @returns {number|null}
   */
  function ieltsOverall(bands) {
    var mean;
    if (typeof bands === 'number') {
      if (isNaN(bands)) return null;
      mean = bands;
    } else {
      mean = averageBands(bands);
      if (mean === null) return null;
    }
    return roundHalfUp(mean * 2) / 2;
  }

  /**
   * Helper to normalize TOEFL ITP input into { l, s, r }.
   */
  function parseToeflInput(scaled, optS, optR) {
    var l, s, r;
    if (typeof scaled === 'number' && typeof optS === 'number' && typeof optR === 'number') {
      l = scaled; s = optS; r = optR;
    } else if (Array.isArray(scaled)) {
      l = Number(scaled[0]); s = Number(scaled[1]); r = Number(scaled[2]);
    } else if (typeof scaled === 'object' && scaled !== null) {
      l = Number(scaled.listening !== undefined ? scaled.listening : scaled.L);
      s = Number(scaled.structure !== undefined ? scaled.structure : (scaled.S !== undefined ? scaled.S : scaled.swe));
      r = Number(scaled.reading !== undefined ? scaled.reading : scaled.R);
    }
    return { l: l, s: s, r: r };
  }

  /**
   * Range validation for TOEFL ITP sections:
   * Listening: 31-68
   * Structure & Written Expression: 31-68
   * Reading: 31-67
   * Total range: 310-677
   * @param {Object|Array|number} scaled
   * @param {number} [optS]
   * @param {number} [optR]
   * @returns {{ valid: boolean, errors: string[], l: number, s: number, r: number }}
   */
  function validateToeflItp(scaled, optS, optR) {
    var parsed = parseToeflInput(scaled, optS, optR);
    var errors = [];
    if (isNaN(parsed.l) || parsed.l < 31 || parsed.l > 68) {
      errors.push('Listening scaled score must be between 31 and 68.');
    }
    if (isNaN(parsed.s) || parsed.s < 31 || parsed.s > 68) {
      errors.push('Structure and Written Expression scaled score must be between 31 and 68.');
    }
    if (isNaN(parsed.r) || parsed.r < 31 || parsed.r > 67) {
      errors.push('Reading scaled score must be between 31 and 67.');
    }
    return {
      valid: errors.length === 0,
      errors: errors,
      l: parsed.l,
      s: parsed.s,
      r: parsed.r
    };
  }

  /**
   * TOEFL ITP total score calculation.
   * Total = roundHalfUp((L + S + R) * 10 / 3)
   * Range: 310 to 677.
   * @param {Object|Array|number} scaled
   * @param {number} [optS]
   * @param {number} [optR]
   * @returns {number|null}
   */
  function toeflItpTotal(scaled, optS, optR) {
    var parsed = parseToeflInput(scaled, optS, optR);
    if (isNaN(parsed.l) || isNaN(parsed.s) || isNaN(parsed.r)) return null;
    return roundHalfUp(((parsed.l + parsed.s + parsed.r) * 10) / 3);
  }

  /**
   * Helper to normalize TOEIC input into { l, r }.
   */
  function parseToeicInput(scaled, optR) {
    var l, r;
    if (typeof scaled === 'number' && typeof optR === 'number') {
      l = scaled; r = optR;
    } else if (Array.isArray(scaled)) {
      l = Number(scaled[0]); r = Number(scaled[1]);
    } else if (typeof scaled === 'object' && scaled !== null) {
      l = Number(scaled.listening !== undefined ? scaled.listening : scaled.L);
      r = Number(scaled.reading !== undefined ? scaled.reading : scaled.R);
    }
    return { l: l, r: r };
  }

  /**
   * Range and step validation for TOEIC sections:
   * Listening: 5-495 (step 5)
   * Reading: 5-495 (step 5)
   * Total: 10-990
   * @param {Object|Array|number} scaled
   * @param {number} [optR]
   * @returns {{ valid: boolean, errors: string[], l: number, r: number }}
   */
  function validateToeic(scaled, optR) {
    var parsed = parseToeicInput(scaled, optR);
    var errors = [];
    if (isNaN(parsed.l) || parsed.l < 5 || parsed.l > 495 || parsed.l % 5 !== 0) {
      errors.push('Listening scaled score must be between 5 and 495 (multiples of 5).');
    }
    if (isNaN(parsed.r) || parsed.r < 5 || parsed.r > 495 || parsed.r % 5 !== 0) {
      errors.push('Reading scaled score must be between 5 and 495 (multiples of 5).');
    }
    return {
      valid: errors.length === 0,
      errors: errors,
      l: parsed.l,
      r: parsed.r
    };
  }

  /**
   * TOEIC total score calculation.
   * Total = L + R
   * Range: 10 to 990.
   * @param {Object|Array|number} scaled
   * @param {number} [optR]
   * @returns {number|null}
   */
  function toeicTotal(scaled, optR) {
    var parsed = parseToeicInput(scaled, optR);
    if (isNaN(parsed.l) || isNaN(parsed.r)) return null;
    return parsed.l + parsed.r;
  }

  /* ══════════════════════════════════════════════════════════ */
  /* RP Score (Moved Unchanged from _scripts.ejs)                */
  /* ══════════════════════════════════════════════════════════ */
  function mistakesToScore(m) {
    if (m === 0)  return 10;
    if (m <= 5)   return 9;
    if (m <= 10)  return 8;
    if (m <= 15)  return 7;
    if (m <= 20)  return 6;
    if (m <= 25)  return 5;
    return 4;
  }

  function rpGradeInfo(avg) {
    if (avg >= 9) return { label: 'Excellent', cls: 'bg-emerald-100 text-emerald-700' };
    if (avg >= 7) return { label: 'Good',      cls: 'bg-sky-100 text-sky-700' };
    if (avg >= 6) return { label: 'Fair',      cls: 'bg-amber-100 text-amber-700' };
    return              { label: 'Below standard', cls: 'bg-red-100 text-red-600' };
  }

  function calculateRp(mistakes) {
    if (!Array.isArray(mistakes) || mistakes.length === 0) return null;
    var scores = [];
    var validMistakes = [];
    for (var i = 0; i < mistakes.length; i++) {
      var m = Number(mistakes[i]);
      if (!isNaN(m) && m >= 0) {
        validMistakes.push(m);
        scores.push(mistakesToScore(m));
      }
    }
    if (scores.length === 0) return null;
    var sum = scores.reduce(function (a, b) { return a + b; }, 0);
    var avg = sum / scores.length;
    var rounded = Math.round(avg * 10) / 10;
    return {
      mistakes: validMistakes,
      scores: scores,
      sum: sum,
      avg: avg,
      rounded: rounded,
      grade: rpGradeInfo(rounded)
    };
  }

  /* ══════════════════════════════════════════════════════════ */
  /* General Score (Moved Unchanged from _scripts.ejs)           */
  /* ══════════════════════════════════════════════════════════ */
  function generalGradeInfo(score) {
    if (score >= 9) return { label: 'Excellent', cls: 'bg-emerald-100 text-emerald-700' };
    if (score >= 7) return { label: 'Good',      cls: 'bg-sky-100 text-sky-700' };
    if (score >= 6) return { label: 'Fair',      cls: 'bg-amber-100 text-amber-700' };
    return              { label: 'Below standard', cls: 'bg-red-100 text-red-600' };
  }

  function calculateGeneral(topics) {
    if (!Array.isArray(topics) || topics.length === 0) return null;
    var scores = [];
    var parts = [];
    for (var i = 0; i < topics.length; i++) {
      var t = topics[i];
      var c = parseFloat(t.correct !== undefined ? t.correct : t[0]);
      var tot = parseFloat(t.total !== undefined ? t.total : t[1]);
      if (!isNaN(c) && !isNaN(tot) && tot > 0) {
        var s = (c / tot) * 10;
        scores.push(s);
        parts.push(c + '/' + tot + ' → ' + s.toFixed(1));
      }
    }
    if (scores.length === 0) return null;
    var sum = scores.reduce(function (a, b) { return a + b; }, 0);
    var avg = sum / scores.length;
    var rounded = Math.round(avg * 10) / 10;
    return {
      scores: scores,
      parts: parts,
      sum: sum,
      avg: avg,
      rounded: rounded,
      grade: generalGradeInfo(rounded)
    };
  }

  /* ══════════════════════════════════════════════════════════ */
  /* IELTS Band Info                                            */
  /* ══════════════════════════════════════════════════════════ */
  function ieltsBandInfo(band) {
    if (band >= 8.0) return { label: 'Expert',    cls: 'bg-emerald-100 text-emerald-700' };
    if (band >= 6.5) return { label: 'Good User', cls: 'bg-sky-100 text-sky-700' };
    if (band >= 5.0) return { label: 'Modest',    cls: 'bg-amber-100 text-amber-700' };
    return                  { label: 'Limited',   cls: 'bg-red-100 text-red-600' };
  }

  /**
   * Goal gap helper: calculates difference to goal.
   * @param {number} score
   * @param {number} goal
   * @returns {{ met: boolean, diff: number, message: string }}
   */
  function calculateGoalGap(score, goal) {
    if (typeof score !== 'number' || isNaN(score) || typeof goal !== 'number' || isNaN(goal)) {
      return null;
    }
    if (score >= goal) {
      return {
        met: true,
        diff: score - goal,
        message: 'Goal met'
      };
    }
    var gap = goal - score;
    var diffStr = Number.isInteger(gap) ? gap.toString() : gap.toFixed(1);
    return {
      met: false,
      diff: gap,
      message: diffStr + ' more point' + (gap === 1 ? '' : 's') + ' needed'
    };
  }

  return {
    roundHalfUp: roundHalfUp,
    lookupBand: lookupBand,
    averageBands: averageBands,
    ieltsOverall: ieltsOverall,
    toeflItpTotal: toeflItpTotal,
    validateToeflItp: validateToeflItp,
    toeicTotal: toeicTotal,
    validateToeic: validateToeic,
    mistakesToScore: mistakesToScore,
    rpGradeInfo: rpGradeInfo,
    calculateRp: calculateRp,
    generalGradeInfo: generalGradeInfo,
    calculateGeneral: calculateGeneral,
    ieltsBandInfo: ieltsBandInfo,
    calculateGoalGap: calculateGoalGap
  };
}));

