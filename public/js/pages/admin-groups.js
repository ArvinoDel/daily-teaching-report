(function() {
  setTimeout(function () { var t = document.getElementById('toast'); if (t) t.remove(); }, 4000);
})();

        /* ── Data ─────────────────────────────────────────────────── */
        var groupsData = JSON.parse(document.getElementById('groups-json').textContent);
        var groupsMap = {};
        groupsData.forEach(function (g) { groupsMap[g._id] = g; });

        function getCsrfToken() {
          var m = document.querySelector('meta[name="csrf-token"]');
          return m ? m.getAttribute('content') : '';
        }
        function escHtml(s) {
          return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        /* ── Modal ────────────────────────────────────────────────── */
        function openModal(id) {
          var g = groupsMap[id];
          if (!g) return;
          document.getElementById('modal-title').textContent = g.group_name;
          var typeBadge = g.type === 'GROUP'
            ? '<span class="badge-emerald text-xs font-semibold px-2.5 py-1 rounded-full">Group</span>'
            : '<span class="badge-purple text-xs font-semibold px-2.5 py-1 rounded-full">Private</span>';
          var levelBadge = g.level
            ? '<span class="bg-slate-100 text-slate-700 text-xs font-bold px-2.5 py-1 rounded-full">' + escHtml(g.level) + '</span>'
            : '';
          var createdBadge = g.createdAtFormatted
            ? '<span class="text-xs text-slate-400 font-medium">Created: ' + escHtml(g.createdAtFormatted) + '</span>'
            : '';
          document.getElementById('modal-meta').innerHTML = typeBadge + levelBadge + createdBadge;
          document.getElementById('modal-count').textContent = g.students.length;
          var ul = document.getElementById('modal-students');
          if (g.students.length === 0) {
            ul.innerHTML = '<li class="text-sm text-slate-400 italic text-center py-4">No students listed.</li>';
          } else {
            ul.innerHTML = g.students.map(function (s, i) {
              return '<li class="flex items-center gap-3">' +
                '<span class="w-6 h-6 rounded-full bg-slate-100 text-slate-500 text-[11px] font-bold flex items-center justify-center flex-shrink-0">' + (i + 1) + '</span>' +
                '<span class="text-sm text-slate-700">' + escHtml(s) + '</span></li>';
            }).join('');
          }
          document.getElementById('modal-edit-wrap').innerHTML =
            '<a href="/admin/groups/' + id + '/edit" class="text-xs font-semibold text-brand-600 hover:underline">Edit Group →</a>';
          document.getElementById('student-modal').classList.remove('hidden');
          document.body.style.overflow = 'hidden';
        }

        function closeModal() {
          document.getElementById('student-modal').classList.add('hidden');
          document.body.style.overflow = '';
        }

        document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

        /* ── Checkbox / Bulk — only visible rows count ────────────── */
        function toggleAll(cb) {
          document.querySelectorAll('.data-row:not(.hidden) .row-check').forEach(function (c) { c.checked = cb.checked; });
          updateBulkBar();
        }

        function updateBulkBar() {
          var checked = document.querySelectorAll('.data-row:not(.hidden) .row-check:checked').length;
          var total = document.querySelectorAll('.data-row:not(.hidden) .row-check').length;
          var bar = document.getElementById('bulk-bar');
          document.getElementById('bulk-count').textContent = checked;
          bar.classList.toggle('hidden', checked === 0);
          var sa = document.getElementById('select-all');
          if (sa) {
            sa.indeterminate = checked > 0 && checked < total;
            sa.checked = checked > 0 && checked === total;
          }
        }

        function clearSelection() {
          document.querySelectorAll('.row-check').forEach(function (c) { c.checked = false; });
          var sa = document.getElementById('select-all');
          if (sa) { sa.checked = false; sa.indeterminate = false; }
          updateBulkBar();
        }

        /* ── Single delete ────────────────────────────────────────── */
        function deleteSingle(btn) {
          var id = btn.dataset.deleteId, name = btn.dataset.name;
          Swal.fire({
            title: 'Delete "' + escHtml(name) + '"?', text: 'This action cannot be undone.', icon: 'warning',
            showCancelButton: true, confirmButtonColor: '#ef4444', cancelButtonColor: '#64748b',
            confirmButtonText: 'Yes, delete it!', cancelButtonText: 'Cancel',
            reverseButtons: true, focusCancel: true,
            customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl', cancelButton: 'rounded-xl' },
          }).then(function (result) {
            if (!result.isConfirmed) return;
            Swal.fire({ title: 'Deleting…', allowOutsideClick: false, showConfirmButton: false, didOpen: function () { Swal.showLoading(); } });
            fetch('/admin/groups/' + id, {
              method: 'DELETE',
              headers: { 'X-Requested-With': 'XMLHttpRequest', 'x-csrf-token': getCsrfToken() },
            }).then(function (res) {
              if (res.ok) {
                Swal.fire({
                  title: 'Deleted!', icon: 'success', timer: 1400, showConfirmButton: false,
                  customClass: { popup: 'rounded-2xl' }
                }).then(function () {
                  clearSelection();
                  LiveRefresh.refresh('admin-groups-table');
                });
              } else {
                Swal.fire({
                  title: 'Error', text: 'Failed to delete. Please try again.', icon: 'error',
                  confirmButtonColor: '#ef4444', customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' }
                });
              }
            }).catch(function () {
              Swal.fire({
                title: 'Network Error', text: 'Could not reach the server.', icon: 'error',
                confirmButtonColor: '#ef4444', customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' }
              });
            });
          });
        }

        /* ── Bulk delete ──────────────────────────────────────────── */
        function bulkDelete() {
          var ids = Array.from(document.querySelectorAll('.row-check:checked')).map(function (c) { return c.value; });
          if (ids.length === 0) return;
          Swal.fire({
            title: 'Delete ' + ids.length + ' group(s)?', text: 'This action cannot be undone.', icon: 'warning',
            showCancelButton: true, confirmButtonColor: '#ef4444', cancelButtonColor: '#64748b',
            confirmButtonText: 'Yes, delete them!', cancelButtonText: 'Cancel',
            reverseButtons: true, focusCancel: true,
            customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl', cancelButton: 'rounded-xl' },
          }).then(function (result) {
            if (!result.isConfirmed) return;
            Swal.fire({ title: 'Deleting…', allowOutsideClick: false, showConfirmButton: false, didOpen: function () { Swal.showLoading(); } });
            fetch('/admin/groups/bulk', {
              method: 'DELETE',
              headers: { 'X-Requested-With': 'XMLHttpRequest', 'x-csrf-token': getCsrfToken(), 'Content-Type': 'application/json' },
              body: JSON.stringify({ ids: ids }),
            })
              .then(function (res) { return res.json(); })
              .then(function (data) {
                if (data.ok) {
                  Swal.fire({
                    title: 'Deleted!', text: data.deleted + ' group(s) removed.', icon: 'success',
                    timer: 1500, showConfirmButton: false, customClass: { popup: 'rounded-2xl' }
                  })
                    .then(function () {
                      clearSelection();
                      LiveRefresh.refresh('admin-groups-table');
                    });
                } else {
                  Swal.fire({
                    title: 'Error', text: data.error || 'Failed.', icon: 'error',
                    confirmButtonColor: '#ef4444', customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' }
                  });
                }
              })
              .catch(function () {
                Swal.fire({
                  title: 'Network Error', text: 'Could not reach the server.', icon: 'error',
                  confirmButtonColor: '#ef4444', customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' }
                });
              });
          });
        }

        /* ── Skeleton swap + infinite scroll ─────────────────────── */
        function initGroupScroll() {
          var PAGE_SIZE = 12;
          var rows = Array.from(document.querySelectorAll('.data-row'));
          var sentinel = document.getElementById('scroll-sentinel');
          var indicator = document.getElementById('load-indicator');
          var loaded = 0;
          var busy = false;

          function loadMore() {
            if (busy || loaded >= rows.length) return;
            busy = true;
            if (loaded > 0 && indicator) indicator.classList.remove('hidden');

            setTimeout(function () {
              var batch = rows.slice(loaded, loaded + PAGE_SIZE);
              batch.forEach(function (el) { el.classList.remove('hidden'); });
              loaded += batch.length;
              busy = false;
              if (indicator) indicator.classList.add('hidden');
              if (loaded >= rows.length && sentinel) sentinel.remove();
              // Refresh select-all state after new rows appear
              updateBulkBar();
            }, loaded === 0 ? 0 : 350);
          }

          loadMore(); // first batch immediately

          if (sentinel && 'IntersectionObserver' in window) {
            new IntersectionObserver(function (entries) {
              if (entries[0].isIntersecting) loadMore();
            }, { rootMargin: '160px' }).observe(sentinel);
          } else {
            rows.forEach(function (el) { el.classList.remove('hidden'); });
          }
        }

        document.addEventListener('DOMContentLoaded', function () {
          document.getElementById('page-skeleton').classList.add('hidden');
          document.getElementById('real-content').classList.remove('hidden');
          initGroupScroll();
        });

        /* Re-init scroll after live section swap */
        document.addEventListener('live:refreshed', function (e) {
          if (e.detail.sections.indexOf('admin-groups-table') !== -1) {
            clearSelection();
            initGroupScroll();
          }
        });

        /* ── Live search autocomplete ─────────────────────────────── */
        (function () {
          var input = document.getElementById('group-search-input');
          var list  = document.getElementById('group-suggestions');
          if (!input || !list) return;

          // Build a flat suggestion list: group names + student names (with source label)
          var suggestions = [];
          groupsData.forEach(function (g) {
            suggestions.push({ label: g.group_name, sub: g.type === 'GROUP' ? 'Group' : 'Private', value: g.group_name });
            g.students.forEach(function (s) {
              suggestions.push({ label: s, sub: 'student in ' + g.group_name, value: s });
            });
          });

          var activeIdx = -1;

          function showSuggestions(q) {
            q = q.trim().toLowerCase();
            list.innerHTML = '';
            activeIdx = -1;
            if (!q || q.length < 1) { list.classList.add('hidden'); return; }

            var matches = suggestions.filter(function (s) {
              return s.label.toLowerCase().includes(q);
            }).slice(0, 8); // cap at 8 items

            if (matches.length === 0) { list.classList.add('hidden'); return; }

            matches.forEach(function (m, i) {
              var li = document.createElement('li');
              li.className = 'flex items-center gap-2.5 px-3 py-2.5 cursor-pointer hover:bg-slate-50 transition text-sm';
              li.dataset.idx = i;

              // Highlight the matching portion
              var re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
              var highlighted = escHtml(m.label).replace(re, '<mark class="bg-brand-100 text-brand-700 rounded font-semibold not-italic">$1</mark>');

              li.innerHTML =
                '<span class="flex-1 font-medium text-slate-800">' + highlighted + '</span>' +
                '<span class="text-[11px] text-slate-400 whitespace-nowrap">' + escHtml(m.sub) + '</span>';

              li.addEventListener('mousedown', function (e) {
                e.preventDefault(); // don't blur the input
                input.value = m.value;
                list.classList.add('hidden');
                input.closest('form').submit();
              });

              list.appendChild(li);
            });

            list.classList.remove('hidden');
          }

          input.addEventListener('input', function () { showSuggestions(this.value); });
          input.addEventListener('focus', function () { showSuggestions(this.value); });

          // Keyboard navigation
          input.addEventListener('keydown', function (e) {
            var items = list.querySelectorAll('li');
            if (!items.length) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              activeIdx = Math.min(activeIdx + 1, items.length - 1);
              items.forEach(function (el, i) { el.classList.toggle('bg-slate-50', i === activeIdx); });
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              activeIdx = Math.max(activeIdx - 1, -1);
              items.forEach(function (el, i) { el.classList.toggle('bg-slate-50', i === activeIdx); });
            } else if (e.key === 'Enter' && activeIdx >= 0) {
              e.preventDefault();
              items[activeIdx].dispatchEvent(new MouseEvent('mousedown'));
            } else if (e.key === 'Escape') {
              list.classList.add('hidden');
              activeIdx = -1;
            }
          });

          // Close when clicking outside
          document.addEventListener('mousedown', function (e) {
            if (!input.contains(e.target) && !list.contains(e.target)) {
              list.classList.add('hidden');
              activeIdx = -1;
            }
          });
        })();
        if (typeof registerAction === 'function') {
          registerAction('filterGroupsLevel', function (e, el) {
            window.location = '/admin/groups?q=' + (el.dataset.query || '') + '&type=' + (el.dataset.type || '') + '&level=' + encodeURIComponent(el.value) + '&sort=' + (el.dataset.sort || '');
          });
          registerAction('filterGroupsSort', function (e, el) {
            window.location = '/admin/groups?q=' + (el.dataset.query || '') + '&type=' + (el.dataset.type || '') + '&level=' + (el.dataset.level || '') + '&sort=' + encodeURIComponent(el.value);
          });
          registerAction('bulkDelete', function () {
            bulkDelete();
          });
          registerAction('clearSelection', function () {
            clearSelection();
          });
          registerAction('toggleAll', function (e, el) {
            toggleAll(el);
          });
          registerAction('updateBulkBar', function () {
            updateBulkBar();
          });
          registerAction('openGroupModal', function (e, el) {
            openModal(el.dataset.groupId);
          });
          registerAction('deleteSingle', function (e, el) {
            deleteSingle(el);
          });
          registerAction('closeGroupModal', function () {
            closeModal();
          });
        }
      