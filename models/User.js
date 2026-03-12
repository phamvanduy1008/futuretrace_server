const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password_hash: { type: String, required: true },
  full_name: { type: String, required: true, trim: true },
  roles: { type: [String], default: ['user'] },
  tier: { type: String, enum: ['free', 'premium_demo'], default: 'free' },
  status: { type: String, enum: ['active', 'banned', 'locked'], default: 'active' },
  failed_login_attempts: { type: Number, default: 0 },
  last_login: { type: Date },
  avatar_url: { type: String, default: '' },
  bio: { type: String, default: '' }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'users'
});

userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ status: 1 });

module.exports = mongoose.model('User', userSchema);
