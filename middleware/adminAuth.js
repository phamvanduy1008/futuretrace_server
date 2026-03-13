const jwt = require('jsonwebtoken');

const adminAuth = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Không có token xác thực admin.' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.audience !== 'admin') {
      return res.status(403).json({ message: 'Token này không được cấp cho admin.' });
    }

    req.admin = {
      userId: decoded.userId,
      email: decoded.email,
      roles: decoded.roles || [],
      audience: decoded.audience,
    };

    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token admin đã hết hạn.', code: 'TOKEN_EXPIRED' });
    }

    return res.status(401).json({ message: 'Token admin không hợp lệ.' });
  }
};

module.exports = adminAuth;
