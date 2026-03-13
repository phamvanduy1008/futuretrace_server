const mongoose = require('mongoose');

const refreshTokenSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  token: { type: String, required: true, unique: true },
  audience: { type: String, enum: ['public', 'admin'], default: 'public' },
  user_agent: { type: String, default: '' },
  ip_address: { type: String, default: '' },
  expires_at: { type: Date, required: true },
  created_at: { type: Date, default: Date.now }
}, {
  collection: 'refresh_tokens'
});

refreshTokenSchema.index({ user_id: 1 });
refreshTokenSchema.index({ user_id: 1, audience: 1 });
refreshTokenSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('RefreshToken', refreshTokenSchema);
