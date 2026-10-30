(function () {
  window._slideViewerState = {
    materialId: null,
    slides: [],
    currentIndex: 0,
    isOpen: false,
    zoomLevel: 1.0,
    isAutoPlaying: false,
    autoPlayTimer: null,
  };

  const modal          = document.getElementById('slide-viewer-modal');
  const counterEl      = document.getElementById('sv-counter');
  const titleEl        = document.getElementById('sv-slide-title');
  const openLinkEl     = document.getElementById('sv-open-link');
  const dlLinkEl       = document.getElementById('sv-download-link');
  const imageEl        = document.getElementById('sv-image');
  const thumbsEl       = document.getElementById('sv-thumbnails');
  const progressBar    = document.getElementById('sv-progress-bar');
  const stageEl        = document.getElementById('sv-stage');
  const zoomTextEl     = document.getElementById('sv-zoom-level');
  const gridModal      = document.getElementById('sv-grid-modal');
  const gridContentEl  = document.getElementById('sv-grid-content');
  const shortcutsModal = document.getElementById('sv-shortcuts-modal');
  const iconPlay       = document.getElementById('sv-icon-play');
  const iconPause      = document.getElementById('sv-icon-pause');
  const playText       = document.getElementById('sv-play-text');

  const IMAGE_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'];

  // ── Public API ──────────────────────────────────────────────────────────

  window.initSlideViewer = function (materialId, fileResources) {
    window._slideViewerState.materialId = materialId;
    const rawList = Array.isArray(fileResources) ? fileResources : [];
    // Keep only images for the slideshow
    const imageSlides = rawList.filter(function (r) {
      if (!r) return false;
      if (r.kind && r.kind !== 'file') return false;
      const fmt = ((r.file && r.file.format) || '').toLowerCase().trim();
      return IMAGE_FORMATS.includes(fmt);
    });
    // Fallback: if caller passed list containing images, use them
    window._slideViewerState.slides = imageSlides.length > 0 ? imageSlides : rawList;
    buildThumbnails();
  };

  window.openSlideViewer = function (index) {
    const s = window._slideViewerState;
    if (!s.slides || s.slides.length === 0) return;
    s.currentIndex = (typeof index === 'number' && index >= 0 && index < s.slides.length) ? index : 0;
    s.isOpen = true;
    resetZoom();
    if (modal) modal.classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
    renderCurrentSlide(false);
  };

  window.closeSlideViewer = function () {
    stopAutoPlay();
    window._slideViewerState.isOpen = false;
    if (modal) modal.classList.add('hidden');
    if (gridModal) gridModal.classList.add('hidden');
    if (shortcutsModal) shortcutsModal.classList.add('hidden');
    document.body.classList.remove('overflow-hidden');
  };

  window.nextSlide = function () {
    const s = window._slideViewerState;
    if (!s.slides || s.slides.length === 0) return;
    s.currentIndex = (s.currentIndex + 1) % s.slides.length;
    resetZoom();
    renderCurrentSlide(true);
  };

  window.prevSlide = function () {
    const s = window._slideViewerState;
    if (!s.slides || s.slides.length === 0) return;
    s.currentIndex = s.currentIndex === 0 ? s.slides.length - 1 : s.currentIndex - 1;
    resetZoom();
    renderCurrentSlide(true);
  };

  window.goToSlide = function (index) {
    const s = window._slideViewerState;
    if (!s.slides || index < 0 || index >= s.slides.length) return;
    s.currentIndex = index;
    resetZoom();
    renderCurrentSlide(true);
    if (gridModal && !gridModal.classList.contains('hidden')) {
      gridModal.classList.add('hidden');
    }
  };

  window.toggleNativeFullscreen = function () {
    if (!document.fullscreenElement) {
      if (modal && modal.requestFullscreen) modal.requestFullscreen();
      else if (modal && modal.webkitRequestFullscreen) modal.webkitRequestFullscreen();
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
  };

  // ── Zoom Feature ────────────────────────────────────────────────────────

  window.zoomIn = function () {
    const s = window._slideViewerState;
    s.zoomLevel = Math.min(3.0, Math.round((s.zoomLevel + 0.25) * 100) / 100);
    applyZoom();
  };

  window.zoomOut = function () {
    const s = window._slideViewerState;
    s.zoomLevel = Math.max(0.75, Math.round((s.zoomLevel - 0.25) * 100) / 100);
    applyZoom();
  };

  window.resetZoom = function () {
    const s = window._slideViewerState;
    s.zoomLevel = 1.0;
    if (imageEl) imageEl.style.transform = '';
    if (zoomTextEl) zoomTextEl.textContent = '100%';
  };

  function applyZoom() {
    const s = window._slideViewerState;
    if (imageEl) {
      imageEl.style.transform = (s.zoomLevel === 1.0) ? '' : `scale(${s.zoomLevel})`;
    }
    if (zoomTextEl) {
      zoomTextEl.textContent = `${Math.round(s.zoomLevel * 100)}%`;
    }
  }

  // ── Auto-Play / Slideshow Feature ───────────────────────────────────────

  window.toggleAutoPlay = function () {
    const s = window._slideViewerState;
    if (s.isAutoPlaying) {
      stopAutoPlay();
    } else {
      startAutoPlay();
    }
  };

  function startAutoPlay() {
    const s = window._slideViewerState;
    s.isAutoPlaying = true;
    if (iconPlay) iconPlay.classList.add('hidden');
    if (iconPause) iconPause.classList.remove('hidden');
    if (playText) playText.textContent = 'Pause';
    clearInterval(s.autoPlayTimer);
    s.autoPlayTimer = setInterval(function () {
      nextSlide();
    }, 4000);
  }

  function stopAutoPlay() {
    const s = window._slideViewerState;
    s.isAutoPlaying = false;
    if (iconPlay) iconPlay.classList.remove('hidden');
    if (iconPause) iconPause.classList.add('hidden');
    if (playText) playText.textContent = 'Play';
    if (s.autoPlayTimer) {
      clearInterval(s.autoPlayTimer);
      s.autoPlayTimer = null;
    }
  }

  // ── Grid & Shortcuts Modal ──────────────────────────────────────────────

  window.toggleSlideGrid = function () {
    if (!gridModal) return;
    const willShow = gridModal.classList.contains('hidden');
    if (willShow) {
      buildGridContent();
      gridModal.classList.remove('hidden');
    } else {
      gridModal.classList.add('hidden');
    }
  };

  window.toggleShortcutsHelp = function () {
    if (!shortcutsModal) return;
    shortcutsModal.classList.toggle('hidden');
  };

  // Build grid cards purely with DOM APIs
  function buildGridContent() {
    const s = window._slideViewerState;
    if (!gridContentEl) return;
    gridContentEl.textContent = ''; // clear safely

    s.slides.forEach(function (slide, idx) {
      const openUrl = '/materials/' + encodeURIComponent(s.materialId) + '/resources/' + encodeURIComponent(slide._id) + '/open';
      const labelText = slide.label || (slide.file && slide.file.originalFilename) || 'Slide ' + (idx + 1);

      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'group flex flex-col rounded-xl overflow-hidden border transition text-left cursor-pointer p-2.5 bg-slate-900/60 hover:bg-slate-800 hover:border-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';
      if (idx === s.currentIndex) {
        card.classList.add('ring-2', 'ring-brand-500', 'border-brand-500', 'bg-slate-800');
      } else {
        card.classList.add('border-slate-800');
      }

      const mediaBox = document.createElement('div');
      mediaBox.className = 'w-full h-32 flex items-center justify-center bg-black/40 rounded-lg overflow-hidden border border-slate-800/80 mb-2';

      const img = document.createElement('img');
      img.src = openUrl;
      img.alt = labelText;
      img.className = 'max-w-full max-h-full object-contain';
      img.loading = 'lazy';
      mediaBox.appendChild(img);

      const footer = document.createElement('div');
      footer.className = 'flex items-center justify-between text-xs w-full gap-2';

      const numSpan = document.createElement('span');
      numSpan.className = 'font-mono font-bold text-slate-400';
      numSpan.textContent = '#' + (idx + 1);

      const titleSpan = document.createElement('span');
      titleSpan.className = 'truncate font-medium text-slate-200 flex-1 text-right';
      titleSpan.textContent = labelText;

      footer.appendChild(numSpan);
      footer.appendChild(titleSpan);

      card.appendChild(mediaBox);
      card.appendChild(footer);

      card.onclick = function () { goToSlide(idx); };
      gridContentEl.appendChild(card);
    });
  }

  // Build thumbnails purely with DOM APIs
  function buildThumbnails() {
    const s = window._slideViewerState;
    if (!thumbsEl) return;
    thumbsEl.textContent = ''; // safe clear

    const total = s.slides.length;
    if (total <= 1) {
      const strip = document.getElementById('sv-thumbnails-strip');
      if (strip) strip.classList.add('hidden');
      return;
    }

    const strip = document.getElementById('sv-thumbnails-strip');
    if (strip) strip.classList.remove('hidden');

    s.slides.forEach(function (slide, idx) {
      const openUrl = '/materials/' + encodeURIComponent(s.materialId) + '/resources/' + encodeURIComponent(slide._id) + '/open';
      const labelText = slide.label || (slide.file && slide.file.originalFilename) || 'Slide ' + (idx + 1);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sv-thumb-item relative flex-shrink-0 rounded-lg overflow-hidden cursor-pointer flex items-center justify-center border-2 border-slate-800 hover:border-slate-600 bg-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';
      btn.style.width = '64px';
      btn.style.height = '42px';
      btn.title = (idx + 1) + '. ' + labelText;

      const img = document.createElement('img');
      img.src = openUrl;
      img.alt = labelText;
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'contain';
      img.style.padding = '2px';
      img.loading = 'lazy';
      btn.appendChild(img);

      const idxBadge = document.createElement('span');
      idxBadge.className = 'absolute bottom-0.5 right-1 text-[9px] font-mono font-bold text-white bg-black/60 px-1 rounded';
      idxBadge.textContent = String(idx + 1);
      btn.appendChild(idxBadge);

      btn.onclick = function () { goToSlide(idx); };
      thumbsEl.appendChild(btn);
    });
  }

  // ── Render Current Slide ─────────────────────────────────────────────────

  function renderCurrentSlide(withFade) {
    const s = window._slideViewerState;
    const total = s.slides.length;
    if (total === 0) return;

    const slide = s.slides[s.currentIndex];
    const openUrl = '/materials/' + encodeURIComponent(s.materialId) + '/resources/' + encodeURIComponent(slide._id) + '/open';
    const dlUrl = openUrl + '?download=1';
    const labelText = slide.label || (slide.file && slide.file.originalFilename) || 'Slide ' + (s.currentIndex + 1);

    if (counterEl) counterEl.textContent = (s.currentIndex + 1) + ' / ' + total;
    if (titleEl) titleEl.textContent = labelText;
    if (openLinkEl) openLinkEl.href = openUrl;
    if (dlLinkEl) dlLinkEl.href = dlUrl;

    if (progressBar) {
      progressBar.style.width = total > 1 ? `${((s.currentIndex + 1) / total) * 100}%` : '100%';
    }

    const doFade = withFade && !!imageEl;
    if (doFade) {
      imageEl.style.opacity = '0';
    }

    const setContent = function () {
      if (imageEl) {
        imageEl.src = openUrl;
        imageEl.alt = labelText;
        if (doFade) {
          requestAnimationFrame(function () {
            imageEl.style.opacity = '1';
          });
        } else {
          imageEl.style.opacity = '1';
        }
      }
    };

    if (doFade) {
      setTimeout(setContent, 150);
    } else {
      setContent();
    }

    // Highlight active thumbnail
    if (thumbsEl) {
      thumbsEl.querySelectorAll('.sv-thumb-item').forEach(function (btn, idx) {
        if (idx === s.currentIndex) {
          btn.classList.add('border-brand-500', 'ring-2', 'ring-brand-500/50');
          btn.classList.remove('border-slate-800');
          btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        } else {
          btn.classList.remove('border-brand-500', 'ring-2', 'ring-brand-500/50');
          btn.classList.add('border-slate-800');
        }
      });
    }
  }

  // ── Touch / Swipe Support ────────────────────────────────────────────────

  let _touchStartX = null;
  if (stageEl) {
    stageEl.addEventListener('touchstart', function (e) {
      _touchStartX = e.touches[0].clientX;
    }, { passive: true });
    stageEl.addEventListener('touchend', function (e) {
      if (_touchStartX === null) return;
      const dx = e.changedTouches[0].clientX - _touchStartX;
      if (Math.abs(dx) > 40) {
        dx < 0 ? nextSlide() : prevSlide();
      }
      _touchStartX = null;
    }, { passive: true });
  }

  // ── Keyboard Shortcuts ───────────────────────────────────────────────────

  window.addEventListener('keydown', function (e) {
    if (!window._slideViewerState.isOpen) return;

    if (e.key === 'Escape') {
      if (shortcutsModal && !shortcutsModal.classList.contains('hidden')) {
        e.preventDefault();
        shortcutsModal.classList.add('hidden');
        return;
      }
      if (gridModal && !gridModal.classList.contains('hidden')) {
        e.preventDefault();
        gridModal.classList.add('hidden');
        return;
      }
      e.preventDefault();
      closeSlideViewer();
      return;
    }

    if (e.key === 'ArrowRight' || e.key === ' ') {
      e.preventDefault();
      nextSlide();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      prevSlide();
    } else if (e.key === 'f' || e.key === 'F') {
      toggleNativeFullscreen();
    } else if (e.key === 'g' || e.key === 'G') {
      toggleSlideGrid();
    } else if (e.key === 'p' || e.key === 'P') {
      toggleAutoPlay();
    } else if (e.key === '+' || e.key === '=') {
      zoomIn();
    } else if (e.key === '-' || e.key === '_') {
      zoomOut();
    } else if (e.key === '0') {
      resetZoom();
    } else if (e.key === '?') {
      toggleShortcutsHelp();
    }
  });

  if (typeof registerAction === 'function') {
    registerAction('toggleSlideGrid', function () { toggleSlideGrid(); });
    registerAction('toggleAutoPlay', function () { toggleAutoPlay(); });
    registerAction('toggleNativeFullscreen', function () { toggleNativeFullscreen(); });
    registerAction('toggleShortcutsHelp', function () { toggleShortcutsHelp(); });
    registerAction('closeSlideViewer', function () { closeSlideViewer(); });
    registerAction('prevSlide', function () { prevSlide(); });
    registerAction('zoomOut', function () { zoomOut(); });
    registerAction('resetZoom', function () { resetZoom(); });
    registerAction('zoomIn', function () { zoomIn(); });
    registerAction('nextSlide', function () { nextSlide(); });
    registerAction('shortcutsModalBackdropClick', function (e, el) {
      if (e.target === el) toggleShortcutsHelp();
    });
    registerAction('openSlideViewer', function (e, el) {
      var idx = Number(el.dataset.slideIndex || 0);
      openSlideViewer(idx);
    });
  }
})();

