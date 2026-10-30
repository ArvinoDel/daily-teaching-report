
(function () {
  var cardDataEl = document.getElementById('card-data-json');
  var cardConfig = {};
  try {
    cardConfig = cardDataEl ? JSON.parse(cardDataEl.textContent || '{}') : {};
  } catch (e) {
    console.error('Failed to parse card data:', e);
  }

  var students = cardConfig.students || [];
  if (!students || students.length === 0) return;

  var baseUrl  = cardConfig.baseUrl || (window.location.protocol + '//' + window.location.host);
  window.CARD_DATA = students;
  window.BASE_URL  = baseUrl;

  var wrapper   = document.getElementById('sheet-wrapper');
  var colSelect = document.getElementById('col-select');
  var printBtn  = document.getElementById('btn-print');
  var printLbl  = document.getElementById('btn-print-label');

  /* ── QR size map per columns ── */
  var QR_SIZE  = { '2': 130, '3': 100, '4': 76 };
  /* ── Cards per page map per columns ── */
  var PER_PAGE = { '2': 8,   '3': 9,   '4': 12 };

  /* ══════════════════════════════════════════════════════════
     STEP 1 — Expand students → one entry per (student, group)
     A student in 2 groups gets 2 separate entries / cards.
     A student with no group gets 1 entry with group = null.
  ══════════════════════════════════════════════════════════ */
  var entries = []; // { student, group, uid }
  students.forEach(function(s) {
    if (!s.groups || s.groups.length === 0) {
      entries.push({ student: s, group: null, uid: s._id + '_0' });
    } else {
      s.groups.forEach(function(g, gi) {
        entries.push({ student: s, group: g, uid: s._id + '_' + gi });
      });
    }
  });

  // Sort entries: by group name then student name — keeps each class together
  entries.sort(function(a, b) {
    var ga = a.group ? a.group.groupName : '';
    var gb = b.group ? b.group.groupName : '';
    if (ga !== gb) return ga.localeCompare(gb);
    return a.student.full_name.localeCompare(b.student.full_name);
  });

  // Update toolbar subtitle with real card count
  var subEl = document.querySelector('.toolbar-sub');
  if (subEl) {
    subEl.textContent = entries.length + ' card' + (entries.length !== 1 ? 's' : '') +
      ' (' + students.length + ' student' + (students.length !== 1 ? 's' : '') + ') ready to print · ' +
      'Scan QR to view the student\'s public Achievement Card';
  }

  /* ── Avatar gradient ── */
  function avatarStyle(name) {
    var hue  = (name.charCodeAt(0) * 37) % 360;
    var hue2 = (hue + 30) % 360;
    return 'background:linear-gradient(135deg,hsl(' + hue + ',65%,58%),hsl(' + hue2 + ',75%,38%))';
  }

  /* ══════════════════════════════════════════════════════════
     STEP 2 — Build one card DOM node per entry
     Each card only shows ITS OWN group chip (not all groups).
  ══════════════════════════════════════════════════════════ */
  function buildCardNode(entry) {
    var s   = entry.student;
    var g   = entry.group;
    var uid = entry.uid;

    var card = document.createElement('div');
    card.className = 'student-card';
    card.dataset.uid = uid;

    // Header: avatar + name + grade
    var initials  = (s.full_name || '?').charAt(0).toUpperCase();
    var gradeHtml = s.grade_school
      ? '<div class="card-grade">' + escH(s.grade_school) + '</div>'
      : '';

    // Single group chip for THIS entry only
    var chipHtml = '';
    if (g) {
      var cls   = g.type === 'PRIVATE' ? 'chip-private' : g.type === 'GROUP' ? 'chip-regular' : 'chip-default';
      var label = escH(g.groupName) + (g.level ? ' · ' + escH(g.level) : '');
      chipHtml  = '<div class="card-groups"><span class="group-chip ' + cls + '">' + label + '</span></div>';
    }

    card.innerHTML =
      '<div class="card-header">' +
        '<div class="card-avatar" style="' + avatarStyle(s.full_name) + '">' + initials + '</div>' +
        '<div class="card-name-block">' +
          '<div class="card-name">' + escH(s.full_name) + '</div>' +
          gradeHtml +
        '</div>' +
      '</div>' +
      '<div class="card-qr" id="qr-' + uid + '"></div>' +
      '<div class="card-code">' + escH(s.student_code) + '</div>' +
      chipHtml;

    return card;
  }

  /* ── Paginate cards into A4 pages ── */
  function buildPages(cardNodes, cols) {
    var perPage = PER_PAGE[String(cols)] || 9;
    var pages   = [];
    for (var i = 0; i < cardNodes.length; i += perPage) {
      pages.push(cardNodes.slice(i, i + perPage));
    }
    return pages;
  }

  /* ── Main render ── */
  function render(cols) {
    var qrSize = QR_SIZE[String(cols)] || 100;

    // Build one card node per entry
    var cardNodes = entries.map(buildCardNode);

    // Paginate and inject into DOM
    var loading = document.getElementById('loading-indicator');
    if (loading) loading.remove();

    // Remove old pages
    wrapper.querySelectorAll('.a4-page').forEach(function(p) { p.remove(); });

    var pages = buildPages(cardNodes, cols);
    pages.forEach(function(group, pageIdx) {
      var page = document.createElement('div');
      page.className = 'a4-page';

      var grid = document.createElement('div');
      grid.className = 'card-grid';
      grid.dataset.cols = String(cols);
      group.forEach(function(node) { grid.appendChild(node); });
      page.appendChild(grid);

      var guide = document.createElement('div');
      guide.className = 'cut-guide';
      guide.textContent = 'Cut along card borders · Page ' + (pageIdx + 1) + ' of ' + pages.length;
      page.appendChild(guide);

      wrapper.appendChild(page);
    });

    /* ══════════════════════════════════════════════════════════
       STEP 3 — Generate QR codes via rAF batching
       One QR per entry (same barcode, different uid element).
    ══════════════════════════════════════════════════════════ */
    var i = 0;
    function genNext() {
      if (i >= entries.length) {
        printBtn.disabled = false;
        printLbl.textContent = 'Print / Save as PDF';
        return;
      }
      var entry = entries[i++];
      var s     = entry.student;
      var uid   = entry.uid;
      var el    = document.getElementById('qr-' + uid);
      if (el && s.barcode) {
        try {
          new QRCode(el, {
            text:         baseUrl + '/student-card/' + encodeURIComponent(s.barcode),
            width:        qrSize,
            height:       qrSize,
            colorDark:    '#1e1b4b',
            colorLight:   '#f8fafc',
            correctLevel: QRCode.CorrectLevel.M,
          });
        } catch(e) {
          el.innerHTML = '<span style="font-size:9px;color:#94a3b8;">QR error</span>';
        }
      }
      requestAnimationFrame(genNext);
    }
    requestAnimationFrame(genNext);
  }

  // Initial render
  render(3);

  // Column selector
  colSelect.addEventListener('change', function() {
    printBtn.disabled = true;
    printLbl.textContent = 'Regenerating…';
    setTimeout(function() { render(parseInt(colSelect.value, 10)); }, 50);
  });

  /* ── Helpers ── */
  function escH(str) {
    return String(str || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
})();
