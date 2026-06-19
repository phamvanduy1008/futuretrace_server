const mongoose = require('mongoose');

const OptionSchema = new mongoose.Schema({
  text: { type: String, required: true },
  score: { type: Number, required: true },
});

const EvaluationQuestionSchema = new mongoose.Schema({
  questionId: { type: Number, required: true, unique: true },
  category: { 
    type: String, 
    enum: ['stress', 'finance', 'capability', 'risk'], 
    required: true 
  },
  text: { type: String, required: true },
  options: [OptionSchema],
  version: { type: String, default: '1.0' }
}, { timestamps: true });

module.exports = mongoose.model('EvaluationQuestion', EvaluationQuestionSchema);
