/**
 * TOEFL ITP Form Conversion Tables
 *
 * README: Adding Official Test Forms
 * ----------------------------------
 * Official TOEFL ITP test forms convert raw section scores to scaled section scores.
 * To add an official form, append an entry to the `forms` array below.
 *
 * Exact CSV-like format specification:
 * Each form object should have the structure:
 * {
 *   id: 'FORM-01',
 *   name: 'Official Practice Form 1',
 *   // Raw score ranges:
 *   // - Listening Comprehension (Section 1): 0 to 50 raw -> 31 to 68 scaled
 *   // - Structure and Written Expression (Section 2): 0 to 40 raw -> 31 to 68 scaled
 *   // - Reading Comprehension (Section 3): 0 to 50 raw -> 31 to 67 scaled
 *   //
 *   // Format: rows sorted descending by minRaw: [[minRaw, scaledScore], ...]
 *   // Example:
 *   // conversions: {
 *   //   listening: [
 *   //     [50, 68],
 *   //     [49, 67],
 *   //     ...
 *   //     [0, 31]
 *   //   ],
 *   //   structure: [
 *   //     [40, 68],
 *   //     ...
 *   //     [0, 31]
 *   //   ],
 *   //   reading: [
 *   //     [50, 67],
 *   //     ...
 *   //     [0, 31]
 *   //   ]
 *   // }
 * }
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CalculatorTables = root.CalculatorTables || {};
    root.CalculatorTables['toefl-itp'] = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  return {
    id: 'toefl-itp',
    name: 'TOEFL ITP Conversion Tables',
    forms: []
  };
}));

