// Simple token service - single token balance, no premium tiers

const getTokenBalance = (user) => ({
  token: user?.token || 0
});

const spendTokens = async (User, userId, amount) => {
  const user = await User.findById(userId);
  if (!user) return null;

  if ((user.token || 0) < amount) return null;

  user.token -= amount;
  await user.save();
  return { user, token: user.token };
};

module.exports = {
  getTokenBalance,
  spendTokens
};
