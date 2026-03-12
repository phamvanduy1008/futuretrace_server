const mongoose = require('mongoose');

const communityCommentSchema = new mongoose.Schema({
  post_id: { type: mongoose.Schema.Types.ObjectId, ref: 'CommunityPost', required: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, required: true },
  parent_id: { type: mongoose.Schema.Types.ObjectId, ref: 'CommunityComment' },
  likes: { type: Number, default: 0 }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: false },
  collection: 'community_comments'
});

communityCommentSchema.index({ post_id: 1, created_at: 1 });
communityCommentSchema.index({ parent_id: 1 });

module.exports = mongoose.model('CommunityComment', communityCommentSchema);
