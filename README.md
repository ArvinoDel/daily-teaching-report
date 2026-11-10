# Daily Teaching Report

Node.js / Express / MongoDB application for managing daily teaching sessions, materials, salaries, and student achievements.

---

## Development

### Prerequisites

- Node.js ≥ 18
- MongoDB (local or Atlas URI in `.env`)

### Installation

```bash
npm install
```

### Environment

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|----------|----------|-------------|
| `SESSION_SECRET` | ✅ | Random string ≥ 40 chars |
| `CRON_SECRET` | ✅ | Bearer token for cron endpoints |
| `MONGO_URI` | ✅ | MongoDB connection string |
| `CLOUDINARY_*` | for uploads | Cloudinary credentials |
| `CSP_ENFORCE` | optional | Set `true` to switch CSP from report-only to enforcing |
| `CSP_REPORT_ONLY` | optional | Set `true` to force report-only even when `CSP_ENFORCE=true` |
| `TAILWIND_CDN` | optional | Set `true` to use the Tailwind Play CDN instead of compiled CSS (quick rollback) |

### Running locally

```bash
npm run dev        # nodemon — auto-restart on changes
```

---

## CSS — Tailwind Build

**Rule: always rebuild and commit `public/css/tailwind.css` after adding or removing Tailwind utility classes in any view.**

```bash
npm run build:css
```

This runs `tailwindcss -i ./public/css/input.css -o ./public/css/tailwind.css --minify` and scans all `views/**/*.ejs` and `public/js/**/*.js` files for class names.

### Why this matters

The app ships a pre-compiled stylesheet (no CDN in production). If you add a new class — say `bg-amber-500` — but skip `build:css`, the class will be missing from the production bundle and the styling will silently break.

### CI guard

`tests/cssFresh.test.js` re-runs the Tailwind CLI to a temporary file and fails with:

```
Run npm run build:css and commit public/css/tailwind.css
```

…if the output differs from the committed file.  The test runs as part of `npm test`.

---

## Testing

```bash
npm test           # node --test --test-force-exit (all test files under tests/)
```

`--test-force-exit` is required because `tests/appBoot.test.js` starts a real HTTP server; the flag ensures the process exits cleanly even if the server handle is not fully released after `server.close()`.

### Test suite overview

| File | What it guards |
|------|----------------|
| `tests/appStack.test.js` | Static regex assertions that every required middleware/config statement is present in `app.js` |
| `tests/appBoot.test.js` | Boot smoke test — starts the real app without a database and checks HTTP behavior (CSP header, rate limiting, cron auth, CSP report endpoint) |
| `tests/cssFresh.test.js` | Tailwind CSS freshness — fails if `public/css/tailwind.css` is stale |
| `tests/csp-policy.test.js` | CSP directive correctness, VERCEL_ENV host guard, report-only/enforce toggle, per-route WASM exception |
| `tests/csp-ratchet.test.js` | Inline-event-handler / inline-script count ratchet — fails when counts rise |
| `tests/reportGapService.test.js` | Gap detection and acknowledgement expiry logic |

---

## Content Security Policy Rollout

See [`docs/csp-rollout.md`](docs/csp-rollout.md) for the staged rollout procedure:

1. Deploy with default report-only mode — read `[CSP Violation]` log lines for at least a week.
2. Set `CSP_ENFORCE=true` in the production environment to switch to enforcing mode.

---

## Smoke Test Checklist

See [`docs/csp-smoke.md`](docs/csp-smoke.md) for the full list of pages and user interactions to manually verify after CSP changes.
