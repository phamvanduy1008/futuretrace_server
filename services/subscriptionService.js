// Simple token service - single token balance, no premium tiers

const getTokenBalance = (user) => ({
  token: user?.token || 0
});

const spendTokens = async (User, userId, amount) => {
  // Use atomic findOneAndUpdate to prevent race conditions (double clicking)
  const user = await User.findOneAndUpdate(
    { _id: userId, token: { $gte: amount } },
    { $inc: { token: -amount } },
    { new: true }
  );
  if (!user) return null;
  
  return { user, token: user.token };
};

module.exports = {
  getTokenBalance,
  spendTokens
};
