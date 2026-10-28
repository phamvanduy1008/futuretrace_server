/**
 * GET /api/admin/metrics/investor?days=30 - Bộ chỉ số cho báo cáo bảo vệ / hồ sơ gọi vốn:
 * tăng trưởng người dùng, kích hoạt, giữ chân, chất lượng AI (groundedness, aiCoverage, 👍),
 * hiệu năng (độ trễ P50/P95), tỷ trọng engine chính (model fine-tune) và kinh tế đơn vị (chi phí AI, doanh thu).
 */
const express = require('express');
const User = require('../models/User');
const Simulation = require('../models/Simulation');
const GeminiLog = require('../models/GeminiLog');
const Feedback = require('../models/Feedback');
const Transaction = require('../models/Transaction');
const adminAuth = require('../middleware/adminAuth');
const requireRoles = require('../middleware/requireRoles');
const llmGateway = require('../services/llmGateway');

const router = express.Router();
const USD_TO_VND = 25400;

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const round = (v, d = 1) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);

router.get('/investor', adminAuth, requireRoles('super_admin', 'ops_support', 'ai_operator'), async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const since = new Date(Date.now() - days * 86400000);

    const [totalUsers, newUsers, consentedUsers, sims, logs, feedback, revenueAgg] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ created_at: { $gte: since } }),
      User.countDocuments({ 'consent.accepted_at': { $exists: true } }),
      Simulation.find({ created_at: { $gte: since } }).select('user_id status').lean(),
      GeminiLog.find({ created_at: { $gte: since }, task: 'simulation_v2' }).select('status provider latency_ms quality cost_estimate').lean(),
      Feedback.find({ created_at: { $gte: since } }).select('rating numbers_plausible provider').lean(),
      Transaction.aggregate([
        { $match: { created_at: { $gte: since }, status: 'success', paymentMethod: { $ne: 'free_claim' } } },
        { $group: { _id: null, vnd: { $sum: '$amount' }, orders: { $sum: 1 }, payers: { $addToSet: '$userId' } } }
      ]).catch(() => [])
    ]);

    // Người dùng hoạt động = có ít nhất 1 mô phỏng trong kỳ; quay lại = có mô phỏng ở >= 2 ngày khác nhau
    const simsByUser = new Map();
    for (const s of sims) {
      const k = String(s.user_id);
      simsByUser.set(k, (simsByUser.get(k) || 0) + 1);
    }
    const completed = sims.filter(s => s.status === 'completed').length;
    const failed = sims.filter(s => s.status === 'failed').length;

    const ok = logs.filter(l => l.status === 'success');
    const latencies = ok.map(l => l.latency_ms).filter(Number.isFinite);
    const firstTokens = ok.map(l => l.quality?.firstTokenMs).filter(Number.isFinite);
    const byProvider = {};
    for (const l of ok) byProvider[l.provider || 'unknown'] = (byProvider[l.provider || 'unknown'] || 0) + 1;
    const ups = feedback.filter(f => f.rating === 1).length;
    const plausibleAnswered = feedback.filter(f => typeof f.numbers_plausible === 'boolean');
    const aiCostUsd = ok.reduce((sum, l) => sum + (l.cost_estimate || 0), 0);
    const revenue = revenueAgg[0] || { vnd: 0, orders: 0, payers: [] };

    res.json({
      periodDays: days,
      growth: {
        totalUsers,
        newUsers,
        consentedUsers,
        activeUsers: simsByUser.size,
        repeatUsers: [...simsByUser.values()].filter(n => n >= 2).length
      },
      engagement: {
        simulations: sims.length,
        completionRate: completed + failed ? round(completed / (completed + failed) * 100) : null,
        simulationsPerActiveUser: simsByUser.size ? round(sims.length / simsByUser.size, 2) : null
      },
      aiQuality: {
        groundednessAvg: round(avg(ok.map(l => l.quality?.groundedness).filter(Number.isFinite)) * 100),
        aiCoverageAvg: round(avg(ok.map(l => l.quality?.aiCoverage).filter(Number.isFinite)) * 100),
        thumbsUpRate: feedback.length ? round(ups / feedback.length * 100) : null,
        numbersPlausibleRate: plausibleAnswered.length ? round(plausibleAnswered.filter(f => f.numbers_plausible).length / plausibleAnswered.length * 100) : null,
        feedbackCount: feedback.length
      },
      performance: {
        latencyMsP50: pct(latencies, 0.5),
        latencyMsP95: pct(latencies, 0.95),
        firstTokenMsP50: pct(firstTokens, 0.5),
        firstTokenMsP95: pct(firstTokens, 0.95),
        errorRate: logs.length ? round((logs.length - ok.length) / logs.length * 100) : null
      },
      engine: {
        requestsByProvider: byProvider,
        primaryModelShare: ok.length ? round((byProvider.modal || 0) / ok.length * 100) : null,
        gateway: llmGateway.status()
      },
      unitEconomics: {
        aiCostVnd: Math.round(aiCostUsd * USD_TO_VND),
        aiCostPerSimulationVnd: ok.length ? Math.round(aiCostUsd * USD_TO_VND / ok.length) : null,
        revenueVnd: revenue.vnd,
        paidOrders: revenue.orders,
        payingUsers: revenue.payers.length,
        conversionToPaidPercent: totalUsers ? round(revenue.payers.length / totalUsers * 100, 2) : null,
        note: 'Chi phí GPU Modal tính theo hóa đơn Modal (không có trong log); chi phí AI ở đây là Gemini dự phòng.'
      }
    });
  } catch (error) {
    console.error('Investor metrics error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống.' });
  }
});

module.exports = router;
