const express = require('express');
const rateLimit = require('express-rate-limit');

const router = express.Router();

const cspReportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post(
  '/',
  cspReportLimiter,
  express.json({
    type: ['application/json', 'application/csp-report', 'application/reports+json'],
    limit: '8kb',
  }),
  (req, res) => {
    try {
      const body = req.body;
      if (body) {
        if (body['csp-report']) {
          const r = body['csp-report'];
          const directive = r['effective-directive'] || r['violated-directive'] || 'unknown';
          const blockedUri = String(r['blocked-uri'] || '').slice(0, 100);
          console.warn(`[CSP Violation] directive=${directive} blockedUri=${blockedUri}`);
        } else if (Array.isArray(body)) {
          body.forEach(item => {
            if (item && item.body) {
              const directive = item.body.effectiveDirective || item.body.violatedDirective || 'unknown';
              const blockedUri = String(item.body.blockedURL || item.body.blockedURI || '').slice(0, 100);
              console.warn(`[CSP Violation] directive=${directive} blockedUri=${blockedUri}`);
            }
          });
        }
      }
    } catch (_) {
      // Never throw on malformed reports
    }
    // CSP report endpoints should return 204 No Content
    res.status(204).end();
  }
);

module.exports = router;

