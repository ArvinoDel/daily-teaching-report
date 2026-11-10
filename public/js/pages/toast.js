(function () {
  'use strict';
  try {
    var dataEl = document.getElementById('toast-data');
    var data = dataEl ? JSON.parse(dataEl.textContent || '{}') : {};
    var uid = data.uid || '';
    if (uid) localStorage.removeItem('dtr_report_draft_' + uid);
    localStorage.removeItem('dtr_report_draft_anonymous');
    sessionStorage.removeItem('dtr_draft_discarded');
  } catch (e) {}

  setTimeout(function () {
    var t = document.getElementById('toast');
    if (t) {
      t.style.opacity = '0';
      t.style.transform = 'translateX(16px)';
    }
  }, 3000);
})();

