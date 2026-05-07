const permissionMiddleware = (permission) => {
  return (req, res, next) => {
    if (!req.user || !req.user.permissions) {
      return res.status(403).json({ error: 'Access denied: No permissions' });
    }

    if (!req.user.permissions.includes(permission)) {
      return res.status(403).json({ error: `Access denied: Requires ${permission}` });
    }

    next();
  };
};

export default permissionMiddleware;