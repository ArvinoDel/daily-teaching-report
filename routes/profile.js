const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/profileController');
const upload = require('../middleware/upload');

router.get('/edit', ctrl.editForm);
router.post('/edit', upload.single('profilePicture'), ctrl.update);

module.exports = router;
