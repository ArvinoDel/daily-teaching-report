'use strict';
const express = require('express');
const router  = express.Router();
const cronController = require('../controllers/cronController');

router.get('/backup', cronController.cronBackup);

module.exports = router;
