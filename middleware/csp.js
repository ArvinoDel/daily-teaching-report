'use strict';

const helmet = require('helmet');

/**
 * Returns true when the app is running in a Vercel production deployment.
 * Vercel sets VERCEL_ENV='production' only for production deployments;
 * preview and development deployments have other values.
 * Locally VERCEL_ENV is unset.
 *
 * Vercel toolbar / Live / Pusher overlay scripts are only injected in
 * non-production Vercel environments, so the extra CSP hosts are only
 * needed there.
 */
function isVercelProduction() {
  return process.env.VERCEL_ENV === 'production';
}

/**
 * Returns CSP directives object.
 * @param {Object} options
 * @param {boolean} [options.wasm=false] - Whether to include 'wasm-unsafe-eval' in script-src
 * @returns {Object} Helmet CSP directives
 */
function getCspDirectives({ wasm = false } = {}) {
  const useTailwindCdn = process.env.TAILWIND_CDN === 'true';
  const vercelProd = isVercelProduction();

  // Vercel toolbar / Live injects scripts and loads fonts only in preview/dev
  // deployments and locally. In production (VERCEL_ENV=production) those hosts
  // are unnecessary noise and should be omitted.
  const vercelLiveHosts = vercelProd ? [] : ['https://vercel.live'];
  const pusherHosts     = vercelProd ? [] : ['https://*.pusher.com', 'wss://*.pusher.com'];
  const vercelAssets    = vercelProd ? [] : ['https://vercel.com', 'https://assets.vercel.com'];

  const scriptSrc = [
    "'self'",
    (req, res) => `'nonce-${res.locals.cspNonce}'`,
    ...(wasm ? ["'wasm-unsafe-eval'"] : []),
    ...(useTailwindCdn ? ['https://cdn.tailwindcss.com'] : []),
    'https://cdn.jsdelivr.net',
    'https://cdnjs.cloudflare.com',
    ...vercelLiveHosts,
  ];

  const styleSrc = [
    "'self'",
    "'unsafe-inline'",
    ...(useTailwindCdn ? ['https://cdn.tailwindcss.com'] : []),
    'https://fonts.googleapis.com',
    'https://cdn.jsdelivr.net',
    ...vercelLiveHosts,
  ];

  const connectSrc = [
    "'self'",
    'blob:',
    'data:',
    ...(useTailwindCdn ? ['https://cdn.tailwindcss.com'] : []),
    'https://cdn.jsdelivr.net',
    'https://tessdata.projectnaptha.com',
    'https://raw.githubusercontent.com',
    'https://api.cloudinary.com',
    ...vercelLiveHosts,
    ...pusherHosts,
  ];

  return {
    defaultSrc: ["'self'"],
    scriptSrc,
    workerSrc: ["'self'", 'blob:', 'data:', 'https://cdn.jsdelivr.net'],
    childSrc:  ["'self'", 'blob:', 'data:', 'https://cdn.jsdelivr.net', ...vercelLiveHosts],
    scriptSrcAttr: ["'none'"],
    styleSrc,
    fontSrc: ["'self'", 'https://fonts.gstatic.com', ...vercelLiveHosts, ...vercelAssets],
    imgSrc:  ["'self'", 'data:', 'blob:', 'https://res.cloudinary.com', ...vercelLiveHosts, ...vercelAssets],
    mediaSrc: ["'self'", 'https://res.cloudinary.com'],
    connectSrc,
    frameSrc: ["'self'", ...vercelLiveHosts],
    objectSrc: ["'none'"],
    baseUri:      ["'self'"],
    formAction:   ["'self'"],
    frameAncestors: ["'self'"],
    reportUri: ['/csp-report'],
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
  isVercelProduction,
};
