(function () {
  if (window.location.hash === '#commission-section') {
    var el = document.getElementById('commission-section');
    if (el) setTimeout(function() {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.classList.add('ring-2', 'ring-amber-300', 'ring-offset-2');
      setTimeout(function() { el.classList.remove('ring-2', 'ring-amber-300', 'ring-offset-2'); }, 2000);
    }, 150);
  }

  var form  = document.getElementById('edit-user-form');
  var dirty = false;

  if (form) {
    form.addEventListener('input',  function () { dirty = true; });
    form.addEventListener('change', function () { dirty = true; });
    form.addEventListener('submit', function () { dirty = false; });
  }

  var cancelBtn = document.getElementById('cancel-btn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', function (e) {
      if (!dirty) return;
      e.preventDefault();
      if (typeof Swal !== 'undefined') {
        Swal.fire({
          title: 'Unsaved changes',
          text: 'You have unsaved changes. Leave anyway?',
          icon: 'warning',
          showCancelButton: true,
          confirmButtonColor: '#ef4444', cancelButtonColor: '#64748b',
          confirmButtonText: 'Leave', cancelButtonText: 'Stay',
          reverseButtons: true, focusCancel: true,
          customClass: { popup: 'rounded-2xl', confirmButton: 'rounded-xl', cancelButton: 'rounded-xl' },
        }).then(function (result) {
          if (result.isConfirmed) window.location.href = '/admin/users';
        });
      } else {
        if (confirm('You have unsaved changes. Leave anyway?')) {
          window.location.href = '/admin/users';
        }
      }
    });
  }

  window.addEventListener('beforeunload', function (e) {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });
})();
