const mongoose = require('mongoose');

const otpVerificationSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, trim: true },
  otp_hash: { type: String, required: true },
  type: { type: String, enum: ['register', 'reset_password'], default: 'register' },
  full_name: { type: String, default: 'Chưa cập nhật' },
  password_hash: { type: String, default: 'NONE' },
  role: { type: String, default: 'student' },
  attempts: { type: Number, default: 0 },
  expires_at: { type: Date, required: true },
  created_at: { type: Date, default: Date.now }
}, {
  collection: 'otp_verifications'
});

// TTL index: auto-delete documents 10 minutes after expires_at
otpVerificationSchema.index({ expires_at: 1 }, { expireAfterSeconds: 600 });
otpVerificationSchema.index({ email: 1, type: 1 });

module.exports = mongoose.model('OtpVerification', otpVerificationSchema);
