(function () {
  // 1. Stuck for more than 7 days filter toggle
  var filterBtn = document.getElementById('toggle-filter-7days');
  var isFiltered = false;

  if (filterBtn) {
    filterBtn.addEventListener('click', function () {
      isFiltered = !isFiltered;
      var rows = document.querySelectorAll('.stuck-teacher-row');
      rows.forEach(function (row) {
        var days = parseInt(row.getAttribute('data-days-since') || '0', 10);
        if (isFiltered && days <= 7) {
          row.style.display = 'none';
        } else {
          row.style.display = '';
        }
      });

      if (isFiltered) {
        filterBtn.classList.add('bg-brand-50', 'text-brand-700', 'border-brand-200');
        filterBtn.classList.remove('bg-white', 'text-slate-600', 'border-slate-200');
      } else {
        filterBtn.classList.remove('bg-brand-50', 'text-brand-700', 'border-brand-200');
        filterBtn.classList.add('bg-white', 'text-slate-600', 'border-slate-200');
      }
    });
  }

  // 2. Per-teacher Send reminder AJAX
  function getCsrfToken() {
    var m = document.querySelector('meta[name="csrf-token"]');
    return m ? m.getAttribute('content') : '';
  }

  document.querySelectorAll('.btn-send-reminder').forEach(function (btn) {
    btn.addEventListener('click', async function (e) {
      e.preventDefault();
      var userId = btn.getAttribute('data-user-id');
      if (!userId || btn.disabled) return;

      var originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Sending…';

      try {
        var res = await fetch('/admin/onboarding/' + encodeURIComponent(userId) + '/remind', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'x-csrf-token': getCsrfToken(),
          },
        });

        var data = await res.json().catch(function () { return { ok: false }; });

        if (res.ok && data.ok) {
          btn.textContent = 'Sent today';
          btn.className = 'btn-send-reminder min-h-[36px] px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 text-slate-400 cursor-not-allowed transition focus-visible:outline-none';
        } else {
          alert(data.error || 'Failed to send reminder.');
          btn.disabled = false;
          btn.textContent = originalText;
        }
      } catch (err) {
        console.error('Send reminder error:', err);
        alert('Failed to send reminder.');
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  });
})();

