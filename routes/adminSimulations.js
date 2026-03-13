const express = require('express');

const Simulation = require('../models/Simulation');
const SimulationScenario = require('../models/SimulationScenario');
const GeminiLog = require('../models/GeminiLog');
const User = require('../models/User');
const adminAuth = require('../middleware/adminAuth');
const requireRoles = require('../middleware/requireRoles');
const {
  buildExcerpt,
  formatDateTime,
  mapSimulationStatus,
} = require('../services/adminFormatters');

const router = express.Router();

const serializeSimulationListItem = async (simulation) => {
  const [user, scenariosCount, latestLog] = await Promise.all([
    User.findById(simulation.user_id).select('full_name'),
    SimulationScenario.countDocuments({ simulation_id: simulation._id }),
    GeminiLog.findOne({ simulation_id: simulation._id }).sort({ created_at: -1 }),
  ]);

  const scenarioDocs = await SimulationScenario.find({ simulation_id: simulation._id }).limit(3);

  return {
    id: simulation._id.toString(),
    userId: simulation.user_id.toString(),
    userName: user?.full_name || 'Unknown',
    title: simulation.title,
    category: 'Simulation',
    status: mapSimulationStatus(simulation.status),
    model: latestLog?.model || '',
    promptVersion: latestLog ? `v${latestLog.prompt_version || 1}` : '',
    scenariosCount,
    enterpriseDetected: Boolean(simulation.is_enterprise),
    durationMs: latestLog?.latency_ms || 0,
    tokensUsed: (latestLog?.input_tokens || 0) + (latestLog?.output_tokens || 0),
    createdAt: formatDateTime(simulation.created_at),
    updatedAt: formatDateTime(simulation.completed_at || simulation.created_at),
    errorSummary: simulation.error_message || '',
    contextSummary: buildExcerpt(simulation.input?.decision || ''),
    scenarioHighlights: scenarioDocs.map((item) => item.title),
  };
};

router.get('/', adminAuth, requireRoles('super_admin', 'ops_support', 'ai_operator'), async (req, res) => {
  try {
    const { page = 1, limit = 20, q = '', status = 'all' } = req.query;
    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const query = {};
    if (status !== 'all') {
      query.status = status === 'running' ? 'processing' : status;
    }
    if (q) {
      query.$or = [
        { title: { $regex: q, $options: 'i' } },
        { 'input.decision': { $regex: q, $options: 'i' } },
      ];
    }

    const [items, total] = await Promise.all([
      Simulation.find(query).sort({ created_at: -1 }).skip(skip).limit(parseInt(limit, 10)),
      Simulation.countDocuments(query),
    ]);

    const serialized = await Promise.all(items.map((item) => serializeSimulationListItem(item)));

    res.json({
      items: serialized,
      total,
      page: parseInt(page, 10),
      totalPages: Math.ceil(total / parseInt(limit, 10)),
      stats: {
        completed: await Simulation.countDocuments({ status: 'completed' }),
        running: await Simulation.countDocuments({ status: 'processing' }),
        queued: await Simulation.countDocuments({ status: 'queued' }),
        failed: await Simulation.countDocuments({ status: 'failed' }),
      },
    });
  } catch (error) {
    console.error('Admin simulations list error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi lấy simulations admin.' });
  }
});

router.get('/:id', adminAuth, requireRoles('super_admin', 'ops_support', 'ai_operator'), async (req, res) => {
  try {
    const simulation = await Simulation.findById(req.params.id);
    if (!simulation) {
      return res.status(404).json({ message: 'Không tìm thấy simulation.' });
    }

    const [user, scenarios, relatedLog] = await Promise.all([
      User.findById(simulation.user_id).select('full_name email tier roles bio'),
      SimulationScenario.find({ simulation_id: simulation._id }),
      GeminiLog.findOne({ simulation_id: simulation._id }).sort({ created_at: -1 }),
    ]);

    res.json({
      id: simulation._id.toString(),
      userId: simulation.user_id.toString(),
      userName: user?.full_name || 'Unknown',
      title: simulation.title,
      status: mapSimulationStatus(simulation.status),
      input: simulation.input || {},
      summary: simulation.summary || '',
      isEnterprise: Boolean(simulation.is_enterprise),
      timeline: simulation.timeline || {},
      createdAt: formatDateTime(simulation.created_at),
      completedAt: formatDateTime(simulation.completed_at),
      errorSummary: simulation.error_message || '',
      user: user
        ? {
          id: user._id.toString(),
          name: user.full_name,
          email: user.email,
          tier: user.tier,
          role: (user.roles || []).find((role) => role !== 'user') || 'user',
          bio: user.bio || '',
        }
        : null,
      scenarios: scenarios.map((item) => ({
        id: item._id.toString(),
        type: item.scenario_type,
        title: item.title,
        description: item.description,
        careerGrowth: item.career_growth,
        happiness: item.happiness,
        roi: item.roi,
        deepAnalysis: item.deep_analysis || {},
      })),
      relatedLog: relatedLog
        ? {
          id: relatedLog._id.toString(),
          model: relatedLog.model,
          promptVersion: `v${relatedLog.prompt_version || 1}`,
          status: relatedLog.status === 'error' ? 'failed' : relatedLog.status,
          latencyMs: relatedLog.latency_ms || 0,
          inputTokens: relatedLog.input_tokens || 0,
          outputTokens: relatedLog.output_tokens || 0,
          errorMessage: relatedLog.error_message || '',
        }
        : null,
    });
  } catch (error) {
    console.error('Admin simulation detail error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi lấy chi tiết simulation.' });
  }
});

module.exports = router;
