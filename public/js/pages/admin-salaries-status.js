/**
 * public/js/pages/admin-salaries-status.js
 *
 * Client-side handlers for salary status management:
 * - Mark as paid (single & bulk)
 * - Reopen payment
 */
(function () {
  'use strict';

  function openModal(id) {
    const el = document.getElementById(id);
    if (el) {
      el.classList.remove('hidden');
      document.body.style.overflow = 'hidden';
    }
  }

  function closeModal(id) {
    const el = document.getElementById(id);
    if (el) {
      el.classList.add('hidden');
      document.body.style.overflow = '';
    }
  }

  // Handle single row "Mark as Paid"
  function openRowMarkPaid(e, el) {
    const salaryId = el.dataset.salaryId;
    const teacherName = el.dataset.teacherName || 'Teacher';
    const idsInput = document.getElementById('mark-paid-ids');
    const summary = document.getElementById('mark-paid-summary');
    const notice = document.getElementById('mark-paid-notice');

    if (idsInput) idsInput.value = salaryId;
    if (summary) summary.textContent = 'Marking payment for ' + teacherName;
    if (notice) {
      notice.textContent = '';
      notice.classList.add('hidden');
    }
    openModal('modal-mark-paid');
  }

  // Handle bulk "Mark as Paid"
  function openBulkMarkPaidModal() {
    const checkedBoxes = Array.from(document.querySelectorAll('.row-check:checked'));
    const idsInput = document.getElementById('mark-paid-ids');
    const summary = document.getElementById('mark-paid-summary');
    const notice = document.getElementById('mark-paid-notice');

    let publishedBoxes = [];
    let nonPublishedCount = 0;

    if (checkedBoxes.length === 0) {
      // If none selected, default to all published slips currently on screen
      publishedBoxes = Array.from(document.querySelectorAll('.row-check')).filter(function (cb) {
        return cb.dataset.status === 'published';
      });
    } else {
      publishedBoxes = checkedBoxes.filter(function (cb) {
        return cb.dataset.status === 'published';
      });
      nonPublishedCount = checkedBoxes.length - publishedBoxes.length;
    }

    const ids = publishedBoxes.map(function (cb) {
      return cb.dataset.salaryId;
    }).filter(Boolean);

    if (ids.length === 0) {
      alert('No published salary slips found to mark as paid.');
      return;
    }

    if (idsInput) idsInput.value = ids.join(',');
    if (summary) {
      summary.textContent = 'Marking ' + ids.length + ' published salary slip' + (ids.length !== 1 ? 's' : '') + ' as paid.';
    }

    if (notice) {
      if (nonPublishedCount > 0) {
        notice.textContent = nonPublishedCount + ' selected slip(s) are drafts or already paid and will be skipped.';
        notice.classList.remove('hidden');
      } else {
        notice.textContent = '';
        notice.classList.add('hidden');
      }
    }

    openModal('modal-mark-paid');
  }

  // Handle row "Reopen payment"
  function openRowReopen(e, el) {
    const salaryId = el.dataset.salaryId;
    const teacherName = el.dataset.teacherName || 'Teacher';
    const form = document.getElementById('form-reopen');
    const label = document.getElementById('reopen-teacher-label');
    const reasonInput = document.getElementById('reopen-reason');

    if (form) form.action = '/admin/salaries/' + salaryId + '/reopen';
    if (label) label.textContent = 'Reopening payment for ' + teacherName;
    if (reasonInput) reasonInput.value = '';

    openModal('modal-reopen');
  }

  if (typeof registerAction === 'function') {
    registerAction('openRowMarkPaid', openRowMarkPaid);
    registerAction('openBulkMarkPaidModal', openBulkMarkPaidModal);
    registerAction('openRowReopen', openRowReopen);
  }

  // Close modals on Escape key
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      ['modal-mark-paid', 'modal-reopen'].forEach(closeModal);
    }
  });
})();

