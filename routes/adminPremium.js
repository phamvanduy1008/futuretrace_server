const express = require('express');

const PremiumAnalysis = require('../models/PremiumAnalysis');
const SimulationScenario = require('../models/SimulationScenario');
const User = require('../models/User');
const adminAuth = require('../middleware/adminAuth');
const requireRoles = require('../middleware/requireRoles');
const { formatDateTime } = require('../services/adminFormatters');

const router = express.Router();

const deriveStatus = (analysis) => {
  const totalMilestones = analysis.report?.milestones?.length || 0;
  const completed = analysis.completed_milestones?.length || 0;
  if (totalMilestones > 0 && completed >= totalMilestones) return 'completed';
  return 'active';
};

const serializeAnalysis = async (analysis) => {
  const [user, scenarioDoc] = await Promise.all([
    User.findById(analysis.user_id).select('full_name email'),
    SimulationScenario.findById(analysis.scenario_id).select('simulation_id title'),
  ]);

  const totalMilestones = analysis.report?.milestones?.length || 0;
  const completed = analysis.completed_milestones?.length || 0;
  const nextMilestone = analysis.report?.milestones?.[completed]?.event || (totalMilestones > 0 ? 'Đã hoàn tất' : '--');
  const simulationId = scenarioDoc?.simulation_id?.toString() || null;

  return {
    id: analysis._id.toString(),
    scenarioId: analysis.scenario_id,
    simulationId,
    userId: analysis.user_id?.toString() || '',
    userName: user?.full_name || 'Người dùng ẩn danh',
    userEmail: user?.email || '',
    title: analysis.title || analysis.scenario?.title || 'Phân tích chiến lược chuyên sâu',
    category: analysis.category || 'career',
    status: deriveStatus(analysis),
    timeframeMonths: analysis.timeframe || 12,
    pivotCount: analysis.report?.strategicPivotPoints?.length || 0,
    completionRate: totalMilestones > 0 ? Math.round((completed / totalMilestones) * 100) : 0,
    createdAt: formatDateTime(analysis.created_at),
    updatedAt: formatDateTime(analysis.updated_at || analysis.created_at),
    nextMilestone,
    feedbackHistory: analysis.feedback_history || [],
    report: analysis.report || {},
    context: analysis.context || {},
    scenario: analysis.scenario || {},
    completedMilestones: analysis.completed_milestones || [],
  };
};

router.get('/', adminAuth, requireRoles('super_admin', 'ops_support'), async (req, res) => {
  try {
    const { page = 1, limit = 20, status = 'all', q = '' } = req.query;
    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const query = {};
    if (q) {
      query.$or = [{ title: { $regex: q, $options: 'i' } }];
    }

    const [items, total] = await Promise.all([
      PremiumAnalysis.find(query).sort({ updated_at: -1, created_at: -1 }).skip(skip).limit(parseInt(limit, 10)),
      PremiumAnalysis.countDocuments(query),
    ]);

    const serialized = await Promise.all(items.map((item) => serializeAnalysis(item)));
    const filtered = status === 'all' ? serialized : serialized.filter((item) => item.status === status);

    res.json({
      items: filtered,
      total: status === 'all' ? total : filtered.length,
      page: parseInt(page, 10),
      totalPages: Math.ceil((status === 'all' ? total : filtered.length) / parseInt(limit, 10)),
    });
  } catch (error) {
    console.error('Admin premium analyses list error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi lấy premium analyses admin.' });
  }
});

router.get('/:id', adminAuth, requireRoles('super_admin', 'ops_support'), async (req, res) => {
  try {
    const analysis = await PremiumAnalysis.findById(req.params.id);
    if (!analysis) {
      return res.status(404).json({ message: 'Không tìm thấy premium analysis.' });
    }

    res.json(await serializeAnalysis(analysis));
  } catch (error) {
    console.error('Admin premium analysis detail error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi lấy chi tiết premium analysis.' });
  }
});

module.exports = router;
