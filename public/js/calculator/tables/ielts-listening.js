(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CalculatorTables = root.CalculatorTables || {};
    root.CalculatorTables['ielts-listening'] = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  return {
    id: 'ielts-listening',
    name: 'IELTS Listening Conversion Table',
    source: 'Cambridge IELTS / British Council score conversion guidelines (low range 4–12 extended per Cambridge guidelines; scores < 4 use floor band)',
    note: "verify with your center's official sheet",
    belowTableBand: 2.0,
    maxRaw: 40,
    rows: [
      [39, 9.0],
      [37, 8.5],
      [35, 8.0],
      [32, 7.5],
      [30, 7.0],
      [26, 6.5],
      [23, 6.0],
      [18, 5.5],
      [16, 5.0],
      [13, 4.5],
      [10, 4.0],
      [8, 3.5],
      [6, 3.0],
      [4, 2.5]
    ]
  };
}));

