const mongoose = require('mongoose');

const OptionSchema = new mongoose.Schema({
  text: { type: String, required: true },
  value: { type: Number, required: true },
});

const EvaluationQuestionSchema = new mongoose.Schema({
  questionId: { type: Number, required: true, unique: true },
  category: { 
    type: String, 
    enum: ['stress', 'finance', 'capability', 'risk'], 
    required: true 
  },
  question: { type: String, required: true },
  isReverse: { type: Boolean, default: false },
  options: [OptionSchema],
  scale_version: { type: String, default: '2.0' }
}, { timestamps: true });

module.exports = mongoose.model('EvaluationQuestion', EvaluationQuestionSchema);
