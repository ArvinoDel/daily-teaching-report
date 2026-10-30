(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CalculatorTables = root.CalculatorTables || {};
    root.CalculatorTables['ielts-reading-center'] = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  return {
    id: 'ielts-reading-center',
    name: 'Center reading table',
    source: 'Center generic reading conversion table (scores < 6 use floor band)',
    note: "verify with your center's official sheet",
    belowTableBand: 2.0,
    maxRaw: 40,
    rows: [
      [40, 9.0],
      [39, 8.5],
      [37, 8.0],
      [36, 7.5],
      [34, 7.0],
      [32, 6.5],
      [30, 6.0],
      [27, 5.5],
      [23, 5.0],
      [19, 4.5],
      [15, 4.0],
      [12, 3.5],
      [9, 3.0],
      [6, 2.5]
    ]
  };
}));

