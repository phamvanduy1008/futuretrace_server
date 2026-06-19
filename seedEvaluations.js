// Script chạy 1 lần để seed 40 câu hỏi vào Database
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { evaluationQuestions } from '../futuretrace/data/evaluationQuestions.ts';

dotenv.config({ path: './.env' });

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

const EvaluationQuestion = mongoose.model('EvaluationQuestion', EvaluationQuestionSchema);

async function seed() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    await EvaluationQuestion.deleteMany({});
    console.log('🗑️ Cleared old questions');

    const mapped = evaluationQuestions.map(q => ({
      questionId: q.id,
      category: q.category,
      text: q.text,
      options: q.options
    }));

    await EvaluationQuestion.insertMany(mapped);
    console.log(`✅ Seeded ${mapped.length} questions successfully`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding:', error);
    process.exit(1);
  }
}

seed();
