const mongoose = require('mongoose');

const otpVerificationSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  otp_hash: { type: String, required: true },
  full_name: { type: String, required: true },
  password_hash: { type: String, required: true },
  role: { type: String, default: 'student' },
  attempts: { type: Number, default: 0 },
  expires_at: { type: Date, required: true },
  created_at: { type: Date, default: Date.now }
}, {
  collection: 'otp_verifications'
});

// TTL index: auto-delete documents 10 minutes after expires_at
otpVerificationSchema.index({ expires_at: 1 }, { expireAfterSeconds: 600 });

module.exports = mongoose.model('OtpVerification', otpVerificationSchema);
