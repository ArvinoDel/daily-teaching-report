(function () {
  'use strict';
  const moreBtn = document.getElementById('admin-more-btn');
  const moreMenu = document.getElementById('admin-more-menu');
  if (moreBtn && moreMenu) {
    moreBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      const willOpen = moreMenu.classList.contains('hidden');
      moreMenu.classList.toggle('hidden');
      moreBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });

    document.addEventListener('click', function (e) {
      if (!moreMenu.contains(e.target) && !moreBtn.contains(e.target)) {
        moreMenu.classList.add('hidden');
        moreBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }
})();
