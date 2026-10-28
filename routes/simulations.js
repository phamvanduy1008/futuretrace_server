const express = require('express');
const auth = require('../middleware/auth');
const requireConsent = require('../middleware/requireConsent');
const Simulation = require('../models/Simulation');
const SimulationScenario = require('../models/SimulationScenario');
const { analyzeInputReadiness } = require('../services/geminiService');
const simulationRunner = require('../services/simulationRunner');
const llmGateway = require('../services/llmGateway');
const GeminiLog = require('../models/GeminiLog');
const Feedback = require('../models/Feedback');
const { spendTokens } = require('../services/subscriptionService');
const User = require('../models/User');

const router = express.Router();
const SIMULATION_COST = 80;
// POST /api/simulations/pre-check - Check if input is detailed enough
router.post('/pre-check', auth, async (req, res) => {
  try {
    const { decision } = req.body;
    if (!decision || !decision.trim()) {
      return res.status(400).json({ message: 'Vui lòng nhập quyết định cần phân tích.' });
    }
    const result = await analyzeInputReadiness({ decision });
    res.json(result);
  } catch (error) {
    console.error('Pre-check error:', error);
    let type = 'GENERAL';
    let statusCode = 500;
    let message = 'Lỗi hệ thống khi kiểm tra dữ liệu.';
    const is429 = error.status === 429 || String(error.message || '').includes('RESOURCE_EXHAUSTED');
    if (error.status === 503 || is429 || (error.message && (error.message.includes('503') || error.message.includes('429')))) {
      type = 'OVERLOADED';
      statusCode = 503;
      message = 'Lượng truy cập đang tăng cao khiến hệ thống AI phản hồi chậm. Vui lòng thử lại sau vài phút.';
    }
    res.status(statusCode).json({ message: error.message || message, type });
  }
});

// ---------------------------------------------------------------- helpers dùng chung (JSON + SSE)
const SIM_PROMPT_VERSION = 2; // services/prompts/simulationTask.js (simulation_v2)

const readSimulationInput = (body = {}) => {
  const { decision, stress, personalFinance, academicPerformance, risk, otherFactors, tier, folderName, timeHorizon,
    location, programId, expectedScore, budgetPerYearMillion, educationLevel } = body;
  const inputData = {
    decision, stress, personalFinance, academicPerformance, risk, otherFactors, tier, timeHorizon: timeHorizon || 5,
    location, programId, expectedScore, budgetPerYearMillion, educationLevel
  };
  return { inputData, folderName };
};

const insufficientTokensBody = async (userId) => {
  const user = await User.findById(userId);
  return {
    message: 'Không đủ token để tạo mô phỏng. Vui lòng mua thêm token tại Cửa hàng.',
    code: 'INSUFFICIENT_TOKENS',
    requiredToken: SIMULATION_COST,
    currentToken: user ? (user.token || 0) : 0
  };
};

const normalizeScenarioType = (type) => {
  if (!type) return 'Neutral';
  const t = String(type).toLowerCase();
  if (t.includes('tích cực') || t.includes('positive')) return 'Positive';
  if (t.includes('rủi ro') || t.includes('risk')) return 'Risk';
  return 'Neutral';
};

/** Lưu kết quả AI vào DB và dựng payload trả về (PredictionResult + historyItem) */
const persistSimulationResult = async ({ userId, simulation, aiResult, folderName, decision, latencyMs }) => {
  await new GeminiLog({
    user_id: userId,
    simulation_id: simulation._id,
    prompt_version: SIM_PROMPT_VERSION,
    task: aiResult.quality?.task,
    provider: aiResult.quality?.provider,
    model: aiResult.modelUsed || 'unknown',
    status: 'success',
    latency_ms: latencyMs,
    quality: aiResult.quality,
    ...GeminiLog.usageFields(aiResult.usage),
    output: aiResult
  }).save();

  simulation.status = 'completed';
  simulation.completed_at = new Date();
  simulation.summary = aiResult.summary;
  simulation.is_enterprise = aiResult.isEnterprise || false;
  simulation.timeline = aiResult.timeline;
  simulation.facts = aiResult.facts;
  simulation.program = aiResult.program;
  simulation.folder_name = folderName || `Nhóm kịch bản: ${decision.slice(0, 50)}`;
  await simulation.save();

  const savedScenarios = [];
  for (const s of aiResult.scenarios || []) {
    if (s.deepAnalysis?.swot) {
      s.deepAnalysis.swot = s.deepAnalysis.swot.map(item => {
        const first = typeof item.type === 'string' ? item.type.trim().toUpperCase()[0] : null;
        return { ...item, type: ['S', 'W', 'O', 'T'].includes(first) ? first : item.type };
      });
    }
    const scenario = await new SimulationScenario({
      simulation_id: simulation._id,
      scenario_type: normalizeScenarioType(s.type),
      title: s.title,
      description: s.description,
      career_growth: s.careerGrowth,
      happiness: s.happiness,
      roi: s.roi,
      probability: s.probability,
      expected_salary: s.expectedSalary,
      quant: s.quant,
      deep_analysis: s.deepAnalysis
    }).save();
    savedScenarios.push({
      id: scenario._id.toString(),
      title: scenario.title,
      description: scenario.description,
      careerGrowth: scenario.career_growth,
      happiness: scenario.happiness,
      roi: scenario.roi,
      probability: scenario.probability,
      expectedSalary: s.expectedSalary,
      quant: scenario.quant,
      type: scenario.scenario_type,
      deepAnalysis: scenario.deep_analysis
    });
  }

  const dateStr = new Date().toLocaleDateString('vi-VN', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
  const avg = (key) => Math.round(savedScenarios.reduce((acc, s) => acc + (s[key] || 0), 0) / Math.max(savedScenarios.length, 1));
  return {
    simulationId: simulation._id,
    isEnterprise: aiResult.isEnterprise || false,
    summary: aiResult.summary,
    scenarios: savedScenarios,
    timeline: aiResult.timeline,
    facts: aiResult.facts || [],
    program: aiResult.program || null,
    quality: aiResult.quality ? {
      provider: aiResult.quality.provider,
      groundedness: aiResult.quality.groundedness,
      aiCoverage: aiResult.quality.aiCoverage
    } : null,
    historyItem: {
      id: simulation._id,
      title: simulation.folder_name,
      category: 'MÔ PHỎNG',
      author: 'user',
      isAnonymous: false,
      date: dateStr,
      desc: `Bao gồm ${savedScenarios.length} kịch bản mô phỏng cho quyết định: ${decision}`,
      isFolder: true,
      scenarios: savedScenarios.map(s => ({
        id: s.id,
        title: s.title,
        category: 'SỰ NGHIỆP',
        date: dateStr,
        desc: s.description,
        color: s.type === 'Risk' ? 'bg-rose-500' : (s.type === 'Positive' ? 'bg-emerald-500' : 'bg-blue-500'),
        type: s.type,
        metrics: { career: s.careerGrowth, happiness: s.happiness, roi: s.roi },
        deepAnalysis: s.deepAnalysis
      })),
      metrics: { career: avg('careerGrowth'), happiness: avg('happiness'), roi: avg('roi') }
    }
  };
};

const classifySimulationError = (error) => {
  if (error.type === 'CANCELLED') return { statusCode: 499, type: 'CANCELLED', message: 'Bạn đã hủy phân tích. Token đã được hoàn lại.' };
  const errStr = String(error.message || '');
  const overloaded = error.type === 'OVERLOADED' || /503|UNAVAILABLE|overloaded|429|RESOURCE_EXHAUSTED|quota/i.test(errStr);
  if (overloaded) {
    return {
      statusCode: 503,
      type: 'OVERLOADED',
      message: 'Hệ thống AI đang quá tải. Quá trình phân tích đã dừng và token của bạn đã được hoàn lại. Vui lòng thử lại sau vài phút.'
    };
  }
  return { statusCode: 500, type: 'GENERAL', message: error.message || 'Lỗi hệ thống khi tạo mô phỏng.' };
};

/** Hoàn token, đánh dấu simulation lỗi, ghi log lỗi */
const handleSimulationFailure = async ({ userId, simulationId, tokensCharged, error, startTime }) => {
  if (tokensCharged) {
    try {
      await User.updateOne({ _id: userId }, { $inc: { token: SIMULATION_COST } });
    } catch (refundError) {
      console.error('Failed to refund tokens:', refundError);
    }
  }
  if (simulationId) {
    await Simulation.findByIdAndUpdate(simulationId, { status: 'failed', error_message: error.message }).catch(() => {});
  }
  await new GeminiLog({
    user_id: userId,
    simulation_id: simulationId,
    prompt_version: SIM_PROMPT_VERSION,
    model: error.modelUsed || 'unknown',
    status: 'error',
    error_message: error.message,
    latency_ms: Date.now() - startTime,
    quality: error.attempts ? { attempts: error.attempts } : undefined
  }).save().catch((logError) => console.error('Failed to log AI error:', logError));
};

const startSimulationRecord = async (userId, inputData, folderName) => {
  const simulation = new Simulation({
    user_id: userId,
    title: folderName || `Nhóm kịch bản: ${inputData.decision.slice(0, 50)}`,
    input: inputData,
    status: 'processing'
  });
  await simulation.save();
  return simulation;
};

// POST /api/simulations - Tạo mô phỏng (trả JSON khi xong; dùng cho client cũ)
router.post('/', auth, requireConsent, async (req, res) => {
  let tokensCharged = false;
  let simulationId = null;
  const startTime = Date.now();
  const { inputData, folderName } = readSimulationInput(req.body);

  try {
    if (!inputData.decision || !inputData.decision.trim()) {
      return res.status(400).json({ message: 'Vui lòng nhập quyết định cần phân tích.' });
    }
    if (!(await spendTokens(User, req.user.userId, SIMULATION_COST))) {
      return res.status(402).json(await insufficientTokensBody(req.user.userId));
    }
    tokensCharged = true;

    const simulation = await startSimulationRecord(req.user.userId, inputData, folderName);
    simulationId = simulation._id;

    const { result: aiResult } = await simulationRunner.run(inputData);
    const payload = await persistSimulationResult({
      userId: req.user.userId, simulation, aiResult, folderName, decision: inputData.decision, latencyMs: Date.now() - startTime
    });
    res.status(201).json(payload);
  } catch (error) {
    console.error('Create simulation error:', error);
    await handleSimulationFailure({ userId: req.user.userId, simulationId, tokensCharged, error, startTime });
    const { statusCode, type, message } = classifySimulationError(error);
    res.status(statusCode).json({ message, type });
  }
});

/**
 * POST /api/simulations/stream - Tạo mô phỏng với Server-Sent Events:
 *   event: facts    (~100ms)  số liệu + nguồn để UI hiện ngay thẻ lương/ROI/điểm chuẩn
 *   event: partial  (liên tục) văn bản AI đang viết (tóm tắt, tiêu đề, mô tả từng kịch bản)
 *   event: reset    provider chính lỗi giữa chừng, đang chuyển sang provider dự phòng
 *   event: done     kết quả đầy đủ (giống POST /api/simulations)
 *   event: error    lỗi (token đã được hoàn)
 */
router.post('/stream', auth, requireConsent, async (req, res) => {
  let tokensCharged = false;
  let simulationId = null;
  let finished = false;
  const startTime = Date.now();
  const { inputData, folderName } = readSimulationInput(req.body);

  if (!inputData.decision || !inputData.decision.trim()) {
    return res.status(400).json({ message: 'Vui lòng nhập quyết định cần phân tích.' });
  }
  if (!(await spendTokens(User, req.user.userId, SIMULATION_COST))) {
    return res.status(402).json(await insufficientTokensBody(req.user.userId));
  }
  tokensCharged = true;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const send = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.flush?.(); // compression middleware: đẩy ngay, không đệm
  };
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': ping\n\n');
      res.flush?.();
    }
  }, 15000);

  const abort = new AbortController();
  res.on('close', () => { if (!finished) abort.abort(new Error('client disconnected')); });

  let streamed = '';
  let lastPartialAt = 0;
  const emitPartial = (force = false) => {
    if (!force && Date.now() - lastPartialAt < 250) return;
    lastPartialAt = Date.now();
    try {
      const partial = llmGateway.parseJsonLoose(streamed);
      send('partial', {
        summary: partial.summary || '',
        scenarios: (partial.scenarios || []).map(s => ({ type: s?.type, title: s?.title || '', description: s?.description || '' }))
      });
    } catch { /* JSON còn quá ngắn để sửa: đợi thêm token */ }
  };

  try {
    const simulation = await startSimulationRecord(req.user.userId, inputData, folderName);
    simulationId = simulation._id;
    send('started', { simulationId });

    const { result: aiResult } = await simulationRunner.run(inputData, {
      signal: abort.signal,
      onFacts: (facts, ms) => send('facts', { ...facts, elapsedMs: ms }),
      onToken: (delta) => {
        streamed += delta;
        emitPartial();
      },
      onReset: (provider) => {
        streamed = '';
        send('reset', { failedProvider: provider });
      },
      // SIM_MODE=sections: không có token liên tục, mỗi phần viết xong gửi một bản tạm
      onPartial: (partial) => send('partial', partial)
    });
    if (streamed) emitPartial(true);
    const payload = await persistSimulationResult({
      userId: req.user.userId, simulation, aiResult, folderName, decision: inputData.decision, latencyMs: Date.now() - startTime
    });
    finished = true;
    send('done', payload);
  } catch (error) {
    finished = true;
    if (error.type !== 'CANCELLED') console.error('Stream simulation error:', error);
    await handleSimulationFailure({ userId: req.user.userId, simulationId, tokensCharged, error, startTime });
    send('error', classifySimulationError(error));
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// POST /api/simulations/warmup - Làm nóng GPU của model chính khi người dùng mở form (giấu cold start)
router.post('/warmup', auth, (req, res) => {
  res.json(llmGateway.warmup());
});

const FEEDBACK_REASONS = ['generic', 'wrong_numbers', 'not_my_situation', 'too_long', 'helpful_plan', 'clear_numbers'];

// POST /api/simulations/:id/feedback - 👍/👎 cho một kịch bản (gửi lại sẽ cập nhật)
router.post('/:id/feedback', auth, async (req, res) => {
  try {
    const { scenarioId, rating, numbersPlausible, reasons, comment } = req.body;
    if (![1, -1].includes(Number(rating))) {
      return res.status(400).json({ message: 'rating phải là 1 hoặc -1.' });
    }
    const simulation = await Simulation.findOne({ _id: req.params.id, user_id: req.user.userId }).select('_id');
    if (!simulation) return res.status(404).json({ message: 'Không tìm thấy mô phỏng.' });
    if (scenarioId && !(await SimulationScenario.exists({ _id: scenarioId, simulation_id: simulation._id }))) {
      return res.status(404).json({ message: 'Không tìm thấy kịch bản.' });
    }
    const log = await GeminiLog.findOne({ simulation_id: simulation._id, status: 'success' }).select('provider model').lean();
    const feedback = await Feedback.findOneAndUpdate(
      { user_id: req.user.userId, simulation_id: simulation._id, scenario_id: scenarioId || null },
      {
        rating: Number(rating),
        numbers_plausible: typeof numbersPlausible === 'boolean' ? numbersPlausible : null,
        reasons: Array.isArray(reasons) ? reasons.filter(r => FEEDBACK_REASONS.includes(r)) : [],
        comment: typeof comment === 'string' ? comment.slice(0, 1000) : undefined,
        provider: log?.provider,
        model: log?.model
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ ok: true, id: feedback._id });
  } catch (error) {
    console.error('Feedback error:', error);
    res.status(500).json({ message: 'Không lưu được phản hồi.' });
  }
});

// GET /api/simulations - List user's simulations (for history page)
router.get('/', auth, async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '', saved = 'false' } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Fetch user to check tier
    const User = require('../models/User');
    const user = await User.findById(req.user.userId);

    const query = { user_id: req.user.userId, status: 'completed' };

    // Filter by saved status if requested
    if (saved === 'true') {
      query.is_saved = true;
    }

    // Tier filtering: if user is free, exclude simulations that were tagged as premium
    if (user && user.tier === 'free') {
      query['input.tier'] = { $ne: 'premium' };
    }

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

      // Filter out simulations with 0 scenarios (as per requirement: không lưu các mô phỏng không tạo được kịch bản)
      if (scenarios.length === 0) continue;

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
        quant: s.quant,
        probability: s.probability,
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
        isSaved: sim.is_saved || false,
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

// POST /api/simulations/:id/save - Save a simulation
router.post('/:id/save', auth, async (req, res) => {
  try {
    const simulation = await Simulation.findOneAndUpdate(
      { _id: req.params.id, user_id: req.user.userId },
      { is_saved: true },
      { new: true }
    );
    if (!simulation) {
      return res.status(404).json({ message: 'Không tìm thấy mô phỏng.' });
    }
    res.json({ message: 'Đã lưu mô phỏng thành công.', isSaved: true });
  } catch (error) {
    console.error('Save simulation error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống.' });
  }
});

// DELETE /api/simulations/:id/save - Unsave a simulation
router.delete('/:id/save', auth, async (req, res) => {
  try {
    const simulation = await Simulation.findOneAndUpdate(
      { _id: req.params.id, user_id: req.user.userId },
      { is_saved: false },
      { new: true }
    );
    if (!simulation) {
      return res.status(404).json({ message: 'Không tìm thấy mô phỏng.' });
    }
    res.json({ message: 'Đã bỏ lưu mô phỏng.', isSaved: false });
  } catch (error) {
    console.error('Unsave simulation error:', error);
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
        deepAnalysis: s.deep_analysis,
        quant: s.quant,
        probability: s.probability
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
