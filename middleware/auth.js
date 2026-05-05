exports.requireAuth = (req, res, next) => {
  if (req.session && req.session.user) return next();
  // [FIX] Only store internal paths to prevent open redirect attacks
  const returnTo = req.originalUrl;
  if (returnTo.startsWith('/') && !returnTo.startsWith('//')) {
    req.session.returnTo = returnTo;
  }
  res.redirect('/auth/login');
};

exports.redirectIfAuth = (req, res, next) => {
  if (req.session && req.session.user) return res.redirect('/reports');
  next();
};