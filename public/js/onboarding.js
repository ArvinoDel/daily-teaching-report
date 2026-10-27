'use strict';

/**
 * public/js/onboarding.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Client-side handler for the teacher onboarding checklist and dashboard card.
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function () {
  function getCsrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
  }

  function announce(msg) {
    const region = document.getElementById('onboarding-live-region');
    if (region) {
      region.textContent = '';
      setTimeout(() => {
        region.textContent = msg;
      }, 50);
    }
  }

  // Animate progress bars smoothly using aria-valuenow
  function initProgressBars() {
    document.querySelectorAll('[role="progressbar"]').forEach(function (bar) {
      const val = bar.getAttribute('aria-valuenow');
      if (val !== null && bar.firstElementChild) {
        requestAnimationFrame(function () {
          bar.firstElementChild.style.width = Math.max(0, Math.min(100, Number(val))) + '%';
        });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initProgressBars);
  } else {
    initProgressBars();
  }

  // Toggle collapsible steps list
  const toggleBtn = document.getElementById('onboarding-toggle-steps');
  const stepsList = document.getElementById('onboarding-steps-list');
  const toggleLabel = document.getElementById('onboarding-toggle-label');
  const toggleIcon = document.getElementById('onboarding-toggle-icon');

  if (toggleBtn && stepsList) {
    toggleBtn.addEventListener('click', function () {
      const isExpanded = toggleBtn.getAttribute('aria-expanded') === 'true';
      const newExpanded = !isExpanded;
      toggleBtn.setAttribute('aria-expanded', String(newExpanded));

      if (newExpanded) {
        stepsList.classList.remove('hidden');
        if (toggleLabel) toggleLabel.textContent = 'Hide steps list';
        if (toggleIcon) toggleIcon.classList.add('rotate-180');
      } else {
        stepsList.classList.add('hidden');
        if (toggleLabel) toggleLabel.textContent = 'Show all steps';
        if (toggleIcon) toggleIcon.classList.remove('rotate-180');
      }
    });
  }

  // Real-time visibility check for dashboard card (auto-disappears once complete)
  const dashboardCard = document.getElementById('onboarding-card');
  if (dashboardCard) {
    function removeCardSmoothly() {
      dashboardCard.style.transition = 'opacity 300ms ease, transform 300ms ease, max-height 400ms ease, margin 400ms ease, padding 400ms ease';
      dashboardCard.style.opacity = '0';
      dashboardCard.style.transform = 'translateY(-10px)';
      setTimeout(function () {
        dashboardCard.remove();
      }, 350);
    }

    async function checkCompletionRealtime() {
      try {
        const res = await fetch('/onboarding/state', {
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data && data.state && (data.state.isComplete || !data.state.visible)) {
          removeCardSmoothly();
        }
      } catch (err) {
        // silent fail on network hiccups
      }
    }

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        checkCompletionRealtime();
      }
    });
    window.addEventListener('focus', checkCompletionRealtime);
  }

  // Delegated click handler for onboarding actions
  document.addEventListener('click', async function (e) {
    const btn = e.target.closest('[data-onboarding-action]');
    if (!btn) return;

    const action = btn.dataset.onboardingAction;
    const stepKey = btn.dataset.stepKey;
    const csrf = getCsrfToken();

    try {
      if (action === 'skip' && stepKey) {
        btn.disabled = true;
        const res = await fetch(`/onboarding/steps/${encodeURIComponent(stepKey)}/skip`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'x-csrf-token': csrf,
          },
        });

        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          announce('Step skipped.');
          if (data && data.state && (data.state.isComplete || !data.state.visible)) {
            const card = document.getElementById('onboarding-card');
            if (card) {
              card.style.transition = 'opacity 300ms ease, transform 300ms ease, max-height 400ms ease, margin 400ms ease, padding 400ms ease';
              card.style.opacity = '0';
              card.style.transform = 'translateY(-10px)';
              setTimeout(() => card.remove(), 350);
              return;
            }
          }
          window.location.reload();
        } else {
          btn.disabled = false;
        }
      }
    } catch (err) {
      console.error('[onboarding] Action error:', err);
      btn.disabled = false;
    }
  });
})();
