const mongoose = require('mongoose');

const geminiLogSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  simulation_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Simulation' },
  prompt_version: { type: Number, required: true, default: 1 },
  model: { type: String, required: true },
  full_prompt: { type: String },
  input_tokens: { type: Number },
  output_tokens: { type: Number },
  latency_ms: { type: Number },
  status: { type: String, enum: ['success', 'error'], required: true },
  error_message: { type: String },
  output: { type: mongoose.Schema.Types.Mixed },
  cost_estimate: { type: Number }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: false },
  collection: 'gemini_logs'
});

geminiLogSchema.index({ created_at: -1 });
geminiLogSchema.index({ simulation_id: 1 });
geminiLogSchema.index({ user_id: 1 });

module.exports = mongoose.model('GeminiLog', geminiLogSchema);
