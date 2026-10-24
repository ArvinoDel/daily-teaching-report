/**
 * LiveRefresh — In-place section refresh for server-rendered EJS pages.
 *
 * Usage:
 *   LiveRefresh.refresh('section-name')
 *   LiveRefresh.refresh(['section-a', 'section-b'])
 *
 * Sections are identified by [data-live-section="name"] attributes.
 * On any failure the page falls back to window.location.reload().
 * Dispatches 'live:refreshed' CustomEvent after every successful swap.
 */
(function (window) {
  'use strict';

  var _inFlight = false;

  /**
   * Fetch the current URL, parse the response HTML, and swap the inner HTML
   * of every element matched by the given section names.
   *
   * @param {string|string[]} sectionNames
   * @returns {Promise<void>}
   */
  function refresh(sectionNames) {
    var names = Array.isArray(sectionNames) ? sectionNames : [sectionNames];

    // Guard: ignore a second concurrent call while one is in flight.
    if (_inFlight) {
      return Promise.resolve();
    }
    _inFlight = true;

    // Preserve scroll position before anything changes.
    var scrollX = window.scrollX || window.pageXOffset || 0;
    var scrollY = window.scrollY || window.pageYOffset || 0;

    // Remember active element so we can attempt to restore focus.
    var focusId = document.activeElement && document.activeElement.id
      ? document.activeElement.id
      : null;

    var url = window.location.href;

    return fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
      .then(function (res) {
        // Redirect to login page or non-OK status → fallback.
        if (!res.ok || res.url.indexOf('/auth/login') !== -1) {
          _inFlight = false;
          window.location.reload();
          return;
        }
        return res.text();
      })
      .then(function (htmlText) {
        if (!htmlText) return; // already reloading

        var parser = new DOMParser();
        var doc = parser.parseFromString(htmlText, 'text/html');

        // Validate all sections exist in both documents before touching the DOM.
        for (var i = 0; i < names.length; i++) {
          var name = names[i];
          var liveEl  = document.querySelector('[data-live-section="' + name + '"]');
          var freshEl = doc.querySelector('[data-live-section="' + name + '"]');
          if (!liveEl || !freshEl) {
            _inFlight = false;
            window.location.reload();
            return;
          }
        }

        // All sections found — do the swap.
        for (var j = 0; j < names.length; j++) {
          var liveSection  = document.querySelector('[data-live-section="' + names[j] + '"]');
          var freshSection = doc.querySelector('[data-live-section="' + names[j] + '"]');
          liveSection.innerHTML = freshSection.innerHTML;
        }

        // Restore scroll (swap may affect layout height slightly but position stays).
        window.scrollTo(scrollX, scrollY);

        // Restore focus if possible.
        if (focusId) {
          var el = document.getElementById(focusId);
          if (el && typeof el.focus === 'function') {
            try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
          }
        }

        _inFlight = false;

        // Notify page scripts to rebind listeners on replaced nodes.
        document.dispatchEvent(new CustomEvent('live:refreshed', {
          bubbles: false,
          detail: { sections: names },
        }));
      })
      .catch(function () {
        // Network failure or parse error → fall back to full reload.
        _inFlight = false;
        window.location.reload();
      });
  }

  window.LiveRefresh = { refresh: refresh };

}(window));
