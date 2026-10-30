(function () {
  'use strict';
  var btn = document.getElementById('btn-delete-report');
  if (!btn) return;

  btn.addEventListener('click', function () {
    var deleteUrl = this.dataset.deleteUrl;
    var csrfToken = document.querySelector('meta[name="csrf-token"]');
    csrfToken = csrfToken ? csrfToken.getAttribute('content') : '';

    if (typeof Swal === 'undefined') {
      if (confirm('Delete this report? This action cannot be undone.')) {
        fetch(deleteUrl, { method: 'DELETE', headers: { 'X-Requested-With': 'XMLHttpRequest', 'x-csrf-token': csrfToken } })
          .then(function () { window.location.href = '/reports'; });
      }
      return;
    }

    Swal.fire({
      title: 'Delete this report?',
      text: 'This action cannot be undone.',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#ef4444',
      cancelButtonColor: '#64748b',
      confirmButtonText: 'Yes, delete it!',
      cancelButtonText: 'Cancel',
      reverseButtons: true,
      focusCancel: true,
      customClass: {
        popup: 'rounded-2xl',
        confirmButton: 'rounded-xl',
        cancelButton: 'rounded-xl',
      },
    }).then(function (result) {
      if (!result.isConfirmed) return;

      Swal.fire({
        title: 'Deleting…',
        text: 'Please wait.',
        allowOutsideClick: false,
        allowEscapeKey: false,
        showConfirmButton: false,
        didOpen: function () { Swal.showLoading(); },
      });

      fetch(deleteUrl, {
        method: 'DELETE',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'x-csrf-token': csrfToken,
        },
      })
        .then(function (res) {
          if (res.ok || res.redirected) {
            Swal.fire({
              title: 'Deleted!',
              text: 'The report has been removed.',
              icon: 'success',
              confirmButtonColor: '#16a34a',
              customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' },
              timer: 1500,
              showConfirmButton: false,
            }).then(function () {
              window.location.href = '/reports';
            });
          } else {
            Swal.fire({
              title: 'Error',
              text: 'Failed to delete. Please try again.',
              icon: 'error',
              confirmButtonColor: '#ef4444',
              customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' },
            });
          }
        })
        .catch(function () {
          Swal.fire({
            title: 'Network Error',
            text: 'Could not reach the server. Please try again.',
            icon: 'error',
            confirmButtonColor: '#ef4444',
            customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' },
          });
        });
    });
  });
})();

