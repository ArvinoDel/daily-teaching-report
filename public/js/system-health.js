'use strict';

/**
 * system-health.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Unobtrusive client-side handlers for superadmin system diagnostics.
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function () {
  function getCsrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
  }

  const alertBox = document.getElementById('system-alert-box');
  const alertContent = document.getElementById('system-alert-content');

  function showAlert(type, htmlContent) {
    if (!alertBox || !alertContent) return;

    alertBox.className = 'mb-6 p-4 rounded-xl text-xs font-medium border transition-all duration-200';

    if (type === 'success') {
      alertBox.classList.add('bg-emerald-50', 'border-emerald-200', 'text-emerald-950');
    } else if (type === 'warning' || type === 'rate-limit') {
      alertBox.classList.add('bg-amber-50', 'border-amber-200', 'text-amber-950');
    } else {
      alertBox.classList.add('bg-rose-50', 'border-rose-200', 'text-rose-950');
    }

    alertContent.innerHTML = htmlContent;
    alertBox.classList.remove('hidden');
    alertBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function hideAlert() {
    if (!alertBox) return;
    alertBox.classList.add('hidden');
  }

  // Dismiss alert button
  document.addEventListener('click', function (e) {
    const dismissBtn = e.target.closest('[data-action="dismiss-alert"]');
    if (dismissBtn) {
      hideAlert();
    }
  });

  // Test Cloudinary connection button
  const testCloudinaryBtn = document.querySelector('[data-action="test-cloudinary"]');
  if (testCloudinaryBtn) {
    testCloudinaryBtn.addEventListener('click', async function () {
      const originalText = testCloudinaryBtn.innerHTML;
      testCloudinaryBtn.disabled = true;
      testCloudinaryBtn.innerHTML = `
        <svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-sky-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
        </svg>
        Testing connection...
      `;

      try {
        const response = await fetch('/admin/system/test-cloudinary', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-csrf-token': getCsrfToken(),
            'X-Requested-With': 'XMLHttpRequest',
          },
        });

        const data = await response.json().catch(() => ({}));

        if (response.ok && data.ok) {
          showAlert(
            'success',
            `<strong>Cloudinary connection test passed.</strong><p class="mt-0.5 text-emerald-800">${escapeHtml(data.message || 'Cloudinary credentials and ping are verified.')}</p>`
          );
        } else if (response.status === 429) {
          showAlert(
            'warning',
            `<strong>Rate limit active.</strong><p class="mt-0.5 text-amber-800">${escapeHtml(data.message || 'Please wait a minute before running this test again.')}</p>`
          );
        } else {
          showAlert(
            'error',
            `<strong>Cloudinary connection test failed.</strong><p class="mt-0.5 text-rose-800">${escapeHtml(data.message || 'Unable to connect to Cloudinary. Check configuration.')}</p>`
          );
        }
      } catch (err) {
        showAlert(
          'error',
          '<strong>Network error.</strong><p class="mt-0.5 text-rose-800">Could not contact server to run test.</p>'
        );
      } finally {
        testCloudinaryBtn.disabled = false;
        testCloudinaryBtn.innerHTML = originalText;
      }
    });
  }

  // Run cleanup preview button
  const cleanupPreviewBtn = document.querySelector('[data-action="cleanup-preview"]');
  if (cleanupPreviewBtn) {
    cleanupPreviewBtn.addEventListener('click', async function () {
      const originalText = cleanupPreviewBtn.innerHTML;
      cleanupPreviewBtn.disabled = true;
      cleanupPreviewBtn.innerHTML = `
        <svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-amber-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
        </svg>
        Running preview...
      `;

      try {
        const response = await fetch('/admin/system/cleanup-preview', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-csrf-token': getCsrfToken(),
            'X-Requested-With': 'XMLHttpRequest',
          },
        });

        const data = await response.json().catch(() => ({}));

        if (response.ok && data.ok) {
          const summary = data.summary || {};
          showAlert(
            'success',
            `<strong>Cleanup preview completed (dry run).</strong>
             <div class="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2 pt-2 border-t border-emerald-200">
               <div><span class="text-emerald-700">Expired backups to delete:</span> <strong>${Number(summary.expiredCount || 0)}</strong></div>
               <div><span class="text-emerald-700">Orphan cloud assets to sweep:</span> <strong>${Number(summary.orphanCount || 0)}</strong></div>
               <div><span class="text-emerald-700">Total deletion candidates:</span> <strong>${Number(summary.wouldDeleteCount || 0)}</strong></div>
             </div>`
          );
        } else if (response.status === 429) {
          showAlert(
            'warning',
            `<strong>Rate limit active.</strong><p class="mt-0.5 text-amber-800">${escapeHtml(data.message || 'Please wait a minute before running cleanup preview again.')}</p>`
          );
        } else {
          showAlert(
            'error',
            `<strong>Cleanup preview failed.</strong><p class="mt-0.5 text-rose-800">${escapeHtml(data.message || 'An error occurred while evaluating cleanup candidates.')}</p>`
          );
        }
      } catch (err) {
        showAlert(
          'error',
          '<strong>Network error.</strong><p class="mt-0.5 text-rose-800">Could not contact server to run cleanup preview.</p>'
        );
      } finally {
        cleanupPreviewBtn.disabled = false;
        cleanupPreviewBtn.innerHTML = originalText;
      }
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
})();

