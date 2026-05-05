const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/authController');
const { redirectIfAuth } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

// [FIX] Rate limit register to prevent account flooding
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: 'Too many registration attempts, please try again later.',
});

router.get('/login', redirectIfAuth, ctrl.loginForm);
router.post('/login', redirectIfAuth, ctrl.login);
router.post('/logout', ctrl.logout);
router.get('/register', ctrl.registerForm);
router.post('/register', registerLimiter, ctrl.register);

module.exports = router;