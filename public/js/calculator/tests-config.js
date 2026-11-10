(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CalculatorConfig = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Centralized test goals configuration.
   * All center goals sit in this single config object.
   */
  var goals = {
    ielts: 6.5,
    'toefl-itp': 550,
    toeic: 750
  };

  /**
   * Declarative definitions for each test.
   */
  var tests = {
    rp: {
      id: 'rp',
      title: 'RP Score',
      themeColor: 'brand',
      type: 'dynamic-topics',
      inputHeading: 'Topics — Mistakes per topic',
      defaultTopicCount: 2,
      badgeRules: [
        { min: 9.0, label: 'Excellent', cls: 'bg-emerald-100 text-emerald-700' },
        { min: 7.0, label: 'Good',      cls: 'bg-sky-100 text-sky-700' },
        { min: 6.0, label: 'Fair',      cls: 'bg-amber-100 text-amber-700' },
        { min: 0.0, label: 'Below standard', cls: 'bg-red-100 text-red-600' }
      ]
    },

    general: {
      id: 'general',
      title: 'General Score',
      themeColor: 'violet',
      type: 'dynamic-ratio',
      inputHeading: 'Topics — Correct / Total',
      defaultTopicCount: 2,
      badgeRules: [
        { min: 9.0, label: 'Excellent', cls: 'bg-emerald-100 text-emerald-700' },
        { min: 7.0, label: 'Good',      cls: 'bg-sky-100 text-sky-700' },
        { min: 6.0, label: 'Fair',      cls: 'bg-amber-100 text-amber-700' },
        { min: 0.0, label: 'Below standard', cls: 'bg-red-100 text-red-600' }
      ]
    },

    ielts: {
      id: 'ielts',
      title: 'IELTS Band',
      themeColor: 'sky',
      type: 'skills',
      goal: goals.ielts,
      goalLabel: 'Good User',
      belowTableBand: 2.0,
      skills: [
        {
          id: 'listening',
          label: 'Listening',
          type: 'raw',
          min: 0,
          max: 40,
          step: 1,
          tableId: 'ielts-listening',
          denominator: '/40'
        },
        {
          id: 'reading',
          label: 'Reading',
          type: 'raw',
          min: 0,
          max: 40,
          step: 1,
          tableId: 'ielts-reading-center',
          // Documented place for Academic vs General Training reading tables:
          // Center currently uses one standard Reading conversion table ('ielts-reading-center').
          // When separate tables are provided by the center:
          // readingTypes: {
          //   academic: 'ielts-reading-academic',
          //   generalTraining: 'ielts-reading-gt'
          // },
          denominator: '/40'
        },
        {
          id: 'writing',
          label: 'Writing',
          type: 'band',
          min: 0,
          max: 9,
          step: 0.5,
          placeholder: '0.0'
        },
        {
          id: 'speaking',
          label: 'Speaking',
          type: 'band',
          min: 0,
          max: 9,
          step: 0.5,
          placeholder: '0.0'
        }
      ],
      badgeRules: [
        { min: 8.0, label: 'Expert',    cls: 'bg-emerald-100 text-emerald-700' },
        { min: 6.5, label: 'Good User', cls: 'bg-sky-100 text-sky-700' },
        { min: 5.0, label: 'Modest',    cls: 'bg-amber-100 text-amber-700' },
        { min: 0.0, label: 'Limited',   cls: 'bg-red-100 text-red-600' }
      ]
    },

    'toefl-itp': {
      id: 'toefl-itp',
      title: 'TOEFL ITP',
      themeColor: 'indigo',
      type: 'standardized-sections',
      goal: goals['toefl-itp'],
      goalLabel: 'Center Goal',
      scoreRange: { min: 310, max: 677 },
      tableId: 'toefl-itp',
      sections: [
        {
          id: 'listening',
          label: 'Listening Comprehension',
          shortLabel: 'Listening',
          scaled: { min: 31, max: 68, step: 1 },
          raw: { min: 0, max: 50, step: 1 }
        },
        {
          id: 'structure',
          label: 'Structure & Written Expression',
          shortLabel: 'Structure',
          scaled: { min: 31, max: 68, step: 1 },
          raw: { min: 0, max: 40, step: 1 }
        },
        {
          id: 'reading',
          label: 'Reading Comprehension',
          shortLabel: 'Reading',
          scaled: { min: 31, max: 67, step: 1 },
          raw: { min: 0, max: 50, step: 1 }
        }
      ]
    },

    toeic: {
      id: 'toeic',
      title: 'TOEIC Listening & Reading',
      themeColor: 'teal',
      type: 'standardized-sections',
      goal: goals.toeic,
      goalLabel: 'Center Goal',
      scoreRange: { min: 10, max: 990 },
      tableId: 'toeic-lr',
      sections: [
        {
          id: 'listening',
          label: 'Listening Comprehension',
          shortLabel: 'Listening',
          scaled: { min: 5, max: 495, step: 5 },
          raw: { min: 0, max: 100, step: 1 }
        },
        {
          id: 'reading',
          label: 'Reading Comprehension',
          shortLabel: 'Reading',
          scaled: { min: 5, max: 495, step: 5 },
          raw: { min: 0, max: 100, step: 1 }
        }
      ]
    }
  };

  return {
    goals: goals,
    tests: tests
  };
}));

