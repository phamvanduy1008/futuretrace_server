const mongoose = require('mongoose');

const AnswerSchema = new mongoose.Schema({
  questionId: { type: Number, required: true },
  selectedValue: { type: Number, required: true }
}, { _id: false });

const UserEvaluationResultSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  answers: [AnswerSchema],
  rawScore: {
    stress: { type: Number, default: 0 },
    finance: { type: Number, default: 0 },
    capability: { type: Number, default: 0 },
    risk: { type: Number, default: 0 }
  },
  normalizedScore: {
    stress: { type: Number, default: 0 },
    finance: { type: Number, default: 0 },
    capability: { type: Number, default: 0 },
    risk: { type: Number, default: 0 }
  },
  level: {
    stress: { type: Number, default: 1 },
    finance: { type: Number, default: 1 },
    capability: { type: Number, default: 1 },
    risk: { type: Number, default: 1 }
  },
  version: { type: String, default: '2.0' }
}, { timestamps: true });

module.exports = mongoose.model('UserEvaluationResult', UserEvaluationResultSchema);
