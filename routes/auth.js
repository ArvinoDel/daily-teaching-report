const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/authController');
const { redirectIfAuth } = require('../middleware/auth');

router.get('/login', redirectIfAuth, ctrl.loginForm);
router.post('/login', redirectIfAuth, ctrl.login);
router.post('/logout', ctrl.logout);
router.get('/register', ctrl.registerForm);
router.post('/register', ctrl.register);

module.exports = router;