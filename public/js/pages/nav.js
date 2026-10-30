(function () {
  'use strict';

  function toggleMenu() {
    var menu      = document.getElementById('mobile-menu');
    var iconOpen  = document.getElementById('icon-open');
    var iconClose = document.getElementById('icon-close');
    if (!menu) return;
    menu.classList.toggle('hidden');
    if (iconOpen) iconOpen.classList.toggle('hidden');
    if (iconClose) iconClose.classList.toggle('hidden');
  }

  function toggleProfileDropdown() {
    var dropdown = document.getElementById('profile-dropdown');
    var chevron  = document.getElementById('profile-chevron');
    if (!dropdown) return;
    dropdown.classList.toggle('hidden');
    if (chevron) chevron.classList.toggle('rotate-180');
  }

  window.toggleMenu = toggleMenu;
  window.toggleProfileDropdown = toggleProfileDropdown;

  if (typeof registerAction === 'function') {
    registerAction('toggleMenu', function () {
      toggleMenu();
    });
    registerAction('toggleProfileDropdown', function () {
      toggleProfileDropdown();
    });
  }

  /* Close dropdown when clicking outside */
  document.addEventListener('click', function (e) {
    var wrapper = document.getElementById('profile-dropdown-wrapper');
    if (!wrapper || wrapper.contains(e.target)) return;
    var dropdown = document.getElementById('profile-dropdown');
    var chevron  = document.getElementById('profile-chevron');
    if (dropdown) dropdown.classList.add('hidden');
    if (chevron)  chevron.classList.remove('rotate-180');
  });

  /* Keepalive heartbeat and live notification badge updater */
  var userDataEl = document.getElementById('nav-user-data');
  if (userDataEl) {
    (function () {
      var BASE_INTERVAL = 60 * 1000;
      var MAX_INTERVAL = 300 * 1000;
      var currentInterval = BASE_INTERVAL;
      var lastPing = Date.now();
      var timer = null;
      var stopped = false;

      function updateNotificationBadges(count) {
        var badges = document.querySelectorAll('[data-notif-badge]');
        badges.forEach(function (el) {
          if (!count || count <= 0) {
            el.classList.add('hidden');
            el.textContent = '0';
          } else {
            el.classList.remove('hidden');
            if (el.getAttribute('data-notif-badge') === 'bell') {
              el.textContent = count > 99 ? '99+' : count;
            } else {
              el.textContent = count;
            }
          }
        });
      }
      window.updateNotificationBadges = updateNotificationBadges;

      function scheduleNext(delay) {
        if (stopped) return;
        if (timer) clearTimeout(timer);
        var jitter = Math.floor(Math.random() * 5000);
        timer = setTimeout(function () {
          if (document.visibilityState === 'visible') {
            sendHeartbeat();
          } else {
            scheduleNext(currentInterval);
          }
        }, delay + jitter);
      }

      function sendHeartbeat() {
        if (stopped) return;
        lastPing = Date.now();
        fetch('/auth/heartbeat', { method: 'GET', credentials: 'same-origin' })
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function (data) {
            if (!data || data.isOnline === false) {
              stopped = true;
              return;
            }
            currentInterval = BASE_INTERVAL;
            if (typeof data.unreadCount === 'number') {
              updateNotificationBadges(data.unreadCount);
            }
            scheduleNext(currentInterval);
          })
          .catch(function () {
            currentInterval = Math.min(currentInterval * 2, MAX_INTERVAL);
            scheduleNext(currentInterval);
          });
      }

      scheduleNext(BASE_INTERVAL);

      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible' && !stopped) {
          if (Date.now() - lastPing > 60 * 1000) {
            sendHeartbeat();
          }
        }
      });
    })();
  }
})();

