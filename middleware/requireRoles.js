const requireRoles = (...allowedRoles) => {
  return (req, res, next) => {
    const actor = req.admin || req.user;
    const roles = actor?.roles || [];

    const hasAccess = roles.some((role) => allowedRoles.includes(role));
    if (!hasAccess) {
      return res.status(403).json({ message: 'Bạn không có quyền truy cập tài nguyên này.' });
    }

    next();
  };
};

module.exports = requireRoles;
