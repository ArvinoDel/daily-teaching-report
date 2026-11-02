# Content Security Policy (CSP) Safe Rollout & Operations Guide

This document describes the rollout process, logging infrastructure, compilation instructions, and transition steps for the hardened Content Security Policy.

---

## 1. Overview & Final Policy Summary

The application has been hardened to eliminate inline script execution and unauthorized resources:

- **`script-src-attr`**: Set to `'none'`. Zero inline event handlers (`onclick`, `onchange`, etc.) exist anywhere in application views.
- **`script-src`**: 
  - Dynamic per-request cryptographic nonce resolver (`'nonce-<base64>'`) generated via `crypto.randomBytes(16)`.
  - Allowed origins: `'self'`, `https://cdn.jsdelivr.net`, `https://cdnjs.cloudflare.com`, `https://vercel.live`.
  - Removed: `'unsafe-inline'`, `'unsafe-eval'`, `blob:`, `data:`, `https://unpkg.com`, and Play CDN `https://cdn.tailwindcss.com` (now compiled locally).
  - Per-Route WebAssembly: `'wasm-unsafe-eval'` is restricted exclusively to `/reports/reward-crosscheck` for Tesseract.js client OCR execution. Global routes strictly exclude it.
- **Containment Directives**:
  - `object-src`: `'none'`
  - `base-uri`: `'self'`
  - `form-action`: `'self'`
  - `frame-ancestors`: `'self'`
- **What Remains**:
  - `style-src` retains `'unsafe-inline'` to support runtime style attributes and dynamic component styles. Future phases can extract or nonce styling.

---

## 2. Safe Rollout Procedure (Safe-by-Default Report-Only)

Production defaults to **Report-Only** mode unless explicit enforcement is requested:

1. **Phase 1: Initial Deployment (Report-Only Default)**:
   - By default in production (`NODE_ENV=production`), the application emits `Content-Security-Policy-Report-Only`.
   - No environment variables are required to be in report-only mode.
   - Browsers execute normally without blocking, sending all violations to `/csp-report`.
   - Monitor server logs for one week for `[CSP Violation]` entries. Resolve any legitimate asset or script issues.

2. **Phase 2: Switch to Enforcing**:
   - Once violations in the logs are verified to be zero, set:
     ```env
     CSP_ENFORCE=true
     ```
   - Helmet will immediately switch from report-only to emitting the enforcing `Content-Security-Policy` header.

3. **Emergency Rollback / Forced Report-Only**:
   - If unexpected issues arise after enforcement, set:
     ```env
     CSP_REPORT_ONLY=true
     ```
   - `CSP_REPORT_ONLY=true` takes precedence and immediately reverts headers back to report-only mode without code redeployment.

---

## 3. Tailwind CSS: Compiled Workflow & CDN Rollback Flag

### Compiled Tailwind CSS (Default)
The application compiles Tailwind CSS at build time, eliminating the Play CDN script, runtime DOM stylesheet compilation, and potential eval vectors:
- **Config**: `tailwind.config.js` defines brand colors and fonts (`Plus Jakarta Sans`, `DM Mono`).
- **Input**: `public/css/input.css` containing `@tailwind base; @tailwind components; @tailwind utilities;`.
- **Output**: `public/css/tailwind.css` (~75 KB minified).
- **Vercel Deployments**: Automatically run via `"vercel-build": "npm run build:css"` in `package.json`.

### How to Build Locally
Run:
```bash
npm run build:css
```
To watch and rebuild during development:
```bash
npx tailwindcss -i ./public/css/input.css -o ./public/css/tailwind.css --watch
```

### Rollback Flag (`TAILWIND_CDN=true`)
If needed for testing or emergency rollback to the Play CDN:
- Set `TAILWIND_CDN=true` in environment variables.
- Views will automatically load `https://cdn.tailwindcss.com` and `/js/tailwind-config.js`.
- CSP directives automatically include `https://cdn.tailwindcss.com` in `script-src`, `style-src`, and `connect-src`.

---

## 4. Violation Reporting Endpoint (`POST /csp-report`)

- **URL**: `/csp-report`
- **Supported Content Types**:
  - `application/csp-report` (CSP Level 2 / legacy browsers)
  - `application/reports+json` (W3C Reporting API v1 / modern Chromium)
- **Security & Limits**:
  - Payload size strictly capped at **8 KB** (`limit: '8kb'`). Requests exceeding 8 KB are rejected with `413 Payload Too Large`.
  - Rate limited to **100 requests per minute** per IP via `express-rate-limit`.
  - Exempt from CSRF and session storage.
  - **Zero data retention**: Request bodies are parsed in memory, logged as a single sanitized line, and discarded. No request bodies are stored in database or disk.
  - Returns `204 No Content`.

---

## 5. How to Read & Diagnose Violation Logs

When a browser encounters a CSP violation, a log line is emitted:

```text
[CSP Violation] directive=<violated-directive> blockedUri=<first-100-chars-of-uri>
```

### Common Directives & Diagnosis

1. **`directive=script-src`**
   - **`blockedUri=inline`**: A `<script>` tag was injected or executed without a valid `nonce` attribute, or inline event handler attempted execution.
   - **`blockedUri=https://cdn.example.com/...`**: An external script was requested from an origin not present in `script-src`. Verify if this is an unauthorized 3rd-party script or a newly added dependency that needs allowlisting.
   - **`blockedUri=eval`**: A script attempted to call `eval()` or `new Function()`.
   - **`blockedUri=wasm-eval`**: WebAssembly compilation on a route other than `/reports/reward-crosscheck`.

2. **`directive=connect-src`**
   - **`blockedUri=https://api.example.com`**: An asynchronous `fetch()` or `XMLHttpRequest` was directed to an unapproved endpoint. Add legitimate API hosts to `connectSrc` in `middleware/csp.js`.

3. **`directive=img-src`**
   - An image was requested from an external CDN not currently permitted. Legitimate image CDNs (e.g. Cloudinary) should be in `imgSrc`.

4. **`directive=object-src`**
   - An embedded plugin (`<object>`, `<embed>`) attempted to load. Should always be rejected (`'none'`).
