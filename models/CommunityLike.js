const mongoose = require('mongoose');

const communityLikeSchema = new mongoose.Schema({
  post_id: { type: mongoose.Schema.Types.ObjectId, ref: 'CommunityPost', required: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: false },
  collection: 'community_likes'
});

communityLikeSchema.index({ post_id: 1, user_id: 1 }, { unique: true });

module.exports = mongoose.model('CommunityLike', communityLikeSchema);
