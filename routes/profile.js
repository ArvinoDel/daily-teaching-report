const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/profileController');
const upload = require('../middleware/upload');
const { verifyCsrf } = require('../middleware/csrf');

router.get('/edit', ctrl.editForm);
router.post('/edit', upload.single('profilePicture'), verifyCsrf, ctrl.update);

module.exports = router;
