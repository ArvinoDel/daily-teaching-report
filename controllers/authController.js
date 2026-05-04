const User = require('../models/User');

// GET /auth/login
exports.loginForm = (req, res) => {
  res.render('auth/login', { error: null });
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

    req.session.user = {
      _id: user._id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
    };

    const returnTo = req.session.returnTo || '/reports';
    delete req.session.returnTo;
    res.redirect(returnTo);
  } catch (err) {
    console.error(err);
    res.render('auth/login', { error: 'Something went wrong. Please try again.' });
  }
};

// POST /auth/logout
exports.logout = (req, res) => {
  req.session.destroy(() => res.redirect('/auth/login'));
};

// GET /auth/register  (first-time setup / admin only)
exports.registerForm = (req, res) => {
  res.render('auth/register', { error: null, success: null });
};

// POST /auth/register
exports.register = async (req, res) => {
  try {
    const { username, password, displayName } = req.body;
    if (!username || !password || !displayName) {
      return res.render('auth/register', { error: 'Please fill in all fields.', success: null });
    }

    const exists = await User.findOne({ username: username.toLowerCase().trim() });
    if (exists) {
      return res.render('auth/register', { error: 'Username already taken.', success: null });
    }

    await User.create({ username, password, displayName });
    res.render('auth/register', { error: null, success: 'Account created! You can now log in.' });
  } catch (err) {
    const msg = err.errors
      ? Object.values(err.errors).map(e => e.message).join(' ')
      : 'Something went wrong.';
    res.render('auth/register', { error: msg, success: null });
  }
};