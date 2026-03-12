const express = require('express');
const auth = require('../middleware/auth');
const Simulation = require('../models/Simulation');
const SimulationScenario = require('../models/SimulationScenario');
const { generateSimulation } = require('../services/geminiService');
const GeminiLog = require('../models/GeminiLog');

const router = express.Router();

// POST /api/simulations - Create a new simulation (calls Gemini AI)
router.post('/', auth, async (req, res) => {
  try {
    const { decision, stress, personalFinance, academicPerformance, risk, otherFactors, tier, folderName } = req.body;

    if (!decision || !decision.trim()) {
      return res.status(400).json({ message: 'Vui lòng nhập quyết định cần phân tích.' });
    }

    const inputData = { decision, stress, personalFinance, academicPerformance, risk, otherFactors, tier };

    // Create simulation record
    const simulation = new Simulation({
      user_id: req.user.userId,
      title: folderName || `Nhóm kịch bản: ${decision.slice(0, 50)}`,
      input: inputData,
      status: 'processing'
    });
    await simulation.save();

    // Call Gemini AI
    const startTime = Date.now();
    let aiResult;
    try {
      aiResult = await generateSimulation(inputData);
    } catch (aiError) {
      simulation.status = 'failed';
      simulation.error_message = aiError.message;
      await simulation.save();

      // Log failure
      await new GeminiLog({
        user_id: req.user.userId,
        simulation_id: simulation._id,
        prompt_version: 1,
        model: 'gemini-2.0-flash',
        status: 'error',
        error_message: aiError.message,
        latency_ms: Date.now() - startTime
      }).save();

      return res.status(500).json({ message: aiError.message, type: 'GENERAL' });
    }

    const latency = Date.now() - startTime;

    // Log success
    await new GeminiLog({
      user_id: req.user.userId,
      simulation_id: simulation._id,
      prompt_version: 1,
      model: 'gemini-2.0-flash',
      status: 'success',
      latency_ms: latency,
      output: aiResult
    }).save();

    // Update simulation with results
    simulation.status = 'completed';
    simulation.completed_at = new Date();
    simulation.summary = aiResult.summary;
    simulation.is_enterprise = aiResult.isEnterprise || false;
    simulation.timeline = aiResult.timeline;
    simulation.folder_name = folderName || `Nhóm kịch bản: ${decision.slice(0, 50)}`;
    await simulation.save();

    // Save scenarios to DB
    const savedScenarios = [];
    if (aiResult.scenarios && aiResult.scenarios.length > 0) {
      for (const s of aiResult.scenarios) {
        const scenario = new SimulationScenario({
          simulation_id: simulation._id,
          scenario_type: s.type || 'Neutral',
          title: s.title,
          description: s.description,
          career_growth: s.careerGrowth,
          happiness: s.happiness,
          roi: s.roi,
          deep_analysis: s.deepAnalysis
        });
        await scenario.save();
        savedScenarios.push({
          id: scenario._id.toString(),
          title: scenario.title,
          description: scenario.description,
          careerGrowth: scenario.career_growth,
          happiness: scenario.happiness,
          roi: scenario.roi,
          type: scenario.scenario_type,
          deepAnalysis: scenario.deep_analysis
        });
      }
    }

    // Return in the format the frontend expects (PredictionResult)
    const dateStr = new Date().toLocaleDateString('vi-VN', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();

    res.status(201).json({
      simulationId: simulation._id,
      isEnterprise: aiResult.isEnterprise || false,
      summary: aiResult.summary,
      scenarios: savedScenarios,
      timeline: aiResult.timeline,
      // Extra data for history item
      historyItem: {
        id: simulation._id,
        title: simulation.folder_name,
        category: 'MÔ PHỎNG',
        author: 'user',
        isAnonymous: false,
        date: dateStr,
        desc: `Bao gồm ${savedScenarios.length} kịch bản mô phỏng cho quyết định: ${decision}`,
        reliability: 95,
        isFolder: true,
        scenarios: savedScenarios.map(s => ({
          id: s.id,
          title: s.title,
          category: 'SỰ NGHIỆP',
          date: dateStr,
          desc: s.description,
          reliability: 95,
          color: s.type === 'Risk' ? 'bg-rose-500' : (s.type === 'Positive' ? 'bg-emerald-500' : 'bg-blue-500'),
          type: s.type,
          metrics: { career: s.careerGrowth, happiness: s.happiness, roi: s.roi },
          deepAnalysis: s.deepAnalysis
        })),
        metrics: {
          career: Math.round(savedScenarios.reduce((acc, s) => acc + s.careerGrowth, 0) / Math.max(savedScenarios.length, 1)),
          happiness: Math.round(savedScenarios.reduce((acc, s) => acc + s.happiness, 0) / Math.max(savedScenarios.length, 1)),
          roi: Math.round(savedScenarios.reduce((acc, s) => acc + s.roi, 0) / Math.max(savedScenarios.length, 1))
        }
      }
    });
  } catch (error) {
    console.error('Create simulation error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi tạo mô phỏng.' });
  }
});

// GET /api/simulations - List user's simulations (for history page)
router.get('/', auth, async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '' } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const query = { user_id: req.user.userId, status: 'completed' };
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { 'input.decision': { $regex: search, $options: 'i' } }
      ];
    }

    const [simulations, total] = await Promise.all([
      Simulation.find(query).sort({ created_at: -1 }).skip(skip).limit(parseInt(limit)),
      Simulation.countDocuments(query)
    ]);

    // Get scenarios for each simulation
    const results = [];
    for (const sim of simulations) {
      const scenarios = await SimulationScenario.find({ simulation_id: sim._id });
      const dateStr = sim.created_at.toLocaleDateString('vi-VN', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();

      const scenariosFormatted = scenarios.map(s => ({
        id: s._id.toString(),
        title: s.title,
        category: 'SỰ NGHIỆP',
        date: dateStr,
        desc: s.description,
        reliability: 95,
        color: s.scenario_type === 'Risk' ? 'bg-rose-500' : (s.scenario_type === 'Positive' ? 'bg-emerald-500' : 'bg-blue-500'),
        type: s.scenario_type,
        metrics: { career: s.career_growth, happiness: s.happiness, roi: s.roi },
        deepAnalysis: s.deep_analysis,
        description: s.description,
        careerGrowth: s.career_growth,
        happiness: s.happiness,
        roi: s.roi
      }));

      results.push({
        id: sim._id.toString(),
        title: sim.folder_name || sim.title,
        category: 'MÔ PHỎNG',
        author: 'user',
        isAnonymous: false,
        date: dateStr,
        desc: `Bao gồm ${scenarios.length} kịch bản mô phỏng cho quyết định: ${sim.input?.decision || ''}`,
        reliability: 95,
        isFolder: true,
        scenarios: scenariosFormatted,
        metrics: {
          career: scenariosFormatted.length > 0 ? Math.round(scenariosFormatted.reduce((acc, s) => acc + (s.metrics?.career || 0), 0) / scenariosFormatted.length) : 0,
          happiness: scenariosFormatted.length > 0 ? Math.round(scenariosFormatted.reduce((acc, s) => acc + (s.metrics?.happiness || 0), 0) / scenariosFormatted.length) : 0,
          roi: scenariosFormatted.length > 0 ? Math.round(scenariosFormatted.reduce((acc, s) => acc + (s.metrics?.roi || 0), 0) / scenariosFormatted.length) : 0
        }
      });
    }

    res.json({
      items: results,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit))
    });
  } catch (error) {
    console.error('Get simulations error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống.' });
  }
});

// GET /api/simulations/:id - Get single simulation with scenarios
router.get('/:id', auth, async (req, res) => {
  try {
    const simulation = await Simulation.findOne({ _id: req.params.id, user_id: req.user.userId });
    if (!simulation) {
      return res.status(404).json({ message: 'Không tìm thấy mô phỏng.' });
    }

    const scenarios = await SimulationScenario.find({ simulation_id: simulation._id });
    const dateStr = simulation.created_at.toLocaleDateString('vi-VN', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();

    res.json({
      id: simulation._id,
      title: simulation.folder_name || simulation.title,
      input: simulation.input,
      status: simulation.status,
      summary: simulation.summary,
      is_enterprise: simulation.is_enterprise,
      timeline: simulation.timeline,
      date: dateStr,
      scenarios: scenarios.map(s => ({
        id: s._id.toString(),
        title: s.title,
        description: s.description,
        careerGrowth: s.career_growth,
        happiness: s.happiness,
        roi: s.roi,
        type: s.scenario_type,
        deepAnalysis: s.deep_analysis
      }))
    });
  } catch (error) {
    console.error('Get simulation error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống.' });
  }
});

// DELETE /api/simulations/:id - Delete simulation and its scenarios
router.delete('/:id', auth, async (req, res) => {
  try {
    const simulation = await Simulation.findOne({ _id: req.params.id, user_id: req.user.userId });
    if (!simulation) {
      return res.status(404).json({ message: 'Không tìm thấy mô phỏng.' });
    }

    await SimulationScenario.deleteMany({ simulation_id: simulation._id });
    await Simulation.deleteOne({ _id: simulation._id });

    res.json({ message: 'Đã xóa mô phỏng thành công.' });
  } catch (error) {
    console.error('Delete simulation error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống.' });
  }
});

module.exports = router;
