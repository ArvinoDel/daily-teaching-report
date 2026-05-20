exports.requireAdmin = (req, res, next) => {
  if (req.session && req.session.user && (req.session.user.role === 'admin' || req.session.user.role === 'superadmin')) {
    return next();
  }
  return res.status(403).render('error', { message: 'Access denied. Admins only.' });
};

exports.requireSuperAdmin = (req, res, next) => {
  if (req.session && req.session.user && req.session.user.role === 'superadmin') {
    return next();
  }
  return res.status(403).render('error', { message: 'Access denied. Superadmins only.' });
};