const mongoose = require('mongoose');

const simulationSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true, trim: true },
  input: {
    decision: { type: String },
    stress: { type: Number },
    personalFinance: { type: Number },
    academicPerformance: { type: Number },
    risk: { type: Number },
    otherFactors: { type: String },
    tier: { type: String }
  },
  status: { type: String, enum: ['queued', 'processing', 'completed', 'failed'], default: 'queued' },
  selected_scenario_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SimulationScenario' },
  completed_at: { type: Date },
  error_message: { type: String },
  retry_count: { type: Number, default: 0 },
  summary: { type: String },
  is_enterprise: { type: Boolean, default: false },
  timeline: {
    start: { type: String },
    sixMonths: { type: String },
    oneYear: { type: String },
    threeYears: { type: String }
  },
  is_folder: { type: Boolean, default: true },
  folder_name: { type: String },
  is_saved: { type: Boolean, default: false }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: false },
  collection: 'simulations'
});

simulationSchema.index({ user_id: 1, created_at: -1 });
simulationSchema.index({ status: 1 });

module.exports = mongoose.model('Simulation', simulationSchema);
