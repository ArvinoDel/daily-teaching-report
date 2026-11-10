(function () {
  let materialData = { materialId: '', fileResources: [] };
  try {
    const dataEl = document.getElementById('show-material-data');
    if (dataEl && dataEl.textContent) {
      materialData = JSON.parse(dataEl.textContent);
    }
  } catch (e) {
    console.error('Failed to parse show material data', e);
  }

  const materialId = materialData.materialId || '';
  const fileResources = materialData.fileResources || [];

  if (typeof window.initSlideViewer === 'function') {
    window.initSlideViewer(materialId, fileResources);
  }
})();

