const mongoose = require('mongoose');

const premiumAnalysisSchema = new mongoose.Schema({
  simulation_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Simulation' },
  scenario_id: { type: String, required: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  category: { type: String, default: 'SỰ NGHIỆP' },
  report: {
    detailedNarrative: String,
    milestones: [{
      month: String,
      event: String,
      impact: String,
      probability: Number,
      details: String
    }],
    influencingFactors: [{
      category: String,
      factor: String,
      influence: String,
      description: String
    }],
    strategicPivotPoints: [{
      condition: String,
      action: String
    }],
    longTermProjection: String
  },
  context: {
    decision: String,
    stress: Number,
    personalFinance: Number,
    academicPerformance: Number,
    risk: Number,
    otherFactors: String,
    tier: String
  },
  scenario: { type: mongoose.Schema.Types.Mixed },
  completed_milestones: { type: [Number], default: [] },
  timeframe: { type: Number, required: true, default: 12 }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'premium_analyses'
});

premiumAnalysisSchema.index({ scenario_id: 1 });
premiumAnalysisSchema.index({ user_id: 1 });

module.exports = mongoose.model('PremiumAnalysis', premiumAnalysisSchema);
