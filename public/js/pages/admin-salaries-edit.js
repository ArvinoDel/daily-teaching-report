
  function parseVal(idOrEl) {
    const el = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
    if (!el) return 0;
    const clean = String(el.value || '').replace(/,/g, '').trim();
    return parseFloat(clean) || 0;
  }

  function fmt(v) {
    return 'Rp\u00a0' + Math.round(v).toLocaleString('en-US');
  }

  function sumInputsByClass(cls) {
    return Array.from(document.querySelectorAll('.' + cls))
      .reduce((s, el) => s + parseVal(el), 0);
  }

  function recalculate() {
    const mealFullDays  = parseVal('mealFullDays');
    const mealFullRate  = parseVal('mealFullRate');
    const mealHalfDays  = parseVal('mealHalfDays');
    const mealHalfRate  = parseVal('mealHalfRate');
    const transportDays = parseVal('transportDays');
    const transportRate = parseVal('transportRate');

    const mealFull  = mealFullDays * mealFullRate;
    const mealHalf  = mealHalfDays * mealHalfRate;
    const transport = transportDays * transportRate;

    const elMF = document.getElementById('mealFullTotal');
    const elMH = document.getElementById('mealHalfTotal');
    const elTR = document.getElementById('transportTotal');
    if (elMF) elMF.textContent = fmt(mealFull);
    if (elMH) elMH.textContent = fmt(mealHalf);
    if (elTR) elTR.textContent = fmt(transport);

    const fixedEarnings = [
      'basicSalary','monthlyIncentive','healthAllowance','positionAllowance',
      'loyaltyAllowance','wifeChildAllowance','teachingReward','gameReward',
      'studentCommission','internetCompensation','overtime',
    ].reduce((s, k) => s + parseVal(k), 0);

    const otherIncome  = sumInputsByClass('other-income-amt');
    const gross = fixedEarnings + mealFull + mealHalf + transport + otherIncome;

    const otherDeduct = sumInputsByClass('other-deduct-amt');
    const deductions  = ['instalment','miscellaneousDeduction','bpjsKetenagakerjaan','tax']
      .reduce((s, k) => s + parseVal(k), 0) + otherDeduct;

    const net = gross - deductions;

    const elSI = document.getElementById('subtotal-income');
    const elSD = document.getElementById('subtotal-deduct');
    const elLG = document.getElementById('live-gross');
    const elLD = document.getElementById('live-deduct');
    const elLN = document.getElementById('live-net');

    if (elSI) elSI.textContent = fmt(gross);
    if (elSD) elSD.textContent = fmt(deductions);
    if (elLG) elLG.textContent = fmt(gross);
    if (elLD) elLD.textContent = fmt(deductions);
    if (elLN) elLN.textContent = fmt(net);
  }

  // Auto add commas every 3 digits with cursor position preservation
  function formatInputWithCommas(input) {
    const orig = input.value;
    const cursor = input.selectionStart ?? orig.length;
    // Count how many digits existed before the caret
    const digitsBefore = orig.slice(0, cursor).replace(/\D/g, '').length;

    // Strip everything except digits
    const rawDigits = orig.replace(/\D/g, '');
    if (rawDigits === '') {
      input.value = '';
      return;
    }

    // Strip leading zeroes unless it's just '0'
    const normalized = rawDigits.replace(/^0+(?=\d)/, '');
    const formatted = normalized.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    input.value = formatted;

    // Calculate new cursor position based on digits seen
    let newCursor = 0;
    let seen = 0;
    for (let i = 0; i < formatted.length; i++) {
      if (/\d/.test(formatted[i])) seen++;
      if (seen === digitsBefore) {
        newCursor = i + 1;
        break;
      }
    }
    if (digitsBefore === 0) newCursor = 0;
    else if (seen < digitsBefore) newCursor = formatted.length;

    input.setSelectionRange(newCursor, newCursor);
  }

  // Delegated input listener for all currency inputs
  document.addEventListener('input', function(e) {
    if (e.target && e.target.classList && e.target.classList.contains('currency-input')) {
      formatInputWithCommas(e.target);
      recalculate();
    } else if (e.target && e.target.classList && e.target.classList.contains('days-input')) {
      recalculate();
    }
  });

  // Select all on focus when input is '0' so user can overwrite directly
  document.addEventListener('focus', function(e) {
    if (e.target && e.target.classList && e.target.classList.contains('currency-input')) {
      if (e.target.value === '0') {
        e.target.select();
      }
    }
  }, true);

  // Default to '0' on blur if empty
  document.addEventListener('blur', function(e) {
    if (e.target && e.target.classList && e.target.classList.contains('currency-input')) {
      if (e.target.value.trim() === '') {
        e.target.value = '0';
        recalculate();
      }
    }
  }, true);

  function addOtherIncome() {
    const row = document.createElement('div');
    row.className = 'flex gap-2.5 other-income-row items-center';
    row.innerHTML = `
      <input type="text" name="otherIncomeLabel[]" placeholder="Label" class="input-std flex-1">
      <div class="relative w-44 flex-shrink-0">
        <span class="absolute left-3.5 inset-y-0 flex items-center text-slate-400 text-xs font-semibold select-none pointer-events-none">Rp</span>
        <input type="text" inputmode="numeric" name="otherIncomeAmount[]" value="0" placeholder="0" autocomplete="off" class="input-money has-prefix w-full other-income-amt currency-input">
      </div>
      <button type="button" data-action="removeOtherIncome"
        class="w-10 h-10 flex items-center justify-center text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-xl transition" title="Remove row">
        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>
      </button>`;
    document.getElementById('other-incomes-list').appendChild(row);
    recalculate();
  }

  function addOtherDeduction() {
    const row = document.createElement('div');
    row.className = 'flex gap-2.5 other-deduction-row items-center';
    row.innerHTML = `
      <input type="text" name="otherDeductionLabel[]" placeholder="Label" class="input-std flex-1">
      <div class="relative w-44 flex-shrink-0">
        <span class="absolute left-3.5 inset-y-0 flex items-center text-red-400 text-xs font-semibold select-none pointer-events-none">Rp</span>
        <input type="text" inputmode="numeric" name="otherDeductionAmount[]" value="0" placeholder="0" autocomplete="off" class="input-money has-prefix w-full other-deduct-amt currency-input">
      </div>
      <button type="button" data-action="removeOtherDeduction"
        class="w-10 h-10 flex items-center justify-center text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-xl transition" title="Remove row">
        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>
      </button>`;
    document.getElementById('other-deductions-list').appendChild(row);
    recalculate();
  }

  // Strip commas before form submit just to ensure clean numeric payload
  document.getElementById('salary-form')?.addEventListener('submit', function() {
    document.querySelectorAll('.currency-input').forEach(function(input) {
      input.value = input.value.replace(/,/g, '');
    });
  });

  // Run initial calculation
  recalculate();

  if (typeof registerAction === 'function') {
    registerAction('removeOtherIncome', function (e, el) {
      var row = el.closest('.other-income-row');
      if (row) row.remove();
      recalculate();
    });
    registerAction('addOtherIncome', function () {
      addOtherIncome();
    });
    registerAction('removeOtherDeduction', function (e, el) {
      var row = el.closest('.other-deduction-row');
      if (row) row.remove();
      recalculate();
    });
    registerAction('addOtherDeduction', function () {
      addOtherDeduction();
    });
  }
