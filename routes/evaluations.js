const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const EvaluationQuestion = require('../models/EvaluationQuestion');
const UserEvaluationResult = require('../models/UserEvaluationResult');

// Lấy danh sách toàn bộ 40 câu hỏi
router.get('/questions', auth, async (req, res) => {
  try {
    const questions = await EvaluationQuestion.find().sort({ questionId: 1 });
    res.json(questions);
  } catch (error) {
    console.error('Error fetching questions:', error);
    res.status(500).json({ message: 'Lỗi server khi lấy danh sách câu hỏi.' });
  }
});

// Seed API (chỉ dùng một lần hoặc cho admin, ở đây để đơn giản ta tạo endpoint)
router.post('/seed', async (req, res) => {
  try {
    const { questions } = req.body;
    if (!questions || !Array.isArray(questions)) {
      return res.status(400).json({ message: 'Dữ liệu không hợp lệ.' });
    }
    await EvaluationQuestion.deleteMany({});
    await EvaluationQuestion.insertMany(questions);
    res.json({ message: `Đã seed thành công ${questions.length} câu hỏi.` });
  } catch (error) {
    console.error('Error seeding questions:', error);
    res.status(500).json({ message: 'Lỗi server khi seed câu hỏi.' });
  }
});

// Submit kết quả đánh giá
router.post('/', auth, async (req, res) => {
  try {
    const { answers } = req.body; // array of { questionId, score }

    if (!answers || !Array.isArray(answers)) {
      return res.status(400).json({ message: 'Dữ liệu trả lời không hợp lệ.' });
    }

    // Fetch questions to validate and get details
    const questions = await EvaluationQuestion.find();
    if (questions.length === 0) {
      return res.status(400).json({ message: 'Chưa có câu hỏi trong hệ thống.' });
    }

    const detailedAnswers = [];
    const categoryScores = { stress: 0, finance: 0, capability: 0, risk: 0 };
    
    for (const ans of answers) {
      const q = questions.find(qu => qu.questionId === ans.questionId);
      if (q) {
        // Validate if score is a valid option
        const validOption = q.options.find(opt => opt.score === ans.score);
        if (!validOption) continue;

        categoryScores[q.category] += validOption.score;
        detailedAnswers.push({
          questionId: q.questionId,
          category: q.category,
          questionText: q.text,
          selectedOptionText: validOption.text,
          score: validOption.score
        });
      }
    }

    // Calculate normalized scores (/10 since 10 questions max 100 each -> total 1000)
    const normalizedScores = {
      stress: categoryScores.stress / 10,
      finance: categoryScores.finance / 10,
      capability: categoryScores.capability / 10,
      risk: categoryScores.risk / 10
    };

    const newResult = new UserEvaluationResult({
      userId: req.user.userId,
      categoryScores,
      normalizedScores,
      detailedAnswers,
      version: '1.0'
    });

    await newResult.save();

    res.status(201).json({
      message: 'Lưu kết quả thành công.',
      normalizedScores
    });
  } catch (error) {
    console.error('Error saving evaluation:', error);
    res.status(500).json({ message: 'Lỗi server khi lưu kết quả.' });
  }
});

// Lấy kết quả đánh giá mới nhất
router.get('/latest', auth, async (req, res) => {
  try {
    const latestResult = await UserEvaluationResult.findOne({ userId: req.user.userId })
      .sort({ createdAt: -1 });
    
    if (!latestResult) {
      return res.json(null); // return null to indicate no evaluation done
    }

    res.json(latestResult);
  } catch (error) {
    console.error('Error fetching latest evaluation:', error);
    res.status(500).json({ message: 'Lỗi server khi lấy kết quả đánh giá.' });
  }
});

module.exports = router;
