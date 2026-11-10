function getCsrfToken() {
  var m = document.querySelector('meta[name="csrf-token"]');
  return m ? m.getAttribute('content') : '';
}

(function () {
  /* ── State ──────────────────────────────────────────────── */
  var currentBarcode = null;
  var sessionLog     = []; // array of {txId, name, type, time, acTotal, subject, class_name}

  /* ── DOM refs ───────────────────────────────────────────── */
  var scanInput      = document.getElementById('scan-input');
  var scanError      = document.getElementById('scan-error');
  var scanErrorMsg   = document.getElementById('scan-error-msg');
  var studentCard    = document.getElementById('student-card');
  var idlePlaceholder= document.getElementById('idle-placeholder');
  var scName         = document.getElementById('sc-name');
  var scGrade        = document.getElementById('sc-grade');
  var scCode         = document.getElementById('sc-code');
  var scTotal        = document.getElementById('sc-total');
  var scAvatar       = document.getElementById('sc-avatar');
  var btnAdd         = document.getElementById('btn-add');
  var btnReduce      = document.getElementById('btn-reduce');
  var logList        = document.getElementById('log-list');
  var logEmpty       = document.getElementById('log-empty');
  var logCount       = document.getElementById('log-count');
  var ctxSubject     = document.getElementById('ctx-subject');
  var ctxClass       = document.getElementById('ctx-class');

  /* ── Auto-focus on load ─────────────────────────────────── */
  scanInput.focus();
  document.addEventListener('keydown', function (e) {
    if (document.activeElement !== scanInput &&
        document.activeElement !== ctxSubject &&
        document.activeElement !== ctxClass) {
      if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
        scanInput.focus();
      }
    }
  });

  /* ── Barcode scan handler ───────────────────────────────── */
  scanInput.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    var barcode = this.value.trim();
    this.value  = '';
    if (!barcode) return;
    lookupBarcode(barcode);
  });

  /* ── Extract barcode from raw scan or typed value (handles QR URLs) ── */
  function extractBarcode(raw) {
    if (!raw) return '';
    raw = raw.trim();
    if (/^https?:\/\//i.test(raw)) {
      try {
        var url = new URL(raw);
        var match = url.pathname.match(/\/(?:student-card|c)\/([^\/]+)/i);
        if (match && match[1]) return decodeURIComponent(match[1]);
      } catch (e) {}
    }
    return raw;
  }

  /* ── Lookup ─────────────────────────────────────────────── */
  function lookupBarcode(raw) {
    var barcode = extractBarcode(raw);
    if (!barcode) return;
    hideError();
    fetch('/admin/scan-ac/lookup?barcode=' + encodeURIComponent(barcode))
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.ok) { return showError(res.error || 'Student not found.'); }
        currentBarcode = barcode;
        renderStudentCard(res.student);
      })
      .catch(function () { showError('Network error. Please try again.'); });
  }

  /* ── Render student card ────────────────────────────────── */
  function renderStudentCard(s) {
    scAvatar.textContent = (s.full_name || '?').charAt(0).toUpperCase();
    scName.textContent   = s.full_name || '—';
    scTotal.textContent  = s.acTotal || 0;
    scCode.textContent   = s.student_code || '';

    if (s.grade_school) {
      scGrade.textContent = s.grade_school;
      scGrade.classList.remove('hidden');
    } else {
      scGrade.classList.add('hidden');
    }

    idlePlaceholder.classList.add('hidden');
    studentCard.classList.remove('hidden');
    studentCard.classList.remove('card-pop');
    void studentCard.offsetWidth; // force reflow
    studentCard.classList.add('card-pop');
  }

  /* ── Action buttons ─────────────────────────────────────── */
  btnAdd.addEventListener('click',    function () { doTransact('add');    });
  btnReduce.addEventListener('click', function () { doTransact('reduce'); });

  function doTransact(type) {
    if (!currentBarcode) return;
    btnAdd.disabled    = true;
    btnReduce.disabled = true;

    var body = new URLSearchParams({
      barcode:    currentBarcode,
      type:       type,
      subject:    ctxSubject.value.trim(),
      class_name: ctxClass.value.trim(),
      _csrf:      getCsrfToken(),
    });

    fetch('/admin/scan-ac/transact', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-csrf-token': getCsrfToken(),
      },
      body:    body.toString(),
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        btnAdd.disabled    = false;
        btnReduce.disabled = false;

        if (!res.ok) { return showError(res.error || 'Failed to record transaction.'); }

        // Update total display
        scTotal.textContent = res.acTotal;

        // Flash the total
        scTotal.style.transition = 'color .15s';
        scTotal.style.color = type === 'add' ? '#059669' : '#dc2626';
        setTimeout(function () { scTotal.style.color = ''; }, 600);

        // Add to session log
        addToLog({
          txId:       res.transaction._id,
          name:       res.transaction.student_name,
          type:       res.transaction.type,
          acTotal:    res.acTotal,
          subject:    res.transaction.subject    || ctxSubject.value.trim(),
          class_name: res.transaction.class_name || ctxClass.value.trim(),
          time:       new Date(),
        });

        // Refocus scanner
        setTimeout(function () { scanInput.focus(); }, 100);
      })
      .catch(function () {
        btnAdd.disabled    = false;
        btnReduce.disabled = false;
        showError('Network error. Please try again.');
      });
  }

  /* ── Session log ────────────────────────────────────────── */
  function addToLog(entry) {
    sessionLog.unshift(entry);

    logEmpty.classList.add('hidden');
    logCount.textContent = sessionLog.length + (sessionLog.length === 1 ? ' scan' : ' scans');

    var timeStr = entry.time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    var isAdd   = entry.type === 'add';

    var row = document.createElement('div');
    row.id  = 'log-row-' + entry.txId;
    row.className = 'px-5 py-3 flex items-center gap-3 ' + (isAdd ? 'row-add' : 'row-reduce');
    row.innerHTML =
      '<div class="w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center font-bold text-sm ' +
        (isAdd ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-600') + '">' +
        (isAdd ? '+' : '−') + '</div>' +
      '<div class="flex-1 min-w-0">' +
        '<p class="text-sm font-semibold text-slate-800 truncate">' + escH(entry.name) + '</p>' +
        '<p class="text-xs text-slate-400 truncate">' +
          (entry.subject ? escH(entry.subject) : '') +
          (entry.class_name ? ' · ' + escH(entry.class_name) : '') +
        '</p>' +
      '</div>' +
      '<div class="flex-shrink-0 text-right">' +
        '<p class="text-xs font-bold ' + (isAdd ? 'text-emerald-600' : 'text-red-500') + '">' +
          (isAdd ? '+1 AC' : '−1 AC') +
        '</p>' +
        '<p class="text-[10px] text-slate-400">' + timeStr + '</p>' +
      '</div>' +
      '<button data-action="undoLog" data-tx-id="' + entry.txId + '" ' +
        'class="flex-shrink-0 w-6 h-6 rounded-full bg-slate-100 hover:bg-red-100 hover:text-red-500 flex items-center justify-center text-slate-400 text-xs transition" ' +
        'title="Undo this transaction">✕</button>';

    logList.insertBefore(row, logList.firstChild);
  }

  window.undoLog = function (txId) {
    if (!confirm('Undo this AC transaction?')) return;
    fetch('/admin/scan-ac/transact/' + txId, {
      method: 'DELETE',
      headers: { 'x-csrf-token': getCsrfToken() }
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.ok) { return showError(res.error || 'Failed to undo.'); }
        var row = document.getElementById('log-row-' + txId);
        if (row) row.remove();
        sessionLog = sessionLog.filter(function (e) { return e.txId !== txId; });
        logCount.textContent = sessionLog.length + (sessionLog.length === 1 ? ' scan' : ' scans');
        if (!sessionLog.length) logEmpty.classList.remove('hidden');
        // Update current student total if same student
        if (currentBarcode) {
          lookupBarcode(currentBarcode);
        }
      })
      .catch(function () { showError('Network error.'); });
  };

  /* ── Error helpers ──────────────────────────────────────── */
  function showError(msg) {
    scanErrorMsg.textContent = msg;
    scanError.classList.remove('hidden');
    scanInput.focus();
    setTimeout(function () { scanError.classList.add('hidden'); }, 4000);
  }
  function hideError() { scanError.classList.add('hidden'); }

  function escH(str) {
    return String(str || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

})();



(function () {
  var mobileUrl = window.location.protocol + '//' + window.location.host + '/admin/scan-ac/mobile';
  document.getElementById('mobile-link').href = mobileUrl;
  try {
    new QRCode(document.getElementById('mobile-qr'), {
      text:   mobileUrl,
      width:  100,
      height: 100,
      colorDark:  '#1e1b4b',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
  } catch(e) {
    document.getElementById('mobile-qr').innerHTML =
      '<p style="font-size:10px;color:#64748b;padding:8px;">QR unavailable</p>';
  }
})();
