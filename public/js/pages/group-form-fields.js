(function () {
  'use strict';

  /* Live student count */
  function updateCount(textarea) {
    if (!textarea) return;
    var lines = textarea.value.split('\n').filter(function (l) { return l.trim().length > 0; });
    var el = document.getElementById('student-count');
    if (el) el.textContent = lines.length;
  }

  /* Highlight active type card on radio change */
  function updateTypeCard() {
    document.querySelectorAll('input[name="type"]').forEach(function (radio) {
      var card = radio.closest('label');
      if (!card) return;
      if (radio.value === 'GROUP') {
        card.className = card.className.replace(/border-(purple|slate)-\S+\s?/g, '').replace(/bg-(purple|emerald)-50/g, '');
        card.classList.add(radio.checked ? 'border-emerald-400' : 'border-slate-100', radio.checked ? 'bg-emerald-50' : '');
      } else {
        card.className = card.className.replace(/border-(emerald|slate)-\S+\s?/g, '').replace(/bg-(emerald|purple)-50/g, '');
        card.classList.add(radio.checked ? 'border-purple-400' : 'border-slate-100', radio.checked ? 'bg-purple-50' : '');
      }
    });
  }

  window.updateCount = updateCount;
  window.updateTypeCard = updateTypeCard;

  if (typeof registerAction === 'function') {
    registerAction('updateCount', function (e, el) {
      updateCount(el);
    });
    registerAction('updateTypeCard', function () {
      updateTypeCard();
    });
    registerAction('setLevelValue', function (e, el) {
      var levelInput = document.getElementById('level');
      if (levelInput) levelInput.value = el.dataset.level;
    });
    registerAction('deleteGroup', function (e, el) {
      if (typeof window.deleteGroup === 'function') {
        window.deleteGroup(el);
      }
    });
  }
})();
