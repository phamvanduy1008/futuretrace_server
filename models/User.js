const mongoose = require('mongoose');

const INVITE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const FREE_SIGNUP_TOKENS = 10000;

const generateInviteCode = () => Array.from({ length: 8 }, () => (
  INVITE_CHARS[Math.floor(Math.random() * INVITE_CHARS.length)]
)).join('');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password_hash: { type: String, required: true },
  full_name: { type: String, required: true, trim: true },
  roles: { type: [String], default: ['user'] },
  tier: { type: String, enum: ['free', 'premium_demo'], default: 'free' },
  token: { type: Number, default: FREE_SIGNUP_TOKENS, min: 0 },
  code_invite: { type: String, required: true, unique: true, sparse: true, trim: true },
  invite_redeemed: { type: Boolean, default: false },
  invited_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  status: { type: String, enum: ['active', 'banned', 'locked'], default: 'active' },
  failed_login_attempts: { type: Number, default: 0 },
  last_login: { type: Date },
  avatar_url: { type: String, default: '' },
  bio: { type: String, default: '' }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'users'
});

userSchema.index({ status: 1 });
userSchema.index({ code_invite: 1 }, { unique: true, sparse: true });

userSchema.statics.generateUniqueInviteCode = async function () {
  for (let i = 0; i < 10; i += 1) {
    const code = generateInviteCode();
    const existing = await this.exists({ code_invite: code });
    if (!existing) return code;
  }
  throw new Error('Could not generate unique invite code');
};

userSchema.pre('validate', async function (next) {
  try {
    if (!this.code_invite) {
      this.code_invite = await this.constructor.generateUniqueInviteCode();
    }
    next();
  } catch (error) {
    next(error);
  }
});

module.exports = mongoose.model('User', userSchema);
