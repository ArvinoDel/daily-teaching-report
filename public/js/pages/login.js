(function () {
  'use strict';
  const togglePassword = document.getElementById('toggle-password');
  const passwordInput = document.getElementById('password');
  const eyeIcon = document.getElementById('eye-icon');
  const eyeSlashIcon = document.getElementById('eye-slash-icon');

  if (togglePassword && passwordInput) {
    togglePassword.addEventListener('click', function () {
      const type = passwordInput.getAttribute('type') === 'password' ? 'text' : 'password';
      passwordInput.setAttribute('type', type);
      if (eyeIcon) eyeIcon.classList.toggle('hidden');
      if (eyeSlashIcon) eyeSlashIcon.classList.toggle('hidden');
    });
  }
})();
