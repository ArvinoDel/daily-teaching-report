/* ── Day toggle ─────────────────────────────────────────────── */
function toggleDay(idx) {
  var body    = document.getElementById('day-body-'   + idx);
  var chevron = document.getElementById('chevron-'    + idx);
  if (!body || !chevron) return;
  var btn     = chevron.closest('button');
  var hint    = btn ? btn.querySelector('span.flex-shrink-0') : null;
  var isOpen  = !body.classList.contains('hidden');

  body.classList.toggle('hidden', isOpen);
  chevron.style.transform = isOpen ? '' : 'rotate(180deg)';
  if (hint) hint.textContent = isOpen ? 'expand' : 'collapse';
}

/* ── Expand / Collapse All ───────────────────────────────────── */
function expandAll() {
  document.querySelectorAll('[id^="day-body-"]').forEach(function(b, i) {
    b.classList.remove('hidden');
    var ch = document.getElementById('chevron-' + i);
    if (ch) ch.style.transform = 'rotate(180deg)';
  });
}
function collapseAll() {
  document.querySelectorAll('[id^="day-body-"]').forEach(function(b, i) {
    b.classList.add('hidden');
    var ch = document.getElementById('chevron-' + i);
    if (ch) ch.style.transform = '';
  });
}

/* ── CSRF helper ─────────────────────────────────────────────── */
function getCsrfToken() {
  var m = document.querySelector('meta[name="csrf-token"]');
  return m ? m.getAttribute('content') : '';
}

/* ── Delete report ───────────────────────────────────────────── */
function deleteReport(btn) {
  var url   = btn.dataset.deleteUrl;
  var label = btn.dataset.label;
  var rowId = btn.dataset.row;

  if (typeof Swal === 'undefined') return;

  Swal.fire({
    title: 'Delete report?',
    html: '<p class="text-sm text-slate-500">Class <strong>' + label + '</strong> will be permanently removed. This cannot be undone.</p>',
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#ef4444',
    cancelButtonColor: '#64748b',
    confirmButtonText: 'Yes, delete',
    cancelButtonText: 'Cancel',
    reverseButtons: true,
    focusCancel: true,
    customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl', cancelButton: 'rounded-xl' },
  }).then(function (result) {
    if (!result.isConfirmed) return;

    Swal.fire({
      title: 'Deleting…',
      allowOutsideClick: false,
      allowEscapeKey: false,
      showConfirmButton: false,
      didOpen: function () { Swal.showLoading(); },
    });

    fetch(url, {
      method: 'DELETE',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'x-csrf-token': getCsrfToken(),
      },
    }).then(function (res) {
      if (res.ok) {
        // Remove the row from the DOM without a full reload
        var row = document.getElementById(rowId);
        if (row) {
          row.style.transition = 'opacity 0.2s, max-height 0.3s';
          row.style.opacity = '0';
          row.style.overflow = 'hidden';
          setTimeout(function () {
            row.style.maxHeight = row.offsetHeight + 'px';
            setTimeout(function () {
              row.style.maxHeight = '0';
              row.style.padding   = '0';
              setTimeout(function () { row.remove(); }, 300);
            }, 20);
          }, 200);
        }
        Swal.fire({
          title: 'Deleted!',
          text: 'Report for ' + label + ' has been removed.',
          icon: 'success',
          timer: 1400,
          showConfirmButton: false,
          customClass: { popup: 'rounded-2xl' },
        });
      } else {
        res.json().then(function (data) {
          Swal.fire({
            title: 'Error',
            text: data.error || 'Failed to delete report.',
            icon: 'error',
            confirmButtonColor: '#ef4444',
            customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' },
          });
        });
      }
    }).catch(function () {
      Swal.fire({
        title: 'Network Error',
        text: 'Could not reach the server.',
        icon: 'error',
        confirmButtonColor: '#ef4444',
        customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' },
      });
    });
  });
}

if (typeof registerAction === 'function') {
  registerAction('toggleDay', function (e, el) {
    toggleDay(el.dataset.dayIdx);
  });
  registerAction('deleteReport', function (e, el) {
    deleteReport(el);
  });
}
