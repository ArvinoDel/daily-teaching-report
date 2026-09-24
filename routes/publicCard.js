const express  = require('express');
const router   = express.Router();
const cardCtrl = require('../controllers/publicStudentCardController');

// Full URL: /student-card/:barcode
router.get('/student-card/:barcode', cardCtrl.viewCard);

// Short alias: /c/:barcode (encodes to shorter QR)
router.get('/c/:barcode', cardCtrl.viewCard);

module.exports = router;
