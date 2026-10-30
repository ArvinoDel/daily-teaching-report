function filterStatus(status) {
  // Update active tab styles
  var tabs = document.querySelectorAll('.filter-tab');
  tabs.forEach(function(tab) {
    if (tab.id === 'tab-' + status) {
      tab.className = 'filter-tab px-3 py-1.5 rounded-lg text-xs font-semibold bg-white text-slate-800 shadow-sm transition';
    } else {
      tab.className = 'filter-tab px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-500 hover:text-slate-700 transition';
    }
  });

  // Toggle rows based on status
  var rows = document.querySelectorAll('.feedback-row');
  rows.forEach(function(row) {
    if (status === 'all' || row.getAttribute('data-status') === status) {
      row.classList.remove('hidden');
    } else {
      row.classList.add('hidden');
    }
  });
}

// Lightbox functions
function openLightbox(url) {
  var lightbox = document.getElementById('lightbox');
  var img = document.getElementById('lightbox-img');
  if (img) img.src = url;
  if (lightbox) lightbox.classList.remove('hidden');
  document.body.classList.add('overflow-hidden'); // Disable scroll
}

function closeLightbox(event) {
  if (event) {
    event.stopPropagation();
  }
  var lightbox = document.getElementById('lightbox');
  if (lightbox) lightbox.classList.add('hidden');
  document.body.classList.remove('overflow-hidden');
}

// Escape key support to close lightbox and description modal
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    closeLightbox();
    closeDescModal();
  }
});

// Description modal functions
function openDescModal(id) {
  var tpl = document.getElementById('desc-full-' + id);
  if (!tpl) return;
  var tempDiv = document.createElement('div');
  tempDiv.innerHTML = tpl.innerHTML;
  var text = tempDiv.textContent || tempDiv.innerText || '';
  var modalContent = document.getElementById('modalDescContent');
  if (modalContent) modalContent.textContent = text;
  var descModal = document.getElementById('descModal');
  if (descModal) descModal.classList.remove('hidden');
  document.body.classList.add('overflow-hidden');
  var copyBtnText = document.getElementById('copyBtnText');
  if (copyBtnText) copyBtnText.textContent = 'Copy';
}

function closeDescModal() {
  var modal = document.getElementById('descModal');
  if (modal) {
    modal.classList.add('hidden');
    document.body.classList.remove('overflow-hidden');
  }
}

function copyDescText() {
  var modalContent = document.getElementById('modalDescContent');
  var text = modalContent ? modalContent.textContent : '';
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function() {
      var btnText = document.getElementById('copyBtnText');
      if (btnText) {
        btnText.textContent = 'Copied!';
        setTimeout(function() { btnText.textContent = 'Copy'; }, 2000);
      }
    });
  }
}

if (typeof registerAction === 'function') {
  registerAction('filterFeedbackStatus', function (e, el) {
    filterStatus(el.dataset.status);
  });
  registerAction('openDescModal', function (e, el) {
    openDescModal(el.dataset.id);
  });
  registerAction('closeDescModal', function () {
    closeDescModal();
  });
  registerAction('openLightbox', function (e, el) {
    openLightbox(el.dataset.imgUrl);
  });
  registerAction('closeLightbox', function () {
    closeLightbox();
  });
  registerAction('copyDescText', function () {
    copyDescText();
  });
}

