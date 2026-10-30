(function () {
  'use strict';

  var overlay  = document.getElementById('student-card-overlay');
  var panel    = document.getElementById('student-card-panel');
  var loading  = document.getElementById('card-loading');
  var errorEl  = document.getElementById('card-error');
  var errorMsg = document.getElementById('card-error-msg');
  var content  = document.getElementById('card-content');
  var currentStudent = null;

  /* ── Open / Close ── */
  function openOverlay() {
    if (!overlay || !panel) return;
    overlay.classList.remove('hidden');
    overlay.classList.add('flex');
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(function () {
      panel.style.transform = 'translateY(0)';
      panel.style.opacity   = '1';
    });
  }

  function closeStudentCard() {
    if (!panel || !overlay) return;
    panel.style.transform = 'translateY(16px)';
    panel.style.opacity   = '0';
    setTimeout(function () {
      overlay.classList.add('hidden');
      overlay.classList.remove('flex');
      document.body.style.overflow = '';
      if (loading) loading.classList.remove('hidden');
      if (errorEl) errorEl.classList.add('hidden');
      if (content) {
        content.classList.add('hidden');
        content.classList.remove('flex');
      }
    }, 280);
  }

  window.closeStudentCard = closeStudentCard;

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && overlay && !overlay.classList.contains('hidden')) {
      closeStudentCard();
    }
  });

  /* ── Public API — open by student _id ── */
  window.showStudentCard = function (studentId) {
    openOverlay();
    resetStates();
    fetch('/admin/student-achievements/student/' + studentId)
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.ok) return showCardError(res.error || 'Not found.');
        renderCard(res.student);
      })
      .catch(function () { showCardError('Network error.'); });
  };

  /* ── Public API — open by barcode string ── */
  window.showStudentCardByBarcode = function (barcode) {
    openOverlay();
    resetStates();
    fetch('/admin/student-achievements/scan?barcode=' + encodeURIComponent(barcode))
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.ok) return showCardError(res.error || 'Not found.');
        renderCard(res.student);
      })
      .catch(function () { showCardError('Network error.'); });
  };

  /* ── Render ── */
  function renderCard(s) {
    currentStudent = s;
    var avatarEl = document.getElementById('card-avatar');
    if (avatarEl) avatarEl.textContent = (s.full_name || '?').charAt(0).toUpperCase();

    var nameEl = document.getElementById('card-student-name');
    if (nameEl) nameEl.textContent = s.full_name || s.raw_name || '—';

    var totalEl = document.getElementById('card-ac-total');
    if (totalEl) totalEl.textContent = s.acTotal || 0;

    // Reset scroll position to top
    var scrollBody = document.getElementById('card-scroll-body');
    if (scrollBody) scrollBody.scrollTop = 0;

    // Badges
    var badges = document.getElementById('card-badges');
    if (badges) {
      badges.innerHTML = '';
      if (s.grade_school) {
        badges.innerHTML += '<span class="inline-block bg-slate-100 text-slate-600 text-xs font-semibold px-2 py-0.5 rounded-full">' + escH(s.grade_school) + '</span>';
      }
    }

    // Groups
    var groupsSec = document.getElementById('card-groups-section');
    var groupsEl  = document.getElementById('card-groups');
    if (groupsSec && groupsEl) {
      if (s.groups && s.groups.length) {
        groupsSec.classList.remove('hidden');
        groupsEl.innerHTML = s.groups.map(function (g) {
          var color = g.type === 'PRIVATE' ? 'bg-purple-100 text-purple-700' : 'bg-emerald-100 text-emerald-700';
          return '<span class="inline-block ' + color + ' text-xs font-semibold px-2.5 py-1 rounded-full">' + escH(g.groupName) + (g.level ? ' · ' + escH(g.level) : '') + '</span>';
        }).join('');
      } else {
        groupsSec.classList.add('hidden');
      }
    }

    // QR Code
    var qrContainer    = document.getElementById('card-qrcode');
    var barcodeMissing = document.getElementById('card-barcode-missing');
    var studentCode    = document.getElementById('card-student-code');
    var publicLink     = document.getElementById('card-public-link');
    var BASE_URL       = window.location.origin || (window.location.protocol + '//' + window.location.host);

    if (qrContainer) qrContainer.innerHTML = '';
    if (s.barcode && typeof QRCode !== 'undefined') {
      try {
        var cardUrl = BASE_URL + '/student-card/' + encodeURIComponent(s.barcode);
        new QRCode(qrContainer, {
          text:         cardUrl,
          width:        160,
          height:       160,
          colorDark:    '#1e1b4b',
          colorLight:   '#ffffff',
          correctLevel: QRCode.CorrectLevel.M,
        });
        if (barcodeMissing) barcodeMissing.classList.add('hidden');
        if (publicLink) {
          publicLink.href = cardUrl;
          publicLink.classList.remove('hidden');
        }
      } catch (e) {
        if (qrContainer) qrContainer.innerHTML = '<p style="font-size:11px;color:#94a3b8;">QR error</p>';
        if (barcodeMissing) barcodeMissing.classList.add('hidden');
      }
    } else {
      if (barcodeMissing) barcodeMissing.classList.remove('hidden');
      if (publicLink) publicLink.classList.add('hidden');
    }
    if (studentCode) studentCode.textContent = s.student_code || s.barcode || '';

    // AC History
    var histList  = document.getElementById('card-history-list');
    var histEmpty = document.getElementById('card-history-empty');
    var histCount = document.getElementById('card-history-count');
    var history   = s.acHistory || [];
    if (histCount) histCount.textContent = history.length;

    if (histEmpty && histList) {
      if (!history.length) {
        histEmpty.classList.remove('hidden');
        histList.innerHTML = '';
      } else {
        histEmpty.classList.add('hidden');
        histList.innerHTML = history.map(function (h) {
          var d = new Date(h.date);
          var dateStr = isNaN(d) ? '—' : d.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
          var isAdd  = h.type !== 'reduce';
          var badge  = h.source === 'scan'
            ? '<span class="text-[10px] font-bold bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded ml-1">SCAN</span>'
            : '<span class="text-[10px] font-bold bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded ml-1">REPORT</span>';
          var absCount = Math.abs(h.count || 1);
          var countBadge = isAdd
            ? '<span class="text-[10px] font-bold bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded ml-1">+' + absCount + '</span>'
            : '<span class="text-[10px] font-bold bg-rose-100 text-rose-700 px-1.5 py-0.5 rounded ml-1">−' + absCount + '</span>';
          var dotColor = isAdd ? 'bg-emerald-500' : 'bg-rose-500';

          var metaParts = [];
          if (h.subject) metaParts.push(escH(h.subject));
          if (h.teacher) metaParts.push('by ' + escH(h.teacher));
          if (h.note) metaParts.push('"' + escH(h.note) + '"');
          var metaStr = metaParts.join(' · ');

          return '<div class="px-6 py-3 flex items-center gap-3 hover:bg-slate-50/80 transition">' +
            '<div class="flex-shrink-0 w-2 h-2 rounded-full ' + dotColor + ' mt-0.5"></div>' +
            '<div class="flex-1 min-w-0">' +
              '<p class="text-sm font-semibold text-slate-800 truncate">' + escH(h.class_name || 'Admin Adjustment') + badge + countBadge + '</p>' +
              (metaStr ? '<p class="text-xs text-slate-400 truncate mt-0.5">' + metaStr + '</p>' : '') +
            '</div>' +
            '<span class="text-xs text-slate-400 flex-shrink-0 font-medium">' + dateStr + '</span>' +
            '</div>';
        }).join('');
      }
    }

    if (loading) loading.classList.add('hidden');
    if (content) {
      content.classList.remove('hidden');
      content.classList.add('flex');
    }
  }

  function showCardError(msg) {
    if (loading) loading.classList.add('hidden');
    if (content) {
      content.classList.add('hidden');
      content.classList.remove('flex');
    }
    if (errorMsg) errorMsg.textContent = msg;
    if (errorEl) {
      errorEl.classList.remove('hidden');
      errorEl.classList.add('flex');
    }
  }

  function resetStates() {
    if (loading) loading.classList.remove('hidden');
    if (errorEl) {
      errorEl.classList.add('hidden');
      errorEl.classList.remove('flex');
    }
    if (content) {
      content.classList.add('hidden');
      content.classList.remove('flex');
    }
  }

  function escH(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  window.printStudentCard = function () { window.print(); };

  if (typeof registerAction === 'function') {
    registerAction('closeStudentCard', function () {
      if (typeof window.closeStudentCard === 'function') {
        window.closeStudentCard();
      }
    });
    registerAction('printStudentCard', function () {
      if (typeof window.printStudentCard === 'function') {
        window.printStudentCard();
      }
    });
  }
})();
