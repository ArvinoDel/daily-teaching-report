# CSP Smoke Test Checklist

Checklist of pages and user actions to verify throughout Content Security Policy hardening. Every interactive control must work without triggering CSP violations (`script-src-attr` or `script-src`).

> **"Verified" column key**
> - `verified: automated test` — covered by `node --test` (DOM, unit, or integration test)
> - `verified: manual` — observed in a live browser session during development
> - `not verified` — not tested; no browser session or automated coverage exists

---

## 1. Navigation & Shell

| Item | Verified |
|------|----------|
| **Navbar Desktop Profile Dropdown** (`/reports`, any page) — Click `#profile-btn` → Dropdown opens with chevron rotation; click outside → closes cleanly | not verified |
| **Mobile Navbar Menu** (viewport < 640 px) — Tap hamburger → slide opens, icon changes; tap link → closes & navigates | not verified |
| **Notification Heartbeat Badge** — Heartbeat fires in background without script errors | not verified |

---

## 2. Dashboard (`/reports`)

| Item | Verified |
|------|----------|
| **Daily Summary Filter & Table** — Click date selector → table reloads; click view-report link → navigates | not verified |

---

## 3. Reports Form (`/reports/new`, `/reports/:id/edit`)

| Item | Verified |
|------|----------|
| **Single Report Mode** — Select class/group → autocomplete fills roster; toggle attendance; add bonus/deduction row; attach photo; submit | verified: automated test (`tests/reportForm.test.js` DOM suite covers autocomplete, roster, attendance, bonus/deduction, and form submission paths) |
| **Competition Report Mode** — Switch session type → competition picker reveals; add/remove group chips; hidden field populated | verified: automated test (DOM suite) |
| **Multi-Report Mode** — Click "+ Add Another Report" → card added; remove card → detached cleanly | verified: automated test (DOM suite) |

---

## 4. Materials (`/materials`, `/materials/:id`, `/materials/:id/edit`, `/admin/materials`)

| Item | Verified |
|------|----------|
| **Materials List** — Search/filter; admin "+ Add Material" modal; delete confirmation | not verified |
| **Material Viewer & Slide Presentation** — "Start Presentation" → modal opens; next/prev/arrow-key navigation; thumbnail strip; close | not verified |
| **Material Editor** — Markdown editor + live preview; drag-and-drop attachment; remove attachment | not verified |

---

## 5. Admin Groups (`/admin/groups`, `/admin/groups/import`)

| Item | Verified |
|------|----------|
| **Groups Management** — Search filter; New Group modal; add/remove student name chips; edit modal; delete prompt | not verified |
| **Roster CSV Import** — Upload CSV → diff preview with namesake resolution | not verified |

---

## 6. Admin Salaries (`/admin/salaries`, `/admin/salaries/:id/edit`, `/admin/salaries/slip`)

| Item | Verified |
|------|----------|
| **Salaries Table** — Month/year filter; "Recalculate All"; export/print | not verified |
| **Salary Edit** — Adjust rates, bonus/deduction rows, dynamic totals; save | not verified |
| **Salary Slip** — Print button triggers `window.print()` | not verified |

---

## 7. Admin Feedbacks (`/admin/feedbacks`)

| Item | Verified |
|------|----------|
| **Feedbacks Table** — Category/status filter; status dropdown; details modal; delete | not verified |

---

## 8. Student Achievements & Scan AC (`/admin/student-achievements`, `/admin/scan-ac`)

| Item | Verified |
|------|----------|
| **Student Achievements** — Search; "+ Add Achievement" modal; "Print Achievement Cards" | not verified |
| **Scan AC** — Toggle camera/manual; scan or type code → verified badge | not verified |

---

## 9. Reward Crosscheck (`/reports/reward-crosscheck`)

| Item | Verified |
|------|----------|
| **Screenshot & OCR** — Drag-and-drop or file picker upload; run OCR; result table; copy results | not verified (headless CLI; no browser; OCR requires Tesseract WASM which cannot run without a GPU/browser context) |

> **CSP note**: the per-route `wasm-unsafe-eval` exception for this page is verified by `tests/csp-policy.test.js` ("global policy excludes wasm-unsafe-eval, reward-crosscheck policy includes wasm-unsafe-eval").

---

## 10. Student Card Modal (`views/partials/admin/student-card-modal.ejs`)

| Item | Verified |
|------|----------|
| **Student Card Details** — Click student link → modal opens; switch tabs (Overview / Attendance / Reward Points); close via X or backdrop | not verified |

---

## 11. Profile & Notifications (`/profile/edit`, `/notifications`)

| Item | Verified |
|------|----------|
| **Profile** — Update display name, email, password; avatar preview | not verified |
| **Notifications** — "Mark All as Read"; click notification navigates | not verified |
