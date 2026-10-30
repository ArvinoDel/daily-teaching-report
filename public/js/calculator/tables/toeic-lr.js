/**
 * TOEIC Listening & Reading Form Conversion Tables
 *
 * README: Adding Official Test Forms
 * ----------------------------------
 * Official TOEIC test forms map raw scores (0-100 questions per section)
 * to scaled scores (5-495 per section, in increments of 5).
 * To add an official form, append an entry to the `forms` array below.
 *
 * Exact CSV-like format specification:
 * {
 *   id: 'FORM-01',
 *   name: 'TOEIC Official Practice Test 1',
 *   // Raw score ranges:
 *   // - Listening: 0 to 100 raw -> 5 to 495 scaled (multiples of 5)
 *   // - Reading: 0 to 100 raw -> 5 to 495 scaled (multiples of 5)
 *   //
 *   // Format: rows sorted descending by minRaw: [[minRaw, scaledScore], ...]
 *   // Example:
 *   // conversions: {
 *   //   listening: [
 *   //     [96, 495],
 *   //     [91, 490],
 *   //     ...
 *   //     [0, 5]
 *   //   ],
 *   //   reading: [
 *   //     [97, 495],
 *   //     ...
 *   //     [0, 5]
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
    root.CalculatorTables['toeic-lr'] = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  return {
    id: 'toeic-lr',
    name: 'TOEIC Listening & Reading Conversion Tables',
    forms: []
  };
}));

