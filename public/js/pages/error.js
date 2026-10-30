(function () {
  'use strict';
  var dataEl = document.getElementById('error-page-data');
  var pageData = dataEl ? JSON.parse(dataEl.textContent || '{}') : {};
  var metaCsrf = document.querySelector('meta[name="csrf-token"]');
  var CSRF_TOKEN = pageData.csrfToken || (metaCsrf ? metaCsrf.getAttribute('content') : '');

  // Toggle panel
  var toggleBtn = document.getElementById('toggleFeedbackBtn');
  var panel = document.getElementById('feedbackPanel');
  if (toggleBtn && panel) {
    toggleBtn.addEventListener('click', function () {
      panel.classList.toggle('hidden');
    });
  }

  // Character counter
  var descEl = document.getElementById('fb_description');
  var charCountEl = document.getElementById('fb_charCount');
  if (descEl && charCountEl) {
    descEl.addEventListener('input', function () {
      charCountEl.textContent = this.value.length;
    });
  }

  // Screenshot preview
  var screenEl = document.getElementById('fb_screenshot');
  var preview = document.getElementById('fb_preview');
  var img = document.getElementById('fb_previewImg');
  if (screenEl && preview && img) {
    screenEl.addEventListener('change', function () {
      var file = this.files[0];
      if (file) {
        img.src = URL.createObjectURL(file);
        preview.classList.remove('hidden');
      } else {
        preview.classList.add('hidden');
      }
    });
  }

  // Submit
  var submitBtn = document.getElementById('fb_submitBtn');
  if (submitBtn) {
    submitBtn.addEventListener('click', function () {
      var btn = this;
      var errBox  = document.getElementById('feedbackErrors');
      var errList = document.getElementById('feedbackErrorList');
      if (errBox) errBox.classList.add('hidden');
      if (errList) errList.innerHTML = '';

      var description = descEl ? descEl.value : '';
      var screenshot  = screenEl && screenEl.files ? screenEl.files[0] : null;

      var nameEl  = document.getElementById('fb_name');
      var emailEl = document.getElementById('fb_email');
      var name  = nameEl ? nameEl.value : '';
      var email = emailEl ? emailEl.value : '';

      var fd = new FormData();
      fd.append('_csrf', CSRF_TOKEN);
      fd.append('description', description);
      fd.append('pageUrl', window.location.href);
      if (nameEl)  fd.append('submitterName',  name);
      if (emailEl) fd.append('submitterEmail', email);
      if (screenshot) fd.append('screenshot', screenshot);

      btn.disabled = true;
      var originalHtml = btn.innerHTML;
      btn.innerHTML = '<svg class="w-4 h-4 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg> Sending...';

      fetch('/feedback', { method: 'POST', body: fd })
        .then(function (res) {
          return res.json();
        })
        .then(function (data) {
          if (data.ok) {
            var fbForm = document.getElementById('feedbackForm');
            var fbSuccess = document.getElementById('feedbackSuccess');
            if (fbForm) fbForm.classList.add('hidden');
            if (fbSuccess) fbSuccess.classList.remove('hidden');
          } else {
            var msgs = data.errors || ['An error occurred.'];
            if (errList) {
              msgs.forEach(function (m) {
                var li = document.createElement('li');
                li.textContent = m;
                errList.appendChild(li);
              });
            }
            if (errBox) errBox.classList.remove('hidden');
          }
        })
        .catch(function () {
          if (errList) errList.innerHTML = '<li>Failed to submit. Please check your internet connection.</li>';
          if (errBox) errBox.classList.remove('hidden');
        })
        .finally(function () {
          btn.disabled = false;
          btn.innerHTML = originalHtml;
        });
    });
  }
})();
