# CSP Smoke Test Checklist

Checklist of pages and user actions to verify throughout Content Security Policy hardening. Every interactive control must work without triggering CSP violations (`script-src-attr` or `script-src`).

---

## 1. Navigation & Shell
- [ ] **Navbar Desktop Profile Dropdown (`/reports`, any page)**
  - Click profile button (`#profile-btn`) -> Dropdown menu opens with chevron rotation.
  - Click outside the dropdown -> Dropdown closes cleanly.
- [ ] **Mobile Navbar Menu (`/reports`, any page on viewport < 640px)**
  - Tap hamburger menu button (`#mobile-menu-btn`) -> Mobile navigation slide opens, hamburger icon switches to close icon.
  - Tap any navigation link (e.g. Dashboard, Materials, Calculator) -> Menu closes and navigates.
- [ ] **Notification Heartbeat Badge**
  - Heartbeat fires in background without script errors.

---

## 2. Dashboard (`/reports`)
- [ ] **Daily Summary Filter & Table**
  - Click summary date selector / navigate dates -> Table reloads with chronological sorting.
  - Click view report link -> Navigates to report detail page.

---

## 3. Reports Form (`/reports/new`, `/reports/:id/edit`)
- [ ] **Single Report Mode**
  - Select class / group name -> Autocomplete dropdown filters, select option populates roster.
  - Toggle attendance checkboxes for students (Present / Absent / Late).
  - Add bonus / deduction items -> New input row created, value calculated.
  - Attach photo / media upload -> File preview renders.
  - Submit report -> Form validation runs and submits cleanly.
- [ ] **Competition Report Mode**
  - Switch session type to "Competition" -> Competition group picker reveals.
  - Search and select 2+ groups -> Group chips added, `competition_groups_hidden` populated.
  - Remove a group chip -> Removed from UI and hidden field.
- [ ] **Multi-Report Mode**
  - Click "+ Add Another Report" -> Adds second report card (`addBulkEntry`).
  - Fill fields in second card, remove card via delete button -> Card cleanly detached.

---

## 4. Materials (`/materials`, `/materials/:id`, `/materials/:id/edit`, `/admin/materials`)
- [ ] **Materials List (`/materials`, `/admin/materials`)**
  - Search / filter by title, level, or category -> List filters immediately.
  - Admin: "+ Add Material" modal opens, form submit works.
  - Admin: Delete material button opens SweetAlert confirmation.
- [ ] **Material Viewer & Slide Presentation (`/materials/:id`)**
  - Click "Start Presentation" -> Fullscreen slide viewer modal opens (`_slide-viewer-modal.ejs`).
  - Next / Prev buttons, arrow keys (Left/Right) navigate slides.
  - Slide thumbnail strip click selects specific slide.
  - Exit fullscreen / Close button -> Modal closes.
- [ ] **Material Editor (`/materials/:id/edit`)**
  - Markdown body editor and live preview.
  - Drag and drop file attachment area -> Highlights on dragover, accepts drop.
  - Remove attachment button deletes file chip.

---

## 5. Admin Groups (`/admin/groups`, `/admin/groups/import`)
- [ ] **Groups Management (`/admin/groups`)**
  - Search groups input filters table rows.
  - Click "New Group" -> Modal opens, group name & level input.
  - Add student name chip (type + press Enter / click Add) -> Chip appears.
  - Remove student name chip -> Chip removed.
  - Edit group modal loads current group data; Save updates group.
  - Delete group prompt works.
- [ ] **Roster CSV Import (`/admin/groups/import`)**
  - Upload CSV file -> Diff preview table loads with namesake resolution buttons.

---

## 6. Admin Salaries (`/admin/salaries`, `/admin/salaries/:id/edit`, `/admin/salaries/slip`)
- [ ] **Salaries Table (`/admin/salaries`)**
  - Month/year filter dropdown updates list.
  - "Recalculate All" button triggers salary batch calculation.
  - "Export to Excel" / "Print" triggers download or print view.
- [ ] **Salary Edit (`/admin/salaries/:id/edit`)**
  - Adjust base rate, teaching session counts, bonus/deduction rows.
  - Calculations update totals dynamically.
  - Save button updates salary document.
- [ ] **Salary Slip (`/admin/salaries/slip`, `/reports/my-salary/slip`)**
  - Print button triggers `window.print()`.

---

## 7. Admin Feedbacks (`/admin/feedbacks`)
- [ ] **Feedbacks Table**
  - Category / status filters update list.
  - Change feedback status dropdown updates status without full reload.
  - View feedback details modal opens with full message.
  - Delete feedback button confirms via dialog.

---

## 8. Student Achievements & Scan AC (`/admin/student-achievements`, `/admin/scan-ac`)
- [ ] **Student Achievements (`/admin/student-achievements`)**
  - Search student by name / ID filters achievements.
  - "+ Add Achievement" modal opens and submits.
  - "Print Achievement Cards" opens card layout (`print-cards.ejs`).
- [ ] **Scan AC (`/admin/scan-ac`, `/admin/scan-ac/mobile`)**
  - Toggle camera scanner / manual entry input.
  - Scan QR code or enter code manually -> Student verified badge appears.

---

## 9. Reward Crosscheck (`/reports/reward-crosscheck`)
- [ ] **Screenshot & OCR**
  - Drag & drop screenshot or file picker upload.
  - Run Crosscheck button initiates OCR processing.
  - Result table displays matching student records and discrepancies.
  - Copy results button copies table markdown/text to clipboard.

---

## 10. Student Card Modal (`views/partials/admin/student-card-modal.ejs`)
- [ ] **Student Card Details**
  - Click any student link across admin views -> Modal opens with student profile.
  - Switch tabs: "Overview", "Attendance History", "Reward Points".
  - Close modal via "X" or backdrop click.

---

## 11. Profile & Notifications (`/profile/edit`, `/notifications`)
- [ ] **Profile (`/profile/edit`)**
  - Update display name, email, password fields.
  - Avatar image file selection preview.
- [ ] **Notifications (`/notifications`)**
  - "Mark All as Read" button marks items read and clears unread badge.
  - Click notification row navigates to relevant report/material.
