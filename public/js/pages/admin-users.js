(function () {
  function getCsrfToken() {
    var m = document.querySelector('meta[name="csrf-token"]');
    return m ? m.getAttribute('content') : '';
  }

  var selectAll = document.getElementById('select-all');
  var bulkBar   = document.getElementById('bulk-bar');
  var bulkCount = document.getElementById('bulk-count');

  function getChecked() {
    return Array.from(document.querySelectorAll('.row-checkbox:checked')).map(function(cb) { return cb.value; });
  }

  function updateBulkBar() {
    var ids = getChecked();
    if (bulkCount) bulkCount.textContent = ids.length;
    if (bulkBar) {
      if (ids.length > 0) bulkBar.classList.remove('hidden');
      else                bulkBar.classList.add('hidden');
    }
    if (selectAll) {
      var all = document.querySelectorAll('.row-checkbox');
      selectAll.indeterminate = ids.length > 0 && ids.length < all.length;
      selectAll.checked       = all.length > 0 && ids.length === all.length;
    }
  }

  function clearSelection() {
    document.querySelectorAll('.row-checkbox').forEach(function(cb) { cb.checked = false; });
    if (selectAll) { selectAll.checked = false; selectAll.indeterminate = false; }
    updateBulkBar();
  }

  // ── Event delegation: single delete ────────────────────────
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('.js-delete-user');
    if (!btn) return;
    var url  = btn.dataset.deleteUrl;
    var name = btn.dataset.name;

    if (typeof Swal === 'undefined') return;

    Swal.fire({
      title: 'Delete ' + name + '?',
      html: '<p class="text-sm text-slate-500">This will permanently delete the user and <strong>all their reports</strong>. This cannot be undone.</p>',
      icon: 'warning',
      showCancelButton: true, confirmButtonColor: '#ef4444', cancelButtonColor: '#64748b',
      confirmButtonText: 'Yes, delete', cancelButtonText: 'Cancel',
      reverseButtons: true, focusCancel: true,
      customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl', cancelButton: 'rounded-xl' },
    }).then(function(result) {
      if (!result.isConfirmed) return;
      Swal.fire({ title: 'Deleting…', allowOutsideClick: false, allowEscapeKey: false,
        showConfirmButton: false, didOpen: function() { Swal.showLoading(); } });
      fetch(url, {
        method: 'DELETE',
        headers: { 'X-Requested-With': 'XMLHttpRequest', 'x-csrf-token': getCsrfToken() },
      }).then(function(res) {
        if (res.ok) {
          Swal.fire({ title: 'Deleted!', text: name + ' has been removed.', icon: 'success',
            confirmButtonColor: '#16a34a',
            customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' },
            timer: 1500, showConfirmButton: false,
          }).then(function() {
            clearSelection();
            if (typeof LiveRefresh !== 'undefined') LiveRefresh.refresh('admin-users-table');
          });
        } else {
          res.json().then(function(data) {
            Swal.fire({ title: 'Error', text: data.error || 'Failed to delete.',
              icon: 'error', confirmButtonColor: '#ef4444',
              customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' } });
          });
        }
      }).catch(function() {
        Swal.fire({ title: 'Network Error', text: 'Could not reach the server.',
          icon: 'error', confirmButtonColor: '#ef4444',
          customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' } });
      });
    });
  });

  // ── Event delegation: checkboxes ────────────────────────────
  document.addEventListener('change', function(e) {
    if (e.target.id === 'select-all') {
      document.querySelectorAll('.row-checkbox').forEach(function(cb) { cb.checked = e.target.checked; });
      updateBulkBar();
    } else if (e.target.classList.contains('row-checkbox')) {
      updateBulkBar();
    }
  });

  // ── Bulk delete ─────────────────────────────────────────────
  var bulkDelBtn = document.getElementById('bulk-delete-btn');
  if (bulkDelBtn) {
    bulkDelBtn.addEventListener('click', function() {
      var ids = getChecked();
      if (!ids.length) return;
      if (typeof Swal === 'undefined') return;

      Swal.fire({
        title: 'Delete ' + ids.length + ' user(s)?',
        html: '<p class="text-sm text-slate-500">This will also delete <strong>all their reports</strong>. This cannot be undone.</p>',
        icon: 'warning',
        showCancelButton: true, confirmButtonColor: '#ef4444', cancelButtonColor: '#64748b',
        confirmButtonText: 'Yes, delete all!', cancelButtonText: 'Cancel',
        reverseButtons: true, focusCancel: true,
        customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl', cancelButton: 'rounded-xl' },
      }).then(function(result) {
        if (!result.isConfirmed) return;
        Swal.fire({ title: 'Deleting…', allowOutsideClick: false, allowEscapeKey: false,
          showConfirmButton: false, didOpen: function() { Swal.showLoading(); } });
        fetch('/admin/users/bulk', {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'x-csrf-token': getCsrfToken(),
          },
          body: JSON.stringify({ ids: ids }),
        }).then(function(res) { return res.json(); }).then(function(data) {
          if (data.ok) {
            Swal.fire({ title: 'Deleted!', text: data.deleted + ' user(s) removed.', icon: 'success',
              confirmButtonColor: '#16a34a', timer: 1500, showConfirmButton: false,
              customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' },
            }).then(function() {
              clearSelection();
              if (typeof LiveRefresh !== 'undefined') LiveRefresh.refresh('admin-users-table');
            });
          } else {
            Swal.fire({ title: 'Error', text: data.error || 'Failed to delete.', icon: 'error',
              confirmButtonColor: '#ef4444', customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' } });
          }
        }).catch(function() {
          Swal.fire({ title: 'Network Error', text: 'Could not reach the server.', icon: 'error',
            confirmButtonColor: '#ef4444', customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' } });
        });
      });
    });
  }

  if (typeof registerAction === 'function') {
    registerAction('clearSelection', function () {
      clearSelection();
    });

    registerAction('approveUser', function (e, el) {
      var id = el.dataset.id;
      var name = el.dataset.name || 'this teacher';
      if (!id) return;

      var doApprove = function () {
        if (typeof Swal !== 'undefined') {
          Swal.fire({
            title: 'Approving…',
            allowOutsideClick: false,
            allowEscapeKey: false,
            showConfirmButton: false,
            didOpen: function () { Swal.showLoading(); },
          });
        }
        fetch('/admin/users/' + encodeURIComponent(id) + '/approve', {
          method: 'POST',
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'x-csrf-token': getCsrfToken(),
          },
        })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (data.ok) {
              if (typeof Swal !== 'undefined') {
                Swal.fire({
                  title: 'Approved!',
                  text: name + ' has been approved and welcomed.',
                  icon: 'success',
                  confirmButtonColor: '#16a34a',
                  timer: 1500,
                  showConfirmButton: false,
                  customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' },
                }).then(function () {
                  window.location.reload();
                });
              } else {
                window.location.reload();
              }
            } else {
              if (typeof Swal !== 'undefined') {
                Swal.fire({
                  title: 'Error',
                  text: data.error || 'Failed to approve.',
                  icon: 'error',
                  confirmButtonColor: '#ef4444',
                  customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' },
                });
              } else {
                alert(data.error || 'Failed to approve.');
              }
            }
          })
          .catch(function () {
            if (typeof Swal !== 'undefined') {
              Swal.fire({
                title: 'Network Error',
                text: 'Could not reach the server.',
                icon: 'error',
                confirmButtonColor: '#ef4444',
                customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' },
              });
            } else {
              alert('Could not reach the server.');
            }
          });
      };

      if (typeof Swal !== 'undefined') {
        Swal.fire({
          title: 'Approve ' + name + '?',
          text: 'This account will become active and receive a welcome notification.',
          icon: 'question',
          showCancelButton: true,
          confirmButtonColor: '#16a34a',
          cancelButtonColor: '#64748b',
          confirmButtonText: 'Yes, approve',
          cancelButtonText: 'Cancel',
          reverseButtons: true,
          focusCancel: true,
          customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl', cancelButton: 'rounded-xl' },
        }).then(function (result) {
          if (result.isConfirmed) doApprove();
        });
      } else {
        if (confirm('Approve ' + name + '?')) doApprove();
      }
    });

    registerAction('rejectUser', function (e, el) {
      var id = el.dataset.id;
      var name = el.dataset.name || 'this registration';
      if (!id) return;

      var sendReject = function (reason) {
        if (typeof Swal !== 'undefined') {
          Swal.fire({
            title: 'Rejecting…',
            allowOutsideClick: false,
            allowEscapeKey: false,
            showConfirmButton: false,
            didOpen: function () { Swal.showLoading(); },
          });
        }
        fetch('/admin/users/' + encodeURIComponent(id) + '/reject', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'x-csrf-token': getCsrfToken(),
          },
          body: JSON.stringify({ reason: reason || '' }),
        })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (data.ok) {
              if (typeof Swal !== 'undefined') {
                Swal.fire({
                  title: 'Rejected',
                  text: name + ' has been rejected.',
                  icon: 'info',
                  confirmButtonColor: '#64748b',
                  timer: 1500,
                  showConfirmButton: false,
                  customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' },
                }).then(function () {
                  window.location.reload();
                });
              } else {
                window.location.reload();
              }
            } else {
              if (typeof Swal !== 'undefined') {
                Swal.fire({
                  title: 'Error',
                  text: data.error || 'Failed to reject.',
                  icon: 'error',
                  confirmButtonColor: '#ef4444',
                  customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' },
                });
              } else {
                alert(data.error || 'Failed to reject.');
              }
            }
          })
          .catch(function () {
            if (typeof Swal !== 'undefined') {
              Swal.fire({
                title: 'Network Error',
                text: 'Could not reach the server.',
                icon: 'error',
                confirmButtonColor: '#ef4444',
                customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' },
              });
            } else {
              alert('Could not reach the server.');
            }
          });
      };

      if (typeof Swal !== 'undefined') {
        Swal.fire({
          title: 'Reject ' + name + '?',
          input: 'text',
          inputLabel: 'Rejection reason (optional, max 200 chars)',
          inputPlaceholder: 'e.g. Unrecognized applicant or duplicate registration',
          inputAttributes: { maxlength: '200' },
          showCancelButton: true,
          confirmButtonColor: '#ef4444',
          cancelButtonColor: '#64748b',
          confirmButtonText: 'Reject registration',
          cancelButtonText: 'Cancel',
          reverseButtons: true,
          focusCancel: true,
          customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl', cancelButton: 'rounded-xl' },
        }).then(function (result) {
          if (result.isConfirmed) sendReject(result.value);
        });
      } else {
        var reason = prompt('Rejection reason (optional, max 200 chars):');
        if (reason !== null) sendReject(reason);
      }
    });

    registerAction('bulkApprovePending', function (e, el) {
      var rawIds = el.dataset.userIds || '';
      var ids = rawIds ? rawIds.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];
      if (!ids.length) return;

      var doBulkApprove = function () {
        if (typeof Swal !== 'undefined') {
          Swal.fire({
            title: 'Approving ' + ids.length + ' teachers…',
            allowOutsideClick: false,
            allowEscapeKey: false,
            showConfirmButton: false,
            didOpen: function () { Swal.showLoading(); },
          });
        }
        fetch('/admin/users/bulk-approve', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'x-csrf-token': getCsrfToken(),
          },
          body: JSON.stringify({ ids: ids }),
        })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (data.ok) {
              if (typeof Swal !== 'undefined') {
                Swal.fire({
                  title: 'Approved!',
                  text: data.approvedCount + ' teacher(s) approved.',
                  icon: 'success',
                  confirmButtonColor: '#16a34a',
                  timer: 1500,
                  showConfirmButton: false,
                  customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' },
                }).then(function () {
                  window.location.reload();
                });
              } else {
                window.location.reload();
              }
            } else {
              if (typeof Swal !== 'undefined') {
                Swal.fire({
                  title: 'Error',
                  text: data.error || 'Failed to bulk approve.',
                  icon: 'error',
                  confirmButtonColor: '#ef4444',
                  customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' },
                });
              } else {
                alert(data.error || 'Failed to bulk approve.');
              }
            }
          })
          .catch(function () {
            if (typeof Swal !== 'undefined') {
              Swal.fire({
                title: 'Network Error',
                text: 'Could not reach the server.',
                icon: 'error',
                confirmButtonColor: '#ef4444',
                customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' },
              });
            } else {
              alert('Could not reach the server.');
            }
          });
      };

      if (typeof Swal !== 'undefined') {
        Swal.fire({
          title: 'Approve ' + ids.length + ' pending teachers?',
          text: 'All selected teachers will be activated and will receive onboarding welcome notifications.',
          icon: 'question',
          showCancelButton: true,
          confirmButtonColor: '#16a34a',
          cancelButtonColor: '#64748b',
          confirmButtonText: 'Yes, approve all',
          cancelButtonText: 'Cancel',
          reverseButtons: true,
          focusCancel: true,
          customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl', cancelButton: 'rounded-xl' },
        }).then(function (result) {
          if (result.isConfirmed) doBulkApprove();
        });
      } else {
        if (confirm('Approve ' + ids.length + ' pending teachers?')) doBulkApprove();
      }
    });
  }
})();

