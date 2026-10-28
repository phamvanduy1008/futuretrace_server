/**
 * Simulation Runner: luồng mô phỏng 3 kịch bản dùng chung cho route JSON, route streaming (SSE),
 * script sinh dữ liệu fine-tune và bộ đánh giá.
 *
 *   prepare()  ~10ms  : Fact Sheet (Knowledge Layer v2) + FT-Salary/ROI + prompt
 *   run()             : prepare -> onFacts -> LLM Gateway (Qwen fine-tune / Gemini dự phòng, stream)
 *                       -> chuẩn hóa -> Grounding Verifier -> kết quả kèm số đo chất lượng
 */

const knowledgeService = require('./knowledgeService');
const ragService = require('./ragService');
const llmGateway = require('./llmGateway');
const { verifySimulation } = require('./groundingService');
const slotRenderer = require('./slotRenderer');
const { detectRegionKey } = require('./careerRoiService');
const task = require('./prompts/simulationTask');
const {
  sanitizeDecision,
  buildCareerQuant,
  formatQuantSnippet,
  normalizeSimulationResponse,
  extractHolisticStudentContext,
  detectDomainProfile
} = require('./geminiService');

const prepare = (input = {}) => {
  const decision = sanitizeDecision(input.decision || '');
  const cleanData = { ...input, decision };
  const searchText = `${decision} ${cleanData.otherFactors || ''} ${cleanData.location || ''}`;
  let { ragData } = ragService.getAugmentedContext(decision, searchText);
  const student = extractHolisticStudentContext(cleanData);
  const factSheet = knowledgeService.buildFactSheet({
    programId: cleanData.programId,
    stage: student.stage,
    decisionText: `${decision} ${cleanData.otherFactors || ''}`,
    regionKey: detectRegionKey(`${cleanData.location || ''} ${decision}`),
    expectedScore: cleanData.expectedScore
  });
  // Kiến thức định tính theo nhóm ngành của crosswalk, không đoán theo từ khóa trong câu (tên trường chứa "Kinh tế"
  // từng kéo ngành Marketing sang kiến thức tài chính)
  if (factSheet.occupation) {
    ragData = ragData || {};
    ragData.domainData = (factSheet.occupation.domain && ragService.domains?.[factSheet.occupation.domain]) || null;
  }
  const quant = buildCareerQuant({ ...cleanData, ragData, factSheet });
  const domain = detectDomainProfile(`${decision} ${cleanData.otherFactors || ''}`, ragData);

  const qualitativeText = ragService.formatQualitativeSnippet(ragData);
  const prompt = task.buildUserPrompt({
    input: cleanData,
    student,
    domainName: domain?.name,
    factSheetText: knowledgeService.formatFactSheet(factSheet),
    quantText: formatQuantSnippet(quant),
    qualitativeText
  });

  // v3: 4 prompt ngắn theo phần, số liệu qua slot
  const slotCtx = slotRenderer.buildSlots({ factSheet, quant, cleanData });
  const hedge = ['approx', 'weak'].includes(factSheet.occupation?.fit);
  const sections = Object.fromEntries(task.SECTIONS.map(section => [section, task.buildSectionPrompt({
    input: cleanData,
    student,
    domainName: domain?.name,
    slotText: slotRenderer.describeSlots(slotCtx, { scenarioType: section === 'overview' ? null : section }),
    qualitativeText,
    section,
    hedge
  })]));

  return { cleanData, ragData, factSheet, quant, student, system: task.SYSTEM_PROMPT, prompt, slotCtx, hedge, sectionSystem: task.SECTION_SYSTEM_PROMPT, sections };
};

/**
 * Sinh 4 phần song song (tổng quan + 3 kịch bản), điền slot, ghép thành JSON đúng định dạng T1.
 * @returns {{json, raw: object, gens: object[], unknownSlots: string[]}}
 */
const generateSections = async (prep, { signal, order, onSection } = {}) => {
  const gens = await Promise.all(task.SECTIONS.map(async (section) => {
    const gen = await llmGateway.generate({
      system: prep.sectionSystem,
      prompt: prep.sections[section],
      schema: section === 'overview' ? task.SECTION_SCHEMAS.overview : task.SECTION_SCHEMAS.scenario,
      maxTokens: section === 'overview' ? 900 : 1400,
      temperature: 0.35,
      signal,
      order
    });
    onSection?.(section, gen);
    return { section, gen };
  }));
  const raw = Object.fromEntries(gens.map(({ section, gen }) => [section, gen.json]));
  const unknownSlots = [];
  const rendered = {};
  for (const section of task.SECTIONS) {
    const r = slotRenderer.renderJson(raw[section] || {}, prep.slotCtx, section === 'overview' ? null : section);
    unknownSlots.push(...r.unknown);
    // Slot không tồn tại: bỏ token để không lộ "{{...}}" ra giao diện (câu chứa nó vẫn qua Grounding Verifier)
    rendered[section] = JSON.parse(JSON.stringify(r.json).replace(/\{\{[^}]*\}\}/g, ''));
  }
  const json = {
    summary: rendered.overview.summary,
    timeline: rendered.overview.timeline,
    scenarios: ['Positive', 'Neutral', 'Risk'].map(type => ({ type, ...rendered[type] }))
  };
  return { json, raw, gens: gens.map(g => g.gen), unknownSlots };
};

/** Số liệu hiển thị ngay (trước khi LLM viết xong): đủ để UI dựng thẻ số liệu + trích nguồn */
const factsPayload = (prep) => ({
  facts: prep.factSheet.facts,
  program: prep.factSheet.program,
  occupation: prep.factSheet.occupation,
  scenarios: prep.quant ? Object.fromEntries(Object.entries(prep.quant.scenarios).map(([type, s]) => [type, {
    careerGrowth: s.careerGrowthScore,
    roi: s.roiScore,
    probability: s.probability,
    salary: s.salary,
    roiDetail: s.roi,
    affordability: s.affordability,
    expectedSalary: s.expectedSalary
  }])) : null,
  confidence: prep.quant?.confidence || null,
  market: prep.quant?.market || null,
  assumptions: prep.quant?.assumptions || null
});

/** Tỷ lệ trường văn bản do AI viết đầy đủ (phần còn lại do template lấp) */
const measureAiCoverage = (json) => {
  if (!json || typeof json !== 'object') return 0;
  const ok = (s, min = 20) => typeof s === 'string' && s.trim().length >= min;
  let total = 1 + 4;
  let filled = (ok(json.summary, 40) ? 1 : 0) + ['start', 'sixMonths', 'oneYear', 'threeYears'].filter(k => ok(json.timeline?.[k])).length;
  const scenarios = Array.isArray(json.scenarios) ? json.scenarios : [];
  for (let i = 0; i < 3; i++) {
    const s = scenarios[i] || {};
    total += 6;
    filled += ['title', 'description', 'criticalAdvice', 'marketAnalysis'].filter(k => ok(s[k], k === 'title' ? 6 : 20)).length;
    filled += Array.isArray(s.swot) && s.swot.filter(x => ok(x?.value)).length >= 4 ? 1 : 0;
    filled += Array.isArray(s.sprint90) && s.sprint90.filter(p => Array.isArray(p?.tasks) && p.tasks.length >= 2).length >= 3 ? 1 : 0;
  }
  return Math.round((filled / total) * 1000) / 1000;
};

/** Đưa JSON của tác vụ T1 về dạng normalizeSimulationResponse mong đợi (deepAnalysis lồng bên trong) */
const toLegacyShape = (json) => ({
  ...json,
  scenarios: (json?.scenarios || []).map(s => ({
    ...s,
    deepAnalysis: { swot: s.swot, sprint90: s.sprint90, criticalAdvice: s.criticalAdvice }
  }))
});

/**
 * @param {object} input  dữ liệu form mô phỏng
 * @param {object} hooks  { onFacts, onToken, onReset, signal, order }
 */
const run = async (input, { onFacts, onToken, onReset, onPartial, signal, order } = {}) => {
  const t0 = Date.now();
  const prep = prepare(input);
  const facts = factsPayload(prep);
  onFacts?.(facts, Date.now() - t0);

  // SIM_MODE=sections: 4 phần + slot (dành cho model riêng v3). Mặc định single (Gemini đang làm engine chính, có streaming)
  if (String(process.env.SIM_MODE || 'single') === 'sections') {
    // Mỗi phần xong thì phát bản tạm (đã điền slot) để giao diện hiện dần như streaming
    const doneParts = {};
    const onSection = (section, gen) => {
      doneParts[section] = slotRenderer.renderJson(gen.json || {}, prep.slotCtx, section === 'overview' ? null : section).json;
      onPartial?.({
        summary: doneParts.overview?.summary || '',
        scenarios: ['Positive', 'Neutral', 'Risk'].filter(t => doneParts[t]).map(t => ({ type: t, title: doneParts[t].title || '', description: doneParts[t].description || '' }))
      });
    };
    const out = await generateSections(prep, { signal, order, onSection });
    const aiCoverage = measureAiCoverage(out.json);
    const result = normalizeSimulationResponse(toLegacyShape(out.json), { ...prep.cleanData, ragData: prep.ragData, quant: prep.quant });
    const grounding = verifySimulation(result, { facts: prep.factSheet.facts, quant: prep.quant, input: prep.cleanData });
    const main = out.gens[0];
    result.isEnterprise = false;
    result.facts = prep.factSheet.facts;
    result.program = prep.factSheet.program;
    result.modelUsed = main.model;
    result.usage = out.gens.reduce((acc, g) => ({
      inputTokens: (acc.inputTokens || 0) + (g.usage?.inputTokens || 0),
      outputTokens: (acc.outputTokens || 0) + (g.usage?.outputTokens || 0),
      costUsd: (acc.costUsd || 0) + (g.usage?.costUsd || 0)
    }), {});
    result.quality = {
      task: task.SECTION_TASK_ID,
      provider: main.provider,
      aiCoverage,
      groundedness: grounding.groundedness,
      numericClaims: grounding.claims,
      removedSentences: grounding.removed.length,
      unknownSlots: out.unknownSlots.length,
      latencyMs: Date.now() - t0,
      llmLatencyMs: Math.max(...out.gens.map(g => g.latencyMs || 0)),
      firstTokenMs: Math.min(...out.gens.map(g => g.firstTokenMs ?? Infinity)),
      attempts: out.gens.flatMap(g => g.attempts || [])
    };
    return { result, prep, raw: { json: out.json, sections: out.raw, provider: main.provider } };
  }

  const gen = await llmGateway.generate({
    system: prep.system,
    prompt: prep.prompt,
    schema: task.SIMULATION_SCHEMA,
    maxTokens: 4096,
    temperature: 0.35,
    onToken,
    onReset,
    signal,
    order
  });

  const aiCoverage = measureAiCoverage(gen.json);
  const result = normalizeSimulationResponse(toLegacyShape(gen.json), { ...prep.cleanData, ragData: prep.ragData, quant: prep.quant });
  const grounding = verifySimulation(result, { facts: prep.factSheet.facts, quant: prep.quant, input: prep.cleanData });

  result.isEnterprise = false;
  result.facts = prep.factSheet.facts;
  result.program = prep.factSheet.program;
  result.modelUsed = gen.model;
  result.usage = gen.usage;
  result.quality = {
    task: task.TASK_ID,
    provider: gen.provider,
    aiCoverage,
    groundedness: grounding.groundedness,
    numericClaims: grounding.claims,
    removedSentences: grounding.removed.length,
    latencyMs: Date.now() - t0,
    llmLatencyMs: gen.latencyMs,
    firstTokenMs: gen.firstTokenMs,
    attempts: gen.attempts
  };
  return { result, prep, raw: gen };
};

module.exports = { prepare, run, generateSections, factsPayload, measureAiCoverage, toLegacyShape };
