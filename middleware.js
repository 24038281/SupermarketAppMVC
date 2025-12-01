// Primary admin is identified by email (configurable via env). Default is now sam@gmail.com.
const PRIMARY_ADMIN_EMAIL = (process.env.PRIMARY_ADMIN_EMAIL || 'sam@gmail.com').trim().toLowerCase();

function attachLocals(req, res, next) {
  res.locals.user = req.session.user || null;
  const email = (req.session.user && req.session.user.email ? req.session.user.email : '').trim().toLowerCase();
  res.locals.isPrimaryAdmin = !!email && email === PRIMARY_ADMIN_EMAIL;
  res.locals.navTheme = res.locals.isPrimaryAdmin ? 'admin' : 'user';
  res.locals.success_msg = req.flash('success');
  res.locals.error_msg = req.flash('error');
  res.locals.loyaltyRedemption = req.session.loyaltyRedemption || null;
  next();
}

function checkAuthenticated(req, res, next) {
  if (req.session.user) return next();
  req.flash('error', 'Please log in to view this resource');
  res.redirect('/login');
}

function checkAdmin(req, res, next) {
  const user = req.session.user;
  const email = (user && user.email ? user.email : '').trim().toLowerCase();
  const isPrimaryAdmin = email === PRIMARY_ADMIN_EMAIL;
  if (user && isPrimaryAdmin) {
    req.session.user.role = 'admin';
    req.session.user.isPrimaryAdmin = true;
    return next();
  }
  req.flash('error', 'Access denied (primary admin only)');
  res.redirect('/shopping');
}

module.exports = { attachLocals, checkAuthenticated, checkAdmin };
