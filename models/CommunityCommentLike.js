const mongoose = require('mongoose');

const communityCommentLikeSchema = new mongoose.Schema({
  comment_id: { type: mongoose.Schema.Types.ObjectId, ref: 'CommunityComment', required: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: false },
  collection: 'community_comment_likes'
});

communityCommentLikeSchema.index({ comment_id: 1, user_id: 1 }, { unique: true });

module.exports = mongoose.model('CommunityCommentLike', communityCommentLikeSchema);
