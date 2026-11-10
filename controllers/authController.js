'use strict';

const User = require('../models/User');
const notificationService = require('../services/notificationService');
const {
  canLogin,
  activeUserFilter,
  decideRegistration,
} = require('../services/userAccountService');

// GET /auth/login
exports.loginForm = (req, res) => {
  const flash = req.query.flash || (req.session && req.session.flash) || null;
  if (req.session && req.session.flash) {
    delete req.session.flash;
  }
  res.render('auth/login', { error: flash });
};

// POST /auth/login
exports.login = async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.render('auth/login', { error: 'Please fill in all fields.' });
    }

    const user = await User.findOne({ username: username.toLowerCase().trim() });
    if (!user) {
      return res.render('auth/login', { error: 'Invalid username or password.' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.render('auth/login', { error: 'Invalid username or password.' });
    }

    // Check account status ONLY after password is verified
    const loginStatus = canLogin(user);
    if (!loginStatus.ok) {
      return res.render('auth/login', { error: loginStatus.message });
    }

    // Update lastActiveAt immediately on login
    const loginNow = new Date();
    await User.findByIdAndUpdate(user._id, { lastActiveAt: loginNow });

    req.session.user = {
      _id: user._id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      profilePicture: user.profilePicture || null,
    };
    req.session._lastTracked = loginNow.getTime();

    // Validate returnTo to prevent open redirect
    const returnTo = req.session.returnTo;
    const safeReturnTo = (returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//'))
      ? returnTo
      : '/reports';
    delete req.session.returnTo;
    res.redirect(safeReturnTo);
  } catch (err) {
    console.error(err);
    res.render('auth/login', { error: 'Something went wrong. Please try again.' });
  }
};

// POST /auth/logout
exports.logout = async (req, res) => {
  try {
    if (req.session && req.session.user) {
      await User.findByIdAndUpdate(req.session.user._id, { lastActiveAt: null });
    }
  } catch (err) {
    console.error('[auth] Failed to clear lastActiveAt on logout:', err);
  }
  req.session.destroy(() => res.redirect('/auth/login'));
};

// GET /auth/heartbeat - Keepalive ping for online presence
exports.heartbeat = (req, res) => {
  const isOnline = !!(req.session && req.session.user);
  const unreadCount = isOnline ? (res.locals.unreadNotificationCount || 0) : 0;
  res.status(200).json({ ok: true, isOnline, unreadCount });
};

// GET /auth/pending
exports.pendingNotice = (req, res) => {
  res.render('auth/pending');
};

// GET /auth/register
exports.registerForm = async (req, res) => {
  const currentYear = new Date().getFullYear();
  try {
    const pendingCount = await User.countDocuments({ accountStatus: 'pending' });
    const decision = decideRegistration({
      mode: process.env.REGISTRATION_MODE,
      pendingCount,
    });
    if (!decision.allowed) {
      return res.render('auth/register', {
        error: decision.error,
        success: null,
        currentYear,
        registrationClosed: decision.code === 'closed',
      });
    }
    res.render('auth/register', {
      error: null,
      success: null,
      currentYear,
      registrationClosed: false,
    });
  } catch (err) {
    console.error('[auth] registerForm error:', err);
    res.render('auth/register', {
      error: null,
      success: null,
      currentYear,
      registrationClosed: false,
    });
  }
};

// POST /auth/register
exports.register = async (req, res) => {
  const currentYear = new Date().getFullYear();

  try {
    const pendingCount = await User.countDocuments({ accountStatus: 'pending' });
    const decision = decideRegistration({
      mode: process.env.REGISTRATION_MODE,
      pendingCount,
    });
    if (!decision.allowed) {
      return res.render('auth/register', {
        error: decision.error,
        success: null,
        currentYear,
        registrationClosed: decision.code === 'closed',
      });
    }

    const { username, password, displayName, joinMonth, joinYear } = req.body;

    if (!username || !password || !displayName) {
      return res.render('auth/register', {
        error: 'Please fill in all fields.',
        success: null,
        currentYear,
        registrationClosed: false,
      });
    }

    // Parse join date
    let joinDate = null;
    if (joinMonth && joinYear) {
      const m = parseInt(joinMonth, 10);
      const y = parseInt(joinYear, 10);
      if (m >= 1 && m <= 12 && y >= 1970 && y <= currentYear) {
        joinDate = new Date(y, m - 1, 1);
        // Clamp to not be in the future
        if (joinDate > new Date()) {
          joinDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
        }
      }
    }

    const exists = await User.findOne({ username: username.toLowerCase().trim() });
    if (exists) {
      return res.render('auth/register', {
        error: 'Username already taken.',
        success: null,
        currentYear,
        registrationClosed: false,
      });
    }

    const cleanDisplayName = String(displayName).replace(/[\r\n\t]/g, ' ').trim().slice(0, 50);

    const newUser = await User.create({
      username: username.toLowerCase().trim(),
      password,
      displayName: cleanDisplayName,
      role: 'teacher', // strictly teacher (ignore any role in request)
      accountStatus: 'pending', // pending approval
      joinDate,
      lastActiveAt: null,
      onboarding: {
        version: 1,
        legacy: false,
        startedAt: null, // Starts on approval
        dismissedAt: null,
        completedAt: null,
      },
    });

    // Notify all active admins and superadmins
    try {
      const admins = await User.find(activeUserFilter({ role: { $in: ['admin', 'superadmin'] } })).select('_id');
      const safeTextName = cleanDisplayName.replace(/<[^>]*>/g, '').trim().slice(0, 40) || 'New teacher';
      for (const a of admins) {
        notificationService.sendNotification({
          recipient: a._id,
          category: 'system',
          type: 'registration_pending',
          title: 'New teacher registration',
          message: `${safeTextName} asked for an account.`,
          link: '/admin/users?status=pending',
          metadata: { userId: newUser._id, username: newUser.username },
        }).catch(e => console.error('[auth] Failed to notify admin of pending registration:', e.message));
      }
    } catch (notifErr) {
      console.error('[auth] Error notifying admins of pending registration:', notifErr.message);
    }

    // Redirect to /auth/pending (user is NOT logged in, no session created)
    return res.redirect('/auth/pending');
  } catch (err) {
    const msg = err.errors
      ? Object.values(err.errors).map(e => e.message).join(' ')
      : 'Something went wrong.';
    res.render('auth/register', {
      error: msg,
      success: null,
      currentYear,
      registrationClosed: false,
    });
  }
};
