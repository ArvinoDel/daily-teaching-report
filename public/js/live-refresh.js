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
  var _pendingSections = [];
  var _pendingResolvers = [];

  /**
   * Helper to deduplicate an array of section names.
   *
   * @param {string[]} array
   * @returns {string[]}
   */
  function _unique(array) {
    var seen = {};
    var out = [];
    for (var i = 0; i < array.length; i++) {
      var item = array[i];
      if (!seen[item]) {
        seen[item] = true;
        out.push(item);
      }
    }
    return out;
  }

  /**
   * Fetch the current URL, parse response HTML, and swap matching sections.
   *
   * @param {string[]} names
   * @returns {Promise<boolean>} resolves true on success, false on reload fallback
   */
  function _performSwap(names) {
    var scrollX = window.scrollX || window.pageXOffset || 0;
    var scrollY = window.scrollY || window.pageYOffset || 0;

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
        if (!res.ok || (res.url && res.url.indexOf('/auth/login') !== -1)) {
          _pendingSections = [];
          _pendingResolvers = [];
          window.location.reload();
          return false;
        }
        return res.text();
      })
      .then(function (htmlText) {
        if (!htmlText) return false;

        var parser = new DOMParser();
        var doc = parser.parseFromString(htmlText, 'text/html');

        for (var i = 0; i < names.length; i++) {
          var name = names[i];
          var liveEl  = document.querySelector('[data-live-section="' + name + '"]');
          var freshEl = doc.querySelector('[data-live-section="' + name + '"]');
          if (!liveEl || !freshEl) {
            _pendingSections = [];
            _pendingResolvers = [];
            window.location.reload();
            return false;
          }
        }

        for (var j = 0; j < names.length; j++) {
          var liveSection  = document.querySelector('[data-live-section="' + names[j] + '"]');
          var freshSection = doc.querySelector('[data-live-section="' + names[j] + '"]');
          liveSection.innerHTML = freshSection.innerHTML;
        }

        window.scrollTo(scrollX, scrollY);

        if (focusId) {
          var el = document.getElementById(focusId);
          if (el && typeof el.focus === 'function') {
            try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
          }
        }

        document.dispatchEvent(new CustomEvent('live:refreshed', {
          bubbles: false,
          detail: { sections: names },
        }));

        return true;
      })
      .catch(function () {
        _pendingSections = [];
        _pendingResolvers = [];
        window.location.reload();
        return false;
      });
  }

  /**
   * Run an in-flight cycle. When complete, if pending sections were queued
   * during this flight, execute a single trailing flight with their union.
   *
   * @param {string[]} names
   * @param {Function[]} currentResolvers
   * @returns {Promise<void>}
   */
  function _runCycle(names, currentResolvers) {
    return _performSwap(names).then(function (success) {
      for (var i = 0; i < currentResolvers.length; i++) {
        try { currentResolvers[i](); } catch (e) { /* ignore */ }
      }

      if (success && _pendingSections.length > 0) {
        var nextNames = _unique(_pendingSections);
        _pendingSections = [];
        var nextResolvers = _pendingResolvers;
        _pendingResolvers = [];
        return _runCycle(nextNames, nextResolvers);
      }
    });
  }

  /**
   * Fetch the current URL, parse the response HTML, and swap the inner HTML
   * of every element matched by the given section names.
   *
   * @param {string|string[]} sectionNames
   * @returns {Promise<void>}
   */
  function refresh(sectionNames) {
    var names = Array.isArray(sectionNames) ? sectionNames : [sectionNames];

    if (_inFlight) {
      for (var i = 0; i < names.length; i++) {
        _pendingSections.push(names[i]);
      }
      return new Promise(function (resolve) {
        _pendingResolvers.push(resolve);
      });
    }

    _inFlight = true;

    return new Promise(function (resolve) {
      _runCycle(names, [resolve])
        .then(function () {
          _inFlight = false;
        }, function () {
          _inFlight = false;
        });
    });
  }

  window.LiveRefresh = { refresh: refresh };

}(window));
