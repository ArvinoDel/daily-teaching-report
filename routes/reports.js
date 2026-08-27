const express = require('express');
const router = express.Router();
const ctrl        = require('../controllers/reportsController');
const crosscheck  = require('../controllers/rewardCrosscheckController');

router.get('/', ctrl.index);
router.get('/new', ctrl.newForm);
router.post('/', ctrl.create);
router.get('/export', ctrl.exportExcel);

// Reward crosscheck routes (must be before /:id wildcard)
router.get('/reward-crosscheck',         crosscheck.renderPage);
router.get('/api/daily-summary',         crosscheck.getMonthReportsApi);
router.post('/api/analyze-sheet',        crosscheck.analyzeSheet);

router.get('/:id', ctrl.show);
router.get('/:id/edit', ctrl.editForm);
router.put('/:id', ctrl.update);
router.delete('/:id', ctrl.destroy);

module.exports = router;
