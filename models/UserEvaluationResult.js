const mongoose = require('mongoose');

const AnswerSchema = new mongoose.Schema({
  questionId: { type: Number, required: true },
  category: { type: String, required: true },
  questionText: { type: String },
  selectedOptionText: { type: String },
  score: { type: Number, required: true }
}, { _id: false });

const UserEvaluationResultSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  categoryScores: {
    stress: { type: Number, default: 0 },
    finance: { type: Number, default: 0 },
    capability: { type: Number, default: 0 },
    risk: { type: Number, default: 0 }
  },
  normalizedScores: {
    stress: { type: Number, default: 0 },
    finance: { type: Number, default: 0 },
    capability: { type: Number, default: 0 },
    risk: { type: Number, default: 0 }
  },
  detailedAnswers: [AnswerSchema],
  version: { type: String, default: '1.0' }
}, { timestamps: true });

module.exports = mongoose.model('UserEvaluationResult', UserEvaluationResultSchema);
