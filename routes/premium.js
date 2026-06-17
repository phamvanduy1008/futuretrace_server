const express = require('express');
const auth = require('../middleware/auth');
const PremiumAnalysis = require('../models/PremiumAnalysis');
const { generatePremiumAnalysis, pivotPremiumAnalysis } = require('../services/geminiService');
const GeminiLog = require('../models/GeminiLog');
const User = require('../models/User');

const router = express.Router();

const PREMIUM_ANALYSIS_COST = 10000;
const PIVOT_COST = 5000;

const getTokenBalance = async (userId) => {
  const user = await User.findById(userId).select('token');
  return user?.token || 0;
};

const spendTokens = async (userId, amount) => {
  return User.findOneAndUpdate(
    { _id: userId, token: { $gte: amount } },
    { $inc: { token: -amount } },
    { new: true }
  ).select('token');
};

// POST /api/premium/analyze - Generate premium analysis via Gemini
router.post('/analyze', auth, async (req, res) => {
  try {
    const { scenario, context, timeframe } = req.body;

    if (!scenario || !scenario.title) {
      return res.status(400).json({ message: 'Thông tin kịch bản là bắt buộc.' });
    }

    // Check if already exists for this scenario
    const existing = await PremiumAnalysis.findOne({
      user_id: req.user.userId,
      scenario_id: scenario.id
    });

    if (existing) {
      // Return existing progress
      return res.json({
        id: existing._id.toString(),
        scenarioId: existing.scenario_id,
        title: existing.title,
        category: existing.category,
        date: existing.created_at.toLocaleDateString('vi-VN', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase(),
        report: existing.report,
        context: existing.context,
        scenario: existing.scenario,
        completedMilestones: existing.completed_milestones,
        timeframe: existing.timeframe,
        isExisting: true,
        remainingToken: await getTokenBalance(req.user.userId)
      });
    }

    const currentToken = await getTokenBalance(req.user.userId);
    if (currentToken < PREMIUM_ANALYSIS_COST) {
      return res.status(402).json({
        message: 'Không đủ token để tạo kịch bản chi tiết. Vui lòng nâng cấp gói premium.',
        code: 'INSUFFICIENT_TOKENS',
        requiredToken: PREMIUM_ANALYSIS_COST,
        currentToken
      });
    }

    // Call Gemini AI
    const startTime = Date.now();
    let report;
    try {
      report = await generatePremiumAnalysis(
        scenario.title,
        scenario.description,
        context,
        timeframe
      );
    } catch (aiError) {
      await new GeminiLog({
        user_id: req.user.userId,
        prompt_version: 1,
        model: 'gemini-2.0-flash',
        status: 'error',
        error_message: aiError.message,
        latency_ms: Date.now() - startTime
      }).save();

      return res.status(500).json({ message: aiError.message });
    }

    // Log success
    await new GeminiLog({
      user_id: req.user.userId,
      prompt_version: 1,
      model: 'gemini-2.0-flash',
      status: 'success',
      latency_ms: Date.now() - startTime,
      output: report
    }).save();

    // Save to DB
    const premiumAnalysis = new PremiumAnalysis({
      user_id: req.user.userId,
      scenario_id: scenario.id,
      title: scenario.title,
      category: scenario.category || 'SỰ NGHIỆP',
      report,
      context: context || {},
      scenario: scenario,
      completed_milestones: [],
      timeframe: timeframe || 12
    });
    
    try {
      await premiumAnalysis.save();
    } catch (saveError) {
      // If a race condition occurred and it was already saved, just return the existing one
      if (saveError.code === 11000) {
        const existingAgain = await PremiumAnalysis.findOne({
          user_id: req.user.userId,
          scenario_id: scenario.id
        });
        return res.json({
          id: existingAgain._id.toString(),
          scenarioId: existingAgain.scenario_id,
          title: existingAgain.title,
          category: existingAgain.category,
          date: existingAgain.created_at.toLocaleDateString('vi-VN', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase(),
          report: existingAgain.report,
          context: existingAgain.context,
          scenario: existingAgain.scenario,
          completedMilestones: existingAgain.completed_milestones,
          timeframe: existingAgain.timeframe,
          isExisting: true,
          remainingToken: await getTokenBalance(req.user.userId)
        });
      }
      throw saveError;
    }

    const chargedUser = await spendTokens(req.user.userId, PREMIUM_ANALYSIS_COST);
    if (!chargedUser) {
      await PremiumAnalysis.deleteOne({ _id: premiumAnalysis._id });
      return res.status(402).json({
        message: 'Không đủ token để tạo kịch bản chi tiết. Vui lòng nâng cấp gói premium.',
        code: 'INSUFFICIENT_TOKENS',
        requiredToken: PREMIUM_ANALYSIS_COST,
        currentToken: await getTokenBalance(req.user.userId)
      });
    }

    res.status(201).json({
      id: premiumAnalysis._id.toString(),
      scenarioId: premiumAnalysis.scenario_id,
      title: premiumAnalysis.title,
      category: premiumAnalysis.category,
      date: premiumAnalysis.created_at.toLocaleDateString('vi-VN', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase(),
      report: premiumAnalysis.report,
      context: premiumAnalysis.context,
      scenario: premiumAnalysis.scenario,
      completedMilestones: premiumAnalysis.completed_milestones,
      timeframe: premiumAnalysis.timeframe,
      tokenSpent: PREMIUM_ANALYSIS_COST,
      remainingToken: chargedUser.token
    });
  } catch (error) {
    console.error('Premium analyze error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi tạo phân tích premium.' });
  }
});

// POST /api/premium/pivot - Re-plan with feedback via Gemini
router.post('/pivot', auth, async (req, res) => {
  try {
    const { progressId, currentReport, completedMilestones, feedback, context, timeframe } = req.body;

    const currentToken = await getTokenBalance(req.user.userId);
    if (currentToken < PIVOT_COST) {
      return res.status(402).json({
        message: 'Không đủ token để tối ưu lộ trình. Vui lòng nâng cấp gói premium.',
        code: 'INSUFFICIENT_TOKENS',
        requiredToken: PIVOT_COST,
        currentToken
      });
    }

    if (!currentReport || !feedback) {
      return res.status(400).json({ message: 'Báo cáo hiện tại và feedback là bắt buộc.' });
    }

    const startTime = Date.now();
    let newReport;
    try {
      newReport = await pivotPremiumAnalysis(
        currentReport,
        completedMilestones || [],
        feedback,
        context,
        timeframe
      );
    } catch (aiError) {
      await new GeminiLog({
        user_id: req.user.userId,
        prompt_version: 1,
        model: 'gemini-2.0-flash',
        status: 'error',
        error_message: aiError.message,
        latency_ms: Date.now() - startTime
      }).save();

      return res.status(500).json({ message: aiError.message });
    }

    // Log success
    await new GeminiLog({
      user_id: req.user.userId,
      prompt_version: 1,
      model: 'gemini-2.0-flash',
      status: 'success',
      latency_ms: Date.now() - startTime,
      output: newReport
    }).save();

    const chargedUser = await spendTokens(req.user.userId, PIVOT_COST);
    if (!chargedUser) {
      return res.status(402).json({
        message: 'Không đủ token để tối ưu lộ trình. Vui lòng nâng cấp gói premium.',
        code: 'INSUFFICIENT_TOKENS',
        requiredToken: PIVOT_COST,
        currentToken: await getTokenBalance(req.user.userId)
      });
    }

    // Update the progress in DB if progressId provided
    if (progressId) {
      await PremiumAnalysis.findByIdAndUpdate(progressId, {
        report: newReport
      });
    }

    res.json({ report: newReport, tokenSpent: PIVOT_COST, remainingToken: chargedUser.token });
  } catch (error) {
    console.error('Premium pivot error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi điều chỉnh lộ trình.' });
  }
});

// GET /api/premium/progress - List user's progress items
router.get('/progress', auth, async (req, res) => {
  try {
    const items = await PremiumAnalysis.find({ user_id: req.user.userId })
      .sort({ created_at: -1 });

    const formatted = items.map(item => ({
      id: item._id.toString(),
      scenarioId: item.scenario_id,
      title: item.title,
      category: item.category,
      date: item.created_at.toLocaleDateString('vi-VN', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase(),
      report: item.report,
      context: item.context,
      scenario: item.scenario,
      completedMilestones: item.completed_milestones,
      timeframe: item.timeframe
    }));

    res.json(formatted);
  } catch (error) {
    console.error('Get progress error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống.' });
  }
});

// GET /api/premium/progress/:id - Get single progress item
router.get('/progress/:id', auth, async (req, res) => {
  try {
    const item = await PremiumAnalysis.findOne({ _id: req.params.id, user_id: req.user.userId });
    if (!item) {
      return res.status(404).json({ message: 'Không tìm thấy tiến trình.' });
    }

    res.json({
      id: item._id.toString(),
      scenarioId: item.scenario_id,
      title: item.title,
      category: item.category,
      date: item.created_at.toLocaleDateString('vi-VN', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase(),
      report: item.report,
      context: item.context,
      scenario: item.scenario,
      completedMilestones: item.completed_milestones,
      timeframe: item.timeframe
    });
  } catch (error) {
    console.error('Get progress item error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống.' });
  }
});

// PUT /api/premium/progress/:id - Update milestone completion
router.put('/progress/:id', auth, async (req, res) => {
  try {
    const { completedMilestones, report } = req.body;
    
    const updateData = {};
    if (completedMilestones !== undefined) {
      updateData.completed_milestones = completedMilestones;
    }
    if (report) {
      updateData.report = report;
    }

    const item = await PremiumAnalysis.findOneAndUpdate(
      { _id: req.params.id, user_id: req.user.userId },
      { $set: updateData },
      { new: true }
    );

    if (!item) {
      return res.status(404).json({ message: 'Không tìm thấy tiến trình.' });
    }

    res.json({
      id: item._id.toString(),
      scenarioId: item.scenario_id,
      title: item.title,
      category: item.category,
      report: item.report,
      completedMilestones: item.completed_milestones,
      timeframe: item.timeframe
    });
  } catch (error) {
    console.error('Update progress error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống.' });
  }
});

// DELETE /api/premium/progress/:id - Delete progress item
router.delete('/progress/:id', auth, async (req, res) => {
  try {
    const item = await PremiumAnalysis.findOne({ _id: req.params.id, user_id: req.user.userId });
    if (!item) {
      return res.status(404).json({ message: 'Không tìm thấy tiến trình.' });
    }

    await PremiumAnalysis.deleteOne({ _id: item._id });
    res.json({ message: 'Đã xóa tiến trình thành công.' });
  } catch (error) {
    console.error('Delete progress error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống.' });
  }
});

// GET /api/premium/progress/by-scenario/:scenarioId - Find progress by scenario ID
router.get('/progress/by-scenario/:scenarioId', auth, async (req, res) => {
  try {
    const item = await PremiumAnalysis.findOne({
      user_id: req.user.userId,
      scenario_id: req.params.scenarioId
    });

    if (!item) {
      return res.json(null);
    }

    res.json({
      id: item._id.toString(),
      scenarioId: item.scenario_id,
      title: item.title,
      category: item.category,
      date: item.created_at.toLocaleDateString('vi-VN', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase(),
      report: item.report,
      context: item.context,
      scenario: item.scenario,
      completedMilestones: item.completed_milestones,
      timeframe: item.timeframe
    });
  } catch (error) {
    console.error('Get progress by scenario error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống.' });
  }
});

module.exports = router;
