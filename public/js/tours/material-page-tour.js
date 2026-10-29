/**
 * public/js/tours/material-page-tour.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Step configuration for the material details page guided tour.
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
    root.MATERIAL_PAGE_TOUR_STEPS = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  return [
    {
      id: 'notes',
      selector: '[data-tour="notes"]',
      title: 'Lesson reading notes',
      description: 'Read lesson guides, objectives, and teaching instructions prepared for this curriculum topic.',
    },
    {
      id: 'files',
      selector: '[data-tour="files"]',
      title: 'Files and links panel',
      description: 'Find worksheets, audio, video, and reference links grouped cleanly by file type.',
    },
    {
      id: 'slideshow',
      selector: '[data-tour="slideshow"]',
      title: 'Present slideshow',
      description: 'Open the lesson images as full-screen slides to show your class.',
      conditional: true,
    },
    {
      id: 'edit',
      selector: '[data-tour="edit"]',
      title: 'Edit material content',
      description: 'Update written lesson notes, upload new worksheets or audio files, and manage reference links.',
      conditional: true,
    },
    {
      id: 'help',
      selector: '[data-tour="help"]',
      title: 'Replay guided tour',
      description: 'Click this question mark button at any time to replay the walkthrough of this material page.',
    },
  ];
});
