function toggleDetail(idx) {
  var row    = document.getElementById('detail-' + idx);
  var toggle = document.getElementById('toggle-' + idx);
  var icon   = toggle ? toggle.querySelector('svg') : null;
  if (!row) return;
  var isOpen = !row.classList.contains('hidden');
  row.classList.toggle('hidden', isOpen);
  if (icon) icon.style.transform = isOpen ? '' : 'rotate(180deg)';
}

if (typeof registerAction === 'function') {
  registerAction('toggleCommissionDetail', function (e, el) {
    toggleDetail(el.dataset.idx);
  });
}
