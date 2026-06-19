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
    const { answers } = req.body; // array of { questionId, selectedValue }

    if (!answers || !Array.isArray(answers)) {
      return res.status(400).json({ message: 'Dữ liệu trả lời không hợp lệ.' });
    }

    // Fetch questions to validate and get details
    const questions = await EvaluationQuestion.find();
    if (questions.length === 0) {
      return res.status(400).json({ message: 'Chưa có câu hỏi trong hệ thống.' });
    }

    const validAnswers = [];
    const rawScore = { stress: 0, finance: 0, capability: 0, risk: 0 };
    
    for (const ans of answers) {
      const q = questions.find(qu => qu.questionId === ans.questionId);
      if (q) {
        // Validate if selectedValue is a valid option
        const validOption = q.options.find(opt => opt.value === ans.selectedValue);
        if (!validOption) continue;

        let finalValue = validOption.value;
        if (q.isReverse) {
          finalValue = 6 - finalValue;
        }

        rawScore[q.category] += finalValue;
        validAnswers.push({
          questionId: q.questionId,
          selectedValue: validOption.value
        });
      }
    }

    // Calculate normalized scores: min=10, max=50 for 10 questions. Formula: ((rawScore - 10) / 40) * 100
    const normalizedScore = {
      stress: Math.round(((rawScore.stress - 10) / 40) * 100),
      finance: Math.round(((rawScore.finance - 10) / 40) * 100),
      capability: Math.round(((rawScore.capability - 10) / 40) * 100),
      risk: Math.round(((rawScore.risk - 10) / 40) * 100)
    };

    // Helper to map 0-100 to 1-5 level
    const mapEvalToLevel = (score) => {
      if (score <= 20) return 1;
      if (score <= 40) return 2;
      if (score <= 60) return 3;
      if (score <= 80) return 4;
      return 5;
    };

    const level = {
      stress: mapEvalToLevel(normalizedScore.stress),
      finance: mapEvalToLevel(normalizedScore.finance),
      capability: mapEvalToLevel(normalizedScore.capability),
      risk: mapEvalToLevel(normalizedScore.risk)
    };

    const newResult = new UserEvaluationResult({
      user_id: req.user.userId,
      answers: validAnswers,
      rawScore,
      normalizedScore,
      level,
      version: '2.0'
    });

    await newResult.save();

    res.status(201).json({
      message: 'Lưu kết quả thành công.',
      normalizedScores: normalizedScore // keep response key backwards compatible if UI needs it
    });
  } catch (error) {
    console.error('Error saving evaluation:', error);
    res.status(500).json({ message: 'Lỗi server khi lưu kết quả.' });
  }
});

// Lấy kết quả đánh giá mới nhất
router.get('/latest', auth, async (req, res) => {
  try {
    const latestResult = await UserEvaluationResult.findOne({ user_id: req.user.userId })
      .sort({ createdAt: -1 });
    
    if (!latestResult) {
      return res.json(null); // return null to indicate no evaluation done
    }

    const responseData = latestResult.toObject();
    responseData.normalizedScores = responseData.normalizedScore;

    res.json(responseData);
  } catch (error) {
    console.error('Error fetching latest evaluation:', error);
    res.status(500).json({ message: 'Lỗi server khi lấy kết quả đánh giá.' });
  }
});

module.exports = router;
