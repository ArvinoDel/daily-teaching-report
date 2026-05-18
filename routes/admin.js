const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/adminController');
const { requireAuth }  = require('../middleware/auth');
const { requireAdmin } = require('../middleware/adminAuth');

router.use(requireAuth, requireAdmin);

// Dashboard
router.get('/', ctrl.dashboard);

// 🟢 Audit log
router.get('/audit-log', ctrl.auditLogIndex);

// Users — bulk route MUST come before /:id to avoid conflict
router.delete('/users/bulk',      ctrl.usersBulkDelete);
router.get('/users',              ctrl.usersList);
router.get('/users/:id/edit',     ctrl.userEditForm);
router.post('/users/:id',         ctrl.userUpdate);
router.delete('/users/:id',       ctrl.userDelete);

// Reports — bulk route MUST come before /:id to avoid conflict
router.delete('/reports/bulk',    ctrl.reportsBulkDelete);
router.get('/reports',            ctrl.reportsList);
router.get('/reports/:id/edit',   ctrl.reportEditForm);
router.put('/reports/:id',        ctrl.reportUpdate);
router.delete('/reports/:id',     ctrl.reportDelete);
router.get('/reports/summary', ctrl.reportsSummaryIndex);

// Commission
router.get('/commission', ctrl.commissionIndex);

module.exports = router;