const express = require('express');
const auth = require('../middleware/auth');
const PremiumAnalysis = require('../models/PremiumAnalysis');
const { generatePremiumAnalysis, pivotPremiumAnalysis, expandStepDetail } = require('../services/geminiService');
const GeminiLog = require('../models/GeminiLog');
const User = require('../models/User');
const { spendTokens } = require('../services/subscriptionService');

const router = express.Router();

const PREMIUM_ANALYSIS_COST = 120;
const PIVOT_COST = 50;

const getUserToken = async (userId) => {
  const user = await User.findById(userId);
  return user ? (user.token || 0) : 0;
};

const formatTokenResponse = (token) => ({
  remainingToken: token
});

// POST /api/premium/analyze - Generate premium analysis via Gemini
router.post('/analyze', auth, async (req, res) => {
  let tokensCharged = false;
  let premiumAnalysisId = null;
  const startTime = Date.now();

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
      // Return existing progress (no token deduction)
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
        ...formatTokenResponse(await getUserToken(req.user.userId))
      });
    }

    // Deduct tokens first
    const currentToken = await getUserToken(req.user.userId);
    if (currentToken < PREMIUM_ANALYSIS_COST) {
      return res.status(402).json({
        message: 'Không đủ token để tạo phân tích chuyên sâu. Vui lòng mua thêm token tại Cửa hàng.',
        code: 'INSUFFICIENT_TOKENS',
        requiredToken: PREMIUM_ANALYSIS_COST,
        currentToken
      });
    }

    const chargeResult = await spendTokens(User, req.user.userId, PREMIUM_ANALYSIS_COST);
    if (!chargeResult) {
      return res.status(402).json({
        message: 'Không đủ token để tạo phân tích chuyên sâu. Vui lòng mua thêm token tại Cửa hàng.',
        code: 'INSUFFICIENT_TOKENS',
        requiredToken: PREMIUM_ANALYSIS_COST,
        currentToken
      });
    }
    tokensCharged = true;

    // Call Gemini AI
    const report = await generatePremiumAnalysis(
      scenario.title,
      scenario.description,
      context,
      timeframe
    );

    // Log success
    await new GeminiLog({
      user_id: req.user.userId,
      prompt_version: 1,
      model: report.modelUsed || 'gemini-3.5-flash',
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
      premiumAnalysisId = premiumAnalysis._id;
    } catch (saveError) {
      // If a race condition occurred and it was already saved, just return the existing one
      if (saveError.code === 11000) {
        // Refund since we didn't end up creating a new analysis
        if (tokensCharged) {
          await User.updateOne({ _id: req.user.userId }, { $inc: { token: PREMIUM_ANALYSIS_COST } });
          tokensCharged = false;
        }

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
          ...formatTokenResponse(await getUserToken(req.user.userId))
        });
      }
      throw saveError;
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
      ...formatTokenResponse(chargeResult.token)
    });
  } catch (error) {
    console.error('Premium analyze error:', error);

    // Refund tokens on error
    if (tokensCharged) {
      try {
        await User.updateOne({ _id: req.user.userId }, { $inc: { token: PREMIUM_ANALYSIS_COST } });
        console.log(`[Token Refund] Refunded ${PREMIUM_ANALYSIS_COST} tokens to user ${req.user.userId}`);
      } catch (refundError) {
        console.error('Failed to refund tokens:', refundError);
      }
    }

    // Clean up created record if DB save succeeded but we still failed
    if (premiumAnalysisId) {
      try {
        await PremiumAnalysis.deleteOne({ _id: premiumAnalysisId });
      } catch (dbError) {
        console.error('Failed to clean up failed premium analysis:', dbError);
      }
    }

    // Log failure
    try {
      await new GeminiLog({
        user_id: req.user.userId,
        prompt_version: 1,
        model: error.modelUsed || 'gemini-3.5-flash',
        status: 'error',
        error_message: error.message,
        latency_ms: Date.now() - startTime
      }).save();
    } catch (logError) {
      console.error('Failed to log Gemini error:', logError);
    }

    let type = 'GENERAL';
    let statusCode = 500;
    let message = error.message || 'Lỗi hệ thống khi tạo phân tích premium.';

    const errStr = typeof message === 'string' ? message : JSON.stringify(message);
    const is503 = errStr.includes('503') || errStr.includes('UNAVAILABLE') || errStr.includes('overloaded');
    const is429 = errStr.includes('429') || errStr.includes('RESOURCE_EXHAUSTED') || errStr.includes('quota');

    if (is503 || is429) {
      type = 'OVERLOADED';
      statusCode = 503;
      message = 'Lượng truy cập đang tăng cao khiến hệ thống AI phản hồi chậm. Quá trình phân tích đã bị gián đoạn, token của bạn KHÔNG bị trừ. Vui lòng thử lại sau vài phút.';
    }

    res.status(statusCode).json({ message, type });
  }
});

// POST /api/premium/pivot - Re-plan with feedback via Gemini
router.post('/pivot', auth, async (req, res) => {
  let tokensCharged = false;
  const startTime = Date.now();
  const { progressId, currentReport, completedMilestones, feedback, context, timeframe } = req.body;

  try {
    if (!currentReport || !feedback) {
      return res.status(400).json({ message: 'Báo cáo hiện tại và feedback là bắt buộc.' });
    }

    const pivotToken = await getUserToken(req.user.userId);
    if (pivotToken < PIVOT_COST) {
      return res.status(402).json({
        message: 'Không đủ token để điều chỉnh lộ trình. Vui lòng mua thêm token tại Cửa hàng.',
        code: 'INSUFFICIENT_TOKENS',
        requiredToken: PIVOT_COST,
        currentToken: pivotToken
      });
    }

    const pivotChargeResult = await spendTokens(User, req.user.userId, PIVOT_COST);
    if (!pivotChargeResult) {
      return res.status(402).json({
        message: 'Không đủ token để điều chỉnh lộ trình. Vui lòng mua thêm token tại Cửa hàng.',
        code: 'INSUFFICIENT_TOKENS',
        requiredToken: PIVOT_COST,
        currentToken: await getUserToken(req.user.userId)
      });
    }
    tokensCharged = true;

    // Retrieve past feedback history if this progress exists
    let feedbackHistory = [];
    if (progressId) {
      const existingProgress = await PremiumAnalysis.findById(progressId);
      if (existingProgress && existingProgress.feedback_history) {
        feedbackHistory = existingProgress.feedback_history;
      }
    }

    // Call Gemini AI
    const newReport = await pivotPremiumAnalysis(
      currentReport,
      completedMilestones || [],
      feedback,
      context,
      timeframe,
      feedbackHistory
    );

    // Log success
    await new GeminiLog({
      user_id: req.user.userId,
      prompt_version: 1,
      model: newReport.modelUsed || 'gemini-2.5-flash-lite',
      status: 'success',
      latency_ms: Date.now() - startTime,
      output: newReport
    }).save();

    // Update the progress in DB if progressId provided
    if (progressId) {
      await PremiumAnalysis.findByIdAndUpdate(progressId, {
        report: newReport,
        $push: { feedback_history: feedback }
      });
    }

    res.json({
      report: newReport,
      tokenSpent: PIVOT_COST,
      ...formatTokenResponse(pivotChargeResult.token)
    });
  } catch (error) {
    console.error('Premium pivot error:', error);

    // Refund tokens on failure
    if (tokensCharged) {
      try {
        await User.updateOne({ _id: req.user.userId }, { $inc: { token: PIVOT_COST } });
        console.log(`[Token Refund] Refunded ${PIVOT_COST} tokens to user ${req.user.userId}`);
      } catch (refundError) {
        console.error('Failed to refund tokens:', refundError);
      }
    }

    // Log failure
    try {
      await new GeminiLog({
        user_id: req.user.userId,
        prompt_version: 1,
        model: error.modelUsed || 'gemini-2.5-flash-lite',
        status: 'error',
        error_message: error.message,
        latency_ms: Date.now() - startTime
      }).save();
    } catch (logError) {
      console.error('Failed to log Gemini error:', logError);
    }

    let type = 'GENERAL';
    let statusCode = 500;
    let message = error.message || 'Lỗi hệ thống khi điều chỉnh lộ trình.';

    const errStr = typeof message === 'string' ? message : JSON.stringify(message);
    const is503 = errStr.includes('503') || errStr.includes('UNAVAILABLE') || errStr.includes('overloaded');
    const is429 = errStr.includes('429') || errStr.includes('RESOURCE_EXHAUSTED') || errStr.includes('quota');

    if (is503 || is429) {
      type = 'OVERLOADED';
      statusCode = 503;
      message = 'Lượng truy cập đang tăng cao khiến hệ thống AI phản hồi chậm. Quá trình phân tích đã bị gián đoạn, token của bạn KHÔNG bị trừ. Vui lòng thử lại sau vài phút.';
    }

    res.status(statusCode).json({ message, type });
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

// PATCH /api/premium/expand-step - Expand details of a specific step in milestones
router.patch('/expand-step', auth, async (req, res) => {
  try {
    const { scenarioId, stepId } = req.body;

    if (!scenarioId || !stepId) {
      return res.status(400).json({ message: 'Thiếu scenarioId hoặc stepId.' });
    }

    const item = await PremiumAnalysis.findOne({
      user_id: req.user.userId,
      scenario_id: scenarioId
    });

    if (!item) {
      return res.status(404).json({ message: 'Không tìm thấy kịch bản và lộ trình tương ứng.' });
    }

    // Find the step in milestones
    let foundStep = null;
    let foundMilestone = null;
    for (let milestone of item.report.milestones) {
      if (Array.isArray(milestone.details)) {
        const step = milestone.details.find(s => s.id === stepId);
        if (step) {
          foundStep = step;
          foundMilestone = milestone;
          break;
        }
      }
    }

    if (!foundStep) {
      return res.status(404).json({ message: 'Không tìm thấy nhiệm vụ chi tiết.' });
    }

    // Call Gemini to generate the expanded step details
    const expanded = await expandStepDetail(
      item.title,
      foundMilestone.event,
      foundStep.title,
      foundStep.description,
      item.context
    );

    // Update the step in-place
    foundStep.description = expanded.description;
    foundStep.objectives = expanded.objectives;
    foundStep.actions = expanded.actions;
    foundStep.tools = expanded.tools;
    foundStep.expectedResult = expanded.expectedResult;

    // Save back to MongoDB
    item.markModified('report.milestones');
    await item.save();

    res.json({
      success: true,
      step: foundStep,
      report: item.report
    });
  } catch (error) {
    console.error('Expand step detail error:', error);
    res.status(500).json({ message: error.message || 'Lỗi hệ thống khi tối ưu chi tiết nhiệm vụ.' });
  }
});

module.exports = router;
