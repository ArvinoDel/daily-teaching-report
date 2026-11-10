function getCsrfToken() {
  var m = document.querySelector('meta[name="csrf-token"]');
  return m ? m.getAttribute('content') : '';
}

  // ── Cloud Backup Modal ───────────────────────────────────────────
  var modal        = document.getElementById('backupModal');
  var openBtn      = document.getElementById('openBackupModalBtn');
  var cancelBtn    = document.getElementById('cancelBackupBtn');
  var modalOverlay = document.getElementById('backupModalOverlay');

  if (openBtn) openBtn.addEventListener('click', function () { modal.classList.remove('hidden'); });
  if (cancelBtn) cancelBtn.addEventListener('click', function () { modal.classList.add('hidden'); });
  if (modalOverlay) modalOverlay.addEventListener('click', function () { modal.classList.add('hidden'); });

  var backupForm = document.getElementById('backupForm');
  if (backupForm) {
    backupForm.addEventListener('submit', function () {
      var btn   = document.getElementById('backupBtn');
      var label = document.getElementById('backupBtnLabel');
      if (btn) btn.disabled = true;
      if (label) label.textContent = 'Creating & Uploading…';
    });
  }

  // ── Direct Export Dropdown ───────────────────────────────────────
  var exportMenu = document.getElementById('exportMenu');
  var exportBtn  = document.getElementById('exportDropdownBtn');

  if (exportBtn && exportMenu) {
    exportBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      exportMenu.classList.toggle('hidden');
    });
    document.addEventListener('click', function () { exportMenu.classList.add('hidden'); });
  }

  // ── Pin / Unpin Backup AJAX ──────────────────────────────────────
  document.querySelectorAll('.btn-pin-backup').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var id = this.dataset.id;
      try {
        var res = await fetch('/admin/backups/' + id + '/pin', {
          method:  'POST',
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'x-csrf-token':     getCsrfToken(),
          },
        });
        var data = await res.json();
        if (data.ok) {
          this.dataset.pinned = data.pinned ? 'true' : 'false';
          var row = document.querySelector('tr[data-backup-id="' + id + '"]');
          if (row) {
            var badge = row.querySelector('.badge-pinned');
            if (badge) {
              if (data.pinned) badge.classList.remove('hidden');
              else badge.classList.add('hidden');
            }
          }
          this.title = data.pinned ? 'Unpin (allow auto-expiry)' : 'Pin backup (prevent auto-expiry)';
          var icon = this.querySelector('svg');
          if (icon) {
            if (data.pinned) {
              icon.classList.add('text-amber-600', 'fill-amber-600');
            } else {
              icon.classList.remove('text-amber-600', 'fill-amber-600');
            }
          }
        } else {
          Swal.fire('Error', data.error || 'Failed to toggle pin.', 'error');
        }
      } catch (err) {
        Swal.fire('Error', 'Request failed.', 'error');
      }
    });
  });

  // ── Delete Expired Now Button (with Preview Step) ─────────────────
  var pruneBtn = document.getElementById('pruneExpiredBtn');
  if (pruneBtn) {
    pruneBtn.addEventListener('click', async function () {
      Swal.fire({
        title: 'Scanning for Expired Backups...',
        text:  'Checking retention rules and orphan storage files...',
        allowOutsideClick: false,
        didOpen: () => { Swal.showLoading(); },
      });

      try {
        var prevRes = await fetch('/admin/backups/prune?preview=1&sweepOrphans=1', {
          method:  'POST',
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'x-csrf-token':     getCsrfToken(),
          },
        });
        var prevData = await prevRes.json();

        if (!prevData.ok) {
          return Swal.fire('Error', prevData.error || 'Failed to scan for expired backups.', 'error');
        }

        var s = prevData.summary || {};
        var expiredCount = s.expiredCount || 0;
        var orphanCount  = s.orphanCount || 0;

        if (expiredCount === 0 && orphanCount === 0) {
          return Swal.fire({
            title: 'No Items to Delete',
            text:  'No expired backups or orphan storage files currently qualify for deletion under retention rules.',
            icon:  'info',
          });
        }

        var html = '<div class="text-left text-xs space-y-3 max-h-60 overflow-y-auto mt-3 p-3 bg-slate-50 rounded-xl border border-slate-200">';
        html += '<div><p class="font-bold text-slate-800 text-sm mb-1">Expired Backups (' + expiredCount + '):</p>';
        if (expiredCount === 0) {
          html += '<p class="text-slate-400">None</p>';
        } else {
          html += '<ul class="list-disc pl-4 space-y-0.5 text-slate-600">';
          (s.expiredBackups || []).forEach(function (b) {
            var d = b.createdAt ? new Date(b.createdAt).toISOString().split('T')[0] : 'unknown';
            html += '<li>' + d + ' (' + (b.sizeFormatted || '0 B') + ') - ' + b.status + '</li>';
          });
          html += '</ul>';
        }
        html += '</div>';

        html += '<div><p class="font-bold text-slate-800 text-sm mb-1">Orphan Cloudinary Assets (' + orphanCount + '):</p>';
        if (orphanCount === 0) {
          html += '<p class="text-slate-400">' + (s.orphanSkippedReason ? 'Skipped: ' + s.orphanSkippedReason : 'None') + '</p>';
        } else {
          html += '<ul class="list-disc pl-4 space-y-0.5 text-slate-600">';
          (s.orphansToDelete || []).forEach(function (o) {
            var fn = (o.public_id || '').split('/').pop();
            html += '<li>' + fn + ' (' + (o.sizeFormatted || '0 B') + ')</li>';
          });
          html += '</ul>';
          if (s.orphanRemainingCount > 0) {
            html += '<p class="text-amber-600 font-medium mt-1">+' + s.orphanRemainingCount + ' more beyond batch cap</p>';
          }
        }
        html += '</div></div>';

        var confirmed = await Swal.fire({
          title:              'Delete Expired Backups & Orphans?',
          html:               '<p class="text-sm text-slate-600">The following items will be permanently removed from MongoDB and Cloudinary storage:</p>' + html,
          icon:               'warning',
          showCancelButton:   true,
          confirmButtonColor: '#e11d48',
          cancelButtonColor:  '#64748b',
          confirmButtonText:  'Yes, Delete All',
          cancelButtonText:   'Cancel',
          reverseButtons:     true,
        });

        if (!confirmed.isConfirmed) return;

        Swal.fire({
          title: 'Pruning Expired Backups...',
          text:  'Cleaning MongoDB records and removing Cloudinary assets.',
          allowOutsideClick: false,
          didOpen: () => { Swal.showLoading(); },
        });

        var res = await fetch('/admin/backups/prune', {
          method:  'POST',
          headers: {
            'Content-Type':     'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'x-csrf-token':     getCsrfToken(),
          },
          body: JSON.stringify({ sweepOrphans: true }),
        });
        var data = await res.json();
        if (data.ok) {
          var resSummary = data.summary || {};
          await Swal.fire({
            title: 'Cleanup Complete',
            html: '<div class="text-left text-sm space-y-1 mt-2">' +
                  '<p>• Deleted records: <strong>' + (resSummary.deletedCount || 0) + '</strong></p>' +
                  '<p>• Freed storage: <strong>' + (resSummary.freedBytesFormatted || '0 B') + '</strong></p>' +
                  '<p>• Orphan assets removed: <strong>' + (resSummary.orphanDeletedCount || 0) + '</strong></p>' +
                  '</div>',
            icon: 'success',
          });
          window.location.reload();
        } else {
          Swal.fire('Error', data.error || 'Failed to prune backups.', 'error');
        }
      } catch (err) {
        Swal.fire('Error', 'Prune request failed.', 'error');
      }
    });
  }

  // ── Delete Single Backup AJAX ────────────────────────────────────
  document.querySelectorAll('.btn-delete-backup').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var id = this.dataset.id;
      var confirmed = await Swal.fire({
        title:              'Delete this backup?',
        text:               'This will delete the database record and destroy the file in Cloudinary.',
        icon:               'warning',
        showCancelButton:   true,
        confirmButtonColor: '#ef4444',
        cancelButtonColor:  '#64748b',
        confirmButtonText:  'Yes, delete',
        cancelButtonText:   'Cancel',
        reverseButtons:     true,
      });
      if (!confirmed.isConfirmed) return;

      try {
        var res = await fetch('/admin/backups/' + id, {
          method:  'DELETE',
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'x-csrf-token':     getCsrfToken(),
          },
        });
        var data = await res.json();
        if (data.ok) {
          var row = document.querySelector('tr[data-backup-id="' + id + '"]');
          if (row) row.remove();
        } else {
          Swal.fire('Error', data.error || 'Failed to delete backup.', 'error');
        }
      } catch (err) {
        Swal.fire('Error', 'Delete request failed.', 'error');
      }
    });
  });
