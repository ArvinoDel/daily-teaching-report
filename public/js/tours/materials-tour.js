/**
 * public/js/tours/materials-tour.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Step configuration for the materials library guided tour.
 * Follows copy rules:
 * - Plain text only (no HTML, no user data)
 * - Sentence case
 * - At most 160 characters per step
 * - Simple English
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MATERIALS_TOUR_STEPS = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  return [
    {
      id: 'search',
      selector: '[data-tour="search"]',
      title: 'Search materials',
      description: 'Type a material name to quickly find lesson notes, exercises, or curriculum documents.',
    },
    {
      id: 'level',
      selector: '[data-tour="level"]',
      title: 'Filter by level',
      description: 'Filter the list by course level to see materials created for specific student groups.',
    },
    {
      id: 'status',
      selector: '[data-tour="status"]',
      title: 'Content status',
      description: 'Switch between all materials, materials with content and materials that still need notes or files.',
    },
    {
      id: 'row-action',
      selector: '[data-tour="row-action"]',
      title: 'Open or add content',
      description: 'Click open to view lesson notes and files, or click add content to contribute teaching materials.',
    },
  ];
});
