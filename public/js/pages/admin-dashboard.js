(function () {
  var chartTeachersEl = document.getElementById('chartTeachersData');
  var dailyTrendEl    = document.getElementById('dailyTrendData');
  if (!chartTeachersEl || !dailyTrendEl) return;

  var chartTeachers = JSON.parse(chartTeachersEl.textContent);
  var dailyTrend    = JSON.parse(dailyTrendEl.textContent);

  var chartDefaults = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { cornerRadius: 8 } },
  };

  // Bar chart — reports per teacher
  if (chartTeachers.length === 0) {
    var emptyEl = document.getElementById('chartTeachersEmpty');
    if (emptyEl) emptyEl.classList.remove('hidden');
  } else {
    var ctxT = document.getElementById('chartTeachers');
    if (ctxT && typeof Chart !== 'undefined') {
      new Chart(ctxT, {
        type: 'bar',
        data: {
          labels: chartTeachers.map(function(t) { return t.name; }),
          datasets: [{
            data: chartTeachers.map(function(t) { return t.count; }),
            backgroundColor: 'rgba(99,102,241,0.15)',
            borderColor: 'rgba(99,102,241,0.7)',
            borderWidth: 2,
            borderRadius: 6,
            borderSkipped: false,
          }],
        },
        options: Object.assign({}, chartDefaults, {
          scales: {
            y: { beginAtZero: true, ticks: { stepSize: 1, font: { size: 11 } }, grid: { color: 'rgba(148,163,184,0.12)' } },
            x: { ticks: { font: { size: 11 } }, grid: { display: false } },
          },
        }),
      });
    }
  }

  // Line chart — daily trend
  if (dailyTrend.length === 0) {
    var emptyTrendEl = document.getElementById('chartTrendEmpty');
    if (emptyTrendEl) emptyTrendEl.classList.remove('hidden');
  } else {
    var ctxD = document.getElementById('chartDailyTrend');
    if (ctxD && typeof Chart !== 'undefined') {
      new Chart(ctxD, {
        type: 'line',
        data: {
          labels: dailyTrend.map(function(d) { return d.date.substring(8); }), // day number
          datasets: [{
            data: dailyTrend.map(function(d) { return d.count; }),
            borderColor: 'rgba(16,185,129,0.8)',
            backgroundColor: 'rgba(16,185,129,0.08)',
            borderWidth: 2.5,
            pointRadius: 4,
            pointHoverRadius: 6,
            tension: 0.3,
            fill: true,
          }],
        },
        options: Object.assign({}, chartDefaults, {
          scales: {
            y: { beginAtZero: true, ticks: { stepSize: 1, font: { size: 11 } }, grid: { color: 'rgba(148,163,184,0.12)' } },
            x: { ticks: { font: { size: 11 } }, grid: { display: false } },
          },
        }),
      });
    }
  }
})();
