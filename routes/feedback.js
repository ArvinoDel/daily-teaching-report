const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/feedbackController');
const uploadFeedback = require('../middleware/uploadFeedback');
const { verifyCsrf } = require('../middleware/csrf');

router.post('/', uploadFeedback.single('screenshot'), verifyCsrf, ctrl.submitFeedback);

module.exports = router;
