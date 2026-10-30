(function () {
  'use strict';
  var dataEl = document.getElementById('student-card-data');
  var data = dataEl ? JSON.parse(dataEl.textContent || '{}') : {};

  // Render the self-referencing QR code for this card page
  var cardUrl = data.cardUrl || window.location.href;
  var qrContainer = document.getElementById('qr-container');
  if (qrContainer && typeof QRCode !== 'undefined') {
    try {
      new QRCode(qrContainer, {
        text:         cardUrl,
        width:        160,
        height:       160,
        colorDark:    '#1e1b4b',
        colorLight:   '#f8fafc',
        correctLevel: QRCode.CorrectLevel.M,
      });
    } catch (e) {
      qrContainer.innerHTML =
        '<p style="font-size:11px;color:#94a3b8;text-align:center;padding:16px;">QR unavailable</p>';
    }
  }

  // Assign gradient avatar color based on first character
  var firstChar = (data.firstChar || '?').toUpperCase();
  var hue = (firstChar.charCodeAt(0) * 37) % 360;
  var avatar = document.getElementById('student-avatar');
  if (avatar) {
    avatar.style.background = 'linear-gradient(135deg, hsl(' + hue + ',65%,58%), hsl(' + (hue + 30) + ',75%,38%))';
  }
})();

