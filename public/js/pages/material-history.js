(function() {
  const items = document.querySelectorAll('.rev-timeline-item');
  const panes = document.querySelectorAll('.rev-preview-pane');

  function selectVersion(v) {
    items.forEach(function(el) {
      const matches = el.getAttribute('data-version') === String(v);
      if (matches) {
        el.classList.add('border-brand', 'bg-brand/5', 'ring-1', 'ring-brand');
        el.classList.remove('border-slate-200', 'bg-white');
      } else {
        el.classList.remove('border-brand', 'bg-brand/5', 'ring-1', 'ring-brand');
        el.classList.add('border-slate-200', 'bg-white');
      }
    });
    panes.forEach(function(pane) {
      if (pane.id === 'rev-preview-' + v) {
        pane.classList.remove('hidden');
      } else {
        pane.classList.add('hidden');
      }
    });
  }

  items.forEach(function(item) {
    const v = item.getAttribute('data-version');
    item.addEventListener('click', function() { selectVersion(v); });
    item.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectVersion(v);
      }
    });
  });
})();
