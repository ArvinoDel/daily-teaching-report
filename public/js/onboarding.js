'use strict';

/**
 * public/js/onboarding.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Client-side handler for the teacher onboarding checklist and dashboard card.
 *
 * Responsibilities:
 * - Progress bar animations
 * - Collapsible steps list toggle
 * - Throttled real-time visibility check (focus, visibilitychange, live:refreshed)
 *   with max 1 request / 15s, no in-flight overlaps, and termination on 429 or
 *   2 consecutive errors
 * - Completion toast ("Checklist complete. Nice work!")
 * - Skip action handling with confirmation for rewards
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Creates a throttled state checker for /onboarding/state.
 * Throttles to at most 1 call every 15s, prevents concurrent requests,
 * and permanently stops checking after a 429 or two consecutive failures.
 *
 * @param {Function} fetchFn
 * @param {Function} onComplete
 * @param {Function} [nowFn=Date.now]
 */
function createThrottledChecker(fetchFn, onComplete, nowFn = Date.now) {
  const THROTTLE_MS = 15000;
  let lastRequestTime = 0;
  let inFlight = false;
  let consecutiveFailures = 0;
  let stopped = false;

  async function check() {
    if (stopped) return;
    if (inFlight) return;

    const now = nowFn();
    if (lastRequestTime > 0 && now - lastRequestTime < THROTTLE_MS) {
      return;
    }

    inFlight = true;
    lastRequestTime = now;

    try {
      const res = await fetchFn();
      if (res.status === 429) {
        stopped = true;
        return;
      }

      if (!res.ok) {
        consecutiveFailures++;
        if (consecutiveFailures >= 2) {
          stopped = true;
        }
        return;
      }

      consecutiveFailures = 0;
      const data = await res.json();
      if (data && data.state && (data.state.isComplete || !data.state.visible)) {
        if (typeof onComplete === 'function') {
          onComplete(data.state);
        }
      }
    } catch (err) {
      consecutiveFailures++;
      if (consecutiveFailures >= 2) {
        stopped = true;
      }
    } finally {
      inFlight = false;
    }
  }

  return {
    check,
    isStopped: () => stopped,
    isInFlight: () => inFlight,
    getConsecutiveFailures: () => consecutiveFailures,
    getLastRequestTime: () => lastRequestTime,
  };
}

(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

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

  // Toast displayed when onboarding completes
  let completionToastShown = false;
  function showCompletionToast() {
    if (completionToastShown || document.getElementById('onboarding-completion-toast')) return;
    completionToastShown = true;

    const toast = document.createElement('div');
    toast.id = 'onboarding-completion-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.className = 'fixed bottom-4 right-4 sm:bottom-6 sm:right-6 max-w-sm bg-white rounded-2xl shadow-xl border border-slate-100 p-4 z-40 transition-all transform duration-300 translate-y-0 opacity-100';

    toast.innerHTML = `
      <div class="flex items-center gap-3">
        <div class="w-8 h-8 rounded-xl bg-brand-50 border border-brand-200 flex items-center justify-center text-brand-600 flex-shrink-0">
          <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
          </svg>
        </div>
        <p class="text-xs font-semibold text-slate-800">Checklist complete. Nice work!</p>
      </div>
    `;

    document.body.appendChild(toast);

    setTimeout(function () {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(function () {
        toast.remove();
      }, 300);
    }, 4000);
  }

  // Smooth card removal
  function removeCardSmoothly(isComplete) {
    const dashboardCard = document.getElementById('onboarding-card');
    if (!dashboardCard) return;

    if (isComplete) {
      showCompletionToast();
    }

    dashboardCard.style.transition = 'opacity 300ms ease, transform 300ms ease, max-height 400ms ease, margin 400ms ease, padding 400ms ease';
    dashboardCard.style.opacity = '0';
    dashboardCard.style.transform = 'translateY(-10px)';
    setTimeout(function () {
      dashboardCard.remove();
    }, 350);
  }

  // Real-time visibility check for dashboard card (auto-disappears once complete)
  const dashboardCard = document.getElementById('onboarding-card');
  if (dashboardCard) {
    const checker = createThrottledChecker(
      () => fetch('/onboarding/state', { headers: { 'X-Requested-With': 'XMLHttpRequest' } }),
      (state) => removeCardSmoothly(Boolean(state && state.isComplete))
    );

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        checker.check();
      }
    });
    window.addEventListener('focus', function () {
      checker.check();
    });
    document.addEventListener('live:refreshed', function () {
      checker.check();
    });
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
        if (stepKey === 'rewards') {
          const confirmed = window.confirm('Skip only if you do not receive teaching rewards. Admins will still see that your amounts are not set.');
          if (!confirmed) return;
        }

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
            removeCardSmoothly(Boolean(data.state && data.state.isComplete));
            return;
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createThrottledChecker,
  };
}
