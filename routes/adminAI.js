const express = require('express');

const GeminiLog = require('../models/GeminiLog');
const Simulation = require('../models/Simulation');
const adminAuth = require('../middleware/adminAuth');
const requireRoles = require('../middleware/requireRoles');
const { formatCost, formatDateTime, formatLatency } = (() => {
  const formatLatency = (value) => {
    if (!value && value !== 0) return '--';
    if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
    return `${value}ms`;
  };

  const formatCost = (value) => `$${Number(value || 0).toFixed(3)}`;
  return { formatCost, formatDateTime: require('../services/adminFormatters').formatDateTime, formatLatency };
})();

const router = express.Router();

router.get('/', adminAuth, requireRoles('super_admin', 'ops_support', 'ai_operator'), async (req, res) => {
  try {
    const { page = 1, limit = 20, status = 'all', model = 'all', q = '' } = req.query;
    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const query = {};
    if (status !== 'all') {
      query.status = status === 'failed' ? 'error' : status;
    }
    if (model !== 'all') query.model = model;
    if (q) {
      query.$or = [
        { model: { $regex: q, $options: 'i' } },
        { error_message: { $regex: q, $options: 'i' } },
      ];
    }

    const [items, total] = await Promise.all([
      GeminiLog.find(query).sort({ created_at: -1 }).skip(skip).limit(parseInt(limit, 10)),
      GeminiLog.countDocuments(query),
    ]);

    const simulationIds = items.map((item) => item.simulation_id).filter(Boolean);
    const simulations = await Simulation.find({ _id: { $in: simulationIds } }).select('title user_id');
    const simulationMap = new Map(simulations.map((item) => [item._id.toString(), item]));

    const serialized = items.map((item) => {
      const simulation = item.simulation_id ? simulationMap.get(item.simulation_id.toString()) : null;
      return {
        id: item._id.toString(),
        requestType: item.simulation_id ? 'simulation' : 'premium',
        correlationId: item._id.toString(),
        userName: simulation?.title || 'N/A',
        model: item.model,
        promptVersion: `v${item.prompt_version || 1}`,
        status: item.status === 'error' ? 'failed' : item.status,
        latencyMs: item.latency_ms || 0,
        latencyLabel: formatLatency(item.latency_ms || 0),
        costLabel: formatCost(item.cost_estimate || 0),
        estimatedCost: item.cost_estimate || 0,
        tokensIn: item.input_tokens || 0,
        tokensOut: item.output_tokens || 0,
        simulationId: item.simulation_id ? item.simulation_id.toString() : null,
        createdAt: formatDateTime(item.created_at),
        errorCode: item.error_message || '',
      };
    });

    const avgLatency =
      items.length > 0
        ? Math.round(items.reduce((acc, item) => acc + (item.latency_ms || 0), 0) / items.length)
        : 0;

    res.json({
      items: serialized,
      total,
      page: parseInt(page, 10),
      totalPages: Math.ceil(total / parseInt(limit, 10)),
      stats: {
        success: serialized.filter((item) => item.status === 'success').length,
        failed: serialized.filter((item) => item.status === 'failed').length,
        retrying: serialized.filter((item) => item.status === 'retrying').length,
        avgLatency,
      },
    });
  } catch (error) {
    console.error('Admin AI logs error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi lấy AI logs.' });
  }
});

module.exports = router;
