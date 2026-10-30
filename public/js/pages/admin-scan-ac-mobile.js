function getCsrfToken() {
  var m = document.querySelector('meta[name="csrf-token"]');
  return m ? m.getAttribute('content') : '';
}

(function () {
  'use strict';

  /* ══════════════════════════════════════════════════════════
     State machine:
       idle → loading → student → idle (loop)
                      → error   → idle
     Scanner engines: native BarcodeDetector (primary) → ZXing (fallback)
  ═════════════════════════════════════════════════════════════ */

  var currentBarcode   = null;
  var sessionCount     = 0;
  var stream           = null;      // active MediaStream
  var scannerEngine    = null;      // 'native' | 'zxing'
  var zxingReader      = null;      // ZXing instance (if used)
  var nativeDetector   = null;      // BarcodeDetector instance (if used)
  var rafId            = null;      // requestAnimationFrame loop ID
  var isScanning       = false;
  var facingMode       = 'environment'; // 'environment' (rear) | 'user' (front)

  /* ── DOM refs ── */
  var video       = document.getElementById('camera-video');
  var scanBadge   = document.getElementById('scan-badge');
  var scanFlash   = document.getElementById('scan-flash');
  var stateIdle   = document.getElementById('state-idle');
  var stateLoad   = document.getElementById('state-loading');
  var stateStud   = document.getElementById('state-student');
  var stateErr    = document.getElementById('state-error');
  var errMsg      = document.getElementById('error-msg');
  var sAvatar     = document.getElementById('s-avatar');
  var sName       = document.getElementById('s-name');
  var sGrade      = document.getElementById('s-grade');
  var sTotal      = document.getElementById('s-total');
  var btnAdd      = document.getElementById('btn-add');
  var btnReduce   = document.getElementById('btn-reduce');
  var btnNext     = document.getElementById('btn-scan-next');
  var sessionTot  = document.getElementById('session-total');
  var timerProgressBar = document.getElementById('timer-progress-bar');
  var countdownSecs    = document.getElementById('countdown-secs');
  var camError    = document.getElementById('cam-error');
  var camOverlay  = document.getElementById('cam-start-overlay');
  var toast       = document.getElementById('toast');
  var manualDrawer      = document.getElementById('manual-drawer');
  var manualInput       = document.getElementById('manual-barcode-input');
  var btnManualSubmit   = document.getElementById('btn-manual-submit');
  var btnManualCancel   = document.getElementById('btn-manual-cancel');
  var btnManualOpen     = document.getElementById('btn-manual-open');
  var btnFlip           = document.getElementById('btn-flip-camera');
  var btnStartCamera    = document.getElementById('btn-start-camera');

  /* ══════════════════════════════════════════════════════════
     PHASE 1 — Secure Context Check
  ══════════════════════════════════════════════════════════ */
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    showCamError(
      'Camera access requires a secure connection (HTTPS). ' +
      'Please open this page via your Vercel URL, not a local IP address.'
    );
  } else {
    boot();
  }

  /* ══════════════════════════════════════════════════════════
     PHASE 2 — Constraint-Based Camera Stream
  ══════════════════════════════════════════════════════════ */
  function boot() {
    // Some browsers need a user gesture to start camera; show overlay as safety net
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showCamError('Your browser does not support camera access. Try Chrome or Safari.');
      return;
    }
    startCamera();
  }

  function startCamera() {
    if (stream) stopStream();

    var constraints = {
      video: {
        facingMode: { ideal: facingMode },
        width:  { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    };

    navigator.mediaDevices.getUserMedia(constraints)
      .then(function (s) {
        stream = s;
        video.srcObject = s;
        video.setAttribute('playsinline', '');
        video.setAttribute('webkit-playsinline', '');
        return video.play();
      })
      .then(function () {
        // Hide start overlay if it was shown
        camOverlay.style.display = 'none';
        startScanEngine();
      })
      .catch(function (err) {
        console.error('getUserMedia error:', err);
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          // Show activation overlay instead of error — user may need to tap
          camOverlay.style.display = 'flex';
        } else if (err.name === 'NotFoundError') {
          showCamError('No camera found on this device.');
        } else {
          showCamError('Camera error: ' + err.message);
        }
      });
  }

  function stopStream() {
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
    video.srcObject = null;
  }

  /* Camera flip */
  btnFlip.addEventListener('click', function () {
    facingMode = facingMode === 'environment' ? 'user' : 'environment';
    stopScanEngine();
    startCamera();
  });

  /* Manual start button (user activation fallback) */
  btnStartCamera.addEventListener('click', function () {
    camOverlay.style.display = 'none';
    startCamera();
  });

  /* ══════════════════════════════════════════════════════════
     PHASE 3 — Hybrid Scanner Engine
  ══════════════════════════════════════════════════════════ */
  function startScanEngine() {
    isScanning = true;
    scanBadge.textContent = 'Scanning…';
    scanBadge.style.background = '#6366f1';

    // Primary: native hardware BarcodeDetector (Android Chrome, Edge, Opera)
    if (window.BarcodeDetector && typeof BarcodeDetector !== 'undefined') {
      BarcodeDetector.getSupportedFormats().then(function (formats) {
        var supported = formats.includes('code_128') || formats.includes('CODE_128');
        if (supported || formats.length > 0) {
          scannerEngine = 'native';
          nativeDetector = new BarcodeDetector({
            formats: ['code_128', 'qr_code', 'code_39', 'ean_13', 'ean_8'].filter(function (f) {
              return formats.includes(f);
            })
          });
          runNativeLoop();
        } else {
          startZxing();
        }
      }).catch(function () {
        startZxing();
      });
    } else {
      startZxing();
    }
  }

  /* ── Native BarcodeDetector loop via requestAnimationFrame ── */
  function runNativeLoop() {
    if (!isScanning) return;
    if (video.readyState < 2) {
      rafId = requestAnimationFrame(runNativeLoop);
      return;
    }
    nativeDetector.detect(video).then(function (barcodes) {
      if (!isScanning) return;
      if (barcodes && barcodes.length > 0) {
        var barcode = barcodes[0].rawValue;
        if (barcode && barcode !== currentBarcode && !isCooldown(barcode)) {
          onBarcodeDetected(barcode);
        }
      }
      rafId = requestAnimationFrame(runNativeLoop);
    }).catch(function () {
      rafId = requestAnimationFrame(runNativeLoop);
    });
  }

  /* ── ZXing fallback (iOS Safari, Firefox) ── */
  function startZxing() {
    if (typeof ZXing === 'undefined') {
      showCamError('Scanner library failed to load. Check your internet connection.');
      return;
    }
    scannerEngine = 'zxing';
    // Create a fresh reader every time to avoid double-loop error
    if (zxingReader) {
      try { zxingReader.reset(); } catch(e) {}
    }
    zxingReader = new ZXing.BrowserMultiFormatReader();

    // Get active deviceId from stream directly — avoids pre-enumeration on iOS
    var videoTrack = stream && stream.getVideoTracks()[0];
    var deviceId = videoTrack ? videoTrack.getSettings().deviceId : undefined;

    zxingReader.decodeFromVideoDevice(deviceId || null, video, function (result) {
      if (!isScanning) return;
      if (result) {
        var barcode = result.getText();
        if (barcode && barcode !== currentBarcode && !isCooldown(barcode)) {
          onBarcodeDetected(barcode);
        }
      }
    });
  }

  /* ── Stop whichever engine is running ── */
  function stopScanEngine() {
    isScanning = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (zxingReader) {
      try { zxingReader.reset(); } catch(e) {}
    }
    scanBadge.textContent = 'Paused';
    scanBadge.style.background = '#475569';
  }

  /* ── Restart engine (called on resetToIdle) ── */
  function resumeScanEngine() {
    isScanning = true;
    scanBadge.textContent = 'Scanning…';
    scanBadge.style.background = '#6366f1';
    if (scannerEngine === 'native') {
      if (!rafId) runNativeLoop();
    } else {
      startZxing();
    }
  }

  /* ══════════════════════════════════════════════════════════
     Inactivity Timer (15s auto-refresh on idle)
  ══════════════════════════════════════════════════════════ */
  var INACTIVITY_SECONDS = 15;
  var inactivityTimer    = null;
  var countdownInterval  = null;
  var secondsLeft        = INACTIVITY_SECONDS;

  function startInactivityTimer() {
    clearInactivityTimer();
    secondsLeft = INACTIVITY_SECONDS;
    updateTimerUI();

    countdownInterval = setInterval(function () {
      secondsLeft--;
      if (secondsLeft <= 0) {
        secondsLeft = 0;
        updateTimerUI();
        clearInactivityTimer();
        resetToIdle();
        return;
      }
      updateTimerUI();
    }, 1000);

    inactivityTimer = setTimeout(function () {
      resetToIdle();
    }, INACTIVITY_SECONDS * 1000);
  }

  function resetInactivityTimer() {
    if (stateStud.style.display !== 'none') {
      startInactivityTimer();
    }
  }

  function clearInactivityTimer() {
    if (inactivityTimer)   { clearTimeout(inactivityTimer);   inactivityTimer = null; }
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    if (timerProgressBar)  { timerProgressBar.style.width = '100%'; }
  }

  function updateTimerUI() {
    if (countdownSecs) {
      countdownSecs.textContent = secondsLeft + 's';
    }
    if (timerProgressBar) {
      var pct = Math.max(0, Math.min(100, (secondsLeft / INACTIVITY_SECONDS) * 100));
      timerProgressBar.style.width = pct + '%';
    }
  }

  /* ══════════════════════════════════════════════════════════
     Cooldown (prevents instant re-trigger of same card on timeout)
  ══════════════════════════════════════════════════════════ */
  var lastDismissedBarcode = null;
  var lastDismissedTime    = 0;

  function setCooldown(barcode) {
    lastDismissedBarcode = barcode;
    lastDismissedTime    = Date.now();
  }

  function isCooldown(barcode) {
    if (!lastDismissedBarcode) return false;
    if (barcode === lastDismissedBarcode && (Date.now() - lastDismissedTime < 2500)) {
      return true;
    }
    return false;
  }

  /* ── Extract barcode from raw scan value (handles QR URLs & raw codes) ── */
  function extractBarcode(raw) {
    if (!raw) return '';
    raw = raw.trim();
    // If it looks like a URL (http:// or https://), try to extract the barcode from path
    if (/^https?:\/\//i.test(raw)) {
      try {
        var url  = new URL(raw);
        var path = url.pathname; // e.g. /student-card/AC12345 or /c/AC12345
        var match = path.match(/\/(?:student-card|c)\/([^\/]+)/i);
        if (match && match[1]) {
          return decodeURIComponent(match[1]);
        }
      } catch (e) { /* not a valid URL, fall through */ }
    }
    return raw;
  }

  /* ══════════════════════════════════════════════════════════
     PHASE 3 — Barcode Detected Handler
  ══════════════════════════════════════════════════════════ */
  var currentLookupId = 0;

  function onBarcodeDetected(raw) {
    if (!raw) return;
    var barcode = extractBarcode(raw);
    if (!barcode) return;
    if (barcode === currentBarcode) return;
    if (isCooldown(barcode)) return;

    // Directly switch to the new barcode, don't get stuck on the first one
    currentBarcode = barcode;
    clearInactivityTimer();

    var thisLookupId = ++currentLookupId;
    setState('loading');
    scanBadge.textContent = 'Scanning…';
    scanBadge.style.background = '#6366f1';

    // Haptic feedback
    if (navigator.vibrate) navigator.vibrate(80);

    // Visual flash on viewfinder
    scanFlash.classList.remove('flash');
    void scanFlash.offsetWidth; // reflow to restart animation
    scanFlash.classList.add('flash');

    // Audio beep (Web Audio API)
    playBeep();

    fetch('/admin/scan-ac/lookup?barcode=' + encodeURIComponent(barcode))
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (thisLookupId !== currentLookupId) return; // Stale lookup from previous barcode
        if (!res.ok) {
          showError(res.error || 'Student not found. Barcode: ' + barcode);
          return;
        }
        renderStudent(res.student);
        startInactivityTimer();
      })
      .catch(function () {
        if (thisLookupId !== currentLookupId) return;
        showError('Network error. Check connection and try again.');
      });
  }

  /* ══════════════════════════════════════════════════════════
     PHASE 4 — Web Audio Beep
  ══════════════════════════════════════════════════════════ */
  function playBeep() {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = 1200;
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.15);
    } catch (e) { /* audio not critical */ }
  }

  /* ── Render student card ── */
  function renderStudent(s) {
    sAvatar.textContent = (s.full_name || '?').charAt(0).toUpperCase();
    sName.textContent   = s.full_name || '—';
    sGrade.textContent  = s.grade_school || '';
    sTotal.textContent  = s.acTotal || 0;
    setState('student');
    scanBadge.textContent = 'Scanning…';
    scanBadge.style.background = '#6366f1';
  }

  /* ══════════════════════════════════════════════════════════
     Transact
  ══════════════════════════════════════════════════════════ */
  btnAdd.addEventListener('click',    function () { resetInactivityTimer(); doTransact('add');    });
  btnReduce.addEventListener('click', function () { resetInactivityTimer(); doTransact('reduce'); });
  btnNext.addEventListener('click',   function () { resetToIdle(); });

  // Any user interaction on student sheet resets inactivity timer
  stateStud.addEventListener('pointerdown', function () {
    resetInactivityTimer();
  });

  function doTransact(type) {
    if (!currentBarcode) return;
    var txBarcode = currentBarcode;
    resetInactivityTimer();
    btnAdd.disabled    = true;
    btnReduce.disabled = true;

    var body = 'barcode=' + encodeURIComponent(txBarcode) +
               '&type=' + type +
               '&_csrf=' + encodeURIComponent(getCsrfToken());

    fetch('/admin/scan-ac/transact', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-csrf-token': getCsrfToken(),
      },
      body: body,
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        btnAdd.disabled    = false;
        btnReduce.disabled = false;
        if (!res.ok) { showToast('⚠️ ' + (res.error || 'Failed')); return; }
        sessionCount++;
        sessionTot.textContent = sessionCount;
        var delta = type === 'add' ? '+1 AC ✓' : '−1 AC ✓';
        var color = type === 'add' ? '#34d399' : '#fca5a5';
        showToast(delta, color);
        if (currentBarcode === txBarcode) {
          sTotal.textContent = res.acTotal;
          resetInactivityTimer();
        }
      })
      .catch(function () {
        btnAdd.disabled    = false;
        btnReduce.disabled = false;
        showToast('⚠️ Network error');
        if (currentBarcode === txBarcode) {
          resetInactivityTimer();
        }
      });
  }

  /* ══════════════════════════════════════════════════════════
     PHASE 4 — Manual Barcode Input Drawer
  ══════════════════════════════════════════════════════════ */
  btnManualOpen.addEventListener('click', function () {
    manualDrawer.classList.add('open');
    setTimeout(function () { manualInput.focus(); }, 150);
  });
  btnManualCancel.addEventListener('click', function () {
    manualDrawer.classList.remove('open');
    manualInput.value = '';
  });
  btnManualSubmit.addEventListener('click', function () {
    var code = manualInput.value.trim().toUpperCase();
    if (!code) return;
    manualDrawer.classList.remove('open');
    manualInput.value = '';
    lastDismissedBarcode = null;
    currentBarcode = null;
    onBarcodeDetected(code);
  });
  manualInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') btnManualSubmit.click();
  });

  /* ══════════════════════════════════════════════════════════
     State machine helpers
  ══════════════════════════════════════════════════════════ */
  window.resetToIdle = function () {
    clearInactivityTimer();
    if (currentBarcode) {
      setCooldown(currentBarcode);
      currentBarcode = null;
    }
    setState('idle');
    scanBadge.textContent = 'Scanning…';
    scanBadge.style.background = '#6366f1';
    if (!isScanning) {
      resumeScanEngine();
    }
  };

  function setState(s) {
    stateIdle.style.display  = s === 'idle'    ? 'flex'  : 'none';
    stateLoad.style.display  = s === 'loading' ? 'flex'  : 'none';
    stateStud.style.display  = s === 'student' ? 'block' : 'none';
    stateErr.style.display   = s === 'error'   ? 'flex'  : 'none';
  }

  function showError(msg) {
    clearInactivityTimer();
    errMsg.textContent = msg;
    setState('error');
    scanBadge.textContent = 'Not Found';
    scanBadge.style.background = '#ef4444';
    // Auto-resume scanning after 3s on error if no other scan occurred
    var errLookupId = currentLookupId;
    setTimeout(function () {
      if (errLookupId === currentLookupId && stateErr.style.display !== 'none') {
        resetToIdle();
      }
    }, 3000);
  }

  function showCamError(msg) {
    camError.querySelector('p').textContent = msg;
    camError.style.display = 'flex';
  }

  /* ── Toast ── */
  var toastTimer;
  function showToast(msg, color) {
    clearTimeout(toastTimer);
    toast.textContent = msg;
    toast.style.color = color || '#f1f5f9';
    toast.classList.add('show');
    toastTimer = setTimeout(function () { toast.classList.remove('show'); }, 2000);
  }

  /* ── Cleanup on page hide (free camera) ── */
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      stopScanEngine();
      stopStream();
    } else if (document.visibilityState === 'visible' && !currentBarcode) {
      startCamera();
    }
  });

})();
