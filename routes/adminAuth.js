const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const adminAuth = require('../middleware/adminAuth');
const { getPrimaryRole } = require('../services/adminFormatters');

const router = express.Router();

const ADMIN_ROLES = ['super_admin', 'ops_support', 'community_moderator', 'ai_operator'];

const hasAdminRole = (roles = []) => roles.some((role) => ADMIN_ROLES.includes(role));

const signAdminTokens = (user) => {
  const roles = user.roles || [];

  const accessToken = jwt.sign(
    {
      userId: user._id,
      email: user.email,
      roles,
      audience: 'admin',
    },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  );

  const refreshToken = crypto.randomBytes(40).toString('hex');
  return { accessToken, refreshToken };
};

const buildAdminSession = (user) => ({
  id: user._id.toString(),
  name: user.full_name,
  email: user.email,
  avatarUrl: user.avatar_url,
  role: getPrimaryRole(user.roles),
  roles: user.roles,
  tier: user.tier,
  bio: user.bio,
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email và mật khẩu admin là bắt buộc.' });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      return res.status(401).json({ message: 'Thông tin đăng nhập admin không đúng.' });
    }

    if (!hasAdminRole(user.roles)) {
      return res.status(403).json({ message: 'Tài khoản này không có quyền admin.' });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ message: 'Tài khoản admin hiện không khả dụng.' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ message: 'Thông tin đăng nhập admin không đúng.' });
    }

    user.failed_login_attempts = 0;
    user.last_login = new Date();
    await user.save();

    await RefreshToken.deleteMany({ user_id: user._id, audience: 'admin' });

    const tokens = signAdminTokens(user);
    await RefreshToken.create({
      user_id: user._id,
      token: tokens.refreshToken,
      audience: 'admin',
      user_agent: req.headers['user-agent'] || '',
      ip_address: req.ip || '',
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    res.json({
      message: 'Đăng nhập admin thành công.',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      admin: buildAdminSession(user),
    });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi đăng nhập admin.' });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ message: 'Refresh token admin là bắt buộc.' });
    }

    const storedToken = await RefreshToken.findOne({ token: refreshToken, audience: 'admin' });
    if (!storedToken || storedToken.expires_at < new Date()) {
      return res.status(401).json({ message: 'Refresh token admin không hợp lệ hoặc đã hết hạn.' });
    }

    const user = await User.findById(storedToken.user_id);
    if (!user || !hasAdminRole(user.roles)) {
      return res.status(401).json({ message: 'Tài khoản admin không hợp lệ.' });
    }

    const tokens = signAdminTokens(user);
    await RefreshToken.deleteOne({ _id: storedToken._id });
    await RefreshToken.create({
      user_id: user._id,
      token: tokens.refreshToken,
      audience: 'admin',
      user_agent: storedToken.user_agent || '',
      ip_address: storedToken.ip_address || '',
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    res.json({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      admin: buildAdminSession(user),
    });
  } catch (error) {
    console.error('Admin refresh error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi refresh admin token.' });
  }
});

router.get('/me', adminAuth, async (req, res) => {
  try {
    const user = await User.findById(req.admin.userId).select('-password_hash');
    if (!user || !hasAdminRole(user.roles)) {
      return res.status(404).json({ message: 'Không tìm thấy tài khoản admin.' });
    }

    res.json(buildAdminSession(user));
  } catch (error) {
    console.error('Admin me error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi lấy phiên admin.' });
  }
});

router.post('/logout', adminAuth, async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (refreshToken) {
      await RefreshToken.deleteOne({
        token: refreshToken,
        user_id: req.admin.userId,
        audience: 'admin',
      });
    } else {
      await RefreshToken.deleteMany({
        user_id: req.admin.userId,
        audience: 'admin',
      });
    }

    res.json({ message: 'Đăng xuất admin thành công.' });
  } catch (error) {
    console.error('Admin logout error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi đăng xuất admin.' });
  }
});

module.exports = router;
