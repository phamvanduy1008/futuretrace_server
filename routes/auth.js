const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const auth = require('../middleware/auth');
const crypto = require('crypto');

const router = express.Router();

const generateTokens = (user) => {
  const accessToken = jwt.sign(
    { userId: user._id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  const refreshToken = crypto.randomBytes(40).toString('hex');
  return { accessToken, refreshToken };
};

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, full_name, role } = req.body;

    if (!email || !password || !full_name) {
      return res.status(400).json({ message: 'Email, mật khẩu và họ tên là bắt buộc.' });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(409).json({ message: 'Email này đã được đăng ký.' });
    }

    const password_hash = await bcrypt.hash(password, 12);
    const user = new User({
      email: email.toLowerCase(),
      password_hash,
      full_name,
      roles: role === 'worker' ? ['user', 'worker'] : ['user'],
      avatar_url: `https://i.pravatar.cc/150?u=${email}`
    });

    await user.save();

    const tokens = generateTokens(user);
    await new RefreshToken({
      user_id: user._id,
      token: tokens.refreshToken,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
    }).save();

    res.status(201).json({
      message: 'Đăng ký thành công.',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user._id,
        email: user.email,
        full_name: user.full_name,
        avatar_url: user.avatar_url,
        roles: user.roles,
        tier: user.tier
      }
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi đăng ký.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email và mật khẩu là bắt buộc.' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(401).json({ message: 'Email hoặc mật khẩu không đúng.' });
    }

    if (user.status === 'banned') {
      return res.status(403).json({ message: 'Tài khoản của bạn đã bị khóa.' });
    }

    if (user.status === 'locked') {
      return res.status(403).json({ message: 'Tài khoản đang bị tạm khóa do đăng nhập thất bại quá nhiều lần.' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      user.failed_login_attempts += 1;
      if (user.failed_login_attempts >= 5) {
        user.status = 'locked';
      }
      await user.save();
      return res.status(401).json({ message: 'Email hoặc mật khẩu không đúng.' });
    }

    // Reset failed attempts on successful login
    user.failed_login_attempts = 0;
    user.last_login = new Date();
    await user.save();

    const tokens = generateTokens(user);

    // Remove old refresh tokens and save new one
    await RefreshToken.deleteMany({ user_id: user._id });
    await new RefreshToken({
      user_id: user._id,
      token: tokens.refreshToken,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    }).save();

    res.json({
      message: 'Đăng nhập thành công.',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user._id,
        email: user.email,
        full_name: user.full_name,
        avatar_url: user.avatar_url,
        roles: user.roles,
        tier: user.tier,
        bio: user.bio
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi đăng nhập.' });
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ message: 'Refresh token là bắt buộc.' });
    }

    const storedToken = await RefreshToken.findOne({ token: refreshToken });
    if (!storedToken || storedToken.expires_at < new Date()) {
      return res.status(401).json({ message: 'Refresh token không hợp lệ hoặc đã hết hạn.' });
    }

    const user = await User.findById(storedToken.user_id);
    if (!user) {
      return res.status(401).json({ message: 'Người dùng không tồn tại.' });
    }

    const tokens = generateTokens(user);

    // Rotate refresh token
    await RefreshToken.deleteOne({ _id: storedToken._id });
    await new RefreshToken({
      user_id: user._id,
      token: tokens.refreshToken,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    }).save();

    res.json({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken
    });
  } catch (error) {
    console.error('Refresh error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống.' });
  }
});

// GET /api/auth/me
router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-password_hash');
    if (!user) {
      return res.status(404).json({ message: 'Người dùng không tìm thấy.' });
    }

    res.json({
      id: user._id,
      email: user.email,
      full_name: user.full_name,
      avatar_url: user.avatar_url,
      roles: user.roles,
      tier: user.tier,
      bio: user.bio,
      created_at: user.created_at
    });
  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống.' });
  }
});

// PUT /api/auth/profile
router.put('/profile', auth, async (req, res) => {
  try {
    const { full_name, avatar_url, bio } = req.body;
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ message: 'Người dùng không tìm thấy.' });
    }

    if (full_name) user.full_name = full_name;
    if (avatar_url) user.avatar_url = avatar_url;
    if (bio !== undefined) user.bio = bio;

    await user.save();

    res.json({
      id: user._id,
      email: user.email,
      full_name: user.full_name,
      avatar_url: user.avatar_url,
      roles: user.roles,
      tier: user.tier,
      bio: user.bio
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống.' });
  }
});

module.exports = router;
