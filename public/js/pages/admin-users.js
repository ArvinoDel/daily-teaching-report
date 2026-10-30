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
  }
})();
