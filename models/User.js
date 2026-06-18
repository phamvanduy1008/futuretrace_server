const mongoose = require('mongoose');

const INVITE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const FREE_SIGNUP_TOKENS = 10000;
const PREMIUM_DAILY_TOKENS = 30000;

const generateInviteCode = () => Array.from({ length: 8 }, () => (
  INVITE_CHARS[Math.floor(Math.random() * INVITE_CHARS.length)]
)).join('');

const getDayKey = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
};

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password_hash: { type: String, required: true },
  full_name: { type: String, required: true, trim: true },
  roles: { type: [String], default: ['user'] },
  tier: { type: String, enum: ['free', 'premium', 'premium_demo'], default: 'free' },
  token: { type: Number, select: false },
  token_free: { type: Number, default: FREE_SIGNUP_TOKENS, min: 0 },
  token_premium: { type: Number, default: 0, min: 0, max: PREMIUM_DAILY_TOKENS },
  code_invite: { type: String, required: true, unique: true, sparse: true, trim: true },
  invite_redeemed: { type: Boolean, default: false },
  invited_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  premium_create_date: { type: Date, default: null },
  premium_due_date: { type: Date, default: null },
  premium_last_token_reset_date: { type: Date, default: null },
  premium_order_ids: { type: [String], default: [], select: false },
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

userSchema.methods.syncLegacyToken = function () {
  if (
    typeof this.token === 'number' &&
    (this.token_free === undefined || this.token_free === null || this.$isDefault?.('token_free'))
  ) {
    this.token_free = this.token;
  }
};

userSchema.methods.refreshPremiumQuota = function (now = new Date()) {
  const isPremium = this.tier === 'premium' || this.tier === 'premium_demo';
  const dueDate = this.premium_due_date ? new Date(this.premium_due_date) : null;

  if (isPremium && dueDate && dueDate <= now) {
    this.tier = 'free';
    this.token_premium = 0;
    return;
  }

  if (!isPremium) return;

  const lastResetKey = getDayKey(this.premium_last_token_reset_date);
  const todayKey = getDayKey(now);

  if (!this.premium_last_token_reset_date || lastResetKey !== todayKey) {
    this.token_premium = PREMIUM_DAILY_TOKENS;
    this.premium_last_token_reset_date = now;
  } else if ((this.token_premium || 0) > PREMIUM_DAILY_TOKENS) {
    this.token_premium = PREMIUM_DAILY_TOKENS;
  }
};

userSchema.pre('validate', async function (next) {
  try {
    if (!this.code_invite) {
      this.code_invite = await this.constructor.generateUniqueInviteCode();
    }
    this.syncLegacyToken();
    this.refreshPremiumQuota();
    next();
  } catch (error) {
    next(error);
  }
});

userSchema.statics.PREMIUM_DAILY_TOKENS = PREMIUM_DAILY_TOKENS;
userSchema.statics.FREE_SIGNUP_TOKENS = FREE_SIGNUP_TOKENS;

module.exports = mongoose.model('User', userSchema);
