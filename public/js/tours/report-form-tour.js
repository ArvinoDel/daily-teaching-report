/**
 * public/js/tours/report-form-tour.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Step configuration for the report form guided tour.
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
    root.REPORT_FORM_TOUR_STEPS = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  return [
    {
      id: 'date',
      selector: '#date',
      title: 'Session date',
      description: 'Select the date when this teaching session took place. Reports are grouped by month on your dashboard.',
    },
    {
      id: 'session-type',
      selector: '#session-type-buttons',
      title: 'Session type',
      description: 'Choose group, private, or competition mode. A competition session requires at least two groups.',
    },
    {
      id: 'class-name',
      selector: '#class_name',
      alternativeSelectors: ['#private_name_input', '#competition-search'],
      title: 'Class or student name',
      description: 'Type or search for your group or student. Picking a group automatically loads its student roster below.',
      conditional: true,
    },
    {
      id: 'students',
      selector: '#manual-students-section',
      alternativeSelectors: ['#student-roster'],
      title: 'Student attendance and cards',
      description: 'Tag students with achievement cards (+AC), deduct cards (-AC), or mark them absent for this class session.',
    },
    {
      id: 'subject',
      selector: '#subject',
      title: 'Course material',
      description: 'Type or select the course material. When content exists, an open material link appears for quick access.',
    },
    {
      id: 'teaching-type',
      selector: '#teaching_type',
      title: 'Teaching type and duration',
      description: 'Your teaching type determines your reward rate for this session. Duration in minutes counts toward your teaching hours.',
    },
    {
      id: 'partner-teacher',
      selector: '#partner-teacher-section',
      title: 'Partner teacher',
      description: 'Tag your prime or partner teacher when teaching an assisted or split class. A copy is added to their reports.',
      conditional: true,
    },
    {
      id: 'notes',
      selector: '#notes',
      title: 'Class notes',
      description: 'Add optional notes about student progress, topics covered, or reminders for upcoming classes.',
    },
    {
      id: 'submit',
      selector: '#btn-add-class',
      alternativeSelectors: ['#btn-main-submit'],
      title: 'Add another class and submit',
      description: 'Use add another class to record multiple sessions for the same day, then save to submit your reports.',
    },
  ];
});
