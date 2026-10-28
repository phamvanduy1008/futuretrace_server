const rateLimit = require('express-rate-limit');

const message = (text) => ({ message: text, type: 'RATE_LIMIT' });

// Đăng nhập / đăng ký: chặn dò mật khẩu
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: message('Bạn thao tác quá nhiều lần. Vui lòng thử lại sau 15 phút.')
});

// Gửi / xác thực OTP: tránh spam email và dò mã 6 số
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 6,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: message('Bạn đã yêu cầu mã xác thực quá nhiều lần. Vui lòng thử lại sau 15 phút.')
});

// Các tác vụ AI tốn tài nguyên: giới hạn theo phiên đăng nhập (fallback theo IP)
const aiLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.headers.authorization || req.ip,
  message: message('Bạn đang gửi quá nhiều yêu cầu AI. Vui lòng đợi vài phút rồi thử lại.')
});

module.exports = { authLimiter, otpLimiter, aiLimiter };
