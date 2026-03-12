const express = require('express');
const auth = require('../middleware/auth');
const PremiumAnalysis = require('../models/PremiumAnalysis');
const { generatePremiumAnalysis, pivotPremiumAnalysis } = require('../services/geminiService');
const GeminiLog = require('../models/GeminiLog');

const router = express.Router();

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
        isExisting: true
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
    await premiumAnalysis.save();

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
      timeframe: premiumAnalysis.timeframe
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

    // Update the progress in DB if progressId provided
    if (progressId) {
      await PremiumAnalysis.findByIdAndUpdate(progressId, {
        report: newReport
      });
    }

    res.json({ report: newReport });
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
    const item = await PremiumAnalysis.findOne({ _id: req.params.id, user_id: req.user.userId });
    if (!item) {
      return res.status(404).json({ message: 'Không tìm thấy tiến trình.' });
    }

    if (completedMilestones !== undefined) {
      item.completed_milestones = completedMilestones;
    }
    if (report) {
      item.report = report;
    }
    await item.save();

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
