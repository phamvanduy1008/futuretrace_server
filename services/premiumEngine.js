/**
 * Premium Engine: lộ trình chuyên sâu (premium), điều chỉnh lộ trình (pivot), mở rộng một bước.
 *
 * Dùng chung với mô phỏng v3:
 *  - Số liệu qua slot {{...}} (services/slotRenderer.js), điền từ Fact Sheet + FT-Salary/ROI của chính hồ sơ.
 *  - Gọi qua llmGateway (không còn đường Ollama cục bộ cũ), có Grounding Verifier sau khi điền.
 *
 * Pivot (Gemini): các mốc ĐÃ HOÀN THÀNH do code giữ nguyên tuyệt đối; AI chỉ viết lại các mốc còn lại và phần tường
 * thuật. Bản cũ gửi cho AI mảng chỉ số [0, 1] nên AI không thấy nội dung mốc đã xong mà vẫn bị yêu cầu "giữ nguyên".
 * Mở rộng bước (Gemini): chỉ nêu tên nền tảng/công cụ; URL ngoài danh sách tên miền tin cậy bị gỡ.
 */

const llmGateway = require('./llmGateway');
const slotRenderer = require('./slotRenderer');
const { verifyDataText: verifyText, collectAllowed } = require('./groundingService');
const simulationRunner = require('./simulationRunner');
const { normalizePremiumAnalysisResponse } = require('./geminiService');
const premiumTimeline = require('./premiumTimeline');

const IMPACT = ['High', 'Medium', 'Low'];
const STEP_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    objectives: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string' } },
    actions: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string' } },
    tools: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string' } },
    expectedResult: { type: 'string' }
  },
  required: ['title', 'description', 'objectives', 'actions', 'tools', 'expectedResult']
};
const MILESTONE_SCHEMA = {
  type: 'object',
  properties: {
    month: { type: 'string' },
    event: { type: 'string' },
    impact: { type: 'string', enum: IMPACT },
    probability: { type: 'integer' },
    details: { type: 'array', minItems: 3, maxItems: 3, items: STEP_SCHEMA }
  },
  required: ['month', 'event', 'impact', 'probability', 'details']
};
const FACTORS_SCHEMA = {
  type: 'array', minItems: 4, maxItems: 4,
  items: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: ['Economic', 'Personal', 'Social', 'Technical'] },
      factor: { type: 'string' },
      influence: { type: 'string', enum: IMPACT },
      description: { type: 'string' }
    },
    required: ['category', 'factor', 'influence', 'description']
  }
};
const PIVOTS_SCHEMA = {
  type: 'array', minItems: 3, maxItems: 3,
  items: { type: 'object', properties: { condition: { type: 'string' }, action: { type: 'string' } }, required: ['condition', 'action'] }
};

// ---------------------------------------------------------------- bối cảnh dùng chung
/** Hồ sơ người học (context lưu cùng lộ trình) -> Fact Sheet + slot, đúng như luồng mô phỏng */
const buildContext = (context = {}) => {
  const input = { ...context };
  if (!input.decision) input.decision = context.goal || '';
  const prep = simulationRunner.prepare(input);
  return { prep, slotText: slotRenderer.describeSlots(prep.slotCtx) };
};

const profileLines = (context = {}, student = {}) => [
  `- Mong muốn / quyết định: ${context.decision || ''}`,
  `- Giai đoạn: ${student.stageLabel || 'chưa rõ'}`,
  `- Học lực ${context.academicPerformance ?? '?'}/5 | Tài chính gia đình ${context.personalFinance ?? '?'}/5 | Áp lực ${context.stress ?? '?'}/5 | Chấp nhận rủi ro ${context.risk ?? '?'}/5`,
  context.location ? `- Khu vực: ${context.location}` : null,
  context.otherFactors ? `- Bổ sung: ${context.otherFactors}` : null
].filter(Boolean).join('\n');

/** Điền slot rồi kiểm số: câu chứa số không căn cứ bị bỏ (cùng chuẩn với mô phỏng) */
const renderAndVerify = (json, prep) => {
  const r = slotRenderer.renderJson(json, prep.slotCtx);
  const allowed = collectAllowed({ facts: prep.factSheet.facts, quant: prep.quant, input: prep.cleanData });
  const stats = { claims: 0, grounded: 0, removed: [] };
  const walk = (v, key) => {
    if (typeof v === 'string') {
      if (['month', 'category', 'influence', 'impact', 'id'].includes(key)) return v;
      const clean = v.replace(/\{\{[^}]*\}\}/g, '').replace(/\s{2,}/g, ' ').trim(); // slot lạ: bỏ token
      const out = verifyText(clean, allowed);
      stats.claims += out.claims;
      stats.grounded += out.grounded;
      stats.removed.push(...out.removed);
      return out.text;
    }
    if (Array.isArray(v)) return v.map(x => walk(x, key)).filter(x => x !== '');
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return {
    json: walk(r.json, null),
    quality: {
      unknownSlots: r.unknown.length,
      numericClaims: stats.claims,
      removedSentences: stats.removed.length,
      groundedness: stats.claims ? Math.round((stats.grounded / stats.claims) * 1000) / 1000 : null
    }
  };
};

const toSteps = (details = [], milestoneIndex, completed) => (Array.isArray(details) ? details : []).slice(0, 3).map((s, j) => ({
  id: `step_${milestoneIndex + 1}_${j + 1}`,
  title: s?.title || '',
  description: s?.description || '',
  objectives: Array.isArray(s?.objectives) ? s.objectives : [],
  actions: Array.isArray(s?.actions) ? s.actions : [],
  tools: Array.isArray(s?.tools) ? s.tools : [],
  expectedResult: s?.expectedResult || '',
  completed: !!completed
}));

// ---------------------------------------------------------------- pivot (Gemini)
const PIVOT_SYSTEM = `Bạn là FutureTrace - cố vấn hướng nghiệp cho học sinh, sinh viên Việt Nam, gọi người học là "em"; không tự xưng chị/anh/tôi/mình, không mở đầu bằng lời chào.
Nhiệm vụ: ĐIỀU CHỈNH lộ trình khi người học gặp biến cố hoặc khó khăn. Các mốc đã hoàn thành được giữ nguyên bởi hệ thống, em chỉ viết lại phần còn lại.
Nguyên tắc bắt buộc:
1. KHÔNG tự viết con số dữ liệu (lương, điểm, phần trăm, tiền, số tin). Khi cần số, viết đúng TÊN SLOT trong bảng SLOT (vd "{{F1}}", "{{P50.start}}"); slot tự điền số, đơn vị và mã nguồn. Xác suất (probability) của mốc là số nguyên 0-100 trong trường riêng, không phải dữ liệu thị trường.
2. Xử lý TRỰC TIẾP khó khăn mới nhất, có tính nối tiếp với các phản hồi trước; không mâu thuẫn với các mốc đã hoàn thành.
3. Mốc mới bắt đầu SAU mốc đã hoàn thành cuối cùng và nằm trong khung thời gian; cụ thể, khả thi với giai đoạn học và tài chính của người học.
4. Không nêu tên trường, công ty, học bổng không có trong hồ sơ hoặc bảng SLOT. Không viết đường link.
5. Viết tiếng Việt tự nhiên, thấu cảm nhưng thẳng thắn. Chỉ trả về JSON đúng schema.`;

const milestoneLine = (m, i) => `${i + 1}. [${m?.month || '?'}] ${m?.event || ''}`;

/**
 * @param {object} p
 * @param {object} p.currentReport        báo cáo đang lưu (detailedNarrative, milestones[5], ...)
 * @param {number[]} p.completedMilestones chỉ số các mốc đã hoàn thành (luôn là tiền tố 0..k-1)
 * @param {string} p.feedback
 * @param {object} p.context              hồ sơ người học lưu cùng lộ trình
 * @param {number} p.timeframe
 * @param {string[]} p.feedbackHistory
 * @param {object} p.scenario             { title, description } (để chuẩn hóa)
 */
/** Schema dùng nhãn tiếng Anh (Economic/Personal/...) cho model ổn định; người dùng thấy tiếng Việt như bản cũ */
const CATEGORY_VI = { Economic: 'Kinh tế', Personal: 'Cá nhân', Social: 'Xã hội', Technical: 'Kỹ thuật' };
const localizeFactors = (report) => ({
  ...report,
  influencingFactors: (report.influencingFactors || []).map(f => ({ ...f, category: CATEGORY_VI[f?.category] || f?.category }))
});

const pivot = async ({ currentReport, completedMilestones = [], feedback, context = {}, timeframe = 12, feedbackHistory = [], scenario = {} }) => {
  const oldMilestones = Array.isArray(currentReport?.milestones) ? currentReport.milestones.slice(0, 5) : [];
  const k = Math.min(5, completedMilestones.length ? Math.max(...completedMilestones) + 1 : 0);
  const kept = oldMilestones.slice(0, k).map((m, i) => ({ ...m, completed: true, details: toSteps(m.details, i, true) }));
  const n = 5 - k;
  // Các mốc mới chia đều phần thời gian còn lại, bắt đầu ngay sau mốc đã hoàn thành cuối cùng
  const T = Math.max(1, parseInt(timeframe, 10) || 12);
  const keptEnd = kept.reduce((mx, m) => Math.max(mx, Math.min(T, premiumTimeline.parseLabel(m.month)?.end ?? 0)), 0);
  const newPeriods = premiumTimeline.planPeriods(T, n, Math.min(T, keptEnd + 1));

  const { prep, slotText } = buildContext(context);
  const schema = {
    type: 'object',
    properties: {
      detailedNarrative: { type: 'string' },
      ...(n > 0 ? { newMilestones: { type: 'array', minItems: n, maxItems: n, items: MILESTONE_SCHEMA } } : {}),
      influencingFactors: FACTORS_SCHEMA,
      strategicPivotPoints: PIVOTS_SCHEMA,
      longTermProjection: { type: 'string' }
    },
    required: ['detailedNarrative', ...(n > 0 ? ['newMilestones'] : []), 'influencingFactors', 'strategicPivotPoints', 'longTermProjection']
  };

  const prompt = `HỒ SƠ NGƯỜI HỌC:
${profileLines(context, prep.student)}
- Khung thời gian toàn lộ trình: ${timeframe} tháng

${slotText}

LỘ TRÌNH HIỆN TẠI (tường thuật):
${String(currentReport?.detailedNarrative || '').slice(0, 2500)}

CÁC MỐC ĐÃ HOÀN THÀNH (hệ thống giữ nguyên, KHÔNG viết lại):
${kept.length ? kept.map(milestoneLine).join('\n') : '(chưa có)'}

CÁC MỐC CÒN LẠI THEO KẾ HOẠCH CŨ (cần điều chỉnh):
${oldMilestones.slice(k).map((m, i) => milestoneLine(m, k + i)).join('\n') || '(không còn mốc nào)'}

${feedbackHistory.length ? `CÁC PHẢN HỒI TRƯỚC:\n${feedbackHistory.map((f, i) => `[Lần ${i + 1}] ${f}`).join('\n')}\n` : ''}KHÓ KHĂN / BIẾN CỐ MỚI NHẤT: "${feedback}"

YÊU CẦU ĐẦU RA (JSON):
- detailedNarrative: tường thuật lại toàn bộ lộ trình sau điều chỉnh, chia đoạn theo mốc thời gian ("Tháng ..."), nói rõ em đã làm được gì, biến cố mới tác động thế nào và hướng đi mới.
${n > 0 ? `- newMilestones: đúng ${n} mốc MỚI thay cho ${n} mốc còn lại, mốc thứ j ứng với giai đoạn thứ j dưới đây và month ghi ĐÚNG nhãn đó (các giai đoạn phủ đủ phần thời gian còn lại tới Tháng ${T}): ${newPeriods.map((p, j) => `(${j + 1}) ${p.label}`).join('; ')}. Mỗi mốc: month, event (kết quả cần đạt khi kết thúc giai đoạn, cụ thể), impact (High/Medium/Low), probability (0-100), details đúng 3 bước {title, description, objectives 2-3, actions 2-3, tools 2-3, expectedResult}.\n` : ''}- influencingFactors: đúng 4 yếu tố (category Economic/Personal/Social/Technical) phản ánh tình hình mới.
- strategicPivotPoints: đúng 3 điểm "Nếu ... thì ..." (condition, action) cho chặng tiếp theo.
- longTermProjection: tầm nhìn 3-5 năm sau điều chỉnh.`;

  const gen = await llmGateway.generate({
    system: PIVOT_SYSTEM, prompt, schema, maxTokens: 8192, temperature: 0.4, order: ['gemini']
  });
  const { json, quality } = renderAndVerify(gen.json || {}, prep);
  const fresh = (Array.isArray(json.newMilestones) ? json.newMilestones : []).slice(0, n).map((m, j) => {
    const idx = k + j;
    return {
      month: m.month, event: m.event, impact: IMPACT.includes(m.impact) ? m.impact : 'Medium',
      probability: Math.max(0, Math.min(100, Math.round(Number(m.probability) || 70))),
      completed: false, details: toSteps(m.details, idx, false)
    };
  });
  const merged = {
    detailedNarrative: json.detailedNarrative,
    milestones: [...kept, ...fresh],
    influencingFactors: json.influencingFactors,
    strategicPivotPoints: json.strategicPivotPoints,
    longTermProjection: json.longTermProjection
  };
  const normalized = normalizePremiumAnalysisResponse(merged, { title: scenario.title, description: scenario.description, context, timeframe });
  // Lưới an toàn: chuẩn hóa không được đụng vào mốc đã hoàn thành
  for (let i = 0; i < k; i++) normalized.milestones[i] = kept[i];
  // Khung thời gian: giữ nhãn mốc đã xong (chỉ sửa nhãn lỗi kiểu "Tháng 1-1"), mốc mới phủ đủ phần còn lại
  const report = localizeFactors(premiumTimeline.applyTimeline(normalized, T, { keep: k }));
  for (let i = 0; i < k; i++) report.milestones[i] = { ...kept[i], month: report.milestones[i].month };
  report.modelUsed = gen.model;
  report.usage = gen.usage;
  report.quality = { task: 'premium_pivot_v2', provider: gen.provider, keptMilestones: k, ...quality };
  return report;
};

// ---------------------------------------------------------------- mở rộng một bước (Gemini)
// Chỉ giữ đường link tới tên miền tin cậy; link khác (dễ là link bịa) bị gỡ, giữ lại phần chữ
const TRUSTED_DOMAINS = [
  'coursera.org', 'udemy.com', 'edx.org', 'khanacademy.org', 'youtube.com', 'github.com', 'google.com', 'microsoft.com',
  'w3schools.com', 'developer.mozilla.org', 'freecodecamp.org', 'figma.com', 'canva.com', 'duolingo.com',
  'ielts.org', 'britishcouncil.vn', 'idp.com', 'ets.org', 'moet.gov.vn', 'thisinhthitotnghiep.edu.vn', 'topcv.vn', 'vietnamworks.com', 'linkedin.com'
];
const URL_RE = /\bhttps?:\/\/[^\s)"'<>]+|\bwww\.[^\s)"'<>]+/gi;
const isTrustedUrl = (u) => {
  try {
    const host = new URL(u.startsWith('http') ? u : `https://${u}`).hostname.replace(/^www\./, '');
    return TRUSTED_DOMAINS.some(d => host === d || host.endsWith(`.${d}`)) || /\.(edu|gov)\.vn$/.test(host);
  } catch { return false; }
};
const stripUntrustedUrls = (v) => {
  if (typeof v === 'string') return v.replace(URL_RE, (u) => (isTrustedUrl(u) ? u : '')).replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim();
  if (Array.isArray(v)) return v.map(stripUntrustedUrls).filter(Boolean);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripUntrustedUrls(x)]));
  return v;
};

const STEP_DETAIL_SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    objectives: { type: 'array', minItems: 3, maxItems: 5, items: { type: 'string' } },
    actions: { type: 'array', minItems: 5, maxItems: 8, items: { type: 'string' } },
    tools: { type: 'array', minItems: 3, maxItems: 5, items: { type: 'string' } },
    expectedResult: { type: 'string' }
  },
  required: ['description', 'objectives', 'actions', 'tools', 'expectedResult']
};

const expandStep = async ({ scenarioTitle, milestoneEvent, stepTitle, stepDescription, context = {} }) => {
  const { prep, slotText } = buildContext(context);
  const system = `Bạn là chuyên gia tư vấn học tập và hướng nghiệp cho học sinh, sinh viên Việt Nam, gọi người học là "em"; không tự xưng chị/anh/tôi/mình, không mở đầu bằng lời chào.
Nhiệm vụ: viết hướng dẫn thực thi CHI TIẾT cho một bước trong lộ trình.
Nguyên tắc: hành động cụ thể (làm gì, làm thế nào, dùng nền tảng/công cụ nào); chỉ nêu TÊN nền tảng, công cụ phổ biến có thật (vd Coursera, Khan Academy, VS Code, Canva), KHÔNG tự tạo đường link, tên khóa học hay tên chứng chỉ không chắc có thật. Không tự viết con số dữ liệu thị trường (lương, điểm chuẩn...): nếu cần, dùng tên slot trong bảng SLOT. Tiếng Việt, chỉ trả về JSON.`;
  const prompt = `HỒ SƠ NGƯỜI HỌC:
${profileLines(context, prep.student)}

${slotText}

- Kịch bản tổng thể: ${scenarioTitle || ''}
- Cột mốc hiện tại: ${milestoneEvent || ''}
- Bước cần chi tiết hóa: ${stepTitle || ''}
- Mô tả sơ bộ: ${stepDescription || ''}

YÊU CẦU ĐẦU RA (JSON):
- description: 80-150 từ, giải thích vì sao bước này quan trọng, cần lưu ý gì, chuẩn bị ra sao.
- objectives: 3-5 mục tiêu cụ thể, đo được.
- actions: 5-8 hành động từng bước, mỗi hành động 15-30 từ, nêu cách làm và nền tảng/công cụ dùng.
- tools: 3-5 công cụ, nền tảng hoặc tài nguyên cụ thể.
- expectedResult: sản phẩm/kết quả cụ thể khi xong bước.`;
  const gen = await llmGateway.generate({ system, prompt, schema: STEP_DETAIL_SCHEMA, maxTokens: 3000, temperature: 0.4, order: ['gemini'] });
  const { json, quality } = renderAndVerify(gen.json || {}, prep);
  const cleaned = stripUntrustedUrls(json);
  return { ...cleaned, modelUsed: gen.model, usage: gen.usage, quality: { task: 'premium_step_v2', provider: gen.provider, ...quality } };
};

// ---------------------------------------------------------------- tạo lộ trình (v3: model riêng adapter "premium")
const premiumTask = require('./prompts/premiumTask');

/** Prompt của từng phần (dùng chung cho production, teacher và đánh giá) */
const buildPremiumPrompts = ({ prep, slotText, scenario, timeframe, periods = premiumTimeline.planPeriods(timeframe) }) => {
  const base = premiumTask.buildBase({ input: prep.cleanData, student: prep.student, scenario, timeframe, slotText });
  return {
    system: premiumTask.SYSTEM_PROMPT,
    periods,
    plan: `${base}\n\n${premiumTask.planInstruction(timeframe, prep.hedge, periods)}`,
    milestone: (plan, i) => `${base}\n\n${premiumTask.milestoneInstruction(plan, i)}`
  };
};

/** Lỗi cấu trúc/thời gian thì không dùng được kết quả (các lỗi khác như độ dài chỉ để lọc dữ liệu huấn luyện) */
const isFatal = (reason) => /^(incomplete_fields|bad_timeline)/.test(reason || '');

/**
 * Tạo lộ trình theo phần: 1 lần gọi khung + 5 lần gọi chi tiết mốc (song song).
 * order: thứ tự provider, vd ['modal', 'gemini']; modalModel: tên adapter trên vLLM.
 */
const generatePremium = async ({ title, description, context = {}, timeframe = 12, order = null, modalModel = 'premium', signal = null }) => {
  const { checkPremiumSection } = require('../ml/finetune/premiumCheck');
  const t0 = Date.now();
  const { prep, slotText } = buildContext(context);
  const prompts = buildPremiumPrompts({ prep, slotText, scenario: { title, description }, timeframe });
  const call = (prompt, schema, maxTokens) => llmGateway.generate({
    system: prompts.system, prompt, schema, maxTokens, temperature: 0.4, order, modalModel, signal
  });

  // Tháng của mốc do code quyết định (giai đoạn i), không phụ thuộc model; ghi lại model có theo đúng nhãn không
  let followed = 0;
  const pinMonths = (json) => {
    if (Array.isArray(json?.milestones)) {
      followed = json.milestones.filter((m, i) => premiumTimeline.tidyLabel(m?.month) === prompts.periods[i]?.label).length;
      json.milestones.forEach((m, i) => { if (m && typeof m === 'object' && prompts.periods[i]) m.month = prompts.periods[i].label; });
    }
    return json;
  };

  // Khung: thử lại 1 lần kèm lý do nếu sai cấu trúc
  let planGen = await call(prompts.plan, premiumTask.PLAN_SCHEMA, 2200);
  pinMonths(planGen.json);
  let reason = checkPremiumSection('plan', planGen.json, prep, { timeframe });
  if (isFatal(reason)) {
    planGen = await call(`${prompts.plan}\n\nLẦN TRƯỚC BỊ LOẠI VÌ: ${reason}. Viết lại và sửa đúng lỗi.`, premiumTask.PLAN_SCHEMA, 2200);
    pinMonths(planGen.json);
    reason = checkPremiumSection('plan', planGen.json, prep, { timeframe });
    if (isFatal(reason)) throw new Error(`premium plan không hợp lệ: ${reason}`);
  }
  const plan = planGen.json;

  const msGens = await Promise.all(plan.milestones.map(async (_, i) => {
    let g = await call(prompts.milestone(plan, i), premiumTask.MILESTONE_SCHEMA, 1600);
    const r = checkPremiumSection('milestone', g.json, prep, { timeframe });
    if (isFatal(r)) g = await call(`${prompts.milestone(plan, i)}\n\nLẦN TRƯỚC BỊ LOẠI VÌ: ${r}. Viết lại và sửa đúng lỗi.`, premiumTask.MILESTONE_SCHEMA, 1600);
    return g;
  }));

  const merged = {
    detailedNarrative: plan.detailedNarrative,
    milestones: plan.milestones.map((m, i) => ({
      month: m.month, event: m.event, impact: IMPACT.includes(m.impact) ? m.impact : 'Medium',
      probability: Math.max(0, Math.min(100, Math.round(Number(m.probability) || 70))),
      completed: false, details: toSteps(msGens[i].json?.details, i, false)
    })),
    influencingFactors: plan.influencingFactors,
    strategicPivotPoints: plan.strategicPivotPoints,
    longTermProjection: plan.longTermProjection
  };
  const { json, quality } = renderAndVerify(merged, prep);
  // Chuẩn hóa xong thì áp lại khung thời gian: 5 giai đoạn phủ đủ 1..T, tường thuật mỗi giai đoạn 1 đoạn
  const report = localizeFactors(premiumTimeline.applyTimeline(normalizePremiumAnalysisResponse(json, { title, description, context, timeframe }), timeframe));
  const gens = [planGen, ...msGens];
  report.modelUsed = planGen.model;
  report.usage = gens.reduce((a, g) => ({
    inputTokens: (a.inputTokens || 0) + (g.usage?.inputTokens || 0),
    outputTokens: (a.outputTokens || 0) + (g.usage?.outputTokens || 0),
    costUsd: (a.costUsd || 0) + (g.usage?.costUsd || 0)
  }), {});
  report.quality = {
    task: premiumTask.TASK_ID, provider: planGen.provider, providers: [...new Set(gens.map(g => g.provider))],
    latencyMs: Date.now() - t0, planCheck: reason || 'ok', monthsFollowed: `${followed}/${prompts.periods.length}`, ...quality
  };
  return report;
};

module.exports = { pivot, expandStep, generatePremium, buildPremiumPrompts, buildContext, renderAndVerify, stripUntrustedUrls, isTrustedUrl, toSteps, MILESTONE_SCHEMA, FACTORS_SCHEMA, PIVOTS_SCHEMA, STEP_SCHEMA };
