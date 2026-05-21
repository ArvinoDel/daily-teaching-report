const express    = require('express');
const router     = express.Router();
const ctrl       = require('../controllers/adminController');
const groupCtrl  = require('../controllers/adminGroupController');
const feedbackCtrl = require('../controllers/feedbackController');
const { requireAuth }  = require('../middleware/auth');
const { requireAdmin, requireSuperAdmin } = require('../middleware/adminAuth');

router.use(requireAuth, requireAdmin);

// Dashboard
router.get('/', ctrl.dashboard);

// Audit log
router.get('/audit-log', ctrl.auditLogIndex);

// Users — bulk BEFORE /:id to avoid route conflict
router.delete('/users/bulk',      ctrl.usersBulkDelete);
router.get('/users',              ctrl.usersList);
router.get('/users/:id/edit',     ctrl.userEditForm);
router.post('/users/:id',         ctrl.userUpdate);
router.delete('/users/:id',       ctrl.userDelete);

// Reports — bulk + named routes BEFORE /:id
router.delete('/reports/bulk',    ctrl.reportsBulkDelete);
router.get('/reports',            ctrl.reportsList);
router.get('/reports/summary',    ctrl.reportsSummaryIndex); // 🔧 moved above /:id/edit
router.get('/reports/:id/edit',   ctrl.reportEditForm);
router.put('/reports/:id',        ctrl.reportUpdate);
router.delete('/reports/:id',     ctrl.reportDelete);

// Groups — bulk + named routes BEFORE /:id
router.delete('/groups/bulk',     groupCtrl.groupsBulkDelete);
router.get('/groups',             groupCtrl.groupsList);
router.get('/groups/new',         groupCtrl.groupNewForm);
router.post('/groups',            groupCtrl.groupCreate);
router.get('/groups/:id/edit',    groupCtrl.groupEditForm);
router.post('/groups/:id',        groupCtrl.groupUpdate);
router.delete('/groups/:id',      groupCtrl.groupDelete);

// Commission
router.get('/commission', ctrl.commissionIndex);

// Feedbacks
router.get('/feedbacks',              requireSuperAdmin, feedbackCtrl.adminList);
router.post('/feedbacks/:id/status',  requireSuperAdmin, feedbackCtrl.adminUpdateStatus);
router.delete('/feedbacks/:id',       requireSuperAdmin, feedbackCtrl.adminDelete);

const backupCtrl = require('../controllers/adminBackupController');

// Backups — superadmin only
router.get('/backups',              requireSuperAdmin, backupCtrl.backupsList);
router.post('/backups',             requireSuperAdmin, backupCtrl.createBackup);
router.get('/backups/:id/download', requireSuperAdmin, backupCtrl.downloadBackup);
router.delete('/backups/:id',       requireSuperAdmin, backupCtrl.deleteBackup);
module.exports = router;