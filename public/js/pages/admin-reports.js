(function () {
  function getCsrfToken() {
    var m = document.querySelector('meta[name="csrf-token"]');
    return m ? m.getAttribute('content') : '';
  }

  /* ── Delete handler (event-delegated so it survives section swap) ─ */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.js-delete-report');
    if (!btn) return;
    var url = btn.dataset.deleteUrl;
    if (typeof Swal === 'undefined') return;

    Swal.fire({
      title: 'Delete this report?',
      text: 'This action cannot be undone.',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#ef4444', cancelButtonColor: '#64748b',
      confirmButtonText: 'Yes, delete it!', cancelButtonText: 'Cancel',
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
          Swal.fire({ title: 'Deleted!', icon: 'success', confirmButtonColor: '#16a34a',
            customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' },
            timer: 1500, showConfirmButton: false,
          }).then(function() {
            if (typeof LiveRefresh !== 'undefined') LiveRefresh.refresh('admin-reports-table');
          });
        } else {
          Swal.fire({ title: 'Error', text: 'Failed to delete.', icon: 'error',
            confirmButtonColor: '#ef4444', customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' } });
        }
      }).catch(function() {
        Swal.fire({ title: 'Network Error', text: 'Could not reach the server.', icon: 'error',
          confirmButtonColor: '#ef4444', customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl' } });
      });
    });
  });

  /* ── Skeleton swap + infinite scroll ─────────────────────── */
  function initInfiniteScroll() {
    var PAGE_SIZE = 12;
    var rows      = Array.from(document.querySelectorAll('.data-row'));
    var sentinel  = document.getElementById('scroll-sentinel');
    var indicator = document.getElementById('load-indicator');
    var loaded    = 0;
    var busy      = false;

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

  function initPage() {
    var skel = document.getElementById('page-skeleton');
    var real = document.getElementById('real-content');
    if (skel) skel.classList.add('hidden');
    if (real) real.classList.remove('hidden');
    initInfiniteScroll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPage);
  } else {
    initPage();
  }

  /* Re-init infinite scroll after live section swap (rows are fresh) */
  document.addEventListener('live:refreshed', function (e) {
    if (e.detail && e.detail.sections && e.detail.sections.indexOf('admin-reports-table') !== -1) {
      initInfiniteScroll();
    }
  });
})();

