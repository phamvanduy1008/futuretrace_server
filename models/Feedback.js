const mongoose = require('mongoose');

/**
 * Phản hồi của người dùng cho từng kịch bản mô phỏng.
 * Dùng cho: (1) chỉ số chất lượng/hài lòng (admin, hồ sơ gọi vốn),
 * (2) chọn mẫu tốt / mẫu lỗi cho vòng fine-tune tiếp theo.
 */
const feedbackSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  simulation_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Simulation', required: true },
  scenario_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SimulationScenario' },
  rating: { type: Number, enum: [-1, 1], required: true },          // 👎 / 👍
  numbers_plausible: { type: Boolean, default: null },              // "Con số có hợp lý không?"
  reasons: { type: [String], default: [] },                         // vd ['generic', 'wrong_numbers', 'not_my_situation']
  comment: { type: String, maxlength: 1000 },
  provider: { type: String },                                       // modal / gemini / ollama (từ GeminiLog)
  model: { type: String }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'feedback'
});

// Mỗi người chỉ có một phản hồi cho mỗi kịch bản (gửi lại = cập nhật)
feedbackSchema.index({ user_id: 1, simulation_id: 1, scenario_id: 1 }, { unique: true });
feedbackSchema.index({ created_at: -1 });

module.exports = mongoose.model('Feedback', feedbackSchema);
