
  /* ── Modal helpers ── */
  function openModal(id) {
    document.getElementById(id).classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }
  function closeModal(id) {
    document.getElementById(id).classList.add('hidden');
    document.body.style.overflow = '';
  }
  function handleBackdropClick(e, id) {
    if (e.target === document.getElementById(id)) closeModal(id);
  }
  // Close on Escape
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      ['modal-generate','modal-publish'].forEach(closeModal);
    }
  });

  /* ── Select-all checkbox ── */
  const selectAll = document.getElementById('select-all');
  if (selectAll) {
    selectAll.addEventListener('change', function() {
      document.querySelectorAll('.row-check').forEach(cb => cb.checked = this.checked);
    });
    // Sync select-all state when individual boxes change
    document.querySelectorAll('.row-check').forEach(cb => {
      cb.addEventListener('change', function() {
        const all   = document.querySelectorAll('.row-check');
        const checked = document.querySelectorAll('.row-check:checked');
        selectAll.indeterminate = checked.length > 0 && checked.length < all.length;
        selectAll.checked = checked.length === all.length;
      });
    });
  }

  /* ── Bulk publish with guard ── */
  function openPublishModal() {
    const checked = document.querySelectorAll('.row-check:checked');
    if (checked.length === 0) {
      // Warn if none selected — will publish ALL
      document.getElementById('publish-summary').innerHTML =
        '<strong class="text-amber-600">No teachers selected</strong> — this will send slips to <strong>all ' +
        document.querySelectorAll('.row-check').length + ' teachers</strong> in this month.';
    } else {
      document.getElementById('publish-summary').textContent =
        checked.length + ' teacher' + (checked.length > 1 ? 's' : '') + ' selected. They will be able to view their salary slip.';
    }
    openModal('modal-publish');
  }

  function submitPublish() {
    closeModal('modal-publish');
    const bulkForm = document.getElementById('bulk-form');
    // Remove any previously appended teacherIds hidden inputs
    bulkForm.querySelectorAll('input[name="teacherIds"]').forEach(el => el.remove());
    // Append checked teacher IDs
    const checked = document.querySelectorAll('.row-check:checked');
    checked.forEach(cb => {
      if (cb.value) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'teacherIds';
        input.value = cb.value;
        bulkForm.appendChild(input);
      }
    });
    bulkForm.submit();
  }

  if (typeof registerAction === 'function') {
    registerAction('dismissSalaryFlash', function () {
      var flash = document.getElementById('salary-flash');
      if (flash) flash.remove();
    });
    registerAction('openSalaryModal', function (e, el) {
      openModal(el.dataset.modal);
    });
    registerAction('closeSalaryModal', function (e, el) {
      closeModal(el.dataset.modal);
    });
    registerAction('openPublishModal', function () {
      openPublishModal();
    });
    registerAction('submitPublish', function () {
      submitPublish();
    });
    registerAction('salaryBackdropClick', function (e, el) {
      handleBackdropClick(e, el.dataset.modal);
    });
  }
