/**
 * salary-bulk-edit.js
 * Client-side logic for the bulk-edit walkthrough on the salary edit page.
 * Loaded only when ?flow=bulk is present (via a <script defer> in edit.ejs).
 * CSP note: No inline scripts. All server data injected via
 *   <script id="bulk-edit-config" type="application/json"> in edit.ejs.
 *
 * sessionStorage key: "salaryBulkEdit:{YYYY-MM}"
 * Shape: { [salaryId]: { updatedAt: ISO-string, fields: {...} } }
 */
'use strict';

let CFG = {};
let INITIAL_SNAPSHOT = {};
let _isNavigatingFlow = false;

document.addEventListener('DOMContentLoaded', () => {
  try {
    const cfgEl = document.getElementById('bulk-edit-config');
    if (cfgEl) CFG = JSON.parse(cfgEl.textContent || '{}');
  } catch (e) { console.error('[bulk-edit] Failed to parse config:', e); }

  if (!CFG.salaryId) return;

  INITIAL_SNAPSHOT = captureFormFields();
  restorePending();
  renderBulkFooter();
  if (typeof recalculate === 'function') recalculate();

  window.addEventListener('beforeunload', (e) => {
    if (_isNavigatingFlow) return;
    if (pendingCount() > 0) { e.preventDefault(); e.returnValue = ''; }
  });
});

/* ─── sessionStorage ─────────────────────────────────────────────────────── */
function storageKey() { return `salaryBulkEdit:${CFG.monthStr}`; }
function loadStorage() {
  try { return JSON.parse(sessionStorage.getItem(storageKey()) || '{}'); }
  catch (_) { return {}; }
}
function saveStorage(data) { sessionStorage.setItem(storageKey(), JSON.stringify(data)); }

function pendingCount() {
  const store = loadStorage();
  let count = Object.keys(store).length;
  if (!store[CFG.salaryId] && isCurrentFormDirty()) count += 1;
  return count;
}
function isCurrentFormDirty() {
  return !fieldsEqual(INITIAL_SNAPSHOT, captureFormFields());
}

/* ─── Form capture ───────────────────────────────────────────────────────── */
function captureFormFields() {
  const val  = (name) => { const el = document.querySelector(`[name="${name}"]`); return el ? el.value : ''; };
  const vals = (name) => Array.from(document.querySelectorAll(`[name="${name}"]`)).map(e => e.value);
  return {
    periodLabel: val('periodLabel'), periodStart: val('periodStart'),
    periodEnd: val('periodEnd'), payDate: val('payDate'), payDateLabel: val('payDateLabel'),
    basicSalary: val('basicSalary'), mealFullDays: val('mealFullDays'),
    mealFullRate: val('mealFullRate'), mealHalfDays: val('mealHalfDays'),
    mealHalfRate: val('mealHalfRate'), transportDays: val('transportDays'),
    transportRate: val('transportRate'), monthlyIncentive: val('monthlyIncentive'),
    healthAllowance: val('healthAllowance'), positionAllowance: val('positionAllowance'),
    loyaltyAllowance: val('loyaltyAllowance'), wifeChildAllowance: val('wifeChildAllowance'),
    teachingReward: val('teachingReward'), gameReward: val('gameReward'),
    studentCommission: val('studentCommission'), internetCompensation: val('internetCompensation'),
    overtime: val('overtime'), instalment: val('instalment'),
    miscellaneousDeduction: val('miscellaneousDeduction'),
    bpjsKetenagakerjaan: val('bpjsKetenagakerjaan'), tax: val('tax'),
    'otherIncomeLabel[]': vals('otherIncomeLabel[]'),
    'otherIncomeAmount[]': vals('otherIncomeAmount[]'),
    'otherDeductionLabel[]': vals('otherDeductionLabel[]'),
    'otherDeductionAmount[]': vals('otherDeductionAmount[]'),
    notes: val('notes'),
  };
}

function fieldsEqual(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const av = a[k], bv = b[k];
    if (Array.isArray(av) && Array.isArray(bv)) {
      if (av.length !== bv.length) return false;
      for (let i = 0; i < av.length; i++) {
        if (normalise(av[i]) !== normalise(bv[i])) return false;
      }
    } else if (Array.isArray(av) || Array.isArray(bv)) {
      return false;
    } else {
      if (normalise(av) !== normalise(bv)) return false;
    }
  }
  return true;
}
function normalise(v) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/,/g, '').trim();
}

/* ─── Restore pending ────────────────────────────────────────────────────── */
function restorePending() {
  const store = loadStorage();
  const entry = store[CFG.salaryId];
  if (!entry) return;
  const fields = entry.fields || {};

  const set = (name, value) => { const el = document.querySelector(`[name="${name}"]`); if (el) el.value = value; };

  const scalars = [
    'periodLabel','periodStart','periodEnd','payDate','payDateLabel',
    'basicSalary','mealFullDays','mealFullRate','mealHalfDays','mealHalfRate',
    'transportDays','transportRate','monthlyIncentive','healthAllowance',
    'positionAllowance','loyaltyAllowance','wifeChildAllowance','teachingReward',
    'gameReward','studentCommission','internetCompensation','overtime',
    'instalment','miscellaneousDeduction','bpjsKetenagakerjaan','tax','notes',
  ];
  scalars.forEach(k => { if (fields[k] !== undefined) set(k, fields[k]); });

  const oiLabels  = fields['otherIncomeLabel[]']    || [];
  const oiAmounts = fields['otherIncomeAmount[]']   || [];
  const odLabels  = fields['otherDeductionLabel[]'] || [];
  const odAmounts = fields['otherDeductionAmount[]']|| [];

  if (oiLabels.length > 0) rebuildDynamicRows('other-incomes-list', 'other-income-row', oiLabels, oiAmounts, 'income');
  if (odLabels.length > 0) rebuildDynamicRows('other-deductions-list', 'other-deduction-row', odLabels, odAmounts, 'deduction');
}

function rebuildDynamicRows(containerId, rowClass, labels, amounts, type) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.querySelectorAll(`.${rowClass}`).forEach(el => el.remove());
  labels.forEach((label, i) => {
    const row = document.createElement('div');
    row.className = `flex gap-2.5 ${rowClass} items-center`;
    const amtClass    = type === 'income' ? 'other-income-amt' : 'other-deduct-amt';
    const labelName   = type === 'income' ? 'otherIncomeLabel[]' : 'otherDeductionLabel[]';
    const amtName     = type === 'income' ? 'otherIncomeAmount[]' : 'otherDeductionAmount[]';
    const prefixColor = type === 'income' ? 'text-slate-400' : 'text-red-400';
    row.innerHTML = `
      <input type="text" name="${labelName}" placeholder="Label" class="input-std flex-1" value="${escHtml(label)}">
      <div class="relative w-44 flex-shrink-0">
        <span class="absolute left-3.5 inset-y-0 flex items-center ${prefixColor} text-xs font-semibold select-none pointer-events-none">Rp</span>
        <input type="text" inputmode="numeric" name="${amtName}" value="${escHtml(amounts[i]||'0')}"
          placeholder="0" autocomplete="off" class="input-money has-prefix w-full ${amtClass} currency-input">
      </div>
      <button type="button" onclick="this.closest('.${rowClass}').remove(); recalculate();"
        class="w-10 h-10 flex items-center justify-center text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-xl transition" title="Remove row">
        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>
      </button>`;
    container.appendChild(row);
  });
}

function escHtml(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ─── Commit current page ────────────────────────────────────────────────── */
function commitCurrentPage() {
  const current = captureFormFields();
  const store   = loadStorage();
  if (fieldsEqual(INITIAL_SNAPSHOT, current)) {
    delete store[CFG.salaryId];
  } else {
    store[CFG.salaryId] = { updatedAt: CFG.updatedAt, fields: current };
  }
  saveStorage(store);
}

/* ─── Navigation ─────────────────────────────────────────────────────────── */
function buildEditUrl(id) {
  return `/admin/salaries/${id}/edit?flow=bulk&month=${encodeURIComponent(CFG.monthStr)}`;
}
function navigateTo(id) {
  _isNavigatingFlow = true;
  commitCurrentPage();
  window.location.href = buildEditUrl(id);
}
function goBack() {
  if (CFG.currentIndex <= 0) return;
  navigateTo(CFG.bulkList[CFG.currentIndex - 1].id);
}
function goNext() {
  if (CFG.currentIndex >= CFG.totalDrafts - 1) return;
  navigateTo(CFG.bulkList[CFG.currentIndex + 1].id);
}

/* ─── Save all ───────────────────────────────────────────────────────────── */
async function saveAll() {
  commitCurrentPage();
  const store = loadStorage();
  const keys  = Object.keys(store);
  if (keys.length === 0) { alert('No changes to save.'); return; }

  const items = keys.map(id => ({ id, updatedAt: store[id].updatedAt, fields: store[id].fields }));
  const btn = document.getElementById('bulk-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving\u2026'; }

  try {
    const res = await fetch('/admin/salaries/bulk-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': CFG.csrfToken },
      body: JSON.stringify({ month: CFG.month, year: CFG.year, items }),
    });
    const data = await res.json();
    if (!data.ok) {
      if (btn) { btn.disabled = false; updateSaveBtnLabel(); }
      alert('Save failed: ' + (data.message || 'Unknown error'));
      return;
    }
    _isNavigatingFlow = true;
    sessionStorage.removeItem(storageKey());
    const savedIds = data.savedIds || [];
    const idsParam = savedIds.length > 0 ? `&reviewIds=${encodeURIComponent(savedIds.join(','))}` : '';
    window.location.href = `/admin/salaries?month=${encodeURIComponent(data.monthStr || CFG.monthStr)}${idsParam}`;
  } catch (err) {
    if (btn) { btn.disabled = false; updateSaveBtnLabel(); }
    alert('Network error: ' + err.message);
  }
}

/* ─── Labels ─────────────────────────────────────────────────────────────── */
function saveBtnLabel(n) {
  if (CFG.currentIndex === CFG.totalDrafts - 1) return `Save all edits (${n})`;
  return `Save ${n} edit${n !== 1 ? 's' : ''}`;
}
function updateSaveBtnLabel() {
  const n = pendingCount();
  const btn = document.getElementById('bulk-save-btn');
  if (!btn) return;
  btn.textContent = saveBtnLabel(n);
  btn.disabled    = n === 0;
}
function updateJumpBarDots() {
  const store = loadStorage();
  (CFG.bulkList || []).forEach(item => {
    const dotEl = document.getElementById(`jump-dot-${item.id}`);
    if (!dotEl) return;
    const hasPending = !!store[item.id] || (item.id === CFG.salaryId && isCurrentFormDirty());
    dotEl.style.display = hasPending ? 'inline-block' : 'none';
  });
}

/* ─── Render footer ──────────────────────────────────────────────────────── */
function renderBulkFooter() {
  const footer = document.getElementById('bulk-footer');
  if (!footer) return;
  const isLast  = CFG.currentIndex === CFG.totalDrafts - 1;
  const isFirst = CFG.currentIndex === 0;
  const n       = pendingCount();

  footer.innerHTML = `
    <div class="flex flex-col sm:flex-row items-start sm:items-center gap-3 w-full">
      <div class="flex items-center gap-2 flex-shrink-0">
        ${!isFirst ? `<button id="bulk-back-btn" type="button"
            class="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 text-slate-600 text-sm font-semibold hover:bg-slate-50 transition">
            <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5"/></svg>
            Back
          </button>` : ''}
        <span class="text-sm font-semibold text-slate-500 whitespace-nowrap">${CFG.currentIndex + 1} of ${CFG.totalDrafts}</span>
      </div>
      <div class="flex-1 overflow-x-auto min-w-0">
        <div class="flex items-center gap-1.5 flex-nowrap py-0.5" id="jump-bar">
          ${(CFG.bulkList||[]).map((item, idx) => {
            const isCurrent = idx === CFG.currentIndex;
            return `<button type="button" id="jump-btn-${item.id}"
              class="relative flex-shrink-0 px-2.5 py-1 rounded-lg text-xs font-semibold transition whitespace-nowrap ${isCurrent ? 'bg-brand-600 text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}"
              data-jump-id="${item.id}" title="${escHtml(item.teacherName)}">
              ${escHtml(item.teacherName)}
              <span id="jump-dot-${item.id}" class="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-400 border border-white" style="display:none"></span>
            </button>`;
          }).join('')}
        </div>
      </div>
      <div class="flex items-center gap-2 flex-shrink-0">
        <button id="bulk-save-btn" type="button"
          class="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed text-white text-sm font-semibold shadow-sm transition"
          ${n === 0 ? 'disabled' : ''}>
          ${saveBtnLabel(n)}
        </button>
        ${!isLast ? `<button id="bulk-next-btn" type="button"
          class="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold shadow-sm transition">
          Next teacher
          <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5"/></svg>
        </button>` : ''}
      </div>
    </div>`;

  document.getElementById('bulk-back-btn')?.addEventListener('click', goBack);
  document.getElementById('bulk-next-btn')?.addEventListener('click', goNext);
  document.getElementById('bulk-save-btn')?.addEventListener('click', saveAll);

  // Jump bar delegation
  document.getElementById('jump-bar')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-jump-id]');
    if (btn) { _isNavigatingFlow = true; navigateTo(btn.dataset.jumpId); }
  });

  updateJumpBarDots();
  requestAnimationFrame(() => {
    document.getElementById(`jump-btn-${CFG.salaryId}`)
      ?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  });
}

/* ─── Re-render on input ─────────────────────────────────────────────────── */
document.addEventListener('input', () => {
  requestAnimationFrame(() => { updateSaveBtnLabel(); updateJumpBarDots(); });
});
