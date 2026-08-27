const crypto = require('crypto');

/**
 * Simple per-session CSRF protection middleware.
 *
 * - Generates a token once per session and exposes it as `res.locals.csrfToken`.
 * - Validates the token on every state-changing request (POST / PUT / DELETE).
 * - Token can be sent via hidden field `_csrf` or header `x-csrf-token`.
 * - Skips body-based validation for multipart/form-data requests (since the
 *   body hasn't been parsed by multer yet). Those routes must call
 *   `verifyCsrf` manually after multer processes the upload.
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

  // Skip body-based validation for multipart requests — req.body hasn't been
  // parsed yet. Routes that use multer MUST call `verifyCsrf` after upload.
  const ct = req.headers['content-type'] || '';
  if (ct.startsWith('multipart/form-data')) {
    return next();
  }

  // Validate token from body or header
  const token = req.body._csrf || req.headers['x-csrf-token'];

  if (!token || token !== req.session.csrfToken) {
    if (req.path.includes('/api/') || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(403).json({
        error: 'Invalid or expired security token. Please refresh the page and try again.',
      });
    }
    return res.status(403).render('error', {
      message: 'Invalid or expired security token. Please go back and try again.',
    });
  }

  next();
}

/**
 * Standalone CSRF verification — use after multer on multipart routes.
 */
function verifyCsrf(req, res, next) {
  const token = req.body._csrf || req.headers['x-csrf-token'];

  if (!token || token !== req.session.csrfToken) {
    return res.status(403).render('error', {
      message: 'Invalid or expired security token. Please go back and try again.',
    });
  }

  next();
}

module.exports = csrfProtection;
module.exports.verifyCsrf = verifyCsrf;
