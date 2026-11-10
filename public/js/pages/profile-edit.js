(function () {
  'use strict';

  function showSizeError() {
    const toast = document.getElementById('size-toast');
    if (toast) {
      toast.classList.remove('hidden');
      setTimeout(() => toast.classList.add('hidden'), 3000);
    }
  }

  function previewAvatar(input) {
    if (input.files && input.files[0]) {
      const file = input.files[0];
      if (file.size > 2 * 1024 * 1024) {
        input.value = '';
        showSizeError();
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const preview  = document.getElementById('avatar-preview');
        const initials = document.getElementById('avatar-initials');
        if (preview) {
          preview.src = e.target.result;
          preview.classList.remove('hidden');
        }
        if (initials) initials.classList.add('hidden');
      };
      reader.readAsDataURL(file);
    }
  }

  window.showSizeError = showSizeError;
  window.previewAvatar = previewAvatar;

  // Auto-scroll and highlight commission section if linked via #commission-section
  if (window.location.hash === '#commission-section') {
    const el = document.getElementById('commission-section');
    if (el) {
      setTimeout(() => {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.classList.add('ring-2', 'ring-brand-500', 'ring-offset-2');
        setTimeout(() => el.classList.remove('ring-2', 'ring-brand-500', 'ring-offset-2'), 2500);
      }, 150);
    }
  }

  if (typeof registerAction === 'function') {
    registerAction('previewAvatar', function (e, el) {
      previewAvatar(el);
    });
  }
})();

