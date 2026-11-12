# Daily Teaching Report

Node.js / Express / MongoDB application for managing daily teaching sessions, materials, salaries, and student achievements.

---

## Development

### Prerequisites

- Node.js ≥ 20 (matches Vercel's Node.js 20 runtime)
- MongoDB (local or Atlas URI in `.env`)

### Installation

```bash
npm install
# or for clean CI/production installs:
npm ci
```

### Environment

Copy `.env.example` to `.env` to create your local environment configuration:

```bash
cp .env.example .env
```

To regenerate `.env.example` directly from the system registry:

```bash
npm run env:example
```

#### Generating Cryptographically Secure Secrets

Never commit real secrets or use weak passwords. Generate cryptographically strong random hex keys using Node's built-in `crypto` module:

```bash
# Generate SESSION_SECRET (at least 32 characters; produces 64 hex characters):
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Generate CRON_SECRET (at least 16 characters; produces 32 hex characters):
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

#### Production-Required Environment Variables

The application and health evaluators strictly require the following variables in production:

| Variable | Requirement | Format Rule | Description |
|----------|-------------|-------------|-------------|
| `MONGO_URI` | ✅ Required | `mongodb://` or `mongodb+srv://` | MongoDB connection string |
| `SESSION_SECRET` | ✅ Required | String ≥ 32 characters | Session encryption and cookie signing key |
| `CRON_SECRET` | ✅ Required | String ≥ 16 characters | Bearer token authorizing automated maintenance endpoints |
| `CLOUDINARY_CLOUD_NAME` | ✅ Required | Non-empty string | Cloudinary account name for assets and database archives |
| `CLOUDINARY_API_KEY` | ✅ Required | Non-empty string | Cloudinary API access key |
| `CLOUDINARY_API_SECRET` | ✅ Required | Non-empty string | Cloudinary API access secret |
| `APP_BASE_URL` | ✅ Required | Valid `https://` URL | Canonical base URL for production links and redirects |

#### Content Security Policy (CSP) Rollout Variables

Manage CSP header policies and staged rollouts with:

| Variable | Default | Description |
|----------|---------|-------------|
| `CSP_REPORT_ONLY` | unset (`false`) | Set to `true` to force CSP into report-only mode, logging violations without blocking assets. |
| `CSP_ENFORCE` | unset (`false`) | Set to `true` to actively enforce CSP rules, blocking non-compliant scripts or styles. Ignored if `CSP_REPORT_ONLY=true`. |

#### Additional Optional Variables & Tunables

- `TAILWIND_CDN`: Set `true` to load Tailwind Play CDN instead of the compiled stylesheet (emergency rollback toggle).
- `GEMINI_API_KEY`: Google Gemini API key for optional AI assistant features (accepts `GOOGLE_GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_KEY` aliases).
- `REGISTRATION_MODE`: User registration policy (`approval` to hold new sign-ups in queue, `closed` to block new accounts).
- Tunable platform, backup retention, upload timeout, material upload limits, onboarding reminder intervals, and report gap analysis windows are also documented in `.env.example`.

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

The app ships a pre-compiled stylesheet (no CDN in production). If you add a new class — say `bg-amber-500` — but skip `build:css`, the class will be missing from the production bundle and styling will silently break.

### CI guard

Continuous Integration and `tests/cssFresh.test.js` verify that `public/css/tailwind.css` matches the latest build output, failing with:

```
Run npm run build:css and commit public/css/tailwind.css
```

…if uncommitted CSS changes exist.

---

## Testing

```bash
npm test           # node --test --test-force-exit (all test files under tests/)
```

`--test-force-exit` is required because `tests/appBoot.test.js` starts a real HTTP server; the flag ensures the process exits cleanly even if the server handle is not fully released after `server.close()`.

All tests run cleanly in an isolated environment without needing any `.env` file or external database connection.

### Test suite overview

| File | What it guards |
|------|----------------|
| `tests/appStack.test.js` | Static regex assertions that every required middleware/config statement is present in `app.js` |
| `tests/appBoot.test.js` | Boot smoke test — starts the real app without a database and checks HTTP behavior (CSP header, rate limiting, cron auth, CSP report endpoint) |
| `tests/cssFresh.test.js` | Tailwind CSS freshness — fails if `public/css/tailwind.css` is stale |
| `tests/csp-policy.test.js` | CSP directive correctness, VERCEL_ENV host guard, report-only/enforce toggle, per-route WASM exception |
| `tests/csp-ratchet.test.js` | Inline-event-handler / inline-script count ratchet — fails when counts rise |
| `tests/envExample.test.js` | Guards `.env.example` freshness against `ENV_REGISTRY`, placeholder safety (no real secrets), and `.gitignore` coverage |
| `tests/systemHealth.test.js` | Health diagnostics, pure evaluation against `ENV_REGISTRY`, process.env leak prevention, and route permissions |
| `tests/reportGap.test.js` | Gap detection and acknowledgement expiry logic |

---

## Continuous Integration (CI)

Continuous Integration is configured via GitHub Actions in [`.github/workflows/ci.yml`](.github/workflows/ci.yml):

- **Triggers**: Pull requests targeting any branch and direct pushes to `main`.
- **Concurrency**: Per-branch/ref concurrency group with `cancel-in-progress: true` to prevent redundant builds.
- **Permissions**: Scoped strictly to `contents: read`.
- **Jobs**:
  1. **CI**:
     - Runs on `ubuntu-latest` with a 15-minute timeout.
     - Sets up Node.js 20 (matching Vercel's active LTS runtime) with npm caching.
     - Runs `npm ci`.
     - Executes `npm run build:css`.
     - Verifies CSS freshness with `git diff --exit-code public/css/tailwind.css`.
     - Executes `npm test` without any `.env` file or external dependencies.
  2. **Security Audit**:
     - Non-blocking job (`continue-on-error: true`).
     - Executes `npm audit --omit=dev --audit-level=high` to surface dependency vulnerabilities directly in pull requests without blocking merges.

---

## Content Security Policy Rollout

See [`docs/csp-rollout.md`](docs/csp-rollout.md) for the staged rollout procedure:

1. Deploy with default report-only mode — read `[CSP Violation]` log lines for at least a week.
2. Set `CSP_ENFORCE=true` in the production environment to switch to enforcing mode.

---

## Smoke Test Checklist

See [`docs/csp-smoke.md`](docs/csp-smoke.md) for the full list of pages and user interactions to manually verify after CSP changes.
