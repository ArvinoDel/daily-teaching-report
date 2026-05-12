const crypto = require('crypto');

/**
 * Simple per-session CSRF protection middleware.
 *
 * - Generates a token once per session and exposes it as `res.locals.csrfToken`.
 * - Validates the token on every state-changing request (POST / PUT / DELETE).
 * - Token can be sent via hidden field `_csrf` or header `x-csrf-token`.
 */
function csrfProtection(req, res, next) {
  // Generate token if the session doesn't have one yet
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }

  // Always make the token available to views
  res.locals.csrfToken = req.session.csrfToken;

  // Safe methods — skip validation
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // Validate token from body or header
  const token = req.body._csrf || req.headers['x-csrf-token'];

  if (!token || token !== req.session.csrfToken) {
    return res.status(403).render('error', {
      message: 'Invalid or expired security token. Please go back and try again.',
    });
  }

  next();
}

module.exports = csrfProtection;
