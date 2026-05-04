exports.requireAuth = (req, res, next) => {
  if (req.session && req.session.user) return next();
  req.session.returnTo = req.originalUrl;
  res.redirect('/auth/login');
};

exports.redirectIfAuth = (req, res, next) => {
  if (req.session && req.session.user) return res.redirect('/reports');
  next();
};