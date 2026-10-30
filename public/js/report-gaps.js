'use strict';

/**
 * report-gaps.js
 * Client-side event controller for possible missing reports and no-class dates.
 * Built with standard event delegation on data-action attributes.
 * Zero inline scripts or inline handlers.
 */

(function () {
  function showAlert(msg, isError) {
    const box = document.getElementById('gap-alert-box');
    const text = document.getElementById('gap-alert-message');
    if (!box || !text) return;

    text.textContent = msg;
    box.className = isError
      ? 'mb-6 p-4 rounded-xl text-sm font-medium border bg-red-50 border-red-200 text-red-700 block transition-all duration-200'
      : 'mb-6 p-4 rounded-xl text-sm font-medium border bg-emerald-50 border-emerald-200 text-emerald-700 block transition-all duration-200';

    // Auto-scroll into view smoothly
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function hideAlert() {
    const box = document.getElementById('gap-alert-box');
    if (box) box.classList.add('hidden');
  }

  function decrementCounter(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const current = parseInt(el.textContent.trim(), 10);
    if (!isNaN(current) && current > 0) {
      el.textContent = current - 1;
    }
  }

  function checkEmptyTable(tbodyId, emptyRowId, emptyMessage, colspan) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    const remainingRows = tbody.querySelectorAll('tr:not([id^="empty-"])');
    if (remainingRows.length === 0) {
      tbody.innerHTML = `
        <tr id="${emptyRowId}">
          <td colspan="${colspan}" class="px-5 py-10 text-center text-slate-400 text-sm">
            ${emptyMessage}
          </td>
        </tr>`;
    }
  }

  /* ─────────────────────────────────────────────────────────────
     MODAL CONTROLS: "Mark as no class" (Acknowledgement)
  ───────────────────────────────────────────────────────────── */
  function openAckModal(button) {
    const kind = button.getAttribute('data-kind') || '';
    const teacherId = button.getAttribute('data-teacher-id') || '';
    const targetName = button.getAttribute('data-target-name') || '';
    const group = button.getAttribute('data-group') || '';
    const date = button.getAttribute('data-date') || '';
    const weekday = button.getAttribute('data-weekday') || '';

    const modal = document.getElementById('modal-ack');
    if (!modal) return;

    document.getElementById('modal-ack-kind').value = kind;
    document.getElementById('modal-ack-teacher').value = teacherId;
    document.getElementById('modal-ack-group').value = group;
    document.getElementById('modal-ack-date').value = date;

    const targetLabel = document.getElementById('modal-ack-target-label');
    if (targetLabel) targetLabel.textContent = targetName || group || 'Teacher';

    const dateRow = document.getElementById('modal-ack-date-row');
    const dateLabel = document.getElementById('modal-ack-date-label');
    if (kind === 'teacher_day' && date) {
      if (dateRow) dateRow.classList.remove('hidden');
      if (dateLabel) dateLabel.textContent = `${weekday ? weekday + ', ' : ''}${date}`;
    } else {
      if (dateRow) dateRow.classList.add('hidden');
    }

    // Reset fields
    const reasonSelect = document.getElementById('modal-ack-reason');
    if (reasonSelect) reasonSelect.value = 'no_class';
    const noteArea = document.getElementById('modal-ack-note');
    if (noteArea) noteArea.value = '';

    modal.classList.remove('hidden');
  }

  function closeAckModal() {
    const modal = document.getElementById('modal-ack');
    if (modal) modal.classList.add('hidden');
  }

  async function handleAckSubmit(e) {
    e.preventDefault();
    const form = document.getElementById('form-ack');
    if (!form) return;

    const kind = document.getElementById('modal-ack-kind').value;
    const teacher = document.getElementById('modal-ack-teacher').value;
    const group = document.getElementById('modal-ack-group').value;
    const date = document.getElementById('modal-ack-date').value;
    const reason = document.getElementById('modal-ack-reason').value;
    const note = document.getElementById('modal-ack-note').value;

    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving...';
    }

    try {
      const res = await fetch('/admin/report-gaps/ack', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ kind, teacher, group, date, reason, note }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Failed to acknowledge gap.');
      }

      closeAckModal();
      showAlert('Gap acknowledged and marked as no class.', false);

      // Remove the row from the table
      let rowSelector = '';
      if (kind === 'teacher_day') {
        rowSelector = `tr[data-row-id="teacher_day-${teacher}-${date}"]`;
        const row = document.querySelector(rowSelector);
        if (row) row.remove();
        decrementCounter('stat-total');
        decrementCounter('stat-teacher-day');
        decrementCounter('badge-teacher-day');
        checkEmptyTable(
          'tbody-teacher-day',
          'empty-teacher-day',
          'No missed usual teaching days detected in this lookback window.',
          4
        );
      } else if (kind === 'teacher_silent') {
        rowSelector = `tr[data-row-id="teacher_silent-${teacher}"]`;
        const row = document.querySelector(rowSelector);
        if (row) row.remove();
        decrementCounter('stat-total');
        decrementCounter('stat-teacher-silent');
        decrementCounter('badge-teacher-silent');
        checkEmptyTable(
          'tbody-teacher-silent',
          'empty-teacher-silent',
          'No silent teachers detected.',
          4
        );
      } else if (kind === 'group_silent') {
        rowSelector = `tr[data-row-id="group_silent-${group}"]`;
        const row = document.querySelector(rowSelector);
        if (row) row.remove();
        decrementCounter('stat-total');
        decrementCounter('stat-group-silent');
        decrementCounter('badge-group-silent');
        checkEmptyTable(
          'tbody-group-silent',
          'empty-group-silent',
          'No silent groups detected.',
          4
        );
      }
    } catch (err) {
      showAlert(err.message || 'Error saving acknowledgement.', true);
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Confirm & Acknowledge';
      }
    }
  }

  /* ─────────────────────────────────────────────────────────────
     REMIND TEACHER
  ───────────────────────────────────────────────────────────── */
  async function handleRemindTeacher(button) {
    const teacherId = button.getAttribute('data-teacher-id');
    const teacherName = button.getAttribute('data-teacher-name') || 'Teacher';
    const gapKind = button.getAttribute('data-gap-kind') || 'teacher_day';
    const date = button.getAttribute('data-date') || '';
    const weekday = button.getAttribute('data-weekday') || '';

    if (!teacherId) return;

    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = 'Sending...';

    try {
      const res = await fetch('/admin/report-gaps/remind', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ teacherId, gapKind, date, weekday }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Failed to send reminder.');
      }

      button.textContent = 'Reminded ✓';
      button.className = 'px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 cursor-not-allowed';
      showAlert(`Reminder sent to ${teacherName}.`, false);
    } catch (err) {
      button.disabled = false;
      button.textContent = originalText;
      showAlert(err.message || 'Failed to send reminder.', true);
    }
  }

  /* ─────────────────────────────────────────────────────────────
     NO-CLASS DATES ADD & DELETE
  ───────────────────────────────────────────────────────────── */
  async function handleAddNoClassDate(e) {
    e.preventDefault();
    const form = document.getElementById('form-no-class-date');
    if (!form) return;

    const from = document.getElementById('ncd-from').value;
    const to = document.getElementById('ncd-to').value;
    const label = document.getElementById('ncd-label').value;

    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Adding...';
    }

    try {
      const res = await fetch('/admin/report-gaps/no-class-dates', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ from, to, label }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Failed to add no-class date.');
      }

      showAlert(`No-class date "${label}" added. Refreshing gap list...`, false);
      form.reset();
      // Reload page to recompute gaps with suppressed dates
      setTimeout(() => {
        window.location.reload();
      }, 500);
    } catch (err) {
      showAlert(err.message || 'Error adding no-class date.', true);
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Add No-Class Date';
      }
    }
  }

  async function handleDeleteNoClassDate(button) {
    const id = button.getAttribute('data-id');
    if (!id) return;

    if (!confirm('Are you sure you want to delete this global no-class date rule?')) {
      return;
    }

    button.disabled = true;
    try {
      const res = await fetch(`/admin/report-gaps/no-class-dates/${id}/delete`, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
        },
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Failed to delete no-class date.');
      }

      showAlert('No-class date rule deleted. Refreshing gap list...', false);
      setTimeout(() => {
        window.location.reload();
      }, 500);
    } catch (err) {
      button.disabled = false;
      showAlert(err.message || 'Failed to delete no-class date.', true);
    }
  }

  /* ─────────────────────────────────────────────────────────────
     EVENT DELEGATION (Click & Submit)
  ───────────────────────────────────────────────────────────── */
  document.addEventListener('click', function (e) {
    const target = e.target.closest('[data-action]');
    if (!target) return;

    const action = target.getAttribute('data-action');
    if (action === 'open-ack-modal') {
      e.preventDefault();
      openAckModal(target);
    } else if (action === 'close-ack-modal') {
      e.preventDefault();
      closeAckModal();
    } else if (action === 'remind-teacher') {
      e.preventDefault();
      handleRemindTeacher(target);
    } else if (action === 'delete-no-class-date') {
      e.preventDefault();
      handleDeleteNoClassDate(target);
    } else if (action === 'dismiss-alert') {
      e.preventDefault();
      hideAlert();
    }
  });

  // Form submits
  document.addEventListener('submit', function (e) {
    if (e.target && e.target.id === 'form-ack') {
      handleAckSubmit(e);
    } else if (e.target && e.target.id === 'form-no-class-date') {
      handleAddNoClassDate(e);
    }
  });

  // Escape key closes acknowledgement modal
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeAckModal();
    }
  });
})();

