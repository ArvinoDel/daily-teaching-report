# Content Security Policy (CSP) Safe Rollout & Operations Guide

This document describes the rollout process, logging infrastructure, and transition steps for the hardened Content Security Policy.

---

## 1. Overview & Final Policy Summary

The application has been hardened to eliminate inline script execution and unauthorized resources:

- **`script-src-attr`**: Set to `'none'`. Zero inline event handlers (`onclick`, `onchange`, etc.) exist anywhere in application views.
- **`script-src`**: 
  - Dynamic per-request cryptographic nonce resolver (`'nonce-<base64>'`) generated via `crypto.randomBytes(16)`.
  - Allowed origins: `'self'`, `https://cdn.tailwindcss.com`, `https://cdn.jsdelivr.net`, `https://cdnjs.cloudflare.com`, `https://vercel.live`.
  - Removed: `'unsafe-inline'`, `'unsafe-eval'`, `blob:`, `data:`, `https://*.tailwindcss.com` (wildcard), `https://unpkg.com`.
- **Containment Directives**:
  - `object-src`: `'none'`
  - `base-uri`: `'self'`
  - `form-action`: `'self'`
  - `frame-ancestors`: `'self'`
- **What Remains**:
  - `style-src` retains `'unsafe-inline'` to support runtime style attributes and dynamic component styles. Future phases can extract or nonce styling.

---

## 2. Safe Rollout Procedure (Report-Only Mode)

Before strictly enforcing in production, run in **Report-Only** mode for one week to capture any unexpected client violations in real-world browser usage:

1. **Enable Report-Only Mode**:
   Set the environment variable:
   ```env
   CSP_REPORT_ONLY=true
   ```
   When set, Helmet emits `Content-Security-Policy-Report-Only` instead of `Content-Security-Policy`. Browsers will execute normally while sending violation telemetry to `/csp-report`.

2. **Monitor Telemetry**:
   Monitor server logs for one week for `[CSP Violation]` entries. Resolve any legitimate asset or script issues.

3. **Switch to Enforcing**:
   Remove `CSP_REPORT_ONLY` or set:
   ```env
   CSP_REPORT_ONLY=false
   ```
   Helmet will immediately emit the enforcing `Content-Security-Policy` header.

---

## 3. Violation Reporting Endpoint (`POST /csp-report`)

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

## 4. How to Read & Diagnose Violation Logs

When a browser encounters a CSP violation, a log line is emitted:

```text
[CSP Violation] directive=<violated-directive> blockedUri=<first-100-chars-of-uri>
```

### Common Directives & Diagnosis

1. **`directive=script-src`**
   - **`blockedUri=inline`**: A `<script>` tag was injected or executed without a valid `nonce` attribute, or inline event handler attempted execution.
   - **`blockedUri=https://cdn.example.com/...`**: An external script was requested from an origin not present in `script-src`. Verify if this is an unauthorized 3rd-party script or a newly added dependency that needs allowlisting.
   - **`blockedUri=eval`**: A script attempted to call `eval()` or `new Function()`.

2. **`directive=connect-src`**
   - **`blockedUri=https://api.example.com`**: An asynchronous `fetch()` or `XMLHttpRequest` was directed to an unapproved endpoint. Add legitimate API hosts to `connectSrc` in `app.js`.

3. **`directive=img-src`**
   - An image was requested from an external CDN not currently permitted. Legitimate image CDNs (e.g. Cloudinary) should be in `imgSrc`.

4. **`directive=object-src`**
   - An embedded plugin (`<object>`, `<embed>`) attempted to load. Should always be rejected (`'none'`).
