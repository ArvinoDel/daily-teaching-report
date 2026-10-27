/**
 * public/js/tours/tour-runner.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Tour runner for guided tours.
 * Built on Driver.js (vanilla JS).
 *
 * Responsibilities:
 * - Reads step configuration (e.g. window.REPORT_FORM_TOUR_STEPS).
 * - Filters out elements that are missing or not visible.
 * - Handles the non-blocking first-visit offer toast with "Start tour" & "No thanks".
 * - Starts directly on ?tour=1 or when the '?' help button is clicked.
 * - Handles persistence calls (/seen, /done, /dismiss).
 * - Manages accessibility: aria, keyboard, Esc to close, focus return to '?'.
 * - Respects prefers-reduced-motion.
 * - Adds an always-visible "Skip tour" button.
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  const TOUR_KEY = 'reportForm';

  function getCsrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
  }

  async function postTourStatus(action) {
    const csrf = getCsrfToken();
    try {
      await fetch(`/onboarding/tours/${encodeURIComponent(TOUR_KEY)}/${encodeURIComponent(action)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'x-csrf-token': csrf,
        },
      });
    } catch (err) {
      // Non-blocking error handling
      console.warn(`[tour-runner] Failed to record tour ${action}:`, err);
    }
  }

  function isElementVisible(el) {
    if (!el) return false;
    if (el.offsetWidth === 0 && el.offsetHeight === 0 && el.getClientRects().length === 0) {
      return false;
    }
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function resolveStepElement(step) {
    const primary = document.querySelector(step.selector);
    if (primary && isElementVisible(primary)) return primary;

    if (Array.isArray(step.alternativeSelectors)) {
      for (const sel of step.alternativeSelectors) {
        const alt = document.querySelector(sel);
        if (alt && isElementVisible(alt)) return alt;
      }
    }
    return null;
  }

  function hasUserFormInput() {
    // Check if user has already started filling form or draft is restored
    const classInput = document.getElementById('class_name');
    const privateInput = document.getElementById('private_name_input');
    const subjectInput = document.getElementById('subject');
    const notesInput = document.getElementById('notes');
    const acHidden = document.getElementById('ac-hidden');
    const bulkEntries = document.getElementById('bulk-extra-entries');

    if (classInput && classInput.value.trim().length > 0) return true;
    if (privateInput && privateInput.value.trim().length > 0) return true;
    if (subjectInput && subjectInput.value.trim().length > 0) return true;
    if (notesInput && notesInput.value.trim().length > 0) return true;
    if (acHidden && acHidden.value.trim().length > 0) return true;
    if (bulkEntries && bulkEntries.children.length > 0) return true;

    return false;
  }

  function initTour() {
    const helpBtn = document.getElementById('tour-help-btn');
    const stepsConfig = window.REPORT_FORM_TOUR_STEPS || [];
    if (!stepsConfig.length) return;

    let driverInstance = null;
    let tourFinished = false;
    let tourSeenRecorded = false;

    function buildDriver() {
      // Driver.js global is at window.driver.js.driver
      const driverFn = (window.driver && window.driver.js && window.driver.js.driver) ||
                       (window.driver && typeof window.driver === 'function' ? window.driver : null);

      if (!driverFn) {
        console.warn('[tour-runner] Driver.js is not loaded.');
        return null;
      }

      // Filter steps to visible elements only
      const driverSteps = [];
      stepsConfig.forEach((s) => {
        const el = resolveStepElement(s);
        if (el) {
          driverSteps.push({
            element: el,
            popover: {
              title: s.title,
              description: s.description,
              side: 'bottom',
              align: 'start',
            },
          });
        }
      });

      if (!driverSteps.length) return null;

      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      tourFinished = false;

      const driverObj = driverFn({
        animate: !prefersReducedMotion,
        smoothScroll: !prefersReducedMotion,
        allowClose: true,
        overlayOpacity: 0.65,
        stagePadding: 8,
        stageRadius: 12,
        popoverClass: 'dt-tour-popover',
        nextBtnText: 'Next',
        prevBtnText: 'Back',
        doneBtnText: 'Done',
        steps: driverSteps,
        onPopoverRender: (popover) => {
          // Add custom Skip tour button if not already present
          if (popover && popover.footer && !popover.footer.querySelector('.dt-tour-skip-btn')) {
            const skipBtn = document.createElement('button');
            skipBtn.type = 'button';
            skipBtn.className = 'dt-tour-skip-btn text-xs font-semibold text-slate-400 hover:text-slate-600 px-2 py-1 rounded transition focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none';
            skipBtn.textContent = 'Skip tour';
            skipBtn.setAttribute('aria-label', 'Skip tour');
            skipBtn.addEventListener('click', function () {
              driverObj.destroy();
            });
            popover.footer.insertBefore(skipBtn, popover.footer.firstChild);
          }
        },
        onDestroyStarted: () => {
          if (driverObj.isLastStep()) {
            tourFinished = true;
          }
          driverObj.destroy();
        },
        onDestroyed: () => {
          if (tourFinished) {
            postTourStatus('done');
          } else {
            postTourStatus('seen');
          }
          if (helpBtn) {
            helpBtn.focus();
          }
        },
      });

      return driverObj;
    }

    function startTour() {
      driverInstance = buildDriver();
      if (driverInstance) {
        if (!tourSeenRecorded) {
          postTourStatus('seen');
          tourSeenRecorded = true;
        }
        driverInstance.drive();
      }
    }

    // Trigger 2: "?" button in form header
    if (helpBtn) {
      helpBtn.addEventListener('click', function (e) {
        e.preventDefault();
        startTour();
      });
    }

    // Trigger 3: /reports/new?tour=1 auto-start
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('tour') === '1') {
      setTimeout(startTour, 300);
      return;
    }

    // Trigger 1: Offer toast for eligible teachers
    const scriptTag = document.currentScript || document.querySelector('script[src*="tour-runner.js"]');
    const shouldOffer = scriptTag && scriptTag.getAttribute('data-should-offer') === 'true';

    if (shouldOffer && !hasUserFormInput()) {
      showOfferToast(startTour);
    }
  }

  function showOfferToast(onStart) {
    // Check if toast already exists
    if (document.getElementById('dt-tour-offer-toast')) return;

    const toast = document.createElement('div');
    toast.id = 'dt-tour-offer-toast';
    toast.setAttribute('role', 'region');
    toast.setAttribute('aria-label', 'Report form tour offer');
    toast.className = 'fixed bottom-4 right-4 sm:bottom-6 sm:right-6 max-w-sm bg-white rounded-2xl shadow-xl border border-slate-100 p-4 z-40 transition-all transform duration-300 translate-y-0 opacity-100';

    toast.innerHTML = `
      <div class="flex items-start gap-3">
        <div class="w-9 h-9 rounded-xl bg-brand-50 border border-brand-200 flex items-center justify-center text-brand-600 flex-shrink-0 mt-0.5">
          <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />
          </svg>
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-xs font-semibold text-slate-800">Take a 1-minute tour of the report form?</p>
          <p class="text-[11px] text-slate-500 mt-0.5 leading-relaxed">Learn how to fill reports, tag student attendance, and submit records smoothly.</p>
          <div class="flex items-center gap-2 mt-3">
            <button type="button" id="dt-tour-offer-start"
              class="min-h-[36px] px-3.5 py-1.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-semibold shadow-sm transition focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none">
              Start tour
            </button>
            <button type="button" id="dt-tour-offer-decline"
              class="min-h-[36px] px-3 py-1.5 rounded-xl text-xs font-semibold text-slate-400 hover:text-slate-600 transition focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none">
              No thanks
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(toast);

    function removeToast() {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => toast.remove(), 300);
    }

    const startBtn = document.getElementById('dt-tour-offer-start');
    const declineBtn = document.getElementById('dt-tour-offer-decline');

    if (startBtn) {
      startBtn.addEventListener('click', function () {
        removeToast();
        onStart();
      });
    }

    if (declineBtn) {
      declineBtn.addEventListener('click', function () {
        removeToast();
        postTourStatus('dismiss');
      });
    }
  }

  // Inject responsive tour styles
  function injectTourStyles() {
    if (document.getElementById('dt-tour-styles')) return;
    const style = document.createElement('style');
    style.id = 'dt-tour-styles';
    style.textContent = `
      .driver-popover.dt-tour-popover {
        max-width: min(340px, calc(100vw - 32px)) !important;
        border-radius: 1rem !important;
        padding: 1rem !important;
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1) !important;
        border: 1px solid #f1f5f9 !important;
      }
      .dt-tour-popover .driver-popover-title {
        font-size: 0.9375rem !important;
        font-weight: 700 !important;
        color: #0f172a !important;
        margin-bottom: 0.25rem !important;
      }
      .dt-tour-popover .driver-popover-description {
        font-size: 0.8125rem !important;
        color: #475569 !important;
        line-height: 1.45 !important;
      }
      .dt-tour-popover .driver-popover-footer {
        margin-top: 0.875rem !important;
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
        gap: 0.5rem !important;
      }
      .dt-tour-popover .driver-popover-next-btn,
      .dt-tour-popover .driver-popover-prev-btn {
        min-height: 36px !important;
        padding: 0.375rem 0.875rem !important;
        border-radius: 0.75rem !important;
        font-size: 0.75rem !important;
        font-weight: 600 !important;
        transition: all 0.15s ease !important;
      }
      .dt-tour-popover .driver-popover-next-btn {
        background-color: #16a34a !important;
        color: #ffffff !important;
        border: none !important;
      }
      .dt-tour-popover .driver-popover-next-btn:hover {
        background-color: #15803d !important;
      }
      .dt-tour-popover .driver-popover-prev-btn {
        background-color: #f8fafc !important;
        color: #64748b !important;
        border: 1px solid #e2e8f0 !important;
      }
      .dt-tour-popover .driver-popover-prev-btn:hover {
        background-color: #f1f5f9 !important;
        color: #334155 !important;
      }
      .dt-tour-popover .driver-popover-close-btn {
        color: #94a3b8 !important;
      }
      .dt-tour-popover .driver-popover-close-btn:hover {
        color: #475569 !important;
      }
    `;
    document.head.appendChild(style);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      injectTourStyles();
      initTour();
    });
  } else {
    injectTourStyles();
    initTour();
  }
})();
