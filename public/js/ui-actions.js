/**
 * public/js/ui-actions.js
 *
 * Central delegated event dispatcher for CSP-hardened UI interactions.
 * Replaces inline on<event>= attributes with data-action="name" and data-* parameters.
 */
(function (global) {
  'use strict';

  var actions = new Map();

  function registerAction(name, fn) {
    if (typeof name !== 'string' || typeof fn !== 'function') {
      throw new TypeError('registerAction expects a string name and a function handler');
    }
    actions.set(name, fn);
  }

  function registerActions(actionMap) {
    if (actionMap && typeof actionMap === 'object') {
      Object.keys(actionMap).forEach(function (name) {
        registerAction(name, actionMap[name]);
      });
    }
  }

  function shouldHandleEvent(el, eventType) {
    var customEvents = el.dataset.actionEvent;
    if (customEvents) {
      var list = customEvents.split(',').map(function (s) { return s.trim(); });
      return list.indexOf(eventType) !== -1;
    }

    var tagName = (el.tagName || '').toLowerCase();
    var inputType = (el.type || '').toLowerCase();

    switch (eventType) {
      case 'click':
        // Avoid clicking inside text inputs/textareas triggering click actions unless explicitly intended
        if (tagName === 'input' && (inputType === 'text' || inputType === 'number' || inputType === 'password' || inputType === 'search' || inputType === 'email')) {
          return false;
        }
        if (tagName === 'textarea') {
          return false;
        }
        return true;

      case 'change':
        return tagName === 'select' || inputType === 'checkbox' || inputType === 'radio' || inputType === 'file' || inputType === 'range';

      case 'input':
        return tagName === 'textarea' || (tagName === 'input' && inputType !== 'checkbox' && inputType !== 'radio' && inputType !== 'file');

      case 'submit':
        return tagName === 'form';

      case 'keydown':
        if (el.dataset.actionKey) {
          return el.dataset.actionKey.toLowerCase() === (event.key || '').toLowerCase();
        }
        return false;

      default:
        return true;
    }
  }

  function handleDelegatedEvent(event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') return;

    var el = target.closest('[data-action]');
    if (!el) return;

    var actionName = el.getAttribute('data-action');
    if (!actionName) return;

    if (!shouldHandleEvent(el, event.type)) {
      return;
    }

    var fn = actions.get(actionName);
    if (typeof fn === 'function') {
      fn(event, el);
    }
  }

  if (typeof document !== 'undefined') {
    var events = ['click', 'change', 'input', 'submit', 'keydown'];
    events.forEach(function (evt) {
      document.addEventListener(evt, handleDelegatedEvent, false);
    });

    // Built-in standard actions
    registerAction('dismissFlash', function (e, el) {
      var flash = document.getElementById('notif-flash') || el.closest('[role="alert"]') || el.parentElement;
      if (flash) flash.remove();
    });

    registerAction('confirmDeleteNotification', function (e, el) {
      if (!confirm('Delete this notification?')) {
        e.preventDefault();
      }
    });

    registerAction('confirmSubmit', function (e, el) {
      var msg = el.dataset.confirm || 'Are you sure?';
      if (!confirm(msg)) {
        e.preventDefault();
      }
    });

    registerAction('printPage', function () {
      window.print();
    });

    registerAction('stopPropagation', function (e) {
      e.stopPropagation();
    });

    registerAction('reloadPage', function () {
      window.location.reload();
    });

    registerAction('autoSubmitForm', function (e, el) {
      if (el.form) {
        el.form.submit();
      }
    });
  }

  // Export to global scope
  global.registerAction = registerAction;
  global.registerActions = registerActions;
  global.__UI_ACTIONS__ = actions;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      registerAction: registerAction,
      registerActions: registerActions,
      actions: actions,
      handleDelegatedEvent: handleDelegatedEvent
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
