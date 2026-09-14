'use strict';
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/notificationController');

// All notification routes are protected with requireAuth when mounted in app.js
router.get('/', ctrl.index);
router.post('/mark-all-read', ctrl.markAllAsRead);
router.post('/:id/read', ctrl.markAsRead);
router.post('/:id/delete', ctrl.deleteNotification);

module.exports = router;
