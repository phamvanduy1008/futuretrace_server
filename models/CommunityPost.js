const mongoose = require('mongoose');

const communityPostSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true, trim: true },
  content: { type: String, required: true },
  scenario_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SimulationScenario' },
  simulation_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Simulation' },
  tags: { type: [String], default: [] },
  category: { type: String, default: 'SỰ NGHIỆP' },
  is_anonymous: { type: Boolean, default: false },
  likes_count: { type: Number, default: 0 },
  comments_count: { type: Number, default: 0 },
  views_count: { type: Number, default: 0 },
  type: { type: String, enum: ['Positive', 'Neutral', 'Risk'], default: 'Positive' },
  reliability: { type: Number, default: 95 },
  career_growth: { type: Number, default: 0 },
  happiness: { type: Number, default: 0 },
  roi: { type: Number, default: 0 },
  deep_analysis: { type: mongoose.Schema.Types.Mixed },
  flagged_by: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  status: { type: String, enum: ['active', 'flagged', 'removed'], default: 'active' }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: false },
  collection: 'community_posts'
});

communityPostSchema.index({ user_id: 1 });
communityPostSchema.index({ status: 1, created_at: -1 });
communityPostSchema.index({ tags: 1 });
communityPostSchema.index({ title: 'text', content: 'text' });

module.exports = mongoose.model('CommunityPost', communityPostSchema);
