(function() {
  setTimeout(function () { var t = document.getElementById('toast'); if (t) t.remove(); }, 4000);
})();

  function initAchievements() {

    /* ── 1. Skeleton → real content ───────────────────────── */
    document.getElementById('page-skeleton').classList.add('hidden');
    document.getElementById('real-content').classList.remove('hidden');

    /* ── 2. Bar fills ─────────────────────────────────────── */
    document.querySelectorAll('[data-width]').forEach(function (el) {
      el.style.width = el.getAttribute('data-width') + '%';
    });

    /* ── 3. Infinite scroll ───────────────────────────────── */
    var PAGE_SIZE = 4;
    var buckets   = Array.from(document.querySelectorAll('.group-bucket'));
    var sentinel  = document.getElementById('scroll-sentinel');
    var indicator = document.getElementById('load-indicator');
    var loaded    = 0;
    var busy      = false;

    function loadMore() {
      if (busy || loaded >= buckets.length) return;
      busy = true;
      if (loaded > 0 && indicator) indicator.classList.remove('hidden');

      setTimeout(function () {
        var batch = buckets.slice(loaded, loaded + PAGE_SIZE);
        batch.forEach(function (el) { el.classList.remove('hidden'); });
        loaded += batch.length;
        busy = false;
        if (indicator) indicator.classList.add('hidden');
        if (loaded >= buckets.length && sentinel) sentinel.remove();
      }, loaded === 0 ? 0 : 380);
    }

    loadMore(); // first batch — no delay

    if (sentinel && 'IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting) loadMore();
      }, { rootMargin: '160px' }).observe(sentinel);
    } else {
      buckets.forEach(function (el) { el.classList.remove('hidden'); });
    }

    /* ── 4. Autocomplete ──────────────────────────────────── */
    var allGroups   = JSON.parse(document.getElementById('all-groups-json').textContent);
    var studentsArr = JSON.parse(document.getElementById('students-json').textContent);
    var suggestions = [], seen = {};

    studentsArr.forEach(function (s) {
      var k = s.name.toLowerCase();
      if (!seen[k]) { seen[k] = 1; suggestions.push({ label: s.name, type: 'student' }); }
    });
    allGroups.forEach(function (g) {
      var gk = 'g:' + g.group_name.toLowerCase();
      if (!seen[gk]) { seen[gk] = 1; suggestions.push({ label: g.group_name, type: g.type === 'PRIVATE' ? 'private' : 'group' }); }
      (g.students || []).forEach(function (name) {
        var sk = name.toLowerCase();
        if (!seen[sk]) { seen[sk] = 1; suggestions.push({ label: name, type: 'student' }); }
      });
    });

    var input    = document.getElementById('search-input');
    var dropdown = document.getElementById('search-dropdown');
    var form     = document.getElementById('filter-form');
    var active   = -1;

    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function tag(t) {
      var cls = t === 'group' ? 'badge-emerald' : t === 'private' ? 'badge-purple' : 'bg-slate-100 text-slate-500';
      var lbl = t === 'group' ? 'Group' : t === 'private' ? 'Private' : 'Student';
      return '<span class="' + cls + ' text-[10px] font-semibold px-1.5 py-0.5 rounded-full ml-1.5">' + lbl + '</span>';
    }

    function renderDD(matches) {
      if (!matches.length) { dropdown.classList.add('hidden'); return; }
      dropdown.innerHTML = matches.map(function (m) {
        return '<button type="button" data-label="' + esc(m.label) + '" class="w-full text-left flex items-center px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 transition ac-item">' +
          '<svg class="w-3.5 h-3.5 text-slate-300 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 15.803a7.5 7.5 0 0 0 10.607 0Z"/></svg>' +
          esc(m.label) + tag(m.type) + '</button>';
      }).join('');
      dropdown.classList.remove('hidden');
      active = -1;
    }

    input.addEventListener('input', function () {
      var q = this.value.trim().toLowerCase();
      if (!q) { dropdown.classList.add('hidden'); return; }
      renderDD(suggestions.filter(function (s) { return s.label.toLowerCase().includes(q); }).slice(0, 8));
    });

    input.addEventListener('keydown', function (e) {
      var its = dropdown.querySelectorAll('.ac-item');
      if (!its.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, its.length - 1); its.forEach(function (el, i) { el.classList.toggle('bg-slate-50', i === active); }); }
      else if (e.key === 'ArrowUp')  { e.preventDefault(); active = Math.max(active - 1, 0); its.forEach(function (el, i) { el.classList.toggle('bg-slate-50', i === active); }); }
      else if (e.key === 'Enter' && active >= 0 && its[active]) { e.preventDefault(); input.value = its[active].dataset.label; dropdown.classList.add('hidden'); form.submit(); }
      else if (e.key === 'Escape') { dropdown.classList.add('hidden'); }
    });

    dropdown.addEventListener('mousedown', function (e) {
      var btn = e.target.closest('.ac-item');
      if (!btn) return;
      e.preventDefault(); input.value = btn.dataset.label; dropdown.classList.add('hidden'); form.submit();
    });

    document.addEventListener('click', function (e) {
      if (!document.getElementById('search-wrapper').contains(e.target)) dropdown.classList.add('hidden');
    });
  } // end initAchievements

  document.addEventListener('DOMContentLoaded', initAchievements);

  /* Re-init after live section swap */
  document.addEventListener('live:refreshed', function (e) {
    if (e.detail.sections.indexOf('admin-achievements-list') !== -1) {
      initAchievements();
    }
  });



(function () {
  var scanInput = document.getElementById('barcode-scanner-input');
  if (!scanInput) return;

  // Focus the scanner input when user presses / outside other inputs
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== scanInput &&
        document.activeElement.tagName !== 'INPUT' &&
        document.activeElement.tagName !== 'SELECT' &&
        document.activeElement.tagName !== 'TEXTAREA') {
      e.preventDefault();
      scanInput.focus();
    }
  });

  scanInput.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var val = this.value.trim();
    if (!val) return;
    e.preventDefault();
    this.value = '';
    // Try barcode lookup first (if it looks like a barcode), else search by name
    showStudentCardByBarcode(val);
  });
})();

async function runStudentSync() {
  if (!confirm('This will scan all classes & reports in the database and generate persistent barcodes for any students who don\'t have one yet.\n\nDo you want to proceed?')) {
    return;
  }
  var btn = document.getElementById('btn-sync-students');
  var txt = document.getElementById('btn-sync-students-text');
  btn.disabled = true;
  btn.classList.add('opacity-75', 'cursor-wait');
  txt.textContent = 'Generating barcodes...';

  try {
    var csrfMeta = document.querySelector('meta[name="csrf-token"]');
    var token = (csrfMeta ? csrfMeta.getAttribute('content') : '') || token;

    var res = await fetch('/admin/student-achievements/migrate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'x-csrf-token': token
      },
      body: JSON.stringify({ _csrf: token })
    });
    var data = await res.json();
    if (data.ok) {
      alert(data.message || 'Sync successful! All students now have barcodes.');
      LiveRefresh.refresh('admin-achievements-list');
    } else {
      alert('Sync failed: ' + (data.error || 'Unknown error'));
      btn.disabled = false;
      btn.classList.remove('opacity-75', 'cursor-wait');
      txt.textContent = 'Sync Student Barcodes';
    }
  } catch (err) {
    alert('Request failed: ' + err.message);
    btn.disabled = false;
    btn.classList.remove('opacity-75', 'cursor-wait');
    txt.textContent = 'Sync Student Barcodes';
  }
}
