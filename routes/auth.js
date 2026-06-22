const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const auth = require('../middleware/auth');
const crypto = require('crypto');
const axios = require('axios');
const OtpVerification = require('../models/OtpVerification');
const { sendOtpEmail } = require('../services/emailService');

const router = express.Router();

const FREE_SIGNUP_TOKENS = 200;
const INVITE_REWARD_TOKENS = 40;

const generateTokens = (user) => {
  const accessToken = jwt.sign(
    { userId: user._id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  const refreshToken = crypto.randomBytes(40).toString('hex');
  return { accessToken, refreshToken };
};

const formatUser = (user) => {
  return {
    id: user._id,
    email: user.email,
    full_name: user.full_name,
    avatar_url: user.avatar_url,
    roles: user.roles,
    bio: user.bio,
    token: user.token || 0,
    code_invite: user.code_invite,
    invite_redeemed: !!user.invite_redeemed,
    has_claimed_free_pack: !!user.has_claimed_free_pack,
    is_google_user: !!user.googleId,
    has_manual_password: !!user.has_manual_password,
    created_at: user.created_at
  };
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
      avatar_url: `https://i.pravatar.cc/150?u=${email}`,
      token: FREE_SIGNUP_TOKENS,
      code_invite: await User.generateUniqueInviteCode()
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
      user: formatUser(user)
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi đăng ký.' });
  }
});

// POST /api/auth/register/send-otp
router.post('/register/send-otp', async (req, res) => {
  try {
    const { email, password, full_name, role } = req.body;

    if (!email || !password || !full_name) {
      return res.status(400).json({ message: 'Email, mật khẩu và họ tên là bắt buộc.' });
    }
    // Password validation: at least 8 characters, 1 uppercase, 1 special character
    const passwordRegex = /^(?=.*[A-Z])(?=.*[!@#$%^&*(),.?":{}|<>]).{8,}$/;
    if (!passwordRegex.test(password)) {
      return res.status(400).json({ message: 'Mật khẩu phải có ít nhất 8 ký tự, bao gồm ít nhất 1 chữ viết hoa và 1 ký tự đặc biệt.' });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(409).json({ message: 'Email này đã được đăng ký.' });
    }

    // Generate 6-digit OTP
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const otp_hash = await bcrypt.hash(otp, 10);
    const password_hash = await bcrypt.hash(password, 12);

    // Upsert pending OTP record (replace if same email requests again)
    await OtpVerification.findOneAndUpdate(
      { email: email.toLowerCase() },
      {
        email: email.toLowerCase(),
        otp_hash,
        full_name,
        password_hash,
        role: role || 'student',
        attempts: 0,
        expires_at: new Date(Date.now() + 5 * 60 * 1000) // 5 minutes
      },
      { upsert: true, new: true }
    );

    // Send OTP email
    await sendOtpEmail(email, otp);

    console.log(`[OTP] Sent to ${email}`);
    res.json({ message: 'Mã xác thực đã được gửi đến email của bạn.' });
  } catch (error) {
    console.error('Send OTP error:', error);
    
    // Phân loại lỗi SMTP để trả về thông điệp hữu ích mà không lộ thông tin nhạy cảm
    if (error.code === 'EAUTH' || error.responseCode === 535) {
      return res.status(500).json({ 
        message: 'Lỗi xác thực với máy chủ email (Gmail App Password sai hoặc bị chặn đăng nhập). Vui lòng liên hệ quản trị viên.',
        error_code: error.code || 'EAUTH'
      });
    }
    
    if (error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED' || error.syscall === 'connect') {
      return res.status(500).json({ 
        message: 'Không thể kết nối đến máy chủ email SMTP (Hết hạn kết nối hoặc bị chặn cổng kết nối). Vui lòng thử lại sau.',
        error_code: error.code || 'ETIMEOUT'
      });
    }
    
    res.status(500).json({ 
      message: `Lỗi hệ thống khi gửi mã xác thực: ${error.message}`,
      error_code: error.code || 'GENERIC_ERROR'
    });
  }
});

// POST /api/auth/register/verify-otp
router.post('/register/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ message: 'Email và mã OTP là bắt buộc.' });
    }

    const record = await OtpVerification.findOne({ email: email.toLowerCase() });
    if (!record) {
      return res.status(404).json({ message: 'Không tìm thấy yêu cầu xác thực. Vui lòng đăng ký lại.' });
    }

    // Check expiry
    if (record.expires_at < new Date()) {
      await OtpVerification.deleteOne({ _id: record._id });
      return res.status(410).json({ message: 'Mã xác thực đã hết hạn. Vui lòng gửi lại mã mới.' });
    }

    // Check attempts
    if (record.attempts >= 5) {
      await OtpVerification.deleteOne({ _id: record._id });
      return res.status(429).json({ message: 'Bạn đã nhập sai quá nhiều lần. Vui lòng đăng ký lại.' });
    }

    // Compare OTP
    const isMatch = await bcrypt.compare(otp, record.otp_hash);
    if (!isMatch) {
      record.attempts += 1;
      await record.save();
      const remaining = 5 - record.attempts;
      return res.status(401).json({ message: `Mã xác thực không đúng. Còn ${remaining} lần thử.` });
    }

    // OTP correct — create user
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      await OtpVerification.deleteOne({ _id: record._id });
      return res.status(409).json({ message: 'Email này đã được đăng ký.' });
    }

    const user = new User({
      email: record.email,
      password_hash: record.password_hash,
      full_name: record.full_name,
      roles: record.role === 'worker' ? ['user', 'worker'] : ['user'],
      avatar_url: `https://i.pravatar.cc/150?u=${record.email}`,
      token: FREE_SIGNUP_TOKENS,
      code_invite: await User.generateUniqueInviteCode()
    });
    await user.save();

    // Cleanup OTP record
    await OtpVerification.deleteOne({ _id: record._id });

    // Generate tokens
    const tokens = generateTokens(user);
    await new RefreshToken({
      user_id: user._id,
      token: tokens.refreshToken,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    }).save();

    console.log(`[OTP] Verified & created user ${email}`);
    res.status(201).json({
      message: 'Đăng ký thành công.',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: formatUser(user)
    });
  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi xác thực.' });
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
      user: formatUser(user)
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
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ message: 'Người dùng không tìm thấy.' });
    }

    if (!user.code_invite) {
      user.code_invite = await User.generateUniqueInviteCode();
      await user.save();
    }

    res.json(formatUser(user));
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

    res.json(formatUser(user));
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống.' });
  }
});

// POST /api/auth/redeem-invite
router.post('/redeem-invite', auth, async (req, res) => {
  try {
    const code = String(req.body.code_invite || '').trim();

    if (!/^[A-Za-z0-9]{8}$/.test(code)) {
      return res.status(400).json({ message: 'Mã mời không hợp lệ.' });
    }

    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ message: 'Người dùng không tìm thấy.' });
    }

    if (user.invite_redeemed) {
      return res.status(409).json({ message: 'Tài khoản này đã nhập mã mời trước đó.' });
    }

    if (user.code_invite === code) {
      return res.status(400).json({ message: 'Bạn không thể nhập mã mời của chính mình.' });
    }

    const inviter = await User.findOne({ code_invite: code });
    if (!inviter) {
      return res.status(404).json({ message: 'Không tìm thấy mã mời này.' });
    }

    const redeemed = await User.findOneAndUpdate(
      { _id: user._id, invite_redeemed: { $ne: true } },
      {
        $inc: { token: INVITE_REWARD_TOKENS },
        $set: { invite_redeemed: true, invited_by: inviter._id }
      },
      { new: true }
    );

    if (!redeemed) {
      return res.status(409).json({ message: 'Tài khoản này đã nhập mã mời trước đó.' });
    }

    await User.updateOne(
      { _id: inviter._id },
      { $inc: { token: INVITE_REWARD_TOKENS } }
    );

    res.json({
      message: 'Nhập mã mời thành công.',
      user: formatUser(redeemed),
      rewards: {
        inviter: INVITE_REWARD_TOKENS,
        invitee: INVITE_REWARD_TOKENS
      }
    });
  } catch (error) {
    console.error('Redeem invite error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi nhập mã mời.' });
  }
});

// PUT /api/auth/password
router.put('/password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ message: 'Người dùng không tìm thấy.' });
    }

    // Google users who never set a manual password can skip currentPassword
    const isGoogleWithoutPassword = user.googleId && !user.has_manual_password;

    if (!isGoogleWithoutPassword) {
      if (!currentPassword) {
        return res.status(400).json({ message: 'Vui lòng cung cấp mật khẩu hiện tại.' });
      }
      const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
      if (!isMatch) {
        return res.status(401).json({ message: 'Mật khẩu cũ không đúng.' });
      }
    }

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ message: 'Mật khẩu mới phải có ít nhất 6 ký tự.' });
    }

    const password_hash = await bcrypt.hash(newPassword, 12);
    user.password_hash = password_hash;
    user.has_manual_password = true;
    await user.save();

    res.json({ message: 'Đổi mật khẩu thành công.', user: formatUser(user) });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống.' });
  }
});

// GET /api/auth/google/callback
router.get('/google/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    return res.status(400).send('Missing authorization code');
  }

  // Validate state (which is the frontend origin) to prevent open redirect
  const allowedOrigins = [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:3000',
    'https://futuretrace.cloud',
    'https://www.futuretrace.cloud'
  ];
  
  let targetOrigin = 'https://futuretrace.cloud';
  if (state && (allowedOrigins.includes(state) || state.startsWith('http://localhost:'))) {
    targetOrigin = state;
  }
  const originClean = targetOrigin.endsWith('/') ? targetOrigin.slice(0, -1) : targetOrigin;

  try {
    // 1. Exchange authorization code for access token
    const tokenResponse = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_CALLBACK_URL,
      grant_type: 'authorization_code'
    });

    const { access_token } = tokenResponse.data;

    // 2. Fetch user profile from Google
    const userResponse = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const { sub: googleId, email, name, picture } = userResponse.data;

    if (!email) {
      return res.status(400).send('Google account does not provide email');
    }

    // 3. Find or create user
    let user = await User.findOne({ email: email.toLowerCase() });

    if (user) {
      // Update Google ID if not set
      if (!user.googleId) {
        user.googleId = googleId;
      }
      if (!user.avatar_url) {
        user.avatar_url = picture || `https://i.pravatar.cc/150?u=${email}`;
      }
      user.last_login = new Date();
      await user.save();
    } else {
      // Create new user
      const password_hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
      user = new User({
        email: email.toLowerCase(),
        password_hash,
        full_name: name || email.split('@')[0],
        googleId,
        avatar_url: picture || `https://i.pravatar.cc/150?u=${email}`,
        token: FREE_SIGNUP_TOKENS,
        code_invite: await User.generateUniqueInviteCode(),
        has_manual_password: false
      });
      await user.save();
    }

    // 4. Generate system tokens
    const tokens = generateTokens(user);

    // Save refresh token to DB
    await RefreshToken.deleteMany({ user_id: user._id });
    await new RefreshToken({
      user_id: user._id,
      token: tokens.refreshToken,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    }).save();

    // 5. Redirect back to frontend with tokens
    return res.redirect(`${originClean}/#/login?token=${tokens.accessToken}&refreshToken=${tokens.refreshToken}`);
  } catch (error) {
    console.error('Google OAuth error:', error?.response?.data || error.message);
    return res.status(500).send('Authentication failed: ' + (error?.response?.data?.error_description || error.message));
  }
});

module.exports = router;
