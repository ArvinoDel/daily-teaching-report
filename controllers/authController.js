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
      profilePicture: user.profilePicture || null,
    };

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
exports.logout = (req, res) => {
  req.session.destroy(() => res.redirect('/auth/login'));
};

// GET /auth/register
exports.registerForm = (req, res) => {
  const currentYear = new Date().getFullYear();
  res.render('auth/register', { error: null, success: null, currentYear });
};

// POST /auth/register
exports.register = async (req, res) => {
  const currentYear = new Date().getFullYear();

  try {
    const { username, password, displayName, joinMonth, joinYear } = req.body;

    if (!username || !password || !displayName) {
      return res.render('auth/register', {
        error: 'Please fill in all fields.', success: null, currentYear,
      });
    }

    // Parse join date
    let joinDate = null;
    if (joinMonth && joinYear) {
      const m = parseInt(joinMonth);
      const y = parseInt(joinYear);
      if (m >= 1 && m <= 12 && y >= 1970 && y <= currentYear) {
        joinDate = new Date(y, m - 1, 1);
        // Clamp to not be in the future
        if (joinDate > new Date()) joinDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      }
    }

    const exists = await User.findOne({ username: username.toLowerCase().trim() });
    if (exists) {
      return res.render('auth/register', {
        error: 'Username already taken.', success: null, currentYear,
      });
    }

    await User.create({ username, password, displayName, joinDate });
    res.render('auth/register', {
      error: null,
      success: 'Account created! You can now log in.',
      currentYear,
    });
  } catch (err) {
    const msg = err.errors
      ? Object.values(err.errors).map(e => e.message).join(' ')
      : 'Something went wrong.';
    res.render('auth/register', { error: msg, success: null, currentYear });
  }
};