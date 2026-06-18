const PREMIUM_DAILY_TOKENS = 30000;
const FREE_RENEWAL_BONUS_TOKENS = 30000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const startOfUtcDay = (date = new Date()) => {
  const value = new Date(date);
  value.setUTCHours(0, 0, 0, 0);
  return value;
};

const addMonths = (date, months) => {
  const value = new Date(date);
  const day = value.getDate();
  value.setMonth(value.getMonth() + months);

  if (value.getDate() !== day) {
    value.setDate(0);
  }

  return value;
};

const getPlanMonths = (planType) => (planType === 'yearly' ? 12 : 1);

const isPremiumActive = (user, now = new Date()) => (
  user?.tier === 'premium' &&
  user?.premium_due_date &&
  new Date(user.premium_due_date).getTime() > now.getTime()
);

const normalizeUserSubscription = async (user, now = new Date()) => {
  if (!user) return user;

  let shouldSave = false;

  if ((user.token_free === undefined || user.token_free === null) && typeof user.token === 'number') {
    user.token_free = user.token;
    shouldSave = true;
  }

  if (user.token_free === undefined || user.token_free === null) {
    user.token_free = 0;
    shouldSave = true;
  }

  if (user.token_premium === undefined || user.token_premium === null) {
    user.token_premium = 0;
    shouldSave = true;
  }

  if (user.tier === 'premium_demo') {
    user.tier = 'premium';
    shouldSave = true;
  }

  const dueDate = user.premium_due_date ? new Date(user.premium_due_date) : null;
  if (user.tier === 'premium' && dueDate && dueDate.getTime() <= now.getTime()) {
    user.tier = 'free';
    user.token_premium = 0;
    shouldSave = true;
  }

  if (isPremiumActive(user, now)) {
    const today = startOfUtcDay(now);
    const lastReset = user.premium_token_reset_date ? startOfUtcDay(user.premium_token_reset_date) : null;

    if (!lastReset || lastReset.getTime() < today.getTime()) {
      user.token_premium = PREMIUM_DAILY_TOKENS;
      user.premium_token_reset_date = today;
      shouldSave = true;
    } else if (user.token_premium > PREMIUM_DAILY_TOKENS) {
      user.token_premium = PREMIUM_DAILY_TOKENS;
      shouldSave = true;
    }
  }

  if (shouldSave) {
    await user.save();
  }

  return user;
};

const applyPremiumPurchase = async (user, planType = 'monthly', now = new Date()) => {
  const months = getPlanMonths(planType);
  const wasPremium = isPremiumActive(user, now);
  const baseDate = wasPremium ? new Date(user.premium_due_date) : now;

  user.tier = 'premium';
  user.premium_create_date = user.premium_create_date || now;
  user.premium_due_date = addMonths(baseDate, months);

  if (wasPremium) {
    user.token_free = (user.token_free || 0) + FREE_RENEWAL_BONUS_TOKENS;
  } else {
    user.token_premium = PREMIUM_DAILY_TOKENS;
    user.premium_token_reset_date = startOfUtcDay(now);
  }

  await user.save();
  return user;
};

const resetPremiumTokensForAllUsers = async (User, now = new Date()) => {
  const today = startOfUtcDay(now);

  await User.updateMany(
    {
      tier: 'premium',
      premium_due_date: { $lte: now }
    },
    {
      $set: { tier: 'free', token_premium: 0 }
    }
  );

  await User.updateMany(
    {
      tier: 'premium',
      premium_due_date: { $gt: now },
      $or: [
        { premium_token_reset_date: { $exists: false } },
        { premium_token_reset_date: null },
        { premium_token_reset_date: { $lt: today } }
      ]
    },
    {
      $set: {
        token_premium: PREMIUM_DAILY_TOKENS,
        premium_token_reset_date: today
      }
    }
  );
};

const getTokenBalance = (user) => ({
  token_free: user?.token_free || 0,
  token_premium: isPremiumActive(user) ? (user?.token_premium || 0) : 0,
  token_total: (user?.token_free || 0) + (isPremiumActive(user) ? (user?.token_premium || 0) : 0)
});

const spendTokens = async (User, userId, amount) => {
  const user = await User.findById(userId);
  await normalizeUserSubscription(user);

  if (!user) return null;

  if (isPremiumActive(user) && (user.token_premium || 0) >= amount) {
    user.token_premium -= amount;
    await user.save();
    return { user, source: 'premium', ...getTokenBalance(user) };
  }

  if ((user.token_free || 0) >= amount) {
    user.token_free -= amount;
    await user.save();
    return { user, source: 'free', ...getTokenBalance(user) };
  }

  return null;
};

module.exports = {
  PREMIUM_DAILY_TOKENS,
  FREE_RENEWAL_BONUS_TOKENS,
  MS_PER_DAY,
  getPlanMonths,
  isPremiumActive,
  normalizeUserSubscription,
  applyPremiumPurchase,
  resetPremiumTokensForAllUsers,
  spendTokens,
  getTokenBalance
};
