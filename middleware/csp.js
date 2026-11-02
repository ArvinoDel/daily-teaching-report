'use strict';

const helmet = require('helmet');

/**
 * Returns CSP directives object.
 * @param {Object} options
 * @param {boolean} [options.wasm=false] - Whether to include 'wasm-unsafe-eval' in script-src
 * @returns {Object} Helmet CSP directives
 */
function getCspDirectives({ wasm = false } = {}) {
  const useTailwindCdn = process.env.TAILWIND_CDN === 'true';

  const scriptSrc = [
    "'self'",
    (req, res) => `'nonce-${res.locals.cspNonce}'`,
    ...(wasm ? ["'wasm-unsafe-eval'"] : []),
    ...(useTailwindCdn ? ["https://cdn.tailwindcss.com"] : []),
    "https://cdn.jsdelivr.net",
    "https://cdnjs.cloudflare.com",
    "https://vercel.live"
  ];

  const styleSrc = [
    "'self'",
    "'unsafe-inline'",
    ...(useTailwindCdn ? ["https://cdn.tailwindcss.com"] : []),
    "https://fonts.googleapis.com",
    "https://cdn.jsdelivr.net",
    "https://vercel.live"
  ];

  const connectSrc = [
    "'self'",
    "blob:",
    "data:",
    ...(useTailwindCdn ? ["https://cdn.tailwindcss.com"] : []),
    "https://cdn.jsdelivr.net",
    "https://tessdata.projectnaptha.com",
    "https://raw.githubusercontent.com",
    "https://api.cloudinary.com",
    "https://vercel.live",
    "https://*.pusher.com",
    "wss://*.pusher.com"
  ];

  return {
    defaultSrc: ["'self'"],
    scriptSrc,
    workerSrc: ["'self'", "blob:", "data:", "https://cdn.jsdelivr.net"],
    childSrc: ["'self'", "blob:", "data:", "https://cdn.jsdelivr.net", "https://vercel.live"],
    scriptSrcAttr: ["'none'"],
    styleSrc,
    fontSrc: ["'self'", "https://fonts.gstatic.com", "https://vercel.live", "https://assets.vercel.com"],
    imgSrc: ["'self'", "data:", "blob:", "https://res.cloudinary.com", "https://vercel.live", "https://vercel.com"],
    mediaSrc: ["'self'", "https://res.cloudinary.com"],
    connectSrc,
    frameSrc: ["'self'", "https://vercel.live"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'self'"],
    reportUri: ["/csp-report"],
  };
}

/**
 * CSP is report-only unless CSP_ENFORCE === 'true'.
 * CSP_REPORT_ONLY === 'true' forces report-only regardless of CSP_ENFORCE.
 */
function isCspReportOnly() {
  return process.env.CSP_REPORT_ONLY === 'true' || process.env.CSP_ENFORCE !== 'true';
}

/**
 * Creates Helmet contentSecurityPolicy middleware with optional wasm exception.
 */
function createCspMiddleware({ wasm = false } = {}) {
  const directives = getCspDirectives({ wasm });
  return helmet.contentSecurityPolicy({
    reportOnly: isCspReportOnly(),
    directives,
  });
}

module.exports = {
  getCspDirectives,
  isCspReportOnly,
  createCspMiddleware,
};

