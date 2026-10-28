const { GoogleGenAI, Type } = require('@google/genai');
const path = require('path');
const fs = require('fs');
const { checkOllamaHealth, generateWithOllama, extractJsonFromText } = require('./ollamaService');
const { getAiProvider } = require('./aiProviderConfig');
const { buildClarificationQuestions } = require('./clarificationService');
const { computeCareerQuant, estimateHappiness, detectRegionKey } = require('./careerRoiService');
const knowledgeService = require('./knowledgeService');

/**
 * Loại bỏ phần prompt injection do frontend nối vào data.decision
 * Ví dụ: "...\n\n[THÔNG TIN BỔ SUNG TỪ NGƯỜI DÙNG]\n- ..."
 */
const sanitizeDecision = (decision) => {
  if (!decision || typeof decision !== 'string') return decision;
  // Cắt bỏ phần "[THÔNG TIN BỔ SUNG..." và bất kỳ injection nào phía sau
  const injectionMarkers = [
    '\n\n[THÔNG TIN BỔ SUNG',
    '\n[THÔNG TIN BỔ SUNG',
    '\n\nTHÔNG TIN BỔ SUNG',
    '\n\n--- THÔNG TIN',
    '\n--- THÔNG TIN'
  ];
  let cleaned = decision;
  for (const marker of injectionMarkers) {
    const idx = cleaned.indexOf(marker);
    if (idx !== -1) {
      cleaned = cleaned.substring(0, idx).trim();
    }
  }
  return cleaned;
};

/**
 * Utility to repair truncated JSON by closing open brackets
 */
const repairJson = (str) => {
  let json = str.trim();
  const stack = [];
  let isInsideString = false;
  let isEscaped = false;

  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    if (char === '"' && !isEscaped) {
      isInsideString = !isInsideString;
    }
    if (isInsideString) {
      isEscaped = (char === '\\' && !isEscaped);
      continue;
    }
    if (char === '{') stack.push('}');
    else if (char === '[') stack.push(']');
    else if (char === '}' || char === ']') {
      if (stack.length > 0 && stack[stack.length - 1] === char) {
        stack.pop();
      }
    }
  }

  // Close open string if truncated mid-string
  if (isInsideString) json += '"';

  // Close all open brackets in reverse order
  while (stack.length > 0) {
    json += stack.pop();
  }
  return json;
};

/**
 * Parse và tự động sửa JSON từ AI output.
 * Su dung jsonrepair library (xu ly Unicode, trailing comma, unescaped quotes, v.v.)
 * Pipeline: pre-clean → JSON.parse → jsonrepair → bracket-repair → Function()
 */
let _jsonrepair = null;
const getJsonRepair = () => {
  if (!_jsonrepair) {
    try {
      _jsonrepair = require('jsonrepair').jsonrepair;
    } catch (e) {
      console.warn('[jsonrepair] Library not available, using fallback');
      _jsonrepair = false;
    }
  }
  return _jsonrepair;
};

const sanitizeRawJsonString = (str) => {
  if (!str || typeof str !== 'string') return '';
  let s = str;
  // 1. Remove control characters except newlines and tabs
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  // 2. Fix multiple consecutive commas
  s = s.replace(/,\s*,+/g, ',');
  // 3. Fix missing values after colon: ": ," -> ": null," or ": }" -> ": null}"
  s = s.replace(/:\s*,/g, ': null,');
  s = s.replace(/:\s*([}\]])/g, ': null $1');
  // 4. Fix trailing commas before closing braces/brackets
  s = s.replace(/,(\s*[}\]])/g, '$1');
  return s;
};

const extractPartialSimulation = (text) => {
  console.log('[AI JSON Recovery] Attempting partial extraction for Simulation...');
  const result = {
    isEnterprise: false,
    summary: '',
    timeline: {},
    scenarios: []
  };

  // 1. Extract summary
  const summaryMatch = text.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
  if (summaryMatch) {
    result.summary = summaryMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
  }

  // 2. Extract timeline block
  const timelineMatch = text.match(/"timeline"\s*:\s*\{([^}]+)\}/i);
  if (timelineMatch) {
    const rawTl = '{' + timelineMatch[1] + '}';
    try {
      const jsonrepair = getJsonRepair();
      const repaired = jsonrepair ? jsonrepair(sanitizeRawJsonString(rawTl)) : rawTl;
      result.timeline = JSON.parse(repaired);
    } catch (e) {
      const startM = rawTl.match(/"start"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
      const sixM = rawTl.match(/"sixMonths"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
      const oneM = rawTl.match(/"oneYear"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
      const threeM = rawTl.match(/"threeYears"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
      result.timeline = {
        start: startM ? startM[1] : undefined,
        sixMonths: sixM ? sixM[1] : undefined,
        oneYear: oneM ? oneM[1] : undefined,
        threeYears: threeM ? threeM[1] : undefined
      };
    }
  }

  // 3. Extract individual scenario objects
  const scenariosBlockMatch = text.match(/"scenarios"\s*:\s*\[([\s\S]*)/i);
  if (scenariosBlockMatch) {
    const block = scenariosBlockMatch[1];
    let depth = 0;
    let objStart = -1;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < block.length; i++) {
      const c = block[i];
      if (escaped) { escaped = false; continue; }
      if (c === '\\' && inString) { escaped = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;

      if (c === '{') {
        if (depth === 0) objStart = i;
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0 && objStart !== -1) {
          const scenarioText = block.substring(objStart, i + 1);
          try {
            const jsonrepair = getJsonRepair();
            const repairedSc = jsonrepair ? jsonrepair(sanitizeRawJsonString(scenarioText)) : scenarioText;
            const parsedSc = JSON.parse(repairedSc);
            if (parsedSc && typeof parsedSc === 'object') {
              result.scenarios.push(parsedSc);
            }
          } catch (scErr) {
            console.warn('[AI JSON Recovery] Skipping unparseable scenario chunk:', scErr.message?.substring(0, 60));
          }
          objStart = -1;
        }
      } else if (c === ']' && depth === 0) {
        break;
      }
    }
  }

  console.log(`[AI JSON Recovery] Recovered: summary=${Boolean(result.summary)}, scenarios=${result.scenarios.length}`);
  return result;
};

const extractPartialPremiumAnalysis = (text) => {
  console.log('[AI JSON Recovery] Attempting partial extraction for Premium Analysis...');
  const result = {
    detailedNarrative: '',
    milestones: [],
    influencingFactors: [],
    strategicPivotPoints: [],
    longTermProjection: ''
  };

  const narrativeMatch = text.match(/"detailedNarrative"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
  if (narrativeMatch) {
    result.detailedNarrative = narrativeMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
  }

  const projMatch = text.match(/"longTermProjection"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
  if (projMatch) {
    result.longTermProjection = projMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
  }

  const extractArrayObjects = (arrayKey) => {
    const regex = new RegExp(`"${arrayKey}"\\s*:\\s*\\[([\\s\\S]*)`, 'i');
    const match = text.match(regex);
    if (!match) return [];
    const block = match[1];
    const items = [];
    let depth = 0;
    let objStart = -1;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < block.length; i++) {
      const c = block[i];
      if (escaped) { escaped = false; continue; }
      if (c === '\\' && inString) { escaped = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;

      if (c === '{') {
        if (depth === 0) objStart = i;
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0 && objStart !== -1) {
          const itemText = block.substring(objStart, i + 1);
          try {
            const jsonrepair = getJsonRepair();
            const repaired = jsonrepair ? jsonrepair(sanitizeRawJsonString(itemText)) : itemText;
            const parsed = JSON.parse(repaired);
            if (parsed && typeof parsed === 'object') {
              items.push(parsed);
            }
          } catch (e) { /* continue */ }
          objStart = -1;
        }
      } else if (c === ']' && depth === 0) {
        break;
      }
    }
    return items;
  };

  result.milestones = extractArrayObjects('milestones');
  result.influencingFactors = extractArrayObjects('influencingFactors');
  result.strategicPivotPoints = extractArrayObjects('strategicPivotPoints');

  console.log(`[AI JSON Recovery] Recovered: narrative=${Boolean(result.detailedNarrative)}, milestones=${result.milestones.length}`);
  return result;
};

const parseAndRepairJson = (text, type = 'generic') => {
  if (!text || typeof text !== 'string') {
    throw new Error('Dữ liệu AI trả về trống hoặc không hợp lệ.');
  }

  // Pre-sanitize text
  const cleaned = extractJsonFromText(text) || text.trim();
  const sanitized = sanitizeRawJsonString(cleaned);

  // Stage 1: Direct parse
  try {
    return JSON.parse(cleaned);
  } catch (e1) { /* continue */ }

  // Stage 2: Direct parse on sanitized
  try {
    return JSON.parse(sanitized);
  } catch (e2) { /* continue */ }

  // Stage 3: jsonrepair on sanitized
  const jsonrepair = getJsonRepair();
  if (jsonrepair) {
    try {
      const repaired = jsonrepair(sanitized);
      return JSON.parse(repaired);
    } catch (e3) { /* continue */ }
  }

  // Stage 4: Clean trailing comma + bracket repair stack
  try {
    const repaired = repairJson(sanitized);
    return JSON.parse(repaired);
  } catch (e4) { /* continue */ }

  // Stage 5: repairJson stack balancer + jsonrepair
  if (jsonrepair) {
    try {
      const bracketFixed = repairJson(sanitized);
      const fullyRepaired = jsonrepair(bracketFixed);
      return JSON.parse(fullyRepaired);
    } catch (e5) { /* continue */ }
  }

  // (Đã bỏ stage dùng `new Function` trên output LLM: thực thi mã do model sinh là lỗ hổng bảo mật)

  // Stage 6: Domain-specific partial recovery
  if (type === 'simulation' || text.includes('"scenarios"')) {
    const partial = extractPartialSimulation(text);
    if (partial && (partial.scenarios.length > 0 || partial.summary)) {
      console.log('[AI JSON] Successfully recovered simulation via partial recovery!');
      return partial;
    }
  }
  if (type === 'premium' || text.includes('"milestones"') || text.includes('"detailedNarrative"')) {
    const partial = extractPartialPremiumAnalysis(text);
    if (partial && (partial.milestones.length > 0 || partial.detailedNarrative)) {
      console.log('[AI JSON] Successfully recovered premium analysis via partial recovery!');
      return partial;
    }
  }
  if (type === 'step' || text.includes('"actions"') || text.includes('"objectives"')) {
    const descMatch = text.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
    const expectedMatch = text.match(/"expectedResult"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
    const extractStringArray = (key) => {
      const m = text.match(new RegExp(`"${key}"\\s*:\\s*\\[([\\s\\S]*?)\\]`, 'i'));
      if (!m) return [];
      const matches = [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)];
      return matches.map(match => match[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').trim());
    };
    return {
      description: descMatch ? descMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n') : '',
      objectives: extractStringArray('objectives'),
      actions: extractStringArray('actions'),
      tools: extractStringArray('tools'),
      expectedResult: expectedMatch ? expectedMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n') : ''
    };
  }

  // Stage 8: Last resort debug log
  console.error('[AI JSON] ALL repair attempts failed.');
  console.error('[AI JSON] Raw text length:', text.length);
  console.error('[AI JSON] First 800 chars:', text.substring(0, 800));
  console.error('[AI JSON] Last 300 chars:', text.substring(text.length - 300));
  throw new Error('Dữ liệu AI trả về không đúng định dạng JSON sau nhiều lần thử sửa. Vui lòng thử lại.');
};


/**
 * Helper to ensure timeline items are always clean readable strings
 */
const stringifyTimelineItem = (item, defaultText) => {
  if (!item) return defaultText;
  if (typeof item === 'string') return item.trim();
  if (typeof item === 'object') {
    if (item.toDo || item.todo) {
      const parts = [];
      if (item.date) parts.push(`[${item.date}]`);
      if (item.toDo || item.todo) parts.push(item.toDo || item.todo);
      if (item.educationLevel) parts.push(`(${item.educationLevel})`);
      return parts.join(' ');
    }
    if (item.description || item.event || item.title || item.action) {
      return item.description || item.event || item.title || item.action;
    }
    const vals = Object.values(item).filter(v => typeof v === 'string' || typeof v === 'number');
    return vals.length > 0 ? vals.join(' - ') : defaultText;
  }
  return String(item);
};

/**
 * Coerce a SWOT item (string or object) → { label, value, color, type }
 */
const normalizeSwotItem = (item, index) => {
  const VALID_SWOT_TYPES = ['S', 'W', 'O', 'T'];
  const swotLabels = ['Điểm mạnh', 'Điểm yếu', 'Cơ hội', 'Thách thức'];
  const swotColors = ['#22c55e', '#ef4444', '#3b82f6', '#f59e0b'];
  const defaultType = VALID_SWOT_TYPES[index % 4];

  // Xác định type hợp lệ từ giá trị AI trả về
  const resolveType = (rawType) => {
    if (!rawType) return defaultType;
    const t = String(rawType).trim().toUpperCase();
    if (VALID_SWOT_TYPES.includes(t)) return t;
    // Map từ tên dài: 'Strength' -> 'S', 'Weakness' -> 'W', etc.
    if (t.startsWith('S')) return 'S';
    if (t.startsWith('W')) return 'W';
    if (t.startsWith('O')) return 'O';
    if (t.startsWith('T')) return 'T';
    return defaultType;
  };

  const defaultValues = {
    'S': 'Sở hữu nền tảng kiến thức tốt và khả năng tiếp thu nhanh nhạy, sẵn sàng đón nhận thử thách mới.',
    'W': 'Cần đầu tư thêm thời gian để rèn luyện kỹ năng thực hành chuyên sâu và nâng cao tính tự lập.',
    'O': 'Nhu cầu thị trường đối với nhân sự có tư duy chủ động và kỹ năng số đang mở rộng mạnh mẽ.',
    'T': 'Áp lực cạnh tranh và sự thay đổi nhanh chóng của công nghệ đòi hỏi khả năng thích ứng liên tục.'
  };

  const sanitizeValue = (val, type) => {
    if (!val || typeof val !== 'string') return defaultValues[type];
    const s = val.trim();
    if (s === '...' || s === '--' || s.length < 10) return defaultValues[type];
    return s;
  };

  if (typeof item === 'string') {
    return {
      label: swotLabels[index % 4],
      value: sanitizeValue(item, defaultType),
      color: swotColors[index % 4],
      type: defaultType
    };
  }
  if (item && typeof item === 'object') {
    const resolvedType = resolveType(item.type);
    const typeIndex = VALID_SWOT_TYPES.indexOf(resolvedType);
    const rawVal = item.value || item.description || item.content || item.text || '';
    return {
      label: item.label || swotLabels[typeIndex >= 0 ? typeIndex : index % 4],
      value: sanitizeValue(rawVal, resolvedType),
      color: item.color || swotColors[typeIndex >= 0 ? typeIndex : index % 4],
      type: resolvedType
    };
  }
  return {
    label: swotLabels[index % 4],
    value: defaultValues[defaultType],
    color: swotColors[index % 4],
    type: defaultType
  };
};

/**
 * Coerce a resource item (string or object) → { label, value, unit, icon, ghostLabel }
 */
const normalizeResourceItem = (item, index) => {
  const defaultLabels = ['Tài chính', 'Thời gian', 'Kỹ năng'];
  const defaultIcons = ['💰', '⏱️', '📚'];
  const defaultUnits = ['triệu/tháng', 'giờ/tuần', 'kỹ năng'];

  if (typeof item === 'string') {
    return {
      label: defaultLabels[index % 3],
      value: 0,
      unit: item, // Put the string as unit/description
      icon: defaultIcons[index % 3],
      ghostLabel: item
    };
  }
  if (item && typeof item === 'object') {
    const val = item.value;
    return {
      label: item.label || item.name || item.title || defaultLabels[index % 3],
      value: typeof val === 'number' ? val : (parseFloat(val) || 0),
      unit: item.unit || item.description || defaultUnits[index % 3],
      icon: item.icon || defaultIcons[index % 3],
      ghostLabel: item.ghostLabel || item.label || item.name || ''
    };
  }
  return { label: defaultLabels[index % 3], value: 0, unit: defaultUnits[index % 3], icon: defaultIcons[index % 3], ghostLabel: '' };
};

/**
 * Coerce a sprint90 item (string or object) → { phase, tasks: string[] }
 */
const normalizeSprint90Item = (item, index) => {
  const defaultPhases = ['Giai đoạn 1 (3 tháng đầu)', 'Giai đoạn 2 (3-6 tháng)', 'Giai đoạn 3 (6-12 tháng)'];

  if (typeof item === 'string') {
    // Try to parse embedded JSON string first
    try {
      const inner = JSON.parse(item);
      if (inner && typeof inner === 'object') {
        return normalizeSprint90Item(inner, index);
      }
    } catch (e) { /* not JSON, treat as task description */ }
    return {
      phase: defaultPhases[index % 3],
      tasks: [item]
    };
  }
  if (item && typeof item === 'object') {
    let tasks = item.tasks || item.actions || item.steps || [];
    if (!Array.isArray(tasks)) {
      tasks = typeof tasks === 'string' ? [tasks] : [];
    }
    tasks = tasks.map(t => (typeof t === 'string' ? t : JSON.stringify(t)));
    return {
      phase: item.phase || item.title || item.name || defaultPhases[index % 3],
      tasks
    };
  }
  return { phase: defaultPhases[index % 3], tasks: [] };
};

/**
 * Ensures the simulation result has all required fields to prevent frontend crashes.
 * Handles both camelCase (deepAnalysis) and snake_case (deep_analysis) from AI output.
 */
const SCENARIO_CONFIGS_STATIC = {
  Positive: {
    type: "Positive",
    defaultCareerGrowth: 92,
    defaultHappiness: 88,
    defaultRoi: 90,
    criticalAdvice: "Tận dụng tối đa đà bứt phá ban đầu để tích lũy sản phẩm thực tế (portfolio, chứng chỉ); đó là bằng chứng thuyết phục nhất trước nhà tuyển dụng.",
    marketFit: { score: 92, analysis: "Mức độ phù hợp xuất sắc với xu hướng thị trường lao động chất lượng cao." }
  },
  Neutral: {
    type: "Neutral",
    defaultCareerGrowth: 78,
    defaultHappiness: 82,
    defaultRoi: 75,
    criticalAdvice: "Giữ vững sự kiên trì và kỷ luật mỗi ngày; thành công lớn đến từ việc tích lũy những thói quen học tập nhỏ một cách bền bỉ.",
    marketFit: { score: 82, analysis: "Phù hợp với đa số tiêu chuẩn tuyển dụng thông thường, mức độ ổn định nghề nghiệp cao." }
  },
  Risk: {
    type: "Risk",
    defaultCareerGrowth: 58,
    defaultHappiness: 62,
    defaultRoi: 52,
    criticalAdvice: "Luôn có quỹ dự phòng và kế hoạch B; ưu tiên bảo toàn tiến độ học tập thay vì ôm đồm quá nhiều việc làm thêm ngoài luồng.",
    marketFit: { score: 68, analysis: "Đòi hỏi nỗ lực bền bỉ và sự nhạy bén để vượt qua rào cản ban đầu trước khi đạt điểm cân bằng." }
  }
};

/**
 * Context-aware SCENARIO_CONFIGS: Generates SWOT, Sprint90, Resources
 * dynamically based on the student's stage and domain profile.
 * This replaces the old static SCENARIO_CONFIGS that were identical for every major.
 */
const getContextualScenarioConfig = (targetType, userContext = {}) => {
  const student = extractHolisticStudentContext(userContext);
  const domain = detectDomainProfile(`${userContext.decision || ''} ${userContext.otherFactors || ''}`, userContext.ragData);
  const staticCfg = SCENARIO_CONFIGS_STATIC[targetType];
  const factors = synthesizeUniversalFactors(userContext.decision || '', userContext);
  const tools = inferUniversalTools(userContext, userContext.decision || '');
  const livingCost = userContext.ragData?.livingCost;
  const costLabel = livingCost ? `~${livingCost.estimated_monthly_student_million} triệu/tháng (${livingCost.city})` : '~5 triệu/tháng';

  const isDuHoc = student.stage === 'DU_HOC_QUOC_TE';
  const isThacSi = student.stage === 'THAC_SI_NGHIEN_CUU';
  const isThptChonToHop = student.stage === 'THPT_CHON_TO_HOP';
  const isThptOnThi = student.stage === 'THPT_ON_THI_DAI_HOC';

  // --- Context-aware SWOT ---
  const swotMap = {
    Positive: [
      {
        type: 'S',
        label: 'Điểm mạnh',
        value: isDuHoc
          ? 'Tư duy cởi mở, khát vọng hội nhập quốc tế và khả năng thích ứng linh hoạt với môi trường học thuật đa văn hóa.'
          : isThacSi
            ? 'Nền tảng học thuật đại học vững vàng và tư duy phản biện khoa học là bệ phóng lớn cho các công trình nghiên cứu chuyên sâu.'
            : isThptChonToHop
              ? 'Sự chủ động định hướng sớm ngay từ cấp 3 giúp xây dựng lộ trình học tập có trọng tâm và phát huy tối đa thế mạnh các môn tự nhiên/xã hội.'
              : isThptOnThi
                ? student.academicPerformance >= 4
                  ? `Học lực xuất sắc (${student.academicPerformance}/5) là điểm tựa vững chắc để bứt phá điểm số tổ hợp xét tuyển và trúng tuyển NV1.`
                  : 'Tinh thần quyết tâm và phương pháp ôn luyện có kỷ luật giúp tối ưu hóa điểm số kỳ thi tốt nghiệp và kỳ thi ĐGNL.'
                : student.academicPerformance >= 4
                  ? `Học lực vượt trội (${student.academicPerformance}/5) là nền tảng tiếp thu nhanh kiến thức chuyên sâu ngành ${domain.name} và chinh phục các tiêu chuẩn tuyển dụng khắt khe.`
                  : `Tư duy chủ động và quyết tâm theo đuổi ngành ${domain.name} tạo lợi thế khác biệt so với các bạn đồng trang lứa.`,
        color: '#22c55e'
      },
      {
        type: 'W',
        label: 'Điểm yếu',
        value: isDuHoc
          ? 'Cần tối ưu hóa điểm số bài thi chuẩn hóa (IELTS/SAT/GRE) và đầu tư thời gian hoàn thiện bài luận cá nhân mang đậm bản sắc riêng.'
          : isThacSi
            ? 'Kỹ năng viết học thuật theo chuẩn quốc tế và khả năng sử dụng các công cụ phân tích dữ liệu chuyên sâu cần tiếp tục trau dồi.'
            : isThptChonToHop
              ? 'Chưa có nhiều trải nghiệm thực tế với ngành nghề tương lai, dễ bị dao động nếu gặp môn học có độ khó cao trong tổ hợp.'
              : isThptOnThi
                ? 'Áp lực tâm lý mùa thi và nguy cơ bị hổng một số chuyên đề phân loại điểm 9-10 nếu không có chiến lược luyện đề khoa học.'
                : student.personalFinance <= 2
                  ? `Áp lực tài chính (${student.personalFinance}/5) đòi hỏi chiến lược quản trị chi phí khoa học, chủ động săn học bổng và tối ưu hóa nguồn lực.`
                  : `Cần cân đối thời gian hợp lý giữa nền tảng lý thuyết, thực hành công cụ chuyên ngành (${tools[0]}) và hoạt động ngoại khóa.`,
        color: '#ef4444'
      },
      {
        type: 'O',
        label: 'Cơ hội',
        value: isDuHoc
          ? 'Tiếp cận các quỹ học bổng danh giá, cơ hội ở lại làm việc tại các quốc gia phát triển và mở rộng mạng lưới quan hệ toàn cầu.'
          : isThacSi
            ? 'Cơ hội tham gia các đề tài nghiên cứu cấp Bộ/Nhà nước, công bố bài báo khoa học và định hình vị thế chuyên gia đầu ngành.'
            : isThptChonToHop || isThptOnThi
              ? `Chính sách xét tuyển sớm đa dạng (học bạ, IELTS, ĐGNL) mở ra nhiều cánh cửa trúng tuyển đại học chất lượng cao cho ngành ${domain.name}.`
              : `Ngành ${domain.name} đang có nhu cầu nhân lực cao, tạo cơ hội giành học bổng, tham gia nghiên cứu và thực tập tại doanh nghiệp hàng đầu ngay từ sớm.`,
        color: '#3b82f6'
      },
      {
        type: 'T',
        label: 'Thách thức',
        value: isDuHoc
          ? 'Sự cạnh tranh hồ sơ học bổng ngày càng gay gắt, biến động chính sách visa và rào cản thích ứng văn hóa bước đầu.'
          : isThacSi
            ? 'Áp lực cân bằng giữa công việc sinh kế và tiến độ hoàn thành luận văn Thạc sĩ đúng hạn theo tiêu chuẩn hội đồng.'
            : isThptOnThi
              ? 'Điểm chuẩn các ngành hot có tính biến động cao và áp lực cạnh tranh chỉ tiêu giữa các phương thức xét tuyển.'
              : isThptChonToHop
                ? 'Sự thay đổi trong cấu trúc đề thi và quy định tuyển sinh của các trường đòi hỏi phải cập nhật thông tin liên tục.'
                : `Áp lực duy trì phong độ xuất sắc trong môi trường cạnh tranh của ngành ${domain.name} và thích ứng với các công nghệ thay đổi nhanh.`,
        color: '#f59e0b'
      }
    ],
    Neutral: [
      {
        type: 'S',
        label: 'Điểm mạnh',
        value: isDuHoc
          ? 'Mục tiêu rõ ràng, kế hoạch tài chính có sự chuẩn bị và ý thức tự lập cao khi bước ra môi trường mới.'
          : isThacSi
            ? 'Kinh nghiệm làm việc thực tế giúp tiếp cận các môn học cao học với góc nhìn ứng dụng thực tiễn sắc bén.'
            : isThptChonToHop || isThptOnThi
              ? 'Tính kiên trì và khả năng học tập ổn định, hoàn thành tốt các môn học chính khóa trong chương trình phổ thông.'
              : `Tính kiên định và khả năng duy trì nhịp độ học tập ổn định trong lĩnh vực ${domain.name}, không bị quá tải áp lực.`,
        color: '#22c55e'
      },
      {
        type: 'W',
        label: 'Điểm yếu',
        value: isDuHoc
          ? 'Trình độ ngoại ngữ giao tiếp và học thuật cần thêm thời gian để đạt độ lưu loát và tự nhiên tuyệt đối.'
          : isThacSi
            ? 'Thời gian dành cho nghiên cứu bị giới hạn do phải đảm bảo công việc chuyên môn hàng ngày.'
            : isThptChonToHop || isThptOnThi
              ? 'Điểm số ở mức khá nhưng chưa thực sự bứt phá ở các môn phân loại cao, cần chiến lược rèn luyện có trọng tâm hơn.'
              : `Tốc độ tích lũy kỹ năng chuyên sâu (${tools[0]}, ${tools[1] || 'ngoại ngữ'}) ở mức vừa phải, cần thêm động lực bứt phá khỏi vùng an toàn.`,
        color: '#ef4444'
      },
      {
        type: 'O',
        label: 'Cơ hội',
        value: isDuHoc
          ? 'Các chương trình du học bán phần, liên kết quốc tế 2+2 hoặc các trường đại học có học phí vừa sức tại châu Á/châu Âu.'
          : isThacSi
            ? 'Nâng cấp bằng cấp và năng lực chuyên môn để sẵn sàng đón nhận cơ hội thăng tiến lên vị trí quản lý hoặc giảng viên.'
            : isThptChonToHop || isThptOnThi
              ? `Nhiều trường đại học đào tạo ngành ${domain.name} với phổ điểm chuẩn phù hợp và môi trường thực hành tốt.`
              : `Thị trường ngành ${domain.name} luôn cần nhân sự vững tay nghề, đáng tin cậy – đây là lợi thế lớn cho người phát triển bền bỉ dài hạn.`,
        color: '#3b82f6'
      },
      {
        type: 'T',
        label: 'Thách thức',
        value: isDuHoc
          ? 'Chi phí sinh hoạt và tỷ giá ngoại tệ biến động đòi hỏi sự quản lý chi tiêu cá nhân chặt chẽ.'
          : isThacSi
            ? 'Nguy cơ kéo dài thời gian bảo vệ luận văn nếu không kiểm soát tốt các mốc tiến độ nghiên cứu.'
            : isThptChonToHop || isThptOnThi
              ? 'Tâm lý an toàn có thể khiến người học bỏ lỡ các cơ hội xét tuyển sớm hoặc vào các trường đại học dẫn đầu.'
              : `Cần cảnh giác trước xu hướng thay đổi nhanh của ngành ${domain.name} để không bị tụt lại so với các bạn đồng nghiệp chủ động hơn.`,
        color: '#f59e0b'
      }
    ],
    Risk: [
      {
        type: 'S',
        label: 'Điểm mạnh',
        value: isDuHoc
          ? 'Bản lĩnh dám nghĩ dám làm và ý chí kiên định vượt qua rào cản tài chính hoặc điều kiện xuất phát điểm.'
          : isThacSi
            ? 'Quyết tâm vượt khó và khả năng tự nghiên cứu các tài liệu chuyên ngành phức tạp trong hoàn cảnh hạn hẹp.'
            : isThptChonToHop || isThptOnThi
              ? 'Khả năng chịu áp lực thi cử tốt và sự nhạy bén khi điều chỉnh chiến lược nguyện vọng phút chót.'
              : `Khả năng chịu áp lực và bản lĩnh linh hoạt giúp thích ứng nhanh với môi trường cạnh tranh khắc nghiệt của ngành ${domain.name}.`,
        color: '#22c55e'
      },
      {
        type: 'W',
        label: 'Điểm yếu',
        value: isDuHoc
          ? 'Nguồn lực tài chính hạn hẹp hoặc điểm ngoại ngữ chưa đạt ngưỡng an toàn, phụ thuộc lớn vào việc xin học bổng cao.'
          : isThacSi
            ? 'Gánh nặng tài chính và thời gian làm việc có nguy cơ khiến việc học Thạc sĩ bị gián đoạn giữa chừng.'
            : isThptChonToHop || isThptOnThi
              ? student.stress >= 4
                ? `Áp lực tâm lý thi cử nặng nề (${student.stress}/5) có thể ảnh hưởng đến phong độ làm bài trong phòng thi.`
                : 'Học lực còn chênh lệch giữa các môn trong tổ hợp, dễ mất điểm ở các nội dung lý thuyết cơ bản.'
              : student.personalFinance <= 2
                ? `Nguồn lực tài chính hạn chế (${student.personalFinance}/5) tạo rào cản lớn trong việc duy trì lộ trình đào tạo dài hạn.`
                : `Nguy cơ xao nhãng mục tiêu học tập chính nếu không kiểm soát tốt thời gian giữa việc làm thêm và ôn luyện chuyên ngành.`,
        color: '#ef4444'
      },
      {
        type: 'O',
        label: 'Cơ hội',
        value: isDuHoc
          ? 'Rèn luyện khả năng sinh tồn và tự lập xuất sắc, tìm kiếm các chương trình vừa học vừa làm hoặc học bổng hỗ trợ khó khăn.'
          : isThacSi
            ? 'Học hỏi từ các bài học thực nghiệm thực tế, phát triển năng lực giải quyết vấn đề dưới áp lực cao.'
            : isThptChonToHop || isThptOnThi
              ? 'Các phương án nguyện vọng bổ sung, ngành đào tạo chất lượng cao liên kết hoặc hệ cao đẳng nghề liên thông uy tín.'
              : `Rèn luyện bản lĩnh vượt khó sớm qua trải nghiệm thực tế, tích lũy kinh nghiệm thực chiến ngành ${domain.name} trước các bạn cùng trang lứa.`,
        color: '#3b82f6'
      },
      {
        type: 'T',
        label: 'Thách thức',
        value: isDuHoc
          ? 'Rủi ro bị từ chối thị thực (visa), thiếu hụt kinh phí sinh hoạt giữa chừng nếu không có nguồn tài trợ ổn định.'
          : isThacSi
            ? 'Áp lực tài chính và cạn kiệt năng lượng tinh thần khi vừa gánh vác công việc kiếm sống vừa làm đề tài khoa học.'
            : isThptChonToHop || isThptOnThi
              ? 'Nguy cơ trượt nguyện vọng mong muốn nếu đặt mục tiêu quá cao so với năng lực thực tế mà thiếu phương án dự phòng.'
              : student.stress >= 4
                ? `Áp lực tinh thần cao (${student.stress}/5) kết hợp cạnh tranh gay gắt đòi hỏi phương pháp cân bằng sức khỏe tinh thần chặt chẽ.`
                : `Cạnh tranh gay gắt từ thị trường lao động và nguy cơ mất phương hướng nếu không có kế hoạch hành động rõ ràng.`,
        color: '#f59e0b'
      }
    ]
  };

  // --- Context-aware Sprint90 ---
  let sprint90Map;
  if (isThptChonToHop) {
    sprint90Map = {
      Positive: [
        { phase: 'Giai đoạn 1 (3 tháng đầu)', tasks: [`Đánh giá học lực các môn khoa học, tham vấn thầy cô và chốt tổ hợp môn KHTN/KHXH tối ưu cho ngành ${domain.name}`, 'Thiết lập thời gian biểu tự học 15h/tuần, rèn luyện phương pháp đọc hiểu sách giáo khoa chương trình mới'] },
        { phase: 'Giai đoạn 2 (3-6 tháng)', tasks: ['Tập trung bứt phá điểm kiểm tra định kỳ, giữ vững GPA học kỳ đầu >= 8.5 các môn trọng tâm', 'Rèn luyện tiếng Anh nền tảng hàng ngày và tìm hiểu chuẩn tuyển sinh các trường ĐH'] },
        { phase: 'Giai đoạn 3 (6-12 tháng)', tasks: [`Gia nhập CLB học thuật hoặc dự án nghiên cứu nhỏ về ${domain.name} để củng cố đam mê`, 'Tham gia các kỳ thi học sinh giỏi trường/tỉnh để tạo lợi thế xét tuyển sớm sau này'] }
      ],
      Neutral: [
        { phase: 'Giai đoạn 1 (3 tháng đầu)', tasks: ['Khảo sát kỹ chương trình các môn học mới, lựa chọn tổ hợp môn học vừa sức với năng lực', 'Xây dựng thói quen ghi chép khoa học và chủ động chuẩn bị bài trước khi đến lớp'] },
        { phase: 'Giai đoạn 2 (3-6 tháng)', tasks: ['Duy trì phong độ học tập đều đặn tất cả các môn, đảm bảo điểm GPA học kỳ >= 7.5', 'Cân bằng thời gian học tập với sinh hoạt thể thao, ngoại khóa để tránh áp lực'] },
        { phase: 'Giai đoạn 3 (6-12 tháng)', tasks: [`Khám phá sở thích nghề nghiệp và các trường đại học đào tạo nhóm ngành ${domain.name}`, 'Đánh giá lại kết quả năm học và tinh chỉnh phương pháp ôn tập cho năm tiếp theo'] }
      ],
      Risk: [
        { phase: 'Giai đoạn 1 (3 tháng đầu)', tasks: ['Xác định ngay những môn học còn yếu trong tổ hợp đã chọn để kịp thời lấp lỗ hổng', 'Tham gia các nhóm học tập đồng đẳng hoặc nhờ thầy cô phụ đạo thêm ngoài giờ'] },
        { phase: 'Giai đoạn 2 (3-6 tháng)', tasks: ['Điều chỉnh phương pháp học tập, ưu tiên nắm chắc kiến thức cơ bản trong sách giáo khoa', 'Giữ vững tâm lý thoải mái, không tạo áp lực quá tải làm ảnh hưởng sức khỏe'] },
        { phase: 'Giai đoạn 3 (6-12 tháng)', tasks: ['Đánh giá lại mức độ phù hợp của tổ hợp môn học, chuẩn bị phương án điều chỉnh nếu cần', 'Chủ động xây dựng kế hoạch bù đắp điểm số các môn còn thấp trong học kỳ hè'] }
      ]
    };
  } else if (isThptOnThi) {
    sprint90Map = {
      Positive: [
        { phase: 'Giai đoạn 1 (3 tháng đầu)', tasks: ['Hệ thống hóa toàn bộ kiến thức lớp 11-12 theo chuyên đề thi tốt nghiệp và ĐGNL', 'Xác định các dạng bài trọng tâm, xây dựng mục tiêu đạt 8.5+ mỗi môn tổ hợp xét tuyển'] },
        { phase: 'Giai đoạn 2 (3-6 tháng)', tasks: ['Tăng tốc luyện giải đề thi thử chuẩn cấu trúc bấm giờ thực tế, rèn kỹ năng xử lý câu phân loại', 'Hoàn thiện hồ sơ xét tuyển sớm (học bạ, chứng chỉ ngoại ngữ, điểm ĐGNL) vào các trường NV1'] },
        { phase: 'Giai đoạn 3 (6-12 tháng)', tasks: ['Rà soát lại toàn bộ lỗi sai hay gặp, giữ phong độ và sức khỏe tinh thần tối ưu trước ngày thi', 'Chốt danh sách đăng ký nguyện vọng đại học thông minh theo chiến lược 3 tầng an toàn'] }
      ],
      Neutral: [
        { phase: 'Giai đoạn 1 (3 tháng đầu)', tasks: ['Lập lịch ôn thi cố định mỗi ngày, nắm vững chắc các kiến thức cơ bản để đạt 7-8 điểm', 'Luyện giải các đề thi tham khảo chính thức của Bộ GD&ĐT các năm gần nhất'] },
        { phase: 'Giai đoạn 2 (3-6 tháng)', tasks: ['Tham gia thi thử tại trường để rèn luyện tâm lý phòng thi và kỹ năng quản lý thời gian', `Tìm hiểu điểm chuẩn tham chiếu các năm của ngành ${domain.name} tại các trường mục tiêu`] },
        { phase: 'Giai đoạn 3 (6-12 tháng)', tasks: ['Nộp hồ sơ xét tuyển sớm theo các phương thức an toàn để cầm chắc cơ hội trúng tuyển', 'Ôn tập nhẹ nhàng tuần cuối, giữ tâm lý tự tin và hoàn thành tốt kỳ thi tốt nghiệp'] }
      ],
      Risk: [
        { phase: 'Giai đoạn 1 (3 tháng đầu)', tasks: ['Tập trung tối đa thời gian vào phần kiến thức dễ lấy điểm (6-7 điểm) để không bị mất điểm oan', 'Lập danh sách các phần kiến thức hay nhầm lẫn và ôn luyện kỹ lưỡng mỗi tuần'] },
        { phase: 'Giai đoạn 2 (3-6 tháng)', tasks: ['Tận dụng tối đa phương thức xét tuyển bằng học bạ THPT để giảm bớt áp lực thi cử', 'Chuẩn bị danh sách các trường đại học top 2 hoặc hệ cao đẳng uy tín làm phương án dự phòng'] },
        { phase: 'Giai đoạn 3 (6-12 tháng)', tasks: ['Đăng ký nguyện vọng với sự phân bổ an toàn cao, giữ vững tâm lý bình tĩnh khi làm bài thi', 'Sẵn sàng các phương án xét tuyển đợt bổ sung nếu kết quả thi không như kỳ vọng'] }
      ]
    };
  } else if (isDuHoc) {
    sprint90Map = {
      Positive: [
        { phase: 'Giai đoạn 1 (3 tháng đầu)', tasks: ['Tập trung ôn luyện cường độ cao và thi đạt chứng chỉ ngoại ngữ mục tiêu (IELTS 7.5+ / SAT 1450+)', 'Lập danh sách 5-8 trường đại học quốc tế mục tiêu có thế mạnh đào tạo và chính sách học bổng tốt'] },
        { phase: 'Giai đoạn 2 (3-6 tháng)', tasks: ['Viết và trau chuốt bài luận cá nhân (Statement of Purpose / SOP) mang đậm bản sắc riêng', 'Kết nối thầy cô, mentor uy tín xin các bức thư giới thiệu (Letter of Recommendation - LoR)'] },
        { phase: 'Giai đoạn 3 (6-12 tháng)', tasks: ['Hoàn thiện và nộp hồ sơ xin học bổng trước hạn chót (Early Deadline), chuẩn bị hồ sơ tài chính', 'Luyện tập kỹ năng phỏng vấn học bổng/visa và tham gia các hội thảo tiền du học'] }
      ],
      Neutral: [
        { phase: 'Giai đoạn 1 (3 tháng đầu)', tasks: ['Kiểm tra trình độ tiếng Anh hiện tại, đăng ký khóa luyện thi bám sát chuẩn đầu vào (IELTS 6.5)', 'Tìm hiểu các chương trình liên kết quốc tế 2+2 hoặc các nước có chi phí học tập vừa phải'] },
        { phase: 'Giai đoạn 2 (3-6 tháng)', tasks: ['Hoàn thành bài luận giới thiệu bản thân, chuẩn bị bảng điểm học bạ dịch thuật công chứng', 'Rà soát các điều kiện cấp visa du học và chuẩn bị giấy tờ chứng minh tài chính gia đình'] },
        { phase: 'Giai đoạn 3 (6-12 tháng)', tasks: ['Nộp hồ sơ xét tuyển nhập học, nhận thư mời (Offer Letter) và tiến hành nộp hồ sơ xin thị thực visa', 'Chuẩn bị hành trang cá nhân, tìm hiểu văn hóa nước sở tại và kết nối hội sinh viên Việt Nam'] }
      ],
      Risk: [
        { phase: 'Giai đoạn 1 (3 tháng đầu)', tasks: ['Tính toán ngân sách du học chi tiết, xác định hạn mức tài chính tối đa gia đình có thể chu cấp', 'Tìm kiếm các trường có mức học phí thấp hoặc các quốc gia cho phép làm thêm hợp pháp'] },
        { phase: 'Giai đoạn 2 (3-6 tháng)', tasks: ['Chuẩn bị thêm phương án B (chương trình đại học quốc tế tại Việt Nam hoặc chuyển tiếp)', 'Hoàn thiện hồ sơ tài chính minh bạch, nhờ chuyên gia tư vấn rà soát lỗi hồ sơ xin visa'] },
        { phase: 'Giai đoạn 3 (6-12 tháng)', tasks: ['Nộp hồ sơ và chuẩn bị phương án dự phòng nếu trượt visa hoặc không đạt mức học bổng kỳ vọng', 'Rèn luyện kỹ năng tự lập, nấu ăn và quản lý chi tiêu nghiêm ngặt trước khi xuất cảnh'] }
      ]
    };
  } else if (isThacSi) {
    sprint90Map = {
      Positive: [
        { phase: 'Giai đoạn 1 (3 tháng đầu)', tasks: ['Tổng quan tài liệu chuyên khảo quốc tế (Literature Review), định hình khoảng trống nghiên cứu tiềm năng', 'Xác định đề tài nghiên cứu Thạc sĩ đột phá gắn liền với xu hướng phát triển của ngành'] },
        { phase: 'Giai đoạn 2 (3-6 tháng)', tasks: ['Soạn thảo đề cương nghiên cứu (Research Proposal) chi tiết, liên hệ Giáo sư hướng dẫn phù hợp', 'Chuẩn bị hồ sơ ứng tuyển học bổng sau đại học / chương trình cao học chất lượng cao'] },
        { phase: 'Giai đoạn 3 (6-12 tháng)', tasks: ['Trúng tuyển Thạc sĩ, hoàn thành các học phần lý thuyết nâng cao và bắt tay vào thu thập dữ liệu', 'Viết bản thảo bài báo khoa học đầu tiên nộp các hội thảo hoặc tạp chí chuyên ngành'] }
      ],
      Neutral: [
        { phase: 'Giai đoạn 1 (3 tháng đầu)', tasks: ['Rà soát các điều kiện đầu vào Thạc sĩ (văn bằng, chứng chỉ ngoại ngữ B2/IELTS 6.0)', 'Củng cố phương pháp nghiên cứu khoa học cơ bản và kỹ năng xử lý số liệu'] },
        { phase: 'Giai đoạn 2 (3-6 tháng)', tasks: ['Hoàn tất thủ tục đăng ký dự thi/xét tuyển cao học, hoàn thành các môn học bổ túc kiến thức', 'Xác định hướng đề tài luận văn có tính ứng dụng cao trong công việc thực tế'] },
        { phase: 'Giai đoạn 3 (6-12 tháng)', tasks: ['Hoàn thành tốt các học phần chuyên ngành cao học, thảo luận đề cương với giảng viên hướng dẫn', 'Cân đối hợp lý giữa thời gian làm việc tại cơ quan và thời gian nghiên cứu tại trường'] }
      ],
      Risk: [
        { phase: 'Giai đoạn 1 (3 tháng đầu)', tasks: ['Lên kế hoạch cân đối tài chính cho toàn khóa học Thạc sĩ, tránh tình trạng gián đoạn giữa chừng', 'Thương lượng với cơ quan làm việc để có sự linh hoạt về thời gian học buổi tối/cuối tuần'] },
        { phase: 'Giai đoạn 2 (3-6 tháng)', tasks: ['Lựa chọn đề tài luận văn sử dụng nguồn dữ liệu sẵn có từ công việc để giảm tải thời gian', 'Thiết lập kỷ luật tự học nghiêm ngặt để hoàn thành bài tập các học phần đúng hạn'] },
        { phase: 'Giai đoạn 3 (6-12 tháng)', tasks: ['Bảo vệ đề cương luận văn Thạc sĩ, duy trì trao đổi định kỳ với người hướng dẫn', 'Tránh mở rộng phạm vi đề tài quá lớn, tập trung giải quyết trọn vẹn mục tiêu cốt lõi'] }
      ]
    };
  } else {
    // University / Professional stage
    sprint90Map = {
      Positive: [
        { phase: 'Giai đoạn 1 (3 tháng đầu)', tasks: [`Thiết lập lịch tự học 20h/tuần, nắm vững kiến thức nền tảng cốt lõi ngành ${domain.name}`, `Bắt đầu làm quen công cụ chuyên ngành ${tools[0]} qua các dự án nhỏ`] },
        { phase: 'Giai đoạn 2 (3-6 tháng)', tasks: [`Xây dựng đồ án/sản phẩm mini đưa lên Portfolio với ${tools[1] || tools[0]}`, 'Rèn luyện tiếng Anh chuyên ngành hàng ngày và tham gia CLB học thuật'] },
        { phase: 'Giai đoạn 3 (6-12 tháng)', tasks: [`Tham gia cuộc thi học thuật hoặc ứng tuyển thực tập sớm tại doanh nghiệp ngành ${domain.name}`, 'Mở rộng kết nối với giảng viên, mentor và anh chị cựu sinh viên'] }
      ],
      Neutral: [
        { phase: 'Giai đoạn 1 (3 tháng đầu)', tasks: [`Nắm chắc kiến thức cốt lõi ngành ${domain.name} và hoàn thành đầy đủ bài tập học phần`, 'Lên kế hoạch sinh hoạt khoa học, giữ vững thể lực và tinh thần'] },
        { phase: 'Giai đoạn 2 (3-6 tháng)', tasks: [`Luyện tập kỹ năng thực hành ${tools[0]} qua bài tập nhóm và dự án cá nhân`, 'Trau dồi tiếng Anh giao tiếp và chuyên ngành đều đặn mỗi ngày'] },
        { phase: 'Giai đoạn 3 (6-12 tháng)', tasks: ['Hoàn thiện hồ sơ năng lực và tìm kiếm cơ hội thực tập hè phù hợp chuyên ngành', 'Đánh giá tiến độ và tinh chỉnh kế hoạch cho giai đoạn tiếp theo'] }
      ],
      Risk: [
        { phase: 'Giai đoạn 1 (3 tháng đầu)', tasks: ['Tìm kiếm nguồn tài liệu miễn phí chất lượng cao và tối ưu hóa ngân sách sinh hoạt', `Xác định các môn học cốt lõi nhất của ngành ${domain.name} để tập trung thời gian hiệu quả`] },
        { phase: 'Giai đoạn 2 (3-6 tháng)', tasks: [`Tìm việc làm thêm phù hợp lĩnh vực ${domain.name} để vừa có thu nhập vừa có kinh nghiệm`, 'Tham gia nhóm hỗ trợ học tập và kết nối mentor miễn phí'] },
        { phase: 'Giai đoạn 3 (6-12 tháng)', tasks: ['Đánh giá lại tình hình tài chính và kết quả học tập, điều chỉnh chiến lược', 'Chủ động đăng ký chính sách hỗ trợ sinh viên hoặc học bổng khuyến khích'] }
      ]
    };
  }

  // --- Context-aware Resources ---
  let resources;
  if (isDuHoc) {
    const costVal = targetType === 'Positive' ? 18 : targetType === 'Neutral' ? 28 : 38;
    resources = [
      { label: 'Tài chính', value: costVal, unit: 'triệu/tháng', icon: '💰', ghostLabel: `Học phí & sinh hoạt du học ${targetType === 'Positive' ? '(đã trừ học bổng)' : '(tự túc)'}` },
      { label: 'Thời gian', value: targetType === 'Positive' ? 25 : targetType === 'Neutral' ? 20 : 15, unit: 'giờ/tuần', icon: '⏱️', ghostLabel: 'Thời gian luyện thi chứng chỉ ngoại ngữ & làm hồ sơ' },
      { label: 'Kỹ năng', value: targetType === 'Positive' ? 4 : targetType === 'Neutral' ? 3 : 2, unit: 'tiêu chí vàng', icon: '📚', ghostLabel: 'IELTS/SAT, Statement of Purpose & Thư giới thiệu' }
    ];
  } else if (isThptChonToHop) {
    resources = [
      { label: 'Tài chính', value: 3, unit: 'triệu/tháng', icon: '💰', ghostLabel: 'Chi phí học tập, sách giáo khoa & tài liệu nâng cao' },
      { label: 'Thời gian', value: 16, unit: 'giờ/tuần', icon: '⏱️', ghostLabel: 'Thời gian tự học & rèn luyện phương pháp tư duy' },
      { label: 'Kỹ năng', value: 3, unit: 'môn trọng tâm', icon: '📚', ghostLabel: 'Điểm tổng kết các môn thuộc tổ hợp lựa chọn' }
    ];
  } else if (isThptOnThi) {
    resources = [
      { label: 'Tài chính', value: 4, unit: 'triệu/tháng', icon: '💰', ghostLabel: 'Chi phí ôn thi chuyên đề, thi thử & tài liệu chuẩn' },
      { label: 'Thời gian', value: 26, unit: 'giờ/tuần', icon: '⏱️', ghostLabel: 'Thời gian luyện đề thi thử & lấp lỗ hổng kiến thức' },
      { label: 'Kỹ năng', value: 3, unit: 'môn thi chính', icon: '📚', ghostLabel: 'Mục tiêu điểm số tổ hợp xét tuyển NV1' }
    ];
  } else if (isThacSi) {
    resources = [
      { label: 'Tài chính', value: 7, unit: 'triệu/tháng', icon: '💰', ghostLabel: 'Học phí cao học & kinh phí nghiên cứu đề tài' },
      { label: 'Thời gian', value: 20, unit: 'giờ/tuần', icon: '⏱️', ghostLabel: 'Thời gian đọc tài liệu chuyên khảo & viết luận văn' },
      { label: 'Kỹ năng', value: 3, unit: 'năng lực học thuật', icon: '📚', ghostLabel: 'Phương pháp nghiên cứu, phân tích số liệu & viết bài báo' }
    ];
  } else {
    const defaultResourceVals = targetType === 'Positive' ? [5, 22, 4] : targetType === 'Neutral' ? [5, 18, 3] : [4, 15, 2];
    resources = [
      { label: 'Tài chính', value: defaultResourceVals[0], unit: 'triệu/tháng', icon: '💰', ghostLabel: `Chi phí học tập & sinh hoạt ${costLabel}` },
      { label: 'Thời gian', value: defaultResourceVals[1], unit: 'giờ/tuần', icon: '⏱️', ghostLabel: `Thời gian học tập & thực hành ${domain.name}` },
      { label: 'Kỹ năng', value: defaultResourceVals[2], unit: 'kỹ năng cốt lõi', icon: '📚', ghostLabel: `Kỹ năng chuyên sâu: ${tools.slice(0, 2).join(', ')}` }
    ];
  }

  return {
    ...staticCfg,
    defaultTitle: `Kịch bản ${targetType === 'Positive' ? 'Tối Ưu' : targetType === 'Neutral' ? 'Cân Bằng' : 'Thận Trọng'}: ${targetType === 'Positive' ? 'Đột Phá' : targetType === 'Neutral' ? 'Phát Triển Vững Vàng' : 'Kiểm Soát Rủi Ro'} ngành ${domain.name}`,
    defaultDescription: getDomainDescription(targetType, userContext),
    swot: swotMap[targetType],
    resources,
    sprint90: sprint90Map[targetType]
  };
};

// Backward-compatible accessor
const SCENARIO_CONFIGS = new Proxy(SCENARIO_CONFIGS_STATIC, {
  get(target, prop) {
    if (prop in target) return target[prop];
    return undefined;
  }
});

const toVietnameseAscii = (str) => {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
};

/**
 * =========================================================================
 * UNIVERSAL CONTEXT INTELLIGENCE & DYNAMIC SYNTHESIS ENGINE
 * =========================================================================
 * Flexible, holistic, highly empathetic career & academic guidance.
 * Automatically adapts to ANY stage (THPT Grade 10-12, University Year 1-4,
 * Career Switch, Dual Degree, Study Abroad, Freelance/Startup) and ANY discipline
 * (Architecture, Law, Psychology, Pedagogy, Agriculture, Arts, Aviation, Medicine, IT, etc.)
 * =========================================================================
 */

const extractHolisticStudentContext = (data = {}) => {
  const decision = data.decision || '';
  const otherFactors = data.otherFactors || '';
  const educationLevel = data.educationLevel || '';
  const clarifications = Array.isArray(data.clarifications) ? data.clarifications.join(' ') : '';
  const fullText = `${decision} ${otherFactors} ${educationLevel} ${clarifications}`.trim();
  const norm = toVietnameseAscii(fullText);

  // 1. Detect Academic / Career Stage (Use norm to avoid ASCII boundary issues with Vietnamese accents)
  let stage = 'DAI_HOC_DAI_CUONG'; // default balanced stage
  let stageLabel = 'Đại học / Chuyên nghiệp';

  if ((/(du hoc|hoc bong|ielts|toefl|dinh cu|nuoc ngoai)/i.test(norm) || /\bSAT\b/.test(fullText))) {
    stage = 'DU_HOC_QUOC_TE';
    stageLabel = 'Định hướng Du học & Học bổng Quốc tế';
  } else if (/(thac si|master|sau dai hoc|cao hoc|nghien cuu sinh|postgraduate|phd|hoc len cao|luan van)/i.test(norm)) {
    stage = 'THAC_SI_NGHIEN_CUU';
    stageLabel = 'Sinh viên định hướng Thạc sĩ & Nghiên cứu Sau đại học';
  } else if (/(lop 10|lop 11|chon to hop|to hop khtn|to hop khxh)/i.test(norm) && !/(dai hoc|sinh vien|nam \d|tot nghiep)/i.test(norm)) {
    stage = 'THPT_CHON_TO_HOP';
    stageLabel = 'Học sinh THPT (Lớp 10-11: Chọn tổ hợp & Định hướng sớm)';
  } else if (/(lop 12|on thi|tot nghiep thpt|thi dai hoc|nguyen vong|xet tuyen|dgnl|dgtd)/i.test(norm) || (/(thpt|cap 3)/i.test(norm) && /(dai hoc|nganh|truong)/i.test(norm))) {
    stage = 'THPT_ON_THI_DAI_HOC';
    stageLabel = 'Học sinh THPT Lớp 12 (Ôn thi tốt nghiệp & Xét tuyển Đại học)';
  } else if (/(khoi nghiep|startup|freelance|freelancer|\btu do\b|kinh doanh rieng|mo quan|mo studio|agency)/i.test(norm)) {
    stage = 'KHOI_NGHIEP_FREELANCE';
    stageLabel = 'Khởi nghiệp, Freelancer & Xây dựng sự nghiệp độc lập';
  } else if (/(song bang|song nganh|chuyen nganh 2|chuyen sang nganh|muon chuyen nganh|doi nganh|hoc them bang|van bang 2)/i.test(norm)) {
    stage = 'CHUYEN_NGANH_SONG_BANG';
    stageLabel = 'Người học Song bằng / Chuyển hướng chuyên ngành';
  } else if (/(nam 3|nam 4|nam cuoi|thuc tap|khoa luan|do an tot nghiep|ra truong)/i.test(norm) && !/\bnam (1|2|nhat|hai)\b/i.test(norm)) {
    stage = 'DAI_HOC_CHUYEN_NGANH_THUC_TAP';
    stageLabel = 'Sinh viên Chuyên ngành & Năm cuối (Thực tập, Đồ án & Chuẩn bị việc làm)';
  } else if (/(nam 1|nam 2|nam nhat|nam hai|dai cuong|tan sinh vien)/i.test(norm)) {
    stage = 'DAI_HOC_DAI_CUONG';
    stageLabel = 'Sinh viên Đại cương (Năm 1-2: Xây dựng nền tảng & Hội nhập)';
  } else if (/(di lam|chuyen nghe|career change|junior|fresher|tim viec)/i.test(norm)) {
    stage = 'CHUYEN_NGANH_DI_LAM';
    stageLabel = 'Giai đoạn Đi làm & Phát triển nghề nghiệp chuyên sâu';
  }

  // 2. Clean primaryGoal
  let primaryGoal = decision ? decision.split('\n')[0].replace(/\.{2,}$/, '').trim() : 'Phát triển sự nghiệp và học tập';
  if (primaryGoal.length > 120) primaryGoal = primaryGoal.substring(0, 120) + '...';

  // 3. Extract Target School if present
  let targetSchool = '';
  const schoolMatch = fullText.match(/(đại học\s+[A-ZÀ-Ỹa-zà-ỹ0-9\s\-]+|đh\s+[A-ZÀ-Ỹa-zà-ỹ0-9\s\-]+|học viện\s+[A-ZÀ-Ỹa-zà-ỹ0-9\s\-]+|trường\s+[A-ZÀ-Ỹa-zà-ỹ0-9\s\-]+|fpt|neu|ftu|ueh|hust|vnu|uit|rmit|bách khoa|kinh tế quốc dân|ngoại thương|y hà nội|y dược)/i);
  if (schoolMatch) {
    targetSchool = schoolMatch[0].trim();
  }

  return {
    stage,
    stageLabel,
    primaryGoal,
    targetSchool,
    fullText,
    norm,
    academicPerformance: data.academicPerformance ?? 3,
    personalFinance: data.personalFinance ?? 3,
    stress: data.stress ?? 3,
    risk: data.risk ?? 3
  };
};

const UNIVERSAL_DOMAIN_MATRIX = {
  architecture_planning: {
    key: 'architecture_planning',
    name: 'Kiến trúc, Quy hoạch & Thiết kế Nội ngoại thất',
    keywords: /\b(kien truc|kien truc su|quy hoach|noi that|ngoai that|canh quan|thiet ke khong gian|bim|revit|autocad|sketchup|lumion|enscape|khoi v|khoi h)\b/i,
    tools: ['AutoCAD / Autodesk Revit (BIM) mô hình hóa công trình', 'SketchUp / Lumion / Enscape diễn họa 3D kiến trúc', 'Photoshop & InDesign dàn trang hồ sơ đồ án', 'Phần mềm Dự toán G8 / Eta quản lý khối lượng'],
    networks: ['Hội Kiến trúc sư Việt Nam & Chi hội Kiến trúc sư trẻ', 'Mạng lưới xưởng thực hành / Design Studios & Consortia', 'Các công ty tư vấn thiết kế và quy hoạch quốc tế'],
    factors: {
      eco: { category: 'Kinh tế', factor: 'Chu kỳ thị trường bất động sản & Quy hoạch hạ tầng', influence: 'High', description: 'Tốc độ đô thị hóa và các dự án đầu tư công/nhà ở xã hội mở ra cơ hội việc làm lớn cho kiến trúc sư có năng lực thực chiến đồ án.' },
      tech: { category: 'Công nghệ', factor: 'Chuyển đổi số mô hình thông tin công trình (BIM)', influence: 'High', description: 'Tiêu chuẩn bắt buộc áp dụng BIM trong hồ sơ thiết kế đòi hỏi sinh viên phải làm chủ Revit và quy trình phối hợp đa bộ môn.' },
      social: { category: 'Xã hội', factor: 'Xu hướng kiến trúc xanh & Đô thị thông minh', influence: 'Medium', description: 'Nhu cầu công trình bền vững đạt chứng chỉ LOTUS/LEED yêu cầu giải pháp thiết kế cân bằng giữa thẩm mỹ và năng lượng tái tạo.' }
    },
    positiveTrajectory: 'Trúng tuyển chương trình kiến trúc chất lượng cao, hoàn thành xuất sắc các đồ án chuyên ngành, làm chủ công nghệ BIM/Revit và sớm gia nhập các văn phòng kiến trúc danh tiếng với portfolio đồ án ấn tượng.',
    neutralTrajectory: 'Phát triển chuyên môn bền bỉ, tích cực cọ xát tại các xưởng thiết kế từ năm 3, tích lũy kinh nghiệm triển khai bản vẽ kỹ thuật thi công và từng bước xây dựng vị thế kiến trúc sư độc lập.',
    riskTrajectory: 'Chủ động ứng phó trước áp lực thức đêm làm đồ án và biến động của thị trường xây dựng: Xây dựng phương pháp quản lý thời gian khoa học, trau dồi thêm kỹ năng thiết kế nội thất/diễn họa 3D để tạo nguồn thu nhập bổ trợ an toàn.'
  },
  civil_construction: {
    key: 'civil_construction',
    name: 'Kỹ thuật Xây dựng & Công trình Hạ tầng',
    keywords: /\b(ky su xay dung|nganh xay dung|cong trinh xay dung|ket cau cong trinh|cau duong|dia chat cong trinh|thuy loi|ha tang cong trinh|sap2000|etabs|civil engineering|xay dung dan dung)\b/i,
    tools: ['Phần mềm phân tích kết cấu Etabs / SAP2000', 'AutoCAD / Revit Structure mô hình kết cấu', 'MS Project / Primavera P6 quản lý tiến độ thi công', 'Hệ thống trắc địa số & Máy toàn đạc điện tử'],
    networks: ['Tổng hội Xây dựng Việt Nam', 'Các tổng thầu xây dựng hàng đầu (Coteccons, Hòa Bình, Vinaconex)', 'Ban quản lý dự án công trình giao thông trọng điểm'],
    factors: {
      eco: { category: 'Kinh tế', factor: 'Làn sóng đầu tư công & Đại dự án hạ tầng quốc gia', influence: 'High', description: 'Các tuyến cao tốc, sân bay Long Thành và hệ thống đường sắt đô thị tạo nhu cầu đột biến về kỹ sư kết cấu và giám sát công trình.' },
      tech: { category: 'Công nghệ', factor: 'Vật liệu mới & Tự động hóa giám sát công trường', influence: 'Medium', description: 'Ứng dụng bê tông tính năng cao, flycam giám sát và cảm biến theo dõi độ lún công trình theo thời gian thực.' },
      social: { category: 'Xã hội', factor: 'Tiêu chuẩn an toàn lao động & Môi trường công trường', influence: 'High', description: 'Yêu cầu khắt khe về an toàn thi công và văn hóa doanh nghiệp đòi hỏi tác phong chuyên nghiệp và kỷ luật cao.' }
    },
    positiveTrajectory: 'Nắm chắc kiến thức cơ học công trình và phân tích kết cấu, thành thạo Etabs/BIM, hoàn thành kỳ thực tập tại tổng thầu cấp 1 và sớm trở thành kỹ sư hiện trường / kỹ sư thiết kế kết cấu chủ chốt.',
    neutralTrajectory: 'Tích lũy kinh nghiệm quản lý giám sát thi công tại các dự án dân dụng và công nghiệp, rèn luyện bản lĩnh công trường, từng bước thăng tiến lên vị trí Chỉ huy phó / Chỉ huy trưởng công trình.',
    riskTrajectory: 'Phương án quản trị áp lực điều động công tác xa và thời gian thi công gấp rút: Rèn luyện thể lực bền bỉ, học thêm chứng chỉ quản lý dự án PMP/chứng chỉ hành nghề giám sát để mở rộng lựa chọn công việc tại văn phòng tư vấn.'
  },
  psychology_counseling: {
    key: 'psychology_counseling',
    name: 'Tâm lý học, Tham vấn & Chăm sóc Sức khỏe Tinh thần',
    keywords: /\b(tam ly|tam ly hoc|tham van tam ly|tri lieu tam ly|suc khoe tinh than|psychology|counseling|dsm-5|spss|tri lieu hanh vi|cbt)\b/i,
    tools: ['Bộ cẩm nang chẩn đoán tâm thần DSM-5 & ICD-11', 'Phần mềm phân tích dữ liệu nghiên cứu SPSS / Jamovi', 'Bộ công cụ trắc nghiệm tâm lý chuẩn hóa (WISC, MBTI, RIASEC, Beck)', 'Sổ tay tham vấn lâm sàng & Quy chuẩn đạo đức nghề nghiệp APA'],
    networks: ['Hội Tâm lý học Việt Nam', 'Mạng lưới các trung tâm tham vấn tâm lý học đường & viện sức khỏe tâm thần', 'Các tổ chức phi chính phủ (NGOs) và doanh nghiệp phát triển chương trình EAP'],
    factors: {
      eco: { category: 'Kinh tế', factor: 'Sự gia tăng ngân sách chăm sóc sức khỏe tinh thần doanh nghiệp', influence: 'High', description: 'Các tập đoàn lớn ngày càng đầu tư vào chương trình chăm sóc tinh thần nhân viên (EAP) và huấn luyện tâm lý (Coaching).' },
      tech: { category: 'Công nghệ', factor: 'Nền tảng tham vấn trực tuyến & Ứng dụng theo dõi cảm xúc', influence: 'Medium', description: 'Sự xuất hiện của các ứng dụng Tele-mental health mở ra kênh kết nối thân chủ linh hoạt trên phạm vi toàn cầu.' },
      social: { category: 'Xã hội', factor: 'Nhận thức xã hội và chính sách tâm lý học đường', influence: 'High', description: 'Thông tư Bộ GD&ĐT quy định vị trí việc làm tư vấn tâm lý trong trường học tạo hành lang pháp lý vững chắc cho sinh viên ngành tâm lý.' }
    },
    positiveTrajectory: 'Xây dựng nền tảng lý thuyết tâm lý vững chắc, tích cực nghiên cứu khoa học có bài báo xuất bản, thực hành tham vấn có giám sát (Supervision) và sớm định hình chuyên môn tham vấn học đường hoặc lâm sàng.',
    neutralTrajectory: 'Hoàn thành chương trình cử nhân với kết quả tốt, tích lũy giờ thực hành lâm sàng tại trung tâm tâm lý hoặc trường học, rèn luyện kỹ năng lắng nghe thấu cảm và từng bước xây dựng danh mục thân chủ tin cậy.',
    riskTrajectory: 'Chiến lược bảo vệ sức khỏe tâm thần bản thân và đối diện rào cản hành nghề: Tham gia các nhóm hỗ trợ đồng đẳng (Intervision), giữ vững ranh giới chuyên môn và học thêm kỹ năng tâm lý tổ chức/nhân sự để gia tăng cơ hội việc làm linh hoạt.'
  },
  law_legal: {
    key: 'law_legal',
    name: 'Luật học, Pháp lý & Tư pháp',
    keywords: /\b(luat|luat hoc|nganh luat|phap ly|tu phap|luat su|tham phan|kiem sat vien|thu vien phap luat|an le|luat kinh te|luat thuong mai|luat quoc te|phap dinh)\b/i,
    tools: ['Cơ sở dữ liệu Văn bản QPPL (Thư Viện Pháp Luật / LuatVietnam)', 'Hệ thống tra cứu Án lệ Tòa án Nhân dân Tối cao', 'Mẫu hợp đồng thương mại quốc tế (ICC / FIDIC / CISG)', 'Phần mềm quản lý hồ sơ vụ việc pháp lý & Trích dẫn học thuật'],
    networks: ['Liên đoàn Luật sư Việt Nam & Đoàn Luật sư các địa phương', 'Mạng lưới các hãng luật tư vấn doanh nghiệp & Tranh tụng', 'Hội Luật gia Việt Nam & Câu lạc bộ Pháp lý sinh viên'],
    factors: {
      eco: { category: 'Kinh tế', factor: 'Hội nhập thương mại quốc tế & Mua bán sáp nhập (M&A)', influence: 'High', description: 'Làn sóng vốn FDI và các thương vụ M&A thúc đẩy nhu cầu tuyển dụng chuyên viên pháp chế doanh nghiệp am hiểu tiếng Anh pháp lý.' },
      tech: { category: 'Công nghệ', factor: 'Ứng dụng LegalTech & Phân tích văn bản pháp luật tự động', influence: 'Medium', description: 'Công nghệ tự động hóa rà soát hợp đồng và tra cứu điều khoản giúp nâng cao năng suất nhưng đòi hỏi tư duy lập luận phản biện sâu sắc hơn.' },
      social: { category: 'Xã hội', factor: 'Hoàn thiện nhà nước pháp quyền & Tuân thủ chuẩn mực đạo đức', influence: 'High', description: 'Yêu cầu thượng tôn pháp luật và uy tín nghề nghiệp là tiêu chí cốt lõi định hình sự nghiệp của một luật sư/chuyên viên pháp lý xuất sắc.' }
    },
    positiveTrajectory: 'Nắm vững hệ thống pháp luật thực định và tư duy phản biện sắc bén, đạt chuẩn tiếng Anh pháp lý xuất sắc (TOELES/IELTS), thực tập tại công ty luật hàng đầu và chuẩn bị nhập học lớp đào tạo luật sư tại Học viện Tư pháp.',
    neutralTrajectory: 'Phát triển ổn định theo hướng chuyên viên pháp chế doanh nghiệp (In-house Counsel), hoàn thành tốt các môn học cốt lõi, tích lũy kinh nghiệm soạn thảo hợp đồng và rà soát rủi ro pháp lý cho doanh nghiệp.',
    riskTrajectory: 'Kế hoạch vượt qua lộ trình đào tạo kéo dài và tỷ lệ cạnh tranh cao: Xây dựng mục tiêu chứng chỉ hành nghề từng giai đoạn, tích cực tham gia các cuộc thi diễn án (Moot Court) để rèn luyện kỹ năng tranh tụng và bản lĩnh pháp đình.'
  },
  education_pedagogy: {
    key: 'education_pedagogy',
    name: 'Sư phạm, Giáo dục & Đào tạo',
    keywords: /\b(su pham|nganh su pham|giao vien|giang vien|day hoc|soan giao an|nghi dinh 116|edtech|gdpt 2018|su pham toan|su pham van|su pham anh|su pham tin)\b/i,
    tools: ['Hệ thống quản lý học tập LMS (Canvas, Moodle, Google Classroom)', 'Công cụ thiết kế bài giảng tương tác Canva / Genially / Kahoot', 'Khung năng lực sư phạm tích cực & Phương pháp giáo dục STEAM', 'Hồ sơ dạy học số & Ngân hàng đề kiểm tra theo chuẩn GDPT 2018'],
    networks: ['Mạng lưới trường phổ thông công lập và liên cấp quốc tế', 'Hiệp hội Đổi mới Sáng tạo Giáo dục & Khối doanh nghiệp EdTech', 'Cộng đồng giáo viên dạy học tích cực toàn quốc'],
    factors: {
      eco: { category: 'Kinh tế', factor: 'Chính sách hỗ trợ học phí và sinh hoạt phí (Nghị định 116)', influence: 'High', description: 'Chính sách ưu đãi của nhà nước tạo điều kiện tài chính thuận lợi cho sinh viên sư phạm, đi kèm cam kết cống hiến ngành giáo dục.' },
      tech: { category: 'Công nghệ', factor: 'Chuyển đổi số dạy học & Trí tuệ nhân tạo hỗ trợ giáo viên', influence: 'High', description: 'Sử dụng AI hỗ trợ soạn giáo án, cá nhân hóa bài tập và chấm điểm tự động giúp giáo viên tập trung vào truyền cảm hứng và bồi dưỡng nhân cách.' },
      social: { category: 'Xã hội', factor: 'Đổi mới căn bản toàn diện giáo dục theo chương trình GDPT 2018', influence: 'High', description: 'Chuyển từ truyền thụ kiến thức sang phát triển phẩm chất và năng lực đòi hỏi phương pháp dạy học năng động và sáng tạo.' }
    },
    positiveTrajectory: 'Tốt nghiệp thủ khoa sư phạm, thành thạo công nghệ giáo dục và phương pháp dạy học tương tác, đạt giải nghiên cứu khoa học sư phạm và được tuyển dụng thẳng vào trường chuyên hoặc trường quốc tế song ngữ.',
    neutralTrajectory: 'Hoàn thành chương trình đào tạo đúng lộ trình, tích lũy kinh nghiệm đứng lớp qua kỳ kiến tập và thực tập sư phạm, xây dựng phong cách giảng dạy nhiệt huyết và từng bước trở thành giáo viên vững chuyên môn.',
    riskTrajectory: 'Chiến lược chủ động trước biến động chỉ tiêu tuyển dụng viên chức ngành giáo dục: Rèn luyện thêm ngoại ngữ và kỹ năng giảng dạy trực tuyến, sẵn sàng tham gia các hệ sinh thái giáo dục ngoài công lập hoặc nền tảng EdTech uy tín.'
  },
  agriculture_biotech: {
    key: 'agriculture_biotech',
    name: 'Nông nghiệp Công nghệ cao & Công nghệ Sinh học',
    keywords: /\b(nong nghiep|lam nghiep|thuy san|cong nghe sinh hoc|sinh hoc phan tu|biotech|gen|pcr|giong cay|thuc pham sinh hoc|globalgap|vietgap|nuoi cay mo)\b/i,
    tools: ['Công cụ phân tích tin sinh học NCBI / BLAST / PyMOL', 'Kỹ thuật phòng thí nghiệm PCR, điện di Gel & nuôi cấy mô tế bào', 'Hệ thống nông nghiệp thông minh cảm biến IoT & tưới tiêu tự động', 'Quy trình kiểm chuẩn an toàn sinh học ISO / GlobalGAP'],
    networks: ['Viện Di truyền Nông nghiệp & Viện Công nghệ Sinh học', 'Các tập đoàn nông nghiệp và thực phẩm công nghệ cao (VinEco, TH True Milk, CP Group)', 'Hiệp hội Công nghệ Sinh học Nông nghiệp Việt Nam'],
    factors: {
      eco: { category: 'Kinh tế', factor: 'Nhu cầu chuyển đổi xanh & Xuất khẩu nông sản tiêu chuẩn cao', influence: 'High', description: 'Thị trường thế giới yêu cầu nông sản có chứng nhận carbon thấp và truy xuất nguồn gốc sinh học rõ ràng.' },
      tech: { category: 'Công nghệ', factor: 'Công nghệ chỉnh sửa gen CRISPR & Tự động hóa nông trại', influence: 'High', description: 'Đột phá trong chọn tạo giống chịu hạn mặn và giám sát sinh trưởng qua vệ tinh/droning đang định hình lại ngành.' },
      social: { category: 'Xã hội', factor: 'An ninh lương thực & Thích ứng biến đổi khí hậu', influence: 'High', description: 'Vai trò trọng yếu của nông nghiệp sinh thái tại Đồng bằng Sông Cửu Long và các vùng chuyên canh nông nghiệp cả nước.' }
    },
    positiveTrajectory: 'Nắm vững kỹ thuật sinh học phân tử hiện đại, tham gia đề tài nghiên cứu lai tạo giống hoặc nuôi cấy mô thành công, xuất sắc nhận học bổng sau đại học hoặc làm việc tại trung tâm R&D của tập đoàn nông nghiệp hàng đầu.',
    neutralTrajectory: 'Phát triển chuyên môn vững chắc theo hướng kỹ sư nông nghiệp thông minh, làm việc tại các trang trại chuẩn GlobalGAP, đảm nhiệm quy trình kiểm soát chất lượng sinh thái bền vững.',
    riskTrajectory: 'Phương án thích ứng trước chu kỳ nghiên cứu dài ngày và biến động thời tiết: Đa dạng hóa kỹ năng sang mảng kiểm nghiệm thực phẩm (QA/QC), phân tích số liệu vi sinh để linh hoạt chuyển đổi công việc.'
  },
  creative_arts_design: {
    key: 'creative_arts_design',
    name: 'Thiết kế Sáng tạo, Đồ họa, UI/UX & Mỹ thuật Đa phương tiện',
    keywords: /\b(thiet ke do hoa|graphic design|ui\/ux|ui ux|my thuat ung dung|designer|photoshop|illustrator|figma|after effects|blender|3d|hoat hinh 3d|sang tao noi dung)\b/i,
    tools: ['Adobe Creative Cloud (Photoshop, Illustrator, After Effects)', 'Figma / Protopie thiết kế trải nghiệm người dùng UI/UX', 'Blender / Cinema 4D dựng hình và hoạt họa 3D', 'Bảng vẽ kỹ thuật số Wacom / iPad & Nền tảng Portfolio Behance/Dribbble'],
    networks: ['Cộng đồng thiết kế sáng tạo Behance & Dribbble Việt Nam', 'Mạng lưới các Creative Agencies, Production Houses & Game Studios', 'Hiệp hội Thiết kế Mẫu & Mỹ thuật Ứng dụng'],
    factors: {
      eco: { category: 'Kinh tế', factor: 'Sự bùng nổ của nền kinh tế sáng tạo (Creator Economy)', influence: 'High', description: 'Nhu cầu xây dựng nhận diện thương hiệu số và trải nghiệm sản phẩm công nghệ tạo nguồn việc làm phong phú.' },
      tech: { category: 'Công nghệ', factor: 'Tác động của Generative AI (Midjourney, DALL-E, Stable Diffusion)', influence: 'High', description: 'AI rút ngắn thời gian tạo ý tưởng, buộc nhà thiết kế phải nâng tầm tư duy thẩm mỹ chiến lược và khả năng kể chuyện (Visual Storytelling).' },
      social: { category: 'Xã hội', factor: 'Tiêu chuẩn trải nghiệm người dùng & Văn hóa thị giác', influence: 'Medium', description: 'Người tiêu dùng ngày càng nhạy bén với tính thẩm mỹ tinh tế và tính ứng dụng trực quan trong mọi sản phẩm.' }
    },
    positiveTrajectory: 'Xây dựng portfolio thiết kế đột phá, nắm vững tư duy thiết kế lấy người dùng làm trung tâm (Design Thinking), làm chủ các công cụ 3D/AI kết hợp và sớm đảm nhận vị trí Lead Designer tại các Agency hoặc công ty công nghệ.',
    neutralTrajectory: 'Rèn luyện kỹ năng thực chiến vững vàng, hoàn thành các dự án thiết kế thương hiệu và truyền thông chất lượng, duy trì nguồn thu nhập ổn định và từng bước phát triển phong cách sáng tạo cá nhân độc đáo.',
    riskTrajectory: 'Chiến lược vượt qua áp lực sáng tạo cạn kiệt (Creative Burnout) và cạnh tranh từ AI: Chủ động nâng cấp từ người thực thi đồ họa (Graphic Artist) lên nhà thiết kế giải pháp chiến lược (Product/Brand Strategist).'
  },
  hospitality_tourism: {
    key: 'hospitality_tourism',
    name: 'Quản trị Khách sạn, Nhà hàng & Du lịch Lữ hành',
    keywords: /\b(du lich|khach san|nha hang|f&b|quan tri khach san|huong dan vien du lich|am thuc|hospitality|quan tri resort|dieu hanh tour)\b/i,
    tools: ['Hệ thống quản lý khách sạn quốc tế PMS (Opera, Fidelio, Smile)', 'Phần mềm điều hành tour & Quản lý đại lý lữ hành', 'Chứng chỉ tiêu chuẩn phục vụ quốc tế WSET / Barista', 'Bộ kỹ năng giao tiếp đa văn hóa và tiếng Anh nghiệp vụ lưu trú'],
    networks: ['Hiệp hội Du lịch Việt Nam (VITA) & Hiệp hội Khách sạn Việt Nam', 'Các chuỗi tập đoàn khách sạn 5 sao quốc tế (Marriott, IHG, Accor, Hilton)', 'Các công ty lữ hành hàng đầu (Saigontourist, Vietravel)'],
    factors: {
      eco: { category: 'Kinh tế', factor: 'Sự phục hồi mạnh mẽ của dòng khách du lịch quốc tế', influence: 'High', description: 'Việt Nam tiếp tục là điểm đến hàng đầu Đông Nam Á, mở ra nhu cầu tuyển dụng cấp quản lý dịch vụ hiếu khách.' },
      tech: { category: 'Công nghệ', factor: 'Hệ sinh thái du lịch thông minh & Ứng dụng đặt phòng OTA', influence: 'Medium', description: 'Số hóa trải nghiệm khách hàng từ khâu nhận phòng tự động đến quản lý đánh giá trực tuyến (TripAdvisor/Google Reviews).' },
      social: { category: 'Xã hội', factor: 'Xu hướng du lịch trải nghiệm văn hóa bản địa & Du lịch sinh thái', influence: 'High', description: 'Du khách ngày càng ưu tiên các tour du lịch có trách nhiệm với môi trường và tôn trọng văn hóa địa phương.' }
    },
    positiveTrajectory: 'Đạt trình độ ngoại ngữ xuất sắc, hoàn thành kỳ thực tập tại resort 5 sao quốc tế, tích lũy năng lực vận hành đa bộ phận và nhanh chóng được quy hoạch vào chương trình Quản lý tập sự (Management Trainee).',
    neutralTrajectory: 'Bắt đầu từ các vị trí dịch vụ khách hàng hoặc điều hành tour thực tế, rèn luyện sự khéo léo trong xử lý tình huống, mở rộng mối quan hệ đối tác lữ hành và từng bước thăng tiến lên cấp giám sát.',
    riskTrajectory: 'Kế hoạch thích ứng trước tính chất mùa vụ và sự nhạy cảm của ngành du lịch: Nâng cao năng lực tổ chức sự kiện (MICE) và quản trị doanh thu (Revenue Management) để đảm bảo công việc ổn định quanh năm.'
  },
  transport_aviation: {
    key: 'transport_aviation',
    name: 'Hàng không, Vận tải & Điều phối Giao nhận',
    keywords: /\b(hang khong|phi cong|tiep vien hang khong|van tai hang khong|hang hai|cang bien|san bay|amadeus|sabre|dieu hanh bay)\b/i,
    tools: ['Hệ thống phân phối toàn cầu và đặt chỗ vé GDS (Amadeus, Sabre)', 'Phần mềm điều phối và giám sát hành trình GPS / Fleet Management', 'Tiêu chuẩn an toàn hàng không ICAO & Chứng chỉ chuyên môn hàng không', 'Kỹ năng giao tiếp hàng không chuẩn mực và ngoại ngữ chuyên ngành'],
    networks: ['Các hãng hàng không nội địa và quốc tế (Vietnam Airlines, Vietjet, Bamboo, Emirates)', 'Tổng công ty Cảng hàng không Việt Nam (ACV)', 'Mạng lưới các doanh nghiệp cảng biển và vận tải đa phương thức'],
    factors: {
      eco: { category: 'Kinh tế', factor: 'Mở rộng mạng đường bay quốc tế & Phát triển hạ tầng sân bay', influence: 'High', description: 'Dự án Cảng HKQT Long Thành cùng việc gia tăng đội tàu bay tạo nhu cầu cấp thiết về nhân lực kỹ thuật và dịch vụ bay.' },
      tech: { category: 'Công nghệ', factor: 'Hệ thống tự động hóa điều độ không lưu & Quản lý chuyến bay số', influence: 'High', description: 'Ứng dụng công nghệ dữ liệu lớn để tối ưu hóa đường bay, tiết kiệm nhiên liệu và giảm thiểu độ trễ.' },
      social: { category: 'Xã hội', factor: 'Chuẩn mực an ninh, an toàn tuyệt đối & Kỷ luật ngành hàng không', influence: 'High', description: 'Môi trường làm việc đòi hỏi sự chuẩn mực cao nhất về đạo đức nghề nghiệp, kiểm tra sức khỏe định kỳ và tác phong chuyên nghiệp.' }
    },
    positiveTrajectory: 'Đạt chuẩn tiếng Anh ICAO level 4+ và các chứng chỉ bay/dịch vụ hàng không xuất sắc, hoàn thành kỳ huấn luyện với điểm số cao và chính thức gia nhập phi đội bay hoặc khối điều hành bay của hãng hàng không quốc gia.',
    neutralTrajectory: 'Đảm nhiệm tốt công việc khai thác mặt đất, dịch vụ hành khách hoặc điều phối vận tải, tích lũy giờ làm việc tiêu chuẩn và từng bước thăng tiến lên các vị trí quản lý vận hành.',
    riskTrajectory: 'Phương án quản trị yêu cầu nghiêm ngặt về sức khỏe và ca kíp làm việc: Thiết lập chế độ rèn luyện thể lực và giấc ngủ khoa học, chuẩn bị thêm các phương án chuyển ngạch sang mảng kinh doanh vận tải/hậu cần hàng không.'
  },
  logistics_supply_chain: {
    key: 'logistics_supply_chain',
    name: 'Logistics, Xuất nhập khẩu & Quản trị Chuỗi cung ứng',
    keywords: /\b(logistics|chuoi cung ung|kho van|xuat nhap khau|xnk|forwarder|supply chain|khai bao hai quan|wms|tms|fiata)\b/i,
    tools: ['Phần mềm Quản trị Chuỗi cung ứng & ERP (SAP / Oracle / TMS / WMS)', 'Excel nâng cao & Power BI phân tích dòng chảy logistics', 'Hệ thống khai báo hải quan điện tử VNACCS / VCIS', 'Chứng chỉ quốc tế chuyên ngành (FIATA / CSCP / CLTD)'],
    networks: ['Hiệp hội Doanh nghiệp Dịch vụ Logistics Việt Nam (VLA)', 'Mạng lưới các tập đoàn logistics đa quốc gia (DHL, Maersk, Kuehne+Nagel, Schenker)', 'Khối doanh nghiệp sản xuất và các sàn thương mại điện tử lớn'],
    factors: {
      eco: { category: 'Kinh tế', factor: 'Việt Nam là trung tâm sản xuất và kho vận trọng điểm khu vực', influence: 'High', description: 'Sự dịch chuyển chuỗi cung ứng toàn cầu thúc đẩy nhu cầu nhân lực logistics tinh thông nghiệp vụ và ngoại ngữ thương mại.' },
      tech: { category: 'Công nghệ', factor: 'Kho bãi thông minh (Smart Warehousing) & Số hóa chuỗi cung ứng', influence: 'High', description: 'Ứng dụng robot tự hành AGV, IoT theo dõi container và hệ thống WMS/TMS quyết định tốc độ và chi phí giao nhận.' },
      social: { category: 'Xã hội', factor: 'Xu hướng logistics xanh (Green Logistics) & Cam kết Net Zero', influence: 'Medium', description: 'Yêu cầu tối ưu hóa lộ trình để cắt giảm phát thải khí nhà kính và sử dụng bao bì tái chế thân thiện môi trường.' }
    },
    positiveTrajectory: 'Trúng tuyển chương trình chất lượng cao, thành thạo tiếng Anh thương mại (IELTS 7.0+), làm chủ phần mềm SAP/TMS và gia nhập tập đoàn Logistics đa quốc gia với mức lương khởi điểm 15 - 25 triệu/tháng.',
    neutralTrajectory: 'Tích lũy kinh nghiệm nghiệp vụ chứng từ, hiện trường hải quan hoặc vận hành kho tại các công ty forwarder uy tín, mở rộng quan hệ đối tác hãng tàu và thăng tiến vững vàng lên chuyên viên chuỗi cung ứng.',
    riskTrajectory: 'Chiến lược ứng phó trước biến động cước vận tải biển và áp lực công việc giờ cao điểm: Không ngừng cập nhật quy định chính sách xuất nhập khẩu, trau dồi chứng chỉ quốc tế FIATA để giữ vững lợi thế cạnh tranh.'
  },
  media_communications: {
    key: 'media_communications',
    name: 'Báo chí, Truyền thông, Marketing & Quan hệ Công chúng (PR)',
    keywords: /\b(truyen thong|bao chi|marketing|pr|quang cao|social media|digital marketing|branding|copywriting|seo|quan he cong chung)\b/i,
    tools: ['Công cụ lắng nghe mạng xã hội Social Listening (Buzzmetrics, Younet Media)', 'Phần mềm sản xuất nội dung đa phương tiện Premiere Pro / CapCut / Canva', 'Công cụ phân tích dữ liệu số Google Analytics 4, Meta Business Suite, Ahrefs', 'Bộ kỹ năng viết thông cáo báo chí & Quản trị khủng hoảng truyền thông'],
    networks: ['Hội Nhà báo Việt Nam & Mạng lưới tòa soạn báo chí đa nền tảng', 'Cộng đồng các Agency quảng cáo, PR và truyền thông tích hợp (IMC)', 'Hiệp hội Marketing Việt Nam (VMA)'],
    factors: {
      eco: { category: 'Kinh tế', factor: 'Sự chuyển dịch ngân sách quảng bá sang truyền thông số và đa kênh', influence: 'High', description: 'Doanh nghiệp ưu tiên đầu tư vào Performance Marketing, Influencer Marketing và chiến dịch sáng tạo nội dung viral.' },
      tech: { category: 'Công nghệ', factor: 'Thuật toán mạng xã hội & AI sáng tạo nội dung tự động', influence: 'High', description: 'Nắm vững nguyên lý phân phối nội dung của TikTok, Reels, YouTube kết hợp công cụ AI để sản xuất nội dung quy mô lớn.' },
      social: { category: 'Xã hội', factor: 'Trách nhiệm xã hội và tính xác thực của thông tin truyền thông', influence: 'High', description: 'Người tiếp nhận ngày càng cảnh giác với tin giả (Fake news); sự trung thực và tính nhân văn là nền tảng cốt lõi của người làm truyền thông.' }
    },
    positiveTrajectory: 'Xây dựng các chiến dịch truyền thông gây tiếng vang, sở hữu kênh nội dung cá nhân có sức ảnh hưởng, hoàn thành kỳ thực tập tại Agency hàng đầu và sớm trở thành chuyên viên chiến lược truyền thông (Communication Strategist).',
    neutralTrajectory: 'Rèn luyện kỹ năng viết sắc sảo, tích lũy kinh nghiệm quản trị trang mạng xã hội và sản xuất video ngắn, xây dựng mạng lưới quan hệ báo chí và từng bước khẳng định uy tín nghề nghiệp.',
    riskTrajectory: 'Kế hoạch vượt qua áp lực chạy chỉ số (KPIs) và khủng hoảng truyền thông: Nâng cao năng lực tư duy phản biện, học thêm kỹ năng phân tích số liệu thị trường để không bị phụ thuộc thuần túy vào cảm hứng sáng tạo.'
  },
  languages_international: {
    key: 'languages_international',
    name: 'Ngôn ngữ, Biên phiên dịch & Quốc tế học',
    keywords: /\b(ngon ngu anh|ngon ngu trung|ngon ngu nhat|ngon ngu han|ngon ngu hoc|khoa ngon ngu|nganh tieng anh|nganh tieng trung|bien dich|phien dich|quoc te hoc|bien phien dich|thong dich vien|cat tool|trados)\b/i,
    tools: ['Phần mềm hỗ trợ dịch thuật chuyên nghiệp CAT Tools (SDL Trados, memoQ)', 'Bộ từ điển thuật ngữ chuyên ngành đa ngữ & Cơ sở dữ liệu dịch tễ', 'Chứng chỉ năng lực ngôn ngữ quốc tế cao cấp (IELTS 8.0+, HSK 6, JLPT N1, TOPIK 6)', 'Thiết bị cabin và kỹ năng phiên dịch song song (Simultaneous Interpreting)'],
    networks: ['Hiệp hội Dịch thuật Việt Nam', 'Mạng lưới các tổ chức ngoại giao, Đại sứ quán & Tổ chức phi chính phủ (NGOs)', 'Khối doanh nghiệp có vốn đầu tư nước ngoài FDI (Nhật Bản, Hàn Quốc, Trung Quốc, Âu Mỹ)'],
    factors: {
      eco: { category: 'Kinh tế', factor: 'Làn sóng đầu tư trực tiếp nước ngoài (FDI) đổ mạnh vào Việt Nam', influence: 'High', description: 'Nhu cầu tuyển dụng nhân sự cầu nối ngôn ngữ am hiểu văn hóa doanh nghiệp nước ngoài luôn ở mức cao.' },
      tech: { category: 'Công nghệ', factor: 'Sự phát triển vượt bậc của các mô hình dịch máy AI (DeepL, LLM)', influence: 'High', description: 'AI dịch nhanh văn bản thông thường, định hướng người học phải phát triển năng lực dịch thuật chuyên sâu (pháp lý, y khoa) và biên tập văn phong tinh tế.' },
      social: { category: 'Xã hội', factor: 'Giao lưu văn hóa và vai trò kết nối ngoại giao nhân dân', influence: 'Medium', description: 'Khả năng thấu hiểu văn hóa và ứng xử tinh tế trong đàm phán quốc tế là giá trị cốt lõi mà công nghệ không thể thay thế.' }
    },
    positiveTrajectory: 'Đạt chứng chỉ ngôn ngữ ở mức tinh hoa, thành thạo biên phiên dịch chuyên ngành sâu, làm việc tại cơ quan ngoại giao hoặc tập đoàn đa quốc gia với vai trò chuyên viên quan hệ quốc tế cấp cao.',
    neutralTrajectory: 'Tích lũy kinh nghiệm biên dịch tài liệu dự án, giảng dạy ngôn ngữ ứng dụng hoặc hỗ trợ quản lý dự án FDI, duy trì nguồn thu nhập ổn định và từng bước phát triển công việc phiên dịch độc lập.',
    riskTrajectory: 'Chiến lược bảo vệ giá trị nghề nghiệp trước làn sóng dịch thuật tự động của AI: Định vị bản thân là chuyên gia song ngữ kết hợp chuyên môn thứ hai (Logistics, Luật, Tài chính hoặc Quản trị kinh doanh).'
  },
  mechanical_automation: {
    key: 'mechanical_automation',
    name: 'Kỹ thuật Cơ khí, Ô tô, Cơ điện tử & Tự động hóa',
    keywords: /\b(co khi|ky thuat o to|tu dong hoa|che tao may|co dien tu|mechatronics|plc|scada|solidworks|robotics|cad cam|cnc|dong co)\b/i,
    tools: ['Phần mềm thiết kế 3D CAD/CAM (SolidWorks, Inventor, Siemens NX)', 'Môi trường lập trình mô phỏng MATLAB / Simulink', 'Lập trình điều khiển công nghiệp PLC (Siemens, Mitsubishi) & Hệ thống SCADA', 'Phần mềm gia công CNC (Mastercam, PowerMill) & In 3D chế tạo mẫu'],
    networks: ['Hội Cơ khí Việt Nam & Hội Tự động hóa Việt Nam (VAA)', 'Các tổ hợp sản xuất công nghiệp và ô tô hiện đại (VinFast, Samsung, Thaco, Honda)', 'Mạng lưới các nhà máy chế tạo thông minh và tích hợp hệ thống'],
    factors: {
      eco: { category: 'Kinh tế', factor: 'Chuyển dịch sang sản xuất thông minh và công nghiệp xe điện', influence: 'High', description: 'Sự bùng nổ của ngành công nghiệp ô tô điện và nhà máy thông minh tạo cơ hội thu nhập cao cho kỹ sư tự động hóa.' },
      tech: { category: 'Công nghệ', factor: 'Robot công nghiệp & Hệ thống điều khiển tích hợp AI', influence: 'High', description: 'Ứng dụng cánh tay robot, thị giác máy tính (Machine Vision) và bảo trì dự đoán trong dây chuyền lắp ráp tự động.' },
      social: { category: 'Xã hội', factor: 'Tiêu chuẩn an toàn công nghiệp & Tiết kiệm năng lượng', influence: 'Medium', description: 'Yêu cầu tối ưu hóa hiệu suất năng lượng và giảm thiểu phế phẩm theo tiêu chuẩn sản xuất bền vững.' }
    },
    positiveTrajectory: 'Nắm vững tư duy thiết kế cơ điện tử, đoạt giải tại các cuộc thi sáng tạo chế tạo robot (Robocon/Maker Fair), hoàn thành kỳ thực tập tại trung tâm R&D và trở thành kỹ sư thiết kế hệ thống tự động hóa chủ chốt.',
    neutralTrajectory: 'Tích lũy kinh nghiệm vận hành, bảo trì và lập trình dây chuyền sản xuất tại các nhà máy công nghiệp lớn, rèn luyện kỹ năng thực chiến vững vàng và từng bước thăng tiến lên Trưởng ca / Giám sát kỹ thuật.',
    riskTrajectory: 'Phương án quản trị áp lực công việc ca kíp tại môi trường nhà máy: Rèn luyện tính cẩn trọng, kỷ luật an toàn lao động và nâng cao năng lực ngoại ngữ (tiếng Anh/tiếng Nhật) để có cơ hội chuyển sang khối văn phòng kỹ thuật R&D.'
  },
  electrical_semiconductor: {
    key: 'electrical_semiconductor',
    name: 'Điện tử - Viễn thông & Công nghệ Bán dẫn (Semiconductor)',
    keywords: /\b(dien tu|vi mach|ban dan|semiconductor|vlsi|ic design|altium|fpga|vien thong|he thong nhung|embedded|iot)\b/i,
    tools: ['Phần mềm thiết kế vi mạch Altium Designer / Cadence / Synopsys', 'Bộ công cụ thiết kế vi mạch tích hợp FPGA & Ngôn ngữ phần cứng Verilog/VHDL', 'Môi trường lập trình hệ thống nhúng (Embedded C/C++, Linux Kernel)', 'Thiết bị đo kiểm điện tử chuyên dụng (Oscilloscope, Logic Analyzer)'],
    networks: ['Hiệp hội Công nghiệp Bán dẫn Quốc tế & Mạng lưới Bán dẫn Việt Nam', 'Các tập đoàn công nghệ vi mạch hàng đầu (Synopsys, Cadence, Intel, Marvell, Qualcomm, Viettel)', 'Mạng lưới phòng thí nghiệm vi mạch các trường đại học kỹ thuật'],
    factors: {
      eco: { category: 'Kinh tế', factor: 'Chiến lược quốc gia phát triển công nghiệp bán dẫn đến năm 2030', influence: 'High', description: 'Chính sách ưu tiên đặc biệt của Chính phủ biến Việt Nam thành trung tâm thiết kế và đóng gói vi mạch, tạo cơn sốt nhân lực chất lượng cao.' },
      tech: { category: 'Công nghệ', factor: 'Tiến trình vi mạch nano & Hệ sinh thái Internet vạn vật (IoT)', influence: 'High', description: 'Yêu cầu thiết kế chip tiết kiệm năng lượng cho thiết bị di động và hạ tầng kết nối 5G/6G đòi hỏi kiến thức chuyên sâu.' },
      social: { category: 'Xã hội', factor: 'Tầm nhìn tự chủ công nghệ cao và an ninh quốc gia', influence: 'High', description: 'Vai trò hạt nhân của kỹ sư vi mạch trong việc xây dựng năng lực công nghệ lõi độc lập cho đất nước.' }
    },
    positiveTrajectory: 'Làm chủ quy trình thiết kế vi mạch số hoặc tương tự (IC Design), tham gia dự án băng chip (Tape-out) thực tế, tốt nghiệp với bằng kỹ sư xuất sắc và làm việc tại các trung tâm R&D vi mạch hàng đầu thế giới.',
    neutralTrajectory: 'Phát triển chuyên môn vững chắc theo hướng lập trình hệ thống nhúng (Embedded Engineer) hoặc kiểm thử vi mạch, tích lũy kinh nghiệm qua các dự án IoT và duy trì mức thu nhập tăng trưởng đều đặn.',
    riskTrajectory: 'Kế hoạch vượt qua độ phức tạp kiến thức điện tử và sự thiếu hụt trang thiết bị thí nghiệm: Tận dụng các phòng lab mô phỏng ảo, chủ động tham gia các khóa đào tạo chuyên sâu của các hãng công nghệ quốc tế để bắt kịp chuẩn ngành.'
  },
  economics_finance: {
    key: 'economics_finance',
    name: 'Kinh tế, Quản trị Kinh doanh, Tài chính & Ngân hàng',
    keywords: /\b(nganh tai chinh|tai chinh ngan hang|tai chinh doanh nghiep|dau tu tai chinh|thi truong tai chinh|chuyen vien tai chinh|kinh te|ngan hang|quan tri kinh doanh|qtkd|kinh doanh thuong mai|chung khoan|fintech|cfa)\b/i,
    tools: ['Phần mềm phân tích tài chính thị trường Bloomberg Terminal / FiinPro', 'Excel tài chính nâng cao & Mô hình định giá doanh nghiệp (Financial Modeling)', 'Phần mềm quản trị doanh nghiệp ERP / Core Banking', 'Chứng chỉ nghề nghiệp danh giá (CFA, FRM)'],
    networks: ['Hiệp hội Ngân hàng Việt Nam (VNBA) & Hội đồng Thẩm định Tài chính', 'Mạng lưới khối ngân hàng thương mại hàng đầu (Big4 & TMCP tư nhân lớn)', 'Cộng đồng cựu sinh viên tài chính ngân hàng các trường khối kinh tế'],
    factors: {
      eco: { category: 'Kinh tế', factor: 'Chính sách tiền tệ vĩ mô & Chu kỳ kinh tế toàn cầu', influence: 'High', description: 'Biến động lãi suất, tỷ giá và thị trường vốn đòi hỏi chuyên viên tài chính phải có năng lực phân tích rủi ro sắc bén.' },
      tech: { category: 'Công nghệ', factor: 'Làn sóng số hóa ngân hàng (Digital Banking) & Fintech', influence: 'High', description: 'Tự động hóa thanh toán, ứng dụng AI trong phân tích chấm điểm tín dụng (Credit Scoring) thay đổi cách thức vận hành truyền thống.' },
      social: { category: 'Xã hội', factor: 'Tiêu chuẩn phát triển bền vững và tài chính xanh (ESG)', influence: 'Medium', description: 'Các tổ chức tài chính ưu tiên cấp vốn cho dự án đáp ứng tiêu chí môi trường và quản trị minh bạch.' }
    },
    positiveTrajectory: 'Tốt nghiệp loại xuất sắc từ trường kinh tế hàng đầu, sở hữu chứng chỉ CFA level 1+, vượt qua kỳ tuyển dụng Quản trị viên tập sự (Management Trainee) tại tập đoàn tài chính đa quốc gia với mức đãi ngộ vượt trội.',
    neutralTrajectory: 'Khởi đầu từ vị trí chuyên viên quan hệ khách hàng doanh nghiệp hoặc phân tích tín dụng, tích lũy kiến thức thẩm định thực tế, mở rộng mạng lưới khách hàng và từng bước thăng tiến lên Trưởng phòng nghiệp vụ.',
    riskTrajectory: 'Chiến lược quản trị áp lực chỉ tiêu doanh số (KPIs) và rủi ro thị trường: Trang bị tư duy phân tích số liệu định lượng và kỹ năng công nghệ để dịch chuyển sang các vai trò chuyên môn như Quản trị rủi ro hoặc Phân tích dữ liệu tài chính.'
  },
  accounting_audit: {
    key: 'accounting_audit',
    name: 'Kế toán, Kiểm toán & Tài chính Doanh nghiệp',
    keywords: /\b(ke toan|kiem toan|accounting|audit|kiem toan vien|acca|cpa|ifrs|vas|misa|fast accounting|big 4|big4)\b/i,
    tools: ['Phần mềm kế toán doanh nghiệp MISA / Fast / SAP Business One', 'Bộ Chuẩn mực Báo cáo Tài chính Quốc tế IFRS & Chuẩn mực VAS', 'Phần mềm kiểm toán chuyên dụng Audit Tools', 'Chứng chỉ nghề nghiệp kế kiểm quốc tế (ACCA, CPA Australia, CMA)'],
    networks: ['Hội Kiểm toán viên Hành nghề Việt Nam (VACPA) & Hiệp hội Kế toán Việt Nam', 'Nhóm 4 công ty kiểm toán hàng đầu thế giới (Big 4: PwC, EY, KPMG, Deloitte)', 'Cộng đồng sinh viên theo đuổi chứng chỉ ACCA toàn quốc'],
    factors: {
      eco: { category: 'Kinh tế', factor: 'Lộ trình bắt buộc áp dụng chuẩn mực báo cáo tài chính quốc tế IFRS', influence: 'High', description: 'Nhu cầu tuyển dụng chuyên gia am hiểu IFRS tăng cao đột biến khi các công ty niêm yết bắt buộc phải chuyển đổi chuẩn mực kế toán.' },
      tech: { category: 'Công nghệ', factor: 'Tự động hóa quy trình kế toán (RPA) & Hóa đơn điện tử', influence: 'High', description: 'Xử lý hóa đơn tự động và phần mềm kế toán đám mây giảm bớt việc nhập liệu thủ công, nâng tầm vai trò tư vấn thuế và kiểm soát nội bộ.' },
      social: { category: 'Xã hội', factor: 'Tính minh bạch tài chính & Đạo đức nghề nghiệp kiểm toán', influence: 'High', description: 'Trách nhiệm xã hội trong việc bảo đảm số liệu trung thực, hợp lý nhằm bảo vệ quyền lợi cổ đông và nhà đầu tư.' }
    },
    positiveTrajectory: 'Chinh phục các môn thi ACCA ngay từ trên ghế giảng đường, vượt qua các vòng thi tuyển khắt khe để thực tập và trở thành trợ lý kiểm toán chính thức tại Big 4 với lộ trình thăng tiến rõ ràng.',
    neutralTrajectory: 'Hoàn thành chương trình cử nhân kế toán kiểm toán đúng hạn, tích lũy kinh nghiệm làm kế toán tổng hợp tại doanh nghiệp vừa và nhỏ, nắm chắc nghiệp vụ thuế và từng bước thăng tiến lên Kế toán trưởng.',
    riskTrajectory: 'Phương án thích ứng với mùa cao điểm kiểm toán (Busy season) và nguy cơ đào thải công việc nhập liệu: Tích cực học thêm phân tích dữ liệu (Data Analytics) và thi lấy chứng chỉ hành nghề kế toán/kiểm toán viên (CPA) để xác lập vị thế bền vững.'
  },
  medicine_pharmacy: {
    key: 'medicine_pharmacy',
    name: 'Y khoa, Dược học, Răng - Hàm - Mặt & Sức khỏe Cộng đồng',
    keywords: /\b(y khoa|nganh y|bac si|duoc hoc|duoc si|nha khoa|rang ham mat|dieu duong|y te cong cong|bac si noi tru|y da khoa|y ha noi|y duoc tphcm)\b/i,
    tools: ['Hệ thống hồ sơ bệnh án điện tử EMR & Phác đồ điều trị của Bộ Y Tế', 'Cơ sở dữ liệu y văn lâm sàng quốc tế UpToDate / PubMed / Medscape', 'Dược thư Quốc gia Việt Nam & Phần mềm quản lý tương tác thuốc', 'Sổ tay thủ thuật ngoại khoa & Kỹ năng thăm khám lâm sàng chuẩn mực'],
    networks: ['Tổng hội Y học Việt Nam & Hội Dược học Việt Nam', 'Mạng lưới các bệnh viện tuyến trung ương (Bạch Mai, Việt Đức, Chợ Rẫy, TW Huế)', 'Hệ thống bệnh viện đa khoa quốc tế và phòng khám chuyên khoa chất lượng cao'],
    factors: {
      eco: { category: 'Kinh tế', factor: 'Chi phí đào tạo dài hạn & Cơ chế tự chủ bệnh viện', influence: 'High', description: 'Lộ trình 6 năm đại học cộng với 18-24 tháng thực hành đòi hỏi kế hoạch tài chính kiên trì và cân đối từ gia đình.' },
      tech: { category: 'Công nghệ', factor: 'Y tế thông minh, AI hỗ trợ chẩn đoán hình ảnh & Phẫu thuật robot', influence: 'Medium', description: 'Công nghệ hỗ trợ bác sĩ nâng cao độ chính xác trong phát hiện tổn thương và tối ưu hóa phác đồ điều trị cho bệnh nhân.' },
      social: { category: 'Xã hội', factor: 'Áp lực đạo đức nghề nghiệp Y đức & Sự thấu hiểu của xã hội', influence: 'High', description: 'Trách nhiệm cao cả cứu người đi kèm áp lực trực đêm dày đặc đòi hỏi tinh thần phụng sự và lòng trắc ẩn sâu sắc.' }
    },
    positiveTrajectory: 'Trúng tuyển trường Y danh giá, hoàn thành 6 năm với điểm số xuất sắc, tích cực tham gia trực lâm sàng tại bệnh viện tuyến cuối, thi đỗ Bác sĩ nội trú danh giá để xác lập vị thế y khoa chuyên sâu.',
    neutralTrajectory: 'Hoàn thành chương trình bác sĩ/dược sĩ đúng tiến độ, tích lũy chứng chỉ hành nghề qua 18 tháng thực hành lâm sàng, phát triển tay nghề vững vàng tại các bệnh viện đa khoa tỉnh hoặc hệ thống phòng khám chất lượng.',
    riskTrajectory: 'Phương án quản trị áp lực học tập căng thẳng và rủi ro trượt nguyện vọng 1 trường y top: Chuẩn bị nguyện vọng 2 vào trường y đào tạo tốt ở khu vực hoặc ngành gần (Y sinh, Dược học), quản lý thời gian khoa học để tránh kiệt sức tinh thần.'
  },
  it_computer_science: {
    key: 'it_computer_science',
    name: 'Công nghệ Thông tin, Khoa học Máy tính & Kỹ thuật Phần mềm',
    keywords: /\b(cntt|cong nghe thong tin|khoa hoc may tinh|ky thuat phan mem|lap trinh|lap trinh vien|tri tue nhan tao|ai engineer|ai|an toan thong tin|cybersecurity|software engineer|developer|coder|devops|cloud computing)\b/i,
    tools: ['Môi trường phát triển IDE & Hệ thống quản lý mã nguồn Git / GitHub', 'Hạ tầng điện toán đám mây Cloud Computing (AWS / GCP / Azure)', 'Hệ sinh thái AI & Thư viện học máy (PyTorch, TensorFlow, Hugging Face, Ollama)', 'Công cụ kiểm thử tự động, CI/CD pipeline & An toàn thông tin'],
    networks: ['Cộng đồng nhà phát triển phần mềm & Mã nguồn mở (GitHub, Stack Overflow)', 'Mạng lưới các tập đoàn công nghệ hàng đầu (FPT, Viettel, VNG, VNPT, Momo)', 'Các tổ chức nghiên cứu trí tuệ nhân tạo và hội nghị công nghệ'],
    factors: {
      eco: { category: 'Kinh tế', factor: 'Nhu cầu nhân lực kỹ sư AI và phần mềm chất lượng cao', influence: 'High', description: 'Dù thị trường có những đợt tái cấu trúc, kỹ sư có nền tảng thuật toán vững và ngoại ngữ tốt luôn nhận mức đãi ngộ hàng đầu.' },
      tech: { category: 'Công nghệ', factor: 'Sự trỗi dậy của Generative AI & Lập trình tự động', influence: 'High', description: 'Các công cụ AI Coding hỗ trợ viết code cơ bản đòi hỏi kỹ sư phải nâng tầm tư duy thiết kế kiến trúc hệ thống và giải quyết vấn đề phức tạp.' },
      social: { category: 'Xã hội', factor: 'Chuyển đổi số quốc gia & Bảo vệ chủ quyền dữ liệu cá nhân', influence: 'High', description: 'Luật An ninh mạng và các tiêu chuẩn bảo mật đòi hỏi sản phẩm phần mềm phải đảm bảo an toàn thông tin tối đa.' }
    },
    positiveTrajectory: 'Nắm chắc kiến trúc hệ thống và thuật toán, tích lũy các dự án mã nguồn mở ấn tượng trên GitHub, đạt chứng chỉ Cloud/AI quốc tế và sớm gia nhập các tập đoàn công nghệ lớn với mức đãi ngộ vượt trội.',
    neutralTrajectory: 'Tập trung phát triển kỹ năng lập trình ứng dụng thực chiến, hoàn thành tốt các dự án phần mềm theo chuẩn Agile/Scrum của doanh nghiệp, duy trì thu nhập vững vàng và thăng tiến lên Senior Engineer.',
    riskTrajectory: 'Chiến lược phòng ngừa đào thải công nghệ và áp lực cạnh tranh nghề nghiệp: Liên tục làm mới kỹ năng qua các dự án thực tế, trau dồi tiếng Anh chuyên ngành và tư duy sản phẩm để không dừng lại ở mức thợ gõ code.'
  },
  social_sciences: {
    key: 'social_sciences',
    name: 'Khoa học Xã hội, Nhân văn & Phát triển Cộng đồng',
    keywords: /\b(khoa hoc xa hoi|nhan van|xa hoi hoc|triet hoc|lich su|dia ly|van hoc|phat trien cong dong|ngo|nghien cuu xa hoi|esg)\b/i,
    tools: ['Phần mềm phân tích dữ liệu xã hội học SPSS & Phân tích định tính NVivo', 'Bộ công cụ trích dẫn học thuật Zotero / Mendeley & Cơ sở dữ liệu JSTOR', 'Kỹ năng thiết kế phiếu khảo sát & Phương pháp phỏng vấn sâu', 'Khung đánh giá tác động xã hội và tiêu chuẩn phát triển bền vững ESG'],
    networks: ['Viện Hàn lâm Khoa học Xã hội Việt Nam', 'Mạng lưới các tổ chức phát triển quốc tế (UNDP, UNICEF, Oxfam)', 'Các viện nghiên cứu chính sách công và tổ chức phi lợi nhuận'],
    factors: {
      eco: { category: 'Kinh tế', factor: 'Nhu cầu chuyên gia đánh giá tác động môi trường và xã hội (ESG)', influence: 'High', description: 'Các doanh nghiệp FDI và dự án đầu tư đều cần chuyên viên thẩm định khía cạnh xã hội và phát triển cộng đồng.' },
      tech: { category: 'Công nghệ', factor: 'Khai phá dữ liệu xã hội lớn (Big Social Data)', influence: 'Medium', description: 'Sử dụng dữ liệu mạng xã hội và kỹ thuật trực quan hóa dữ liệu để phân tích xu hướng hành vi con người trong thời đại số.' },
      social: { category: 'Xã hội', factor: 'Giải quyết các thách thức xã hội hiện đại (già hóa dân số, bình đẳng)', influence: 'High', description: 'Nhu cầu cấp thiết về các chính sách an sinh xã hội nhân văn và bảo tồn các giá trị di sản văn hóa dân tộc.' }
    },
    positiveTrajectory: 'Đạt thành tích nghiên cứu học thuật xuất sắc, có bài tham luận tại hội thảo chuyên ngành, nhận học bổng du học toàn phần hoặc trở thành chuyên gia nghiên cứu chính sách tại tổ chức quốc tế.',
    neutralTrajectory: 'Hoàn thành chương trình đào tạo cử nhân vững vàng, tham gia các dự án phát triển cộng đồng hoặc công tác xã hội, tích lũy kinh nghiệm quản trị dự án nhân đạo và duy trì sự nghiệp ý nghĩa.',
    riskTrajectory: 'Kế hoạch hóa giải băn khoăn về cơ hội việc làm ngành xã hội: Tích cực học thêm kỹ năng số, ngoại ngữ thành thạo và kỹ năng viết truyền thông để sẵn sàng ứng tuyển vào các vị trí PR, nhân sự hoặc quản lý dự án doanh nghiệp.'
  },
  general_flexible: {
    key: 'general_flexible',
    name: 'Định hướng Khởi nghiệp, Tự do & Phát triển Liên ngành',
    keywords: /\b(khoi nghiep|startup|freelance|freelancer|tu do|kinh doanh rieng|lien nganh|phat trien ban than|muc tieu)\b/i,
    tools: ['Notion / Obsidian xây dựng hệ thống quản lý tri thức cá nhân (Second Brain)', 'Mô hình kinh doanh tinh gọn Lean Canvas & Business Model Canvas', 'Công cụ quản trị tiến độ theo khung Agile Trello / Jira', 'Bộ công cụ thương hiệu cá nhân số & Kênh portfolio đa nền tảng'],
    networks: ['Mạng lưới các vườn ươm khởi nghiệp (Startup Incubators & Accelerators)', 'Cộng đồng những người làm việc tự do & Indie Hackers Việt Nam', 'Mạng lưới cựu sinh viên khởi nghiệp và các nhà đầu tư thiên thần'],
    factors: {
      eco: { category: 'Kinh tế', factor: 'Nền kinh tế linh hoạt (Gig Economy) & Cơ hội tiếp cận vốn ươm mầm', influence: 'High', description: 'Sự phát triển của nền kinh tế số cho phép cá nhân tự tạo dựng sản phẩm và cung cấp dịch vụ trên quy mô toàn cầu.' },
      tech: { category: 'Công nghệ', factor: 'Công cụ No-code, Low-code và AI đòn bẩy năng suất', influence: 'High', description: 'Khả năng ứng dụng công nghệ để một cá nhân có thể vận hành hiệu quả tương đương một doanh nghiệp nhỏ.' },
      social: { category: 'Xã hội', factor: 'Xu hướng tự chủ sự nghiệp & Khát vọng tạo tác động xã hội', influence: 'High', description: 'Thế hệ trẻ ngày càng coi trọng sự tự do, linh hoạt và mong muốn giải quyết các bài toán thực tiễn của cuộc sống.' }
    },
    positiveTrajectory: 'Nhanh chóng định hình giá trị khác biệt cốt lõi, phát triển sản phẩm mẫu MVP được thị trường đón nhận tích cực, mở rộng quy mô hoạt động và thiết lập nguồn thu nhập độc lập tăng trưởng vượt bậc.',
    neutralTrajectory: 'Xây dựng sự nghiệp từng bước vững chắc, vừa học hỏi kinh nghiệm vừa tích lũy nguồn vốn dự phòng, duy trì sự cân bằng cuộc sống và hoàn thiện dần mô hình kinh doanh cá nhân.',
    riskTrajectory: 'Chiến lược quản trị rủi ro dòng tiền và sự bất định của hành trình độc lập: Luôn duy trì quỹ dự phòng tài chính tối thiểu 6 tháng sinh hoạt phí, thiết lập kỷ luật làm việc nghiêm ngặt và không ngừng kiểm thử phản hồi từ khách hàng.'
  }
};

const detectDomainProfile = (primaryText = '', secondaryTextOrRag = null, ragData = null) => {
  let secondaryText = '';
  let activeRag = ragData;
  if (typeof secondaryTextOrRag === 'string') {
    secondaryText = secondaryTextOrRag;
  } else if (secondaryTextOrRag && typeof secondaryTextOrRag === 'object') {
    activeRag = secondaryTextOrRag;
  }

  const normPrimary = toVietnameseAscii(primaryText);
  const norm = `${normPrimary} ${secondaryText ? toVietnameseAscii(secondaryText) : ''}`.trim();

  // 1. Direct high-specificity keyword match on primary goal/decision first
  for (const [key, profile] of Object.entries(UNIVERSAL_DOMAIN_MATRIX)) {
    if (key === 'general_flexible') continue;
    if (profile.keywords.test(normPrimary)) {
      return profile;
    }
  }

  // 2. Direct keyword match on secondary text (e.g. other factors)
  if (secondaryText) {
    const normSecondary = toVietnameseAscii(secondaryText);
    for (const [key, profile] of Object.entries(UNIVERSAL_DOMAIN_MATRIX)) {
      if (key === 'general_flexible') continue;
      if (profile.keywords.test(normSecondary)) {
        return profile;
      }
    }
  }

  // 3. If RAG has macro domain knowledge, use it as secondary link
  if (activeRag?.domainData?.key) {
    const k = activeRag.domainData.key;
    if (k === 'xay_dung_kien_truc') {
      if (/(kien truc|noi that|ngoai that|quy hoach)/i.test(norm)) return UNIVERSAL_DOMAIN_MATRIX.architecture_planning;
      return UNIVERSAL_DOMAIN_MATRIX.civil_construction;
    }
    if (k === 'khoa_hoc_xa_hoi') {
      if (/(tam ly|tham van|tri lieu)/i.test(norm)) return UNIVERSAL_DOMAIN_MATRIX.psychology_counseling;
      return UNIVERSAL_DOMAIN_MATRIX.social_sciences;
    }
    if (k === 'luat_phap_ly') return UNIVERSAL_DOMAIN_MATRIX.law_legal;
    if (k === 'su_pham_giao_duc') return UNIVERSAL_DOMAIN_MATRIX.education_pedagogy;
    if (k === 'nong_lam_ngu') return UNIVERSAL_DOMAIN_MATRIX.agriculture_biotech;
    if (k === 'thiet_ke_sang_tao') return UNIVERSAL_DOMAIN_MATRIX.creative_arts_design;
    if (k === 'du_lich_khach_san') return UNIVERSAL_DOMAIN_MATRIX.hospitality_tourism;
    if (k === 'logistics_xnk') return UNIVERSAL_DOMAIN_MATRIX.logistics_supply_chain;
    if (k === 'marketing_truyen_thong') return UNIVERSAL_DOMAIN_MATRIX.media_communications;
    if (k === 'ky_thuat_co_dien') {
      if (/(dien tu|vi mach|ban dan|semiconductor)/i.test(norm)) return UNIVERSAL_DOMAIN_MATRIX.electrical_semiconductor;
      return UNIVERSAL_DOMAIN_MATRIX.mechanical_automation;
    }
    if (k === 'kinh_te_tai_chinh') return UNIVERSAL_DOMAIN_MATRIX.economics_finance;
    if (k === 'ke_toan_kiem_toan') return UNIVERSAL_DOMAIN_MATRIX.accounting_audit;
    if (k === 'y_duoc') return UNIVERSAL_DOMAIN_MATRIX.medicine_pharmacy;
    if (k === 'cntt') return UNIVERSAL_DOMAIN_MATRIX.it_computer_science;
  }

  // 3. Fallback to general flexible
  return UNIVERSAL_DOMAIN_MATRIX.general_flexible;
};

const synthesizeUniversalSummary = (cleanData = {}, ragData = null) => {
  const student = extractHolisticStudentContext(cleanData);
  const domain = detectDomainProfile(student.fullText, ragData);
  const goal = student.primaryGoal;

  let realDataSnippet = '';
  if (ragData?.marketIntel?.total_postings) {
    realDataSnippet = `Phân tích từ dữ liệu tuyển sinh và hơn ${ragData.marketIntel.total_postings.toLocaleString()} tin tuyển dụng thực tế trong lĩnh vực ${ragData.marketIntel.industry}, `;
  } else if (ragData?.domainData?.name) {
    realDataSnippet = `Dựa trên dữ liệu chuẩn hóa lĩnh vực ${ragData.domainData.name} và chỉ số thị trường lao động, `;
  } else {
    realDataSnippet = `Kết hợp dữ liệu chuẩn tuyển sinh 185 trường đại học và chỉ số thị trường việc làm toàn quốc, `;
  }

  let schoolContext = student.targetSchool ? `tại ${student.targetSchool}` : '';

  if (student.stage === 'THPT_CHON_TO_HOP') {
    return `Báo cáo tư vấn chiến lược định hướng sớm và chọn tổ hợp môn học cho mục tiêu "${goal}" ${schoolContext}: ${realDataSnippet}FutureTrace đã thiết lập lộ trình phân tích khoa học cho học sinh THPT. Hệ thống mô phỏng 3 kịch bản: (1) Lộ trình tối ưu phát huy tối đa thế mạnh các môn chuyên môn; (2) Phương án học tập cân bằng toàn diện và giữ vững học bạ; (3) Chiến lược ứng phó linh hoạt trước các áp lực học tập và thay đổi nguyện vọng giúp học sinh và phụ huynh hoàn toàn an tâm chủ động.`;
  }

  if (student.stage === 'THPT_ON_THI_DAI_HOC') {
    let scoreNote = ragData?.admissions?.majors?.[0]?.benchmark_2024 ? `(điểm chuẩn tham chiếu dao động ${ragData.admissions.majors[0].benchmark_2024} điểm)` : '';
    return `Báo cáo phân tích chuyên sâu tuyển sinh và lộ trình chinh phục mục tiêu "${goal}" ${schoolContext} ${scoreNote}: ${realDataSnippet}nhu cầu nhân lực ngành ${domain.name} ghi nhận những chuyển dịch rõ nét theo năng lực thực hành và ngoại ngữ. Hệ thống FutureTrace đã xây dựng 3 kịch bản mô phỏng toàn diện: bứt phá trúng tuyển NV1 xuất sắc, lộ trình an toàn bền vững theo ngành đào tạo mục tiêu, và phương án quản trị rủi ro điểm số & chi phí học tập giúp bạn tối ưu hóa cơ hội thành công.`;
  }

  if (student.stage === 'DAI_HOC_DAI_CUONG') {
    return `Báo cáo hoạch định phát triển học thuật và xây dựng năng lực nền tảng cho mục tiêu "${goal}" ${schoolContext}: ${realDataSnippet}giai đoạn đại cương đóng vai trò bản lề để làm chủ phương pháp tự học và công cụ chuyên ngành (${domain.tools[0]}). Ba kịch bản mô phỏng vạch rõ: hướng đi bứt phá GPA và học bổng, lộ trình phát triển kỹ năng thực hành cân bằng, và chiến lược thích ứng giúp vượt qua áp lực học tập chuyển tiếp.`;
  }

  if (student.stage === 'DAI_HOC_CHUYEN_NGANH_THUC_TAP') {
    return `Báo cáo chiến lược thực tập và sẵn sàng gia nhập thị trường lao động cho mục tiêu "${goal}" ${schoolContext}: ${realDataSnippet}tiêu chuẩn tuyển dụng ngành ${domain.name} đặc biệt đề cao sản phẩm đồ án thực chiến và năng lực sử dụng công cụ chuyên sâu (${domain.tools.slice(0, 2).join(', ')}). Ba kịch bản mô phỏng vạch rõ lộ trình bứt phá khóa luận/thực tập tại tổ chức hàng đầu, tiến trình tích lũy kinh nghiệm vững chắc, và giải pháp quản trị rủi ro cạnh tranh việc làm đầu ra.`;
  }

  if (student.stage === 'THAC_SI_NGHIEN_CUU') {
    return `Báo cáo hoạch định đào tạo sau đại học và chiến lược học thuật Thạc sĩ/Nghiên cứu cho mục tiêu "${goal}" ${schoolContext}: ${realDataSnippet}bậc đào tạo Thạc sĩ đòi hỏi năng lực nghiên cứu độc lập, phương pháp luận khoa học và công bố học thuật chuyên sâu (${domain.tools[0]}). FutureTrace xây dựng 3 kịch bản mô phỏng: bứt phá giành học bổng/thủ khoa đầu ra cao học, lộ trình học Thạc sĩ song hành tích lũy kinh nghiệm làm việc thực tế, và chiến lược quản trị rủi ro áp lực nghiên cứu đề tài luận văn.`;
  }

  if (student.stage === 'DU_HOC_QUOC_TE') {
    return `Báo cáo chiến lược du học và chinh phục học bổng quốc tế cho mục tiêu "${goal}" ${schoolContext}: ${realDataSnippet}tiêu chuẩn tuyển sinh quốc tế ngành ${domain.name} đòi hỏi sự kết hợp toàn diện giữa điểm số học thuật (GPA/IELTS/SAT), bài luận thể hiện bản sắc cá nhân và hoạt động ngoại khóa nổi bật. FutureTrace thiết lập 3 kịch bản: bứt phá giành học bổng danh giá, phương án du học an toàn với lộ trình tài chính cân đối, và chiến lược quản trị rủi ro visa & thích ứng văn hóa nước sở tại.`;
  }

  if (student.stage === 'KHOI_NGHIEP_FREELANCE') {
    return `Báo cáo phân tích tính khả thi và mô phỏng chiến lược độc lập cho định hướng "${goal}": ${realDataSnippet}khả năng ứng dụng công nghệ đòn bẩy và kiểm soát dòng tiền quyết định sự sống còn của mô hình độc lập. FutureTrace mô phỏng 3 kịch bản: bứt phá tìm kiếm khách hàng/thị trường mục tiêu, tiến trình phát triển cân bằng duy trì nguồn vốn an toàn, và phương án quản trị rủi ro thị trường giúp bảo toàn nguồn lực tối đa.`;
  }

  // Default / Professional stage
  return `Báo cáo phân tích chuyên môn và mô phỏng lộ trình chiến lược toàn diện cho mục tiêu "${goal}" ${schoolContext}: ${realDataSnippet}hệ thống FutureTrace mô phỏng 3 hướng đi thực tế gồm kịch bản bứt phá chuyên môn tối ưu, lộ trình phát triển cân bằng bền bỉ, và giải pháp phòng ngừa rủi ro thích ứng linh hoạt giúp bạn làm chủ tương lai sự nghiệp.`;
};

const synthesizeUniversalScenarioDescription = (targetType, userContext = {}, ragData = null) => {
  const student = extractHolisticStudentContext(userContext);
  const domain = detectDomainProfile(student.fullText, ragData);
  const school = student.targetSchool ? `tại ${student.targetSchool}` : '';

  if (targetType === 'Positive') {
    if (student.stage === 'THPT_CHON_TO_HOP') {
      return `Lộ trình phát triển tối ưu: Lựa chọn chuẩn xác tổ hợp môn thế mạnh, xây dựng phương pháp học tập chủ động, đạt điểm tổng kết GPA xuất sắc và tích lũy các giải thưởng học thuật tạo lợi thế xét tuyển sớm.`;
    }
    if (student.stage === 'THPT_ON_THI_DAI_HOC') {
      return `Chiến lược bứt phá xuất sắc: Ôn luyện trúng trọng tâm cấu trúc đề thi, đạt điểm thi tối ưu khối xét tuyển để trúng tuyển NV1 ${school}, sớm giành các suất học bổng đầu vào và tạo lập vị thế học thuật tự tin.`;
    }
    if (student.stage === 'DU_HOC_QUOC_TE') {
      return `Lộ trình du học xuất sắc: Đạt chuẩn điểm thi chứng chỉ quốc tế vượt kỳ vọng (IELTS 7.5+ / SAT 1450+), hoàn thiện bài luận cá nhân sâu sắc, chinh phục học bổng 70-100% tại trường đại học hàng đầu và tự tin hội nhập môi trường học thuật quốc tế.`;
    }
    if (student.stage === 'DAI_HOC_CHUYEN_NGANH_THUC_TAP') {
      return `Lộ trình bứt phá sự nghiệp xuất sắc: Hoàn thành khóa luận với kết quả cao, làm chủ các công cụ chuẩn ngành (${domain.tools[0]}), hoàn thành kỳ thực tập xuất sắc tại doanh nghiệp dẫn đầu và nhận lời mời làm việc chính thức trước khi tốt nghiệp.`;
    }
    if (student.stage === 'THAC_SI_NGHIEN_CUU') {
      return `Lộ trình Thạc sĩ xuất sắc: Xây dựng đề cương nghiên cứu đột phá, công bố bài báo khoa học trên các tạp chí/hội thảo chuyên ngành, hoàn thành xuất sắc luận văn cao học và mở ra cơ hội học tiếp Tiến sĩ (PhD) hoặc đảm nhiệm vị trí R&D/quản lý cấp cao.`;
    }
    return `Lộ trình bứt phá tối ưu cho ngành ${domain.name}: ${domain.positiveTrajectory}`;
  }

  if (targetType === 'Neutral') {
    if (student.stage === 'THPT_CHON_TO_HOP') {
      return `Tiến trình học tập ổn định: Duy trì phong độ học tập đều đặn các môn, cân bằng giữa thời gian học và sinh hoạt ngoại khóa, từng bước khám phá sâu sắc năng khiếu bản thân để chuẩn bị tốt cho các năm học tiếp theo.`;
    }
    if (student.stage === 'THPT_ON_THI_DAI_HOC') {
      return `Lộ trình an toàn và vững chắc: Phân bổ đều thời gian ôn tập, đạt mức điểm an toàn theo học lực thực tế, trúng tuyển vào ngành ${domain.name} đúng nguyện vọng và thích ứng suôn sẻ với môi trường đại học.`;
    }
    if (student.stage === 'DU_HOC_QUOC_TE') {
      return `Lộ trình du học bền vững: Đạt điểm chuẩn ngoại ngữ theo yêu cầu trường mục tiêu, chuẩn bị hồ sơ du học chỉn chu, nhận các mức học bổng bán phần hoặc hỗ trợ tài chính hợp lý và thích nghi suôn sẻ với cuộc sống du học sinh.`;
    }
    if (student.stage === 'DAI_HOC_CHUYEN_NGANH_THUC_TAP') {
      return `Tiến trình phát triển ổn định: Hoàn thành tốt các học phần chuyên ngành, tích cực cọ xát tại các doanh nghiệp thực tập, tích lũy kỹ năng xử lý công việc thực tế và sẵn sàng chuyển tiếp sang vai trò nhân viên chính thức.`;
    }
    if (student.stage === 'THAC_SI_NGHIEN_CUU') {
      return `Tiến trình đào tạo cao học bền vững: Hoàn thành các học phần lý thuyết đúng hạn, bảo vệ thành công luận văn Thạc sĩ theo chuẩn quy định và tích lũy kiến thức chuyên môn sâu phục vụ công việc.`;
    }
    return `Tiến trình phát triển cân bằng và bền vững cho ngành ${domain.name}: ${domain.neutralTrajectory}`;
  }

  if (targetType === 'Risk') {
    if (student.stage === 'THPT_CHON_TO_HOP') {
      return `Phương án thích ứng linh hoạt trước áp lực học tập: Thiết lập phương án điều chỉnh phương pháp học khi gặp môn học khó, giữ vững tinh thần thoải mái và chủ động tham vấn thầy cô để không bị hổng kiến thức nền tảng.`;
    }
    if (student.stage === 'THPT_ON_THI_DAI_HOC') {
      return `Chiến lược quản trị rủi ro điểm chuẩn và kỳ thi: Chuẩn bị phương án xét tuyển 3 tầng (nguyện vọng trường top, trường vừa sức và phương án dự phòng gần ngành), kiểm soát tài chính học phí và giữ vững tâm lý trước ngày thi.`;
    }
    if (student.stage === 'DU_HOC_QUOC_TE') {
      return `Chiến lược quản trị rủi ro du học và tài chính: Chuẩn bị danh sách trường mục tiêu đa dạng theo nhiều phân khúc học phí, hoàn thiện phương án tài chính dự phòng, chuẩn bị kế hoạch học chuyển tiếp (2+2) hoặc các chương trình liên kết quốc tế trong nước để đảm bảo an toàn lộ trình.`;
    }
    if (student.stage === 'DAI_HOC_CHUYEN_NGANH_THUC_TAP') {
      return `Phương án ứng phó áp lực tốt nghiệp và cạnh tranh việc làm: Chủ động bổ sung chứng chỉ nghề nghiệp và ngoại ngữ thiết yếu, mở rộng ứng tuyển sang các ngành gần, tối ưu hóa chi phí cá nhân để duy trì sự kiên định.`;
    }
    if (student.stage === 'THAC_SI_NGHIEN_CUU') {
      return `Chiến lược quản trị rủi ro học cao học: Lựa chọn đề tài luận văn có tính ứng dụng cao, giữ liên lạc thường xuyên với giảng viên hướng dẫn, cân đối tài chính và tránh để việc nghiên cứu làm gián đoạn thu nhập.`;
    }
    return `Chiến lược thích ứng linh hoạt và quản trị rủi ro ngành ${domain.name}: ${domain.riskTrajectory}`;
  }

  return `Phân tích kịch bản tương lai và lộ trình hành động toàn diện cho ngành ${domain.name}.`;
};

const synthesizeUniversalTimeline = (userContext = {}) => {
  const student = extractHolisticStudentContext(userContext);
  const domain = detectDomainProfile(student.fullText);

  if (student.stage === 'THPT_CHON_TO_HOP') {
    return {
      start: 'Bắt đầu ngay hôm nay: Đánh giá điểm mạnh học lực các môn khoa học và xã hội, xác định nhóm năng khiếu tự nhiên và tham vấn ý kiến thầy cô, gia đình.',
      sixMonths: 'Sau 6 tháng: Chốt tổ hợp môn học THPT phù hợp (KHTN hoặc KHXH), thiết lập thời gian biểu tự học cố định và duy trì điểm GPA học kỳ đầu vững chắc.',
      oneYear: 'Sau 1 năm: Tham gia các câu lạc bộ học thuật hoặc dự án ngoại khóa trải nghiệm thực tế để củng cố đam mê nghề nghiệp tương lai.',
      threeYears: 'Sau 3 năm: Tích lũy học bạ xuất sắc, sẵn sàng tâm lý và nền tảng kiến thức vững vàng bước vào kỳ thi tốt nghiệp và xét tuyển đại học.'
    };
  }

  if (student.stage === 'THPT_ON_THI_DAI_HOC') {
    return {
      start: 'Bắt đầu ngay hôm nay: Lập kế hoạch ôn luyện chuyên sâu theo cấu trúc đề thi chuẩn, rà soát và lấp đầy các lỗ hổng kiến thức trọng tâm của tổ hợp môn.',
      sixMonths: 'Sau 6 tháng: Tối ưu hóa điểm số qua các kỳ thi thử, hoàn thiện hồ sơ xét tuyển sớm và chốt danh sách nguyện vọng theo chiến lược an toàn 3 tầng.',
      oneYear: 'Sau 1 năm: Trúng tuyển và chính thức bước vào giảng đường đại học, thích nghi nhanh với phương pháp tự học và rèn luyện ngoại ngữ chuẩn đầu ra.',
      threeYears: `Sau 3 năm: Hoàn thành vững chắc chương trình cơ sở ngành ${domain.name}, làm chủ công cụ thực hành (${domain.tools[0]}) và sẵn sàng ứng tuyển thực tập.`
    };
  }

  if (student.stage === 'DU_HOC_QUOC_TE') {
    return {
      start: 'Bắt đầu ngay hôm nay: Đánh giá trình độ ngoại ngữ hiện tại, lên kế hoạch ôn thi chứng chỉ chuẩn hóa (IELTS/SAT/GRE) và tìm hiểu tiêu chí xét học bổng các trường.',
      sixMonths: 'Sau 6 tháng: Đạt chứng chỉ mục tiêu, lên ý tưởng và hoàn thiện bài luận cá nhân (Personal Statement/SOP), kết nối thầy cô xin thư giới thiệu (LoR).',
      oneYear: 'Sau 1 năm: Nhận thư mời nhập học (Offer Letter) và gói học bổng, hoàn tất thủ tục chứng minh tài chính, khám sức khỏe và xin thị thực du học (Visa).',
      threeYears: `Sau 3 năm: Tích lũy kiến thức xuất sắc chương trình quốc tế ngành ${domain.name}, làm chủ công nghệ mới (${domain.tools[0]}) và sẵn sàng nắm bắt cơ hội việc làm toàn cầu.`
    };
  }

  if (student.stage === 'DAI_HOC_DAI_CUONG') {
    return {
      start: 'Bắt đầu ngay hôm nay: Xây dựng phương pháp học đại học hiệu quả, duy trì điểm GPA học kỳ đầu trên 3.0/4.0 và rèn luyện tiếng Anh giao tiếp.',
      sixMonths: 'Sau 6 tháng: Gia nhập câu lạc bộ học thuật chuyên ngành, tìm kiếm nhóm đồng hành học tập và tiếp cận các tài liệu chuyên khảo chuyên ngành.',
      oneYear: `Sau 1 năm: Hoàn thành vững khối kiến thức đại cương, bắt đầu học các công cụ chuyên ngành cốt lõi (${domain.tools[0]}) và tích lũy chứng chỉ ngoại ngữ.`,
      threeYears: `Sau 3 năm: Tham gia các đề tài nghiên cứu hoặc đồ án thực tế, hoàn thiện hồ sơ CV/Portfolio và ứng tuyển thực tập sinh tại doanh nghiệp dẫn đầu.`
    };
  }

  if (student.stage === 'DAI_HOC_CHUYEN_NGANH_THUC_TAP') {
    return {
      start: `Bắt đầu ngay hôm nay: Rà soát chuẩn đầu ra tốt nghiệp, hoàn thiện hồ sơ năng lực (CV/Portfolio) và thực hành chuyên sâu công cụ ${domain.tools[0]}.`,
      sixMonths: 'Sau 6 tháng: Ứng tuyển và hoàn thành kỳ thực tập thực chiến tại doanh nghiệp, tích lũy bài học xử lý công việc và mở rộng mạng lưới quan hệ.',
      oneYear: 'Sau 1 năm: Bảo vệ thành công khóa luận/đồ án tốt nghiệp với kết quả cao, chuyển giao suôn sẻ sang vị trí nhân viên chính thức.',
      threeYears: 'Sau 3 năm: Khẳng định vị thế chuyên môn vững chắc (Mid-level), tự tin đảm nhận các bài toán phức tạp và đạt mức thu nhập cạnh tranh cao.'
    };
  }

  if (student.stage === 'THAC_SI_NGHIEN_CUU') {
    return {
      start: 'Bắt đầu ngay hôm nay: Xác định hướng nghiên cứu chuyên sâu, lựa chọn giảng viên hướng dẫn tiềm năng và rà soát các điều kiện xét tuyển cao học / học bổng.',
      sixMonths: 'Sau 6 tháng: Hoàn thiện đề cương nghiên cứu (Research Proposal), đạt chuẩn chứng chỉ ngoại ngữ (IELTS/TOEFL) và chuẩn bị hồ sơ ứng tuyển Thạc sĩ.',
      oneYear: 'Sau 1 năm: Trúng tuyển chương trình cao học, hoàn thành xuất sắc các học phần lý thuyết nâng cao và bắt đầu khảo sát dữ liệu thực nghiệm.',
      threeYears: 'Sau 3 năm: Bảo vệ thành công luận văn Thạc sĩ với đánh giá xuất sắc, công bố bài báo khoa học và định hình vị thế chuyên gia đầu ngành.'
    };
  }

  if (student.stage === 'KHOI_NGHIEP_FREELANCE') {
    return {
      start: 'Bắt đầu ngay hôm nay: Xây dựng bản mô hình kinh doanh tinh gọn (Lean Canvas), xác định phân khúc khách hàng mục tiêu và chuẩn bị quỹ dự phòng.',
      sixMonths: 'Sau 6 tháng: Cho ra mắt sản phẩm mẫu thử nghiệm (MVP) hoặc dịch vụ đầu tiên, thu thập phản hồi người dùng và tinh chỉnh giải pháp.',
      oneYear: 'Sau 1 năm: Tối ưu hóa kênh tiếp cận khách hàng, xây dựng uy tín thương hiệu cá nhân và duy trì dòng tiền hoạt động dương ổn định.',
      threeYears: 'Sau 3 năm: Mở rộng quy mô kinh doanh hoặc định hình mạng lưới khách hàng trung thành, tự chủ hoàn toàn về thời gian và tài chính.'
    };
  }

  // General fallback timeline
  return {
    start: `Bắt đầu ngay hôm nay: Thiết lập mục tiêu rõ ràng cho lộ trình ${domain.name}, lên lịch biểu học tập cố định mỗi ngày và chuẩn bị tài liệu chuyên môn.`,
    sixMonths: `Sau 6 tháng: Hoàn thành vững chắc nền tảng kiến thức cốt lõi, thực hành qua các bài tập dự án nhỏ và làm chủ công cụ ${domain.tools[0]}.`,
    oneYear: 'Sau 1 năm: Đạt được các chứng chỉ hoặc thành tích học tập quan trọng, hoàn thiện hồ sơ năng lực và tích lũy kỹ năng thực chiến.',
    threeYears: 'Sau 3 năm: Khẳng định năng lực chuyên môn vững vàng trên thị trường, chủ động nắm bắt cơ hội việc làm hoặc phát triển sự nghiệp dẫn đầu.'
  };
};

const inferUniversalTools = (context = {}, title = '') => {
  const fullText = `${context.decision || ''} ${title || ''} ${context.otherFactors || ''}`.trim();
  const domain = detectDomainProfile(fullText);
  return domain.tools.slice(0, 3);
};

const synthesizeUniversalFactors = (titleStr = '', ctx = {}) => {
  const fullText = `${titleStr || ''} ${ctx?.decision || ''} ${ctx?.otherFactors || ''}`.trim();
  const student = extractHolisticStudentContext(ctx);
  const domain = detectDomainProfile(fullText);

  let eco = { ...domain.factors.eco };
  let tech = { ...domain.factors.tech };
  let social = { ...domain.factors.social };
  let personal = {
    category: 'Cá nhân',
    factor: 'Năng lực chuyên môn & Kỷ luật tự học',
    influence: 'High',
    description: 'Trình độ hiện tại, khả năng tập trung và sự bền bỉ quyết định trực tiếp tốc độ hoàn thành lộ trình.'
  };

  if (student.personalFinance <= 2) {
    eco = {
      category: 'Kinh tế',
      factor: 'Quản trị chi phí đào tạo & Kế hoạch tài chính',
      influence: 'High',
      description: 'Áp lực tài chính yêu cầu tối ưu chi phí sinh hoạt, tìm kiếm học bổng hoặc việc làm bán thời gian phù hợp để đảm bảo duy trì lộ trình bền bỉ.'
    };
  }

  if (student.stress >= 4) {
    personal = {
      category: 'Cá nhân',
      factor: 'Khả năng quản trị áp lực & Sức bền tinh thần',
      influence: 'High',
      description: 'Cường độ học tập/công việc cao đòi hỏi phương pháp cân bằng thời gian nghỉ ngơi khoa học, giữ vững tinh thần và tránh kiệt sức giữa chặng.'
    };
  } else if (student.academicPerformance >= 4) {
    personal = {
      category: 'Cá nhân',
      factor: 'Nền tảng học thuật xuất sắc & Khả năng bứt phá',
      influence: 'High',
      description: 'Học lực vượt trội là bệ phóng lớn để tiếp thu nhanh kiến thức chuyên sâu và giải quyết các bài toán phức tạp của ngành.'
    };
  }

  return [eco, personal, social, tech];
};

// Backward-compatibility wrappers ensuring existing references never break
const isLogisticsDomain = (str) => UNIVERSAL_DOMAIN_MATRIX.logistics_supply_chain.keywords.test(toVietnameseAscii(str));
const isMedicalDomain = (str) => UNIVERSAL_DOMAIN_MATRIX.medicine_pharmacy.keywords.test(toVietnameseAscii(str));
const isITDomain = (str) => UNIVERSAL_DOMAIN_MATRIX.it_computer_science.keywords.test(toVietnameseAscii(str));
const isBusinessDomain = (str) => UNIVERSAL_DOMAIN_MATRIX.economics_finance.keywords.test(toVietnameseAscii(str));
const buildDomainEnrichedSummary = (userContext = {}) => synthesizeUniversalSummary(userContext, userContext.ragData);
const getDomainDescription = (targetType, userContext = {}) => synthesizeUniversalScenarioDescription(targetType, userContext, userContext.ragData);
const getDomainTimeline = (userContext = {}) => synthesizeUniversalTimeline(userContext);

/**
 * Ensures the simulation result has all required fields to prevent frontend crashes.
 * Handles both camelCase (deepAnalysis) and snake_case (deep_analysis) from AI output.
 * Guarantees distinct titles, descriptions, and metrics for all 3 scenarios.
 */
const buildCareerQuant = (userContext = {}) => {
  const student = extractHolisticStudentContext(userContext);
  const rag = userContext.ragData || {};
  const sheet = userContext.factSheet || {};
  // Nhóm nghề ưu tiên lấy từ crosswalk ngành đào tạo -> nghề (Knowledge Layer v2)
  const occupation = sheet.occupation;
  // Ngành không có thị trường tuyển dụng công khai (quân đội, công an, biểu diễn nghệ thuật...): không ước lượng lương/ROI
  if (occupation?.fit === 'none') return null;
  const livingFact = sheet.facts?.find(f => f.kind === 'living_cost');
  const tuitionVnd = sheet.program?.tuitionVnd;
  try {
    return computeCareerQuant({
      stage: student.stage,
      decisionText: `${userContext.decision || ''} ${userContext.otherFactors || ''}`,
      industryText: occupation?.industry || rag.marketIntel?.industry || userContext.decision,
      roleTitle: occupation?.role || rag.salaryBench?.role?.title,
      locationText: userContext.location,
      livingMonthlyMillion: livingFact?.value ?? rag.livingCost?.estimated_monthly_student_million,
      // Học phí của chương trình (nguồn tổng hợp chưa ghi đơn vị; giả định theo năm, có gắn cờ)
      tuitionPerYearMillion: tuitionVnd ? Math.round(tuitionVnd / 1e5) / 10 : undefined,
      tuitionSource: tuitionVnd ? 'program_unit_unverified' : undefined,
      personalFinance: userContext.personalFinance,
      budgetPerYearMillion: Number(userContext.budgetPerYearMillion) || undefined
    });
  } catch (err) {
    console.warn('[Career Quant] Failed, falling back to AI metrics:', err.message);
    return null;
  }
};

/**
 * Khối số liệu định lượng đưa vào prompt để phần diễn giải của LLM khớp với con số hiển thị.
 */
const formatQuantSnippet = (quant) => {
  if (!quant) return '';
  const label = { Positive: 'Tối ưu (P75)', Neutral: 'Cân bằng (P50)', Risk: 'Thận trọng (P25)' };
  const lines = ['=== [SỐ LIỆU ĐỊNH LƯỢNG FT-SALARY - DÙNG ĐÚNG CÁC CON SỐ NÀY, KHÔNG TỰ ƯỚC LƯỢNG LƯƠNG/ROI] ==='];
  const lens = quant.assumptions?.lensYears || 20;
  for (const [type, s] of Object.entries(quant.scenarios)) {
    lines.push(`- ${label[type]}: lương khởi điểm ~${s.salary.startMonthlyMillion} tr/tháng, sau 5 năm ~${s.salary.year5MonthlyMillion} tr/tháng; ` +
      `ROI ${lens} năm ${Math.round(s.roi.ratio * 100)}%${s.roi.paybackYearFromNow ? `, hoàn vốn năm thứ ${s.roi.paybackYearFromNow}` : `, chưa hoàn vốn trong ${lens} năm`}; ` +
      `nhu cầu tiền mặt ~${s.affordability.cashNeedPerYearMillion} tr/năm${s.affordability.affordable ? '' : ` (vượt khả năng gia đình ~${s.affordability.gapPerYearMillion} tr/năm)`}.`);
  }
  // Không đưa "động lượng nhu cầu" vào prompt: nhãn ngành trong dữ liệu trôi theo năm nên tín hiệu không đủ tin cậy
  if (quant.market) {
    lines.push(`- Lương danh nghĩa ngành tăng ~${quant.market.salaryGrowthPercentPerYear}%/năm giai đoạn ${quant.market.period.join('-')}.`);
  }
  return lines.join('\n');
};

const normalizeSimulationResponse = (data, userContext = {}) => {
  const domainTimeline = synthesizeUniversalTimeline(userContext);
  const defaults = {
    isEnterprise: false,
    summary: synthesizeUniversalSummary(userContext, userContext.ragData),
    scenarios: [],
    timeline: domainTimeline
  };

  const normalized = { ...defaults, ...data };

  // Ensure rich, domain-grounded summary
  const rawSummary = data.summary || data.tong_quan || data.overview || '';
  if (!rawSummary || typeof rawSummary !== 'string' || rawSummary.trim().length < 30 || rawSummary.includes('Báo cáo phân tích tương lai và mô phỏng lộ trình toàn diện từ FutureTrace')) {
    normalized.summary = synthesizeUniversalSummary(userContext, userContext.ragData);
  } else {
    normalized.summary = rawSummary.trim();
  }

  // Normalize timeline to guaranteed strings, avoiding short or generic placeholders
  const rawTimeline = data.timeline || data.lo_trinh || {};
  const cleanTimelineItem = (raw, fallback) => {
    const s = stringifyTimelineItem(raw, fallback);
    if (!s || s.trim().length < 15 || s.includes('Bắt đầu hành trình') || s.includes('Giai đoạn')) {
      return fallback;
    }
    return s.trim();
  };

  normalized.timeline = {
    start: cleanTimelineItem(rawTimeline.start, domainTimeline.start),
    sixMonths: cleanTimelineItem(rawTimeline.sixMonths, domainTimeline.sixMonths),
    oneYear: cleanTimelineItem(rawTimeline.oneYear, domainTimeline.oneYear),
    threeYears: cleanTimelineItem(rawTimeline.threeYears, domainTimeline.threeYears)
  };

  // Helper to determine scenario type cleanly
  const resolveScenarioType = (rawType, index) => {
    if (typeof rawType === 'string') {
      const t = rawType.trim().toLowerCase();
      if (t.includes('pos') || t.includes('tối ưu') || t.includes('toi uu') || t.includes('tích cực') || t.includes('tich cuc')) return 'Positive';
      if (t.includes('risk') || t.includes('rủi ro') || t.includes('rui ro') || t.includes('thận trọng') || t.includes('than trong')) return 'Risk';
      if (t.includes('neu') || t.includes('cân bằng') || t.includes('can bang') || t.includes('trung bình') || t.includes('ổn định')) return 'Neutral';
    }
    const order = ['Positive', 'Neutral', 'Risk'];
    return order[index % 3];
  };

  const isGenericTitle = (t) => {
    if (!t || typeof t !== 'string') return true;
    const s = t.trim().toLowerCase();
    return s.length < 8 || s.includes('kịch bản tiềm năng') || s.includes('kich ban tiem nang') || s.includes('chưa hoàn thiện');
  };

  const isGenericDescription = (d) => {
    if (!d || typeof d !== 'string') return true;
    const s = d.trim().toLowerCase();
    return s.length < 80 || s.includes('phân tích kịch bản chưa hoàn thiện') || s.includes('chua hoan thien') || s.includes('lộ trình đòi hỏi tính kỷ luật') || s.includes('tận dụng tối đa thế mạnh cá nhân');
  };

  // Ensure scenarios is an array (support aliases)
  let rawScenarios = data.scenarios || data.data || data.scenarios_list || data.kich_ban || [];
  if (rawScenarios && typeof rawScenarios === 'object' && !Array.isArray(rawScenarios)) {
    rawScenarios = Object.values(rawScenarios);
  }
  if (!Array.isArray(rawScenarios)) {
    rawScenarios = [];
  }

  // Định lượng bằng FT-Salary + Career ROI Engine (thay cho các hằng số mặc định)
  const quant = userContext.quant !== undefined ? userContext.quant : buildCareerQuant(userContext);

  // Map and normalize each scenario
  const targetTypes = ['Positive', 'Neutral', 'Risk'];
  const processedScenarios = [];

  for (let i = 0; i < 3; i++) {
    const targetType = targetTypes[i];
    const cfg = getContextualScenarioConfig(targetType, userContext);

    // Find a matching scenario from AI output, or take scenario at index i
    let s = rawScenarios.find(sc => resolveScenarioType(sc.type || sc.scenario_type, -1) === targetType);
    if (!s && rawScenarios[i]) {
      s = rawScenarios[i];
    }
    if (!s) {
      s = {};
    }

    // Support deep_analysis (snake_case from AI) and deepAnalysis (camelCase)
    const da = s.deepAnalysis || s.deep_analysis || {};

    // --- SWOT ---
    let rawSwot = da.swot || [];
    if (!Array.isArray(rawSwot)) rawSwot = typeof rawSwot === 'object' ? Object.values(rawSwot) : [];
    let swot = rawSwot.map((item, idx) => normalizeSwotItem(item, idx));
    while (swot.length < 4) {
      swot.push(cfg.swot[swot.length]);
    }

    // --- Resources ---
    let rawResources = da.resources || [];
    if (typeof rawResources === 'string') {
      try { rawResources = JSON.parse(rawResources); } catch (e) { rawResources = [rawResources]; }
    }
    if (!Array.isArray(rawResources)) rawResources = typeof rawResources === 'object' ? Object.values(rawResources) : [];
    let resources = rawResources.map((item, idx) => normalizeResourceItem(item, idx));
    const defaultResourceVals = targetType === 'Positive' ? [5, 25, 4] : targetType === 'Neutral' ? [4, 18, 3] : [3, 22, 2];
    resources = resources.map((res, idx) => {
      if (!res.value || res.value === 0) {
        res.value = defaultResourceVals[idx % 3];
      }
      return res;
    });
    while (resources.length < 3) {
      resources.push(cfg.resources[resources.length]);
    }

    // --- Sprint90 ---
    let rawSprint90 = da.sprint90 || [];
    if (typeof rawSprint90 === 'string') {
      try { rawSprint90 = JSON.parse(rawSprint90); } catch (e) { rawSprint90 = [rawSprint90]; }
    }
    if (!Array.isArray(rawSprint90)) rawSprint90 = typeof rawSprint90 === 'object' ? Object.values(rawSprint90) : [];
    let sprint90 = rawSprint90.map((item, idx) => normalizeSprint90Item(item, idx));
    while (sprint90.length < 3) {
      sprint90.push(cfg.sprint90[sprint90.length]);
    }

    // --- Aliases for Title & Description ---
    const rawTitle = s.title || s.name || s.scenario_title || s.tieu_de || s.ten || s.ten_kich_ban;
    let finalTitle = isGenericTitle(rawTitle) ? cfg.defaultTitle : String(rawTitle).trim();

    const rawDesc = s.description || s.desc || s.summary || s.mo_ta || s.chi_tiet || s.noi_dung;
    const isDuplicateDesc = processedScenarios.some(prev => prev.description && prev.description === String(rawDesc || '').trim());
    let finalDesc = (isGenericDescription(rawDesc) || isDuplicateDesc) ? getDomainDescription(targetType, userContext) : String(rawDesc).trim();

    if (finalDesc.length < 110) {
      // Context-aware padding instead of generic text
      const ctxStudent = extractHolisticStudentContext(userContext);
      const ctxDomain = detectDomainProfile(`${userContext.decision || ''} ${userContext.otherFactors || ''}`, userContext.ragData);
      const ctxTools = inferUniversalTools(userContext, userContext.decision || '');
      const stagePad = ctxStudent.stage.includes('THPT') ? `Giai đoạn ${ctxStudent.stageLabel} đòi hỏi chiến lược ôn luyện tập trung và quản trị tâm lý vững vàng.` :
        ctxStudent.stage === 'DU_HOC_QUOC_TE' ? `Lộ trình du học ngành ${ctxDomain.name} đòi hỏi sự chuẩn bị toàn diện từ chứng chỉ ngoại ngữ, bài luận cá nhân đến hồ sơ tài chính vững vàng.` :
          ctxStudent.stage.includes('THAC_SI') ? `Lộ trình cao học đòi hỏi năng lực nghiên cứu độc lập, phương pháp luận khoa học và kiểm soát tiến độ luận văn chặt chẽ.` :
            `Lộ trình ngành ${ctxDomain.name} đòi hỏi làm chủ công cụ chuyên ngành (${ctxTools[0]}) và tích lũy kinh nghiệm thực tiễn qua dự án thực tế.`;
      finalDesc = `${finalDesc} ${stagePad}`;
    }

    if (isGenericTitle(rawTitle) && userContext && userContext.decision) {
      const cleanGoal = userContext.decision.split('\n')[0].replace(/\.{2,}$/, '').trim();
      const displayGoal = cleanGoal.length > 40 ? cleanGoal.substring(0, 40) + '...' : cleanGoal;
      const ctxDomain = detectDomainProfile(`${userContext.decision || ''} ${userContext.otherFactors || ''}`, userContext.ragData);
      if (targetType === 'Positive') finalTitle = `Kịch bản Tối Ưu: Đột phá mục tiêu "${displayGoal}" (${ctxDomain.name})`;
      else if (targetType === 'Neutral') finalTitle = `Kịch bản Cân Bằng: Phát triển bền vững theo hướng "${displayGoal}" (${ctxDomain.name})`;
      else if (targetType === 'Risk') finalTitle = `Kịch bản Thận Trọng: Vượt thử thách khi theo đuổi "${displayGoal}" (${ctxDomain.name})`;
    }

    // --- Metrics with fallback to distinct defaults ---
    const parseMetric = (val, fallback, min = 20, max = 99) => {
      const n = typeof val === 'number' ? val : parseInt(val);
      if (isNaN(n) || n < min || n > max) return fallback;
      return n;
    };

    const q = quant?.scenarios?.[targetType];
    const aiMetrics = {
      careerGrowth: parseMetric(s.careerGrowth ?? s.career_growth ?? s.growth ?? s.career ?? s.su_nghiep, null),
      happiness: parseMetric(s.happiness ?? s.happy ?? s.hanh_phuc, null),
      roi: parseMetric(s.roi ?? s.roi_score ?? s.hieu_qua_tai_chinh, null)
    };
    const careerGrowth = q ? q.careerGrowthScore : (aiMetrics.careerGrowth ?? cfg.defaultCareerGrowth);
    const roi = q ? q.roiScore : (aiMetrics.roi ?? cfg.defaultRoi);
    const happinessEst = estimateHappiness(targetType, aiMetrics.happiness, userContext, q);
    const happiness = happinessEst.value;

    // --- Critical Advice & Market Fit ---
    const rawAdvice = da.criticalAdvice || da.critical_advice || s.criticalAdvice || s.critical_advice || s.loi_khuyen;
    const finalAdvice = (rawAdvice && typeof rawAdvice === 'string' && rawAdvice.trim().length > 15 && !rawAdvice.includes('Đang cập nhật'))
      ? rawAdvice.trim()
      : cfg.criticalAdvice;

    const rawMarketFit = s.marketFit || s.market_fit || da.marketFit || {};
    const marketAnalysisText = s.marketAnalysis || s.market_analysis || rawMarketFit.analysis || rawMarketFit.mo_ta;
    const finalMarketFit = {
      score: typeof rawMarketFit.score === 'number' ? rawMarketFit.score : cfg.marketFit.score,
      analysis: (marketAnalysisText && typeof marketAnalysisText === 'string' && marketAnalysisText.trim().length > 15)
        ? marketAnalysisText.trim()
        : cfg.marketFit.analysis
    };

    processedScenarios.push({
      title: finalTitle,
      description: finalDesc,
      careerGrowth,
      happiness,
      roi,
      type: targetType,
      deepAnalysis: {
        swot,
        resources,
        sprint90,
        criticalAdvice: finalAdvice
      },
      marketFit: finalMarketFit,
      probability: q ? q.probability : undefined,
      expectedSalary: q ? q.expectedSalary : undefined,
      quant: q ? {
        model: quant.model,
        confidence: quant.confidence,
        market: quant.market,
        assumptions: quant.assumptions,
        roi: q.roi,
        salary: q.salary,
        affordability: q.affordability,
        metricSources: { careerGrowth: 'ft-salary', roi: 'ft-salary', happiness: happinessEst.source },
        aiMetrics
      } : undefined
    });
  }

  normalized.scenarios = processedScenarios;
  return normalized;
};

// =========================================================
// =========================================================
// RAG (Retrieval-Augmented Generation) Knowledge Base Layer
// Multi-Channel Hybrid Retrieval:
// 1. data.parquet (606,878 recruitment postings in Vietnam)
// 2. diem_chuan_tat_ca_cac_truong.xlsx (183 universities)
// 3. luong_trung_binh_vietnamworks.xlsx (6,220 job salaries)
// 4. numbeo_cost_of_living.json (student living costs)
// 5. domains_index.json (14 macro fields)
// =========================================================
const ragService = require('./ragService');

/**
 * Detect the relevant field from user's decision text
 */
const detectFieldFromText = (text) => {
  if (!text) return null;
  return ragService.retrieveDomainKnowledge(text);
};

/**
 * Build a RAG context string from the matched field data to inject into prompt
 */
const buildRAGContext = (fieldData, fullText = '') => {
  const { ragSnippet } = ragService.getAugmentedContext(fullText || (fieldData?.name || ''));
  return ragSnippet;
};

// =========================================================

const { getAI, GEMINI_FALLBACK_MODELS, GEMINI_TIMEOUT_MS, extractUsage, latencyConfigFor } = require('./geminiClient');

const callGeminiWithRetry = async (modelNames, contents, config, maxRetries = 1) => {
  const models = Array.isArray(modelNames) ? modelNames : [modelNames];
  let lastError;

  for (const model of models) {
    console.log(`[AI] Attempting call with model: ${model}`);
    let success = false;
    let response;

    for (let i = 0; i <= maxRetries; i++) {
      try {
        const ai = getAI();
        const requestConfig = {
          ...config,
          abortSignal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
          ...latencyConfigFor(model)
        };
        response = await ai.models.generateContent({
          model: model,
          contents: contents,
          config: requestConfig
        });
        response.modelUsed = model;
        response.usage = extractUsage(response, model);
        success = true;
        break;
      } catch (error) {
        lastError = error;
        console.warn(`[AI Retry ${i}/${maxRetries}] Failed with model "${model}":`, error.message);

        if (error.status === 400 && !error.message.includes('API key not valid')) {
          throw error;
        }

        const errorMsgLower = error.message ? error.message.toLowerCase() : '';
        const isModelNotFoundError = error.status === 404 ||
          errorMsgLower.includes('not found') ||
          errorMsgLower.includes('not supported') ||
          errorMsgLower.includes('denied access') ||
          error.status === 403;

        if (isModelNotFoundError) {
          console.warn(`[AI Fallback] Model "${model}" is not available or access is denied. Switching to fallback.`);
          break;
        }

        if (i < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
        }
      }
    }

    if (success) {
      console.log(`[AI Success] Successfully generated content using model: ${model}`);
      return response;
    }
  }

  if (lastError && typeof lastError === 'object') {
    try {
      lastError.modelUsed = models[0];
    } catch (e) {
      // ignore
    }
  }
  throw lastError;
};

const analyzeInputReadiness = async (data) => {
  const decision = (data.decision || '').trim();
  const words = decision.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  // ============================================================
  // GIAI ĐOẠN 1: KIỂM TRA ĐỘ HOÀN THIỆN CÂU (Linguistic Completeness Check)
  // - Phát hiện câu bị bỏ dở, gõ chưa xong (ví dụ: "t...", "em muốn thi...", "học ngành...")
  // - Phát hiện dấu chấm lửng ở cuối: "..." hoặc ".."
  // - Phát hiện từ đơn lẻ bị ngắt ngang: ký tự 1-2 chữ cái kèm dấu chấm ("t...", "v...")
  // - Phát hiện giới từ/liên từ treo không có tân ngữ: "tại", "ở", "vào", "trường", "ngành", "với", v.v.
  // - Quá ngắn: dưới 10 ký tự hoặc dưới 3 từ
  // ============================================================
  const isHangingEllipsis = /\.{2,}$/.test(decision);
  const isHangingToken = /\s+[a-zA-Z]{1,2}\.{1,}$/.test(decision) || (/\s+[a-z]$/i.test(decision) && !/(khối|khoi|nhóm|lop|lớp)\s+[a-z]$/i.test(decision));
  const isDanglingPreposition = /(tại|tai|ở|o|vào|vao|với|voi|nhưng|nhung|và|va|hoặc|hoac|cho|để|de|khi|nếu|neu)\s*$/i.test(decision) ||
    /(vào ngành|học ngành|thi ngành|chọn ngành|ở khoa|tại khoa)\s*$/i.test(decision);
  const isTooShort = wordCount < 3 || decision.length < 10;
  const isIncomplete = isHangingEllipsis || isHangingToken || isDanglingPreposition || isTooShort;

  // ============================================================
  // GIAI ĐOẠN 3: KIỂM TRA ĐỘ ĐẦY ĐỦ VÀ CỤ THỂ (Specificity & Detail Anchor Check)
  // Một câu được coi là ĐỦ CHI TIẾT ("ready") khi:
  // 1. KHÔNG bị ngắt quãng hoặc bỏ dở (not incomplete)
  // 2. Độ dài >= 20 ký tự
  // 3. Có ít nhất một mỏ neo thông tin cụ thể:
  //    - Có tên trường đại học / học viện cụ thể (Bách Khoa, Y Hà Nội, NEU, FPT, FTU, UEH...)
  //    - HOẶC có mức điểm thi / học lực / tài chính cụ thể (27 điểm, khối B, học phí, học bổng...)
  //    - HOẶC người dùng đã qua bước làm rõ và bổ sung ngữ cảnh ([THÔNG TIN BỔ SUNG TỪ NGƯỜI DÙNG])
  // ============================================================
  // Có tên trường cụ thể: "Đại học/ĐH/Học viện/Trường" + tên viết hoa, tên riêng phổ biến, hoặc viết tắt.
  // Không tính "ngân hàng", "sư phạm", "y dược" đứng một mình (đó là tên ngành) hay "sinh viên đại học" (không có tên trường).
  const hasSchool = /(Đại học|ĐH|Học viện|Trường|đại học|học viện|trường)\s+(?!(năm|nào|gì|công lập|tư)(?=[\s,.;!?]|$))[A-ZĐÀ-Ỹ]/.test(decision) ||
    /(bách khoa|kinh tế quốc dân|ngoại thương|y hà nội|y dược tp|phenikaa|hutech|tôn đức thắng|vinuni|phạm ngọc thạch|duy tân|văn lang|hoa sen|nguyễn tất thành)/i.test(decision) ||
    /\b(FPT|NEU|FTU|UEH|HUST|VNU|UIT|RMIT|HCMUT|UEL|USSH|HUCE|PTIT|DUT|HCMUS)\b/i.test(decision);
  const hasScoreOrBudget = /(điểm|diem|khối [a-d][0-9]*|khoi [a-d][0-9]*|ielts|học bổng|hoc bong|học phí|hoc phi|triệu\/tháng|triệu\/năm|tự lập|du học|nội trú|chuyên khoa)/i.test(decision);
  const isAlreadyEnriched = Boolean(
    data.clarifications?.length ||
    decision.includes('[THÔNG TIN BỔ SUNG TỪ NGƯỜI DÙNG]') ||
    (data.otherFactors && data.otherFactors.trim().length > 10)
  );

  if (!isIncomplete && (hasSchool || hasScoreOrBudget || isAlreadyEnriched) && decision.length >= 20) {
    console.log(`[AI Pre-check] ⚡ Input is fully detailed & specific: "${decision.substring(0, 50)}..." (${decision.length} chars)`);
    return { status: 'ready', questions: [], modelUsed: 'semantic-readiness-engine' };
  }

  // ============================================================
  // GIAI ĐOẠN 4: CÂU HỎI LÀM RÕ THEO GIAI ĐOẠN HỌC + NGÀNH ĐÍCH (< 1 ms, không gọi AI)
  // Xem services/clarificationService.js
  // ============================================================
  const student = extractHolisticStudentContext({ decision });
  return {
    status: 'needs_clarification',
    questions: buildClarificationQuestions(decision, student),
    modelUsed: 'stage-domain-clarifier'
  };
};

const generateSimulation = async (data) => {
  // Làm sạch data.decision - loại bỏ prompt injection từ frontend
  const cleanDecision = sanitizeDecision(data.decision || '');
  const cleanData = { ...data, decision: cleanDecision };

  // RAG: Multi-Channel Hybrid Retrieval across 606k job postings, 183 universities, and salary benchmarks
  const searchText = `${cleanDecision} ${cleanData.otherFactors || ''} ${cleanData.location || ''} ${cleanData.educationLevel || ''}`;
  const { ragData } = ragService.getAugmentedContext(cleanDecision, searchText);
  // Knowledge Layer v2: số liệu có nguồn (Fact Sheet) thay cho các con số trong chỉ mục RAG cũ
  const factSheet = knowledgeService.buildFactSheet({
    programId: cleanData.programId,
    decisionText: `${cleanDecision} ${cleanData.otherFactors || ''}`,
    regionKey: detectRegionKey(`${cleanData.location || ''} ${cleanDecision}`)
  });
  const quant = buildCareerQuant({ ...cleanData, ragData, factSheet });
  const ragContext = [
    knowledgeService.formatFactSheet(factSheet),
    formatQuantSnippet(quant),
    ragService.formatQualitativeSnippet(ragData)
  ].filter(Boolean).join('\n');
  if (ragData) {
    const activeChannels = [
      ragData.admissions ? `Admissions(${ragData.admissions.school_name})` : null,
      ragData.marketIntel ? `MarketIntel(${ragData.marketIntel.industry}: ${ragData.marketIntel.total_postings.toLocaleString()} jobs)` : null,
      ragData.salaryBench ? `Salaries(${ragData.salaryBench.role ? ragData.salaryBench.role.title : 'RIASEC'})` : null,
      ragData.livingCost ? `LivingCost(${ragData.livingCost.city})` : null,
      ragData.domainData ? `Domain(${ragData.domainData.name})` : null
    ].filter(Boolean);
    console.log(`[RAG Service] ✅ Activated channels: ${activeChannels.join(', ')}`);
  } else {
    console.log('[RAG Service] No specific entity match – using general AI grounding');
  }

  // ============================================================
  // PROMPT ĐÃ ĐƯỢC NÂNG CẤP CHO LOCAL MODEL (Ollama 7B)
  // Chiến lược: Inject ngữ cảnh sâu (giai đoạn + ngành + tools)
  // nhưng GIẢM kích thước JSON mẫu → Model tập trung sinh narrative
  // Backend tự tổng hợp SWOT/Sprint90/Resources/Timeline từ domain
  // ============================================================
  const buildOllamaPrompt = (d, rag) => {
    const ragSnippet = rag ? `\nDỮ LIỆU THỰC TẾ (RAG):\n${rag}\n` : '';
    // Pre-extract context for enrichment
    const ctxStudent = extractHolisticStudentContext(d);
    const ctxDomain = detectDomainProfile(`${d.decision || ''} ${d.otherFactors || ''}`);
    const ctxTools = ctxDomain.tools.slice(0, 3);
    const schoolStr = ctxStudent.targetSchool ? `Trường mục tiêu: ${ctxStudent.targetSchool}. ` : '';
    return `Bạn là Chuyên gia Cố vấn Chiến lược Học thuật & Sự nghiệp (Master Academic & Career Strategist) với 15 năm kinh nghiệm.
Nhiệm vụ: Phân tích sắc sảo và CÁ NHÂN HÓA quyết định của người học, đưa ra 3 kịch bản tương lai CHUYÊN SÂU, ĐẲNG CẤP.

BỐI CẢNH CHIẾN LƯỢC (BẮT BUỘC BÁM SÁT):
- Giai đoạn: ${ctxStudent.stageLabel}
- Ngành nghề: ${ctxDomain.name}
- Công cụ chuẩn ngành: ${ctxTools.join(', ')}
- ${schoolStr}Mục tiêu: ${d.decision}
- Hồ sơ: Học lực ${d.academicPerformance}/5 | Tài chính ${d.personalFinance}/5 | Áp lực ${d.stress}/5 | Rủi ro ${d.risk}/5
- Bổ sung: ${d.otherFactors || 'Không có'}${ragSnippet}

QUY TẮC NGHIÊM NGẶT:
1. Mỗi description PHẢI nhắc tên ngành (${ctxDomain.name}), công cụ chuyên ngành hoặc tên trường cụ thể. TUYỆT ĐỐI KHÔNG viết câu chung chung áp dụng cho mọi ngành.
2. Kịch bản phải phản ánh đúng giai đoạn: ${ctxStudent.stage === 'THPT_CHON_TO_HOP' ? 'Học sinh THPT Lớp 10-11: Chọn tổ hợp môn (KHTN/KHXH), xây dựng phương pháp học tập, giữ GPA học bạ xuất sắc. TUYỆT ĐỐI KHÔNG gợi ý đi làm, thực tập doanh nghiệp hay thi tốt nghiệp sớm.' :
        ctxStudent.stage === 'THPT_ON_THI_DAI_HOC' ? 'Học sinh THPT Lớp 12: Chiến lược ôn thi tốt nghiệp THPT/ĐGNL, điểm chuẩn tổ hợp xét tuyển sớm và đặt nguyện vọng trường ĐH an toàn 3 tầng. TUYỆT ĐỐI KHÔNG gợi ý thực tập hay viết CV xin việc.' :
          ctxStudent.stage === 'DU_HOC_QUOC_TE' ? 'Định hướng Du học & Học bổng: Luyện thi chứng chỉ quốc tế (IELTS/SAT/GRE), viết luận cá nhân (Statement of Purpose), hoạt động ngoại khóa leadership, chuẩn bị tài chính và săn học bổng.' :
            ctxStudent.stage === 'THAC_SI_NGHIEN_CUU' ? 'Định hướng Thạc sĩ & Nghiên cứu: Nghiên cứu khoa học chuyên sâu, tổng quan tài liệu (literature review), viết đề cương nghiên cứu (proposal), liên hệ giáo sư hướng dẫn và công bố bài báo khoa học.' :
              ctxStudent.stage === 'DAI_HOC_CHUYEN_NGANH_THUC_TAP' ? 'Sinh viên năm 3-4 chuyên ngành: Làm chủ công cụ chuyên ngành thực chiến (${ctxTools[0]}), đồ án môn học, hoàn thiện CV/Portfolio, thực tập doanh nghiệp và chuyển tiếp nhân viên chính thức.' :
                'Sinh viên năm 1-2 đại cương: Phương pháp học tín chỉ đại học, giữ GPA >= 3.2, rèn luyện ngoại ngữ chuẩn đầu ra và làm quen công cụ nền tảng.'
      }
3. criticalAdvice phải là lời khuyên CHUYÊN GIA sắc sảo, cụ thể cho ngành ${ctxDomain.name}. Không khuyên sáo rỗng.

Trả về DUY NHẤT JSON hợp lệ (KHÔNG markdown, KHÔNG text thừa):
{"summary":"50-60 từ, nhắc tên ngành + dữ liệu RAG","scenarios":[{"type":"Positive","description":"50-70 từ lộ trình bứt phá đúng ngành","criticalAdvice":"30-40 từ lời khuyên chuyên gia sắc sảo","marketAnalysis":"20-30 từ phân tích thị trường"},{"type":"Neutral","description":"50-70 từ lộ trình cân bằng","criticalAdvice":"30-40 từ","marketAnalysis":"20-30 từ"},{"type":"Risk","description":"50-70 từ quản trị rủi ro","criticalAdvice":"30-40 từ","marketAnalysis":"20-30 từ"}]}`;
  };

  // Prompt đầy đủ cho Gemini Cloud (có thể handle prompt dài)
  const buildGeminiPrompt = (d, rag) => {
    const ragBlock = rag ? `\n${rag}\n\nHƯỚNG DẪN: Tất cả con số về lương, tỉ lệ việc làm PHẢI dựa trên dữ liệu thực tế trên.` : '';
    return `Bạn là chuyên gia phân tích tương lai của hệ thống FutureTrace.

NHIỆM VỤ: Phân tích quyết định và giả lập 3 kịch bản tương lai (Tối ưu/Cân bằng/Rủi ro).

QUY TẮC:
- Nếu người dùng là người đi làm/doanh nghiệp → isEnterprise=true, summary ghi rõ "Hệ thống chỉ tối ưu cho học sinh 16-22 tuổi. Vui lòng nâng cấp lên bản doanh nghiệp."
- Nếu là học sinh/sinh viên → isEnterprise=false, phân tích đầy đủ 3 kịch bản.

DỮ LIỆU ĐẦU VÀO:
- Quyết định: ${d.decision}
- Học vấn: ${d.educationLevel || 'Học sinh/Sinh viên'} | Tâm trạng: ${d.mood || 'Bình thường'}
- Áp lực: ${d.stress}/5 | Tài chính: ${d.personalFinance}/5 | Học lực: ${d.academicPerformance}/5 | Rủi ro: ${d.risk}/5
- Tầm nhìn: ${d.timeHorizon || 5} năm | Địa điểm: ${d.location || 'Chưa rõ'}
- Giá trị cốt lõi: ${d.coreValues || 'Cân bằng'} | Yếu tố khác: ${d.otherFactors || 'Không có'}${ragBlock}

YÊU CẦU ĐẦU RA JSON (BẮT BUỘC):
- summary: 40-50 từ, giọng văn phù hợp tâm trạng, tích hợp số liệu thị trường.
- timeline: 4 mốc string (start/sixMonths/oneYear/threeYears), mỗi mốc 30-40 từ, hành động cụ thể theo học vấn, KHÔNG đưa số lương vào.
- scenarios: ĐÚNG 3 kịch bản (Positive/Neutral/Risk). Mỗi kịch bản:
  + title: tên gọi cụ thể (không dùng "Kịch bản tiềm năng")
  + type: chính xác "Positive" hoặc "Neutral" hoặc "Risk"
  + description: 50-80 từ, chi tiết, dựa trên dữ liệu thực tế.
  + careerGrowth/happiness/roi: số nguyên 0-100
  + deepAnalysis.swot: ĐÚNG 4 phần tử [{type:"S",label,value,color},{type:"W",...},{type:"O",...},{type:"T",...}], value 30-45 từ
  + deepAnalysis.resources: 3 phần tử [{label,value:number,unit,icon,ghostLabel}]
  + deepAnalysis.sprint90: 3 phần tử [{phase,tasks:[string,string,string]}]
  + deepAnalysis.criticalAdvice: lời khuyên quan trọng nhất.
  + marketFit: {score:number,analysis:string}

Viết tiếng Việt. Không viết lan man. Tuân thủ JSON.`;
  };

  const provider = getAiProvider();

  // 1. Try Local Fine-Tuned Ollama first if configured
  if (provider === 'ollama' || provider === 'hybrid') {
    try {
      const health = await checkOllamaHealth();
      if (health.online && health.hasModel) {
        console.log(`[AI Engine] 🚀 Using Local Fine-Tuned Model via Ollama: ${process.env.OLLAMA_MODEL || 'futuretrace-ai'}`);
        const ollamaPrompt = buildOllamaPrompt(cleanData, ragContext);
        const localSystemPrompt = `Bạn là Chuyên gia Cố vấn Chiến lược Học thuật & Sự nghiệp FutureTrace (Master Academic & Career Strategist).
Phong cách: Viết như chuyên gia 15 năm kinh nghiệm tư vấn hướng nghiệp — sắc sảo, thấu cảm, truyền cảm hứng.
Quy tắc vàng: Mỗi kịch bản PHẢI phản ánh rõ đặc thù ngành nghề (công cụ, tiêu chuẩn, thị trường cụ thể). TUYỆT ĐỐI KHÔNG viết câu chung chung áp dụng được cho mọi ngành.
Định dạng: Chỉ trả về JSON thuần túy bắt đầu bằng { và kết thúc bằng }. Không markdown, không giải thích.`;
        const narrativeScenario = {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['Positive', 'Neutral', 'Risk'] },
            description: { type: 'string' },
            criticalAdvice: { type: 'string' },
            marketAnalysis: { type: 'string' }
          },
          required: ['type', 'description', 'criticalAdvice', 'marketAnalysis']
        };
        const localRes = await generateWithOllama(ollamaPrompt, localSystemPrompt, {
          temperature: 0.35,
          maxTokens: 900,
          // Prompt + RAG ~1.300 token tiếng Việt; 2048 cũ khiến Ollama cắt mất phần đầu prompt
          numCtx: 4096,
          timeout: 180000,
          format: {
            type: 'object',
            properties: {
              summary: { type: 'string' },
              scenarios: { type: 'array', items: narrativeScenario, minItems: 3, maxItems: 3 }
            },
            required: ['summary', 'scenarios']
          }
        });
        const parsed = parseAndRepairJson(localRes.text);
        const normalized = normalizeSimulationResponse(parsed, { ...cleanData, ragData, quant });
    normalized.facts = factSheet.facts;
    normalized.program = factSheet.program;
        normalized.modelUsed = localRes.modelUsed;
        console.log(`[AI Engine] ✅ Local model success. Scenarios: ${normalized.scenarios?.length || 0}`);
        return normalized;
      } else if (provider === 'ollama') {
        throw new Error('Ollama Local Server chưa được bật hoặc chưa nạp model futuretrace-ai.');
      } else {
        console.log('[AI Engine] ⚡ Ollama Local is offline. Seamlessly falling back to Gemini Cloud API...');
      }
    } catch (ollamaErr) {
      console.warn('[AI Engine] Ollama Local generation failed, attempting fallback to Gemini:', ollamaErr.message);
      if (provider === 'ollama' && !process.env.GEMINI_API_KEYS && !process.env.GEMINI_API_KEY) throw ollamaErr;
    }
  }

  const prompt = buildGeminiPrompt(cleanData, ragContext);

  // 2. Cloud Fallback via Gemini AI
  try {
    const response = await callGeminiWithRetry(
      GEMINI_FALLBACK_MODELS,
      prompt,
      {
        responseMimeType: 'application/json',
        maxOutputTokens: 8192,
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            isEnterprise: { type: Type.BOOLEAN },
            summary: { type: Type.STRING },
            scenarios: {
              type: Type.ARRAY,
              description: "Mảng BẮT BUỘC chứa ĐÚNG 3 phần tử (Positive, Neutral, Risk). Không được thiếu.",
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  description: { type: Type.STRING },
                  careerGrowth: { type: Type.NUMBER },
                  happiness: { type: Type.NUMBER },
                  roi: { type: Type.NUMBER, description: "Tỷ suất hoàn vốn đầu tư dự kiến (ROI) sau đúng " + (data.timeHorizon || 5) + " năm" },
                  type: { type: Type.STRING, description: "Must be exactly 'Positive', 'Neutral', or 'Risk'" },
                  deepAnalysis: {
                    type: Type.OBJECT,
                    properties: {
                      swot: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            label: { type: Type.STRING },
                            value: { type: Type.STRING },
                            color: { type: Type.STRING },
                            type: { type: Type.STRING, description: "Must be exactly 'S', 'W', 'O', or 'T'" }
                          }
                        }
                      },
                      resources: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            label: { type: Type.STRING },
                            value: { type: Type.NUMBER },
                            unit: { type: Type.STRING },
                            icon: { type: Type.STRING },
                            ghostLabel: { type: Type.STRING }
                          }
                        }
                      },
                      sprint90: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            phase: { type: Type.STRING },
                            tasks: { type: Type.ARRAY, items: { type: Type.STRING } }
                          }
                        }
                      },
                      criticalAdvice: { type: Type.STRING }
                    }
                  },
                  marketFit: {
                    type: Type.OBJECT,
                    properties: {
                      score: { type: Type.NUMBER, description: "Score from 0 to 100 representing how well the market trend fits this user." },
                      analysis: { type: Type.STRING, description: "Detailed analysis comparing the user's capabilities, core values, and location with the market trend." }
                    },
                    required: ['score', 'analysis']
                  }
                },
                required: ['title', 'description', 'careerGrowth', 'happiness', 'roi', 'type', 'deepAnalysis', 'marketFit']
              }
            },
            timeline: {
              type: Type.OBJECT,
              properties: {
                start: { type: Type.STRING },
                sixMonths: { type: Type.STRING },
                oneYear: { type: Type.STRING },
                threeYears: { type: Type.STRING }
              },
              required: ['start', 'sixMonths', 'oneYear', 'threeYears']
            }
          },
          required: ['isEnterprise', 'summary', 'scenarios', 'timeline']
        }
      }
    );

    // Safe text extraction handling potential SDK variations
    let text = "";
    try {
      if (typeof response.text === 'string') {
        text = response.text.trim();
      } else if (typeof response.text === 'function') {
        text = response.text().trim();
      } else if (response.response && typeof response.response.text === 'function') {
        text = response.response.text().trim();
      } else if (response.candidates && response.candidates[0]?.content?.parts?.[0]?.text) {
        text = response.candidates[0].content.parts[0].text.trim();
      }
    } catch (e) {
      console.error('[AI Text Extraction Error]:', e);
    }

    if (!text) {
      console.error('[AI RESPONSE STRUCTURE ERROR]: Could not extract text. Keys:', Object.keys(response));
      throw new Error('AI không trả về nội dung văn bản. Vui lòng thử lại.');
    }

    const parsed = parseAndRepairJson(text, 'simulation');
    const normalized = normalizeSimulationResponse(parsed, { ...cleanData, ragData, quant });
    normalized.facts = factSheet.facts;
    normalized.program = factSheet.program;
    normalized.modelUsed = response.modelUsed;
    normalized.usage = response.usage;
    return normalized;
  } catch (error) {
    console.error('[AI Error Details - Simulation]:', error);
    throw error;
  }
}

/**
 * Kiem tra xem chuoi co phai la placeholder hoac loi nhac tu prompt khong
 */
const isEchoedPlaceholder = (str) => {
  if (!str || typeof str !== 'string') return true;
  const s = str.trim().toLowerCase();
  return (
    s === '--' ||
    s.length < 5 ||
    s.includes('tuong thuat chi tiet') ||
    s.includes('tường thuật chi tiết') ||
    s.includes('khong chung chung') ||
    s.includes('không chung chung') ||
    s.includes('ten cot moc') ||
    s.includes('tên cột mốc') ||
    s.includes('nhiem vu chinh') ||
    s.includes('nhiệm vụ chính') ||
    s.includes('nhiem vu trong tam') ||
    s.includes('nhiệm vụ trọng tâm') ||
    s.includes('nhiem vu 1') ||
    s.includes('nhiệm vụ 1') ||
    s.includes('nhiem vu 2') ||
    s.includes('nhiệm vụ 2') ||
    s.includes('nhiem vu 3') ||
    s.includes('nhiệm vụ 3') ||
    s.includes('mô tả cụ thể') ||
    s.includes('mo ta cu the') ||
    s.includes('thay tat ca noi dung') ||
    s.includes('thay tất cả nội dung') ||
    s.includes('vien canh 3-5 nam') ||
    s.includes('viễn cảnh 3-5 năm') ||
    s.includes('nhan to tu kho khan') ||
    s.includes('ten nhan to')
  );
};

/**
 * Tinh toan 5 moc giai doan thoi gian dong theo timeframe nguoi dung da chon (vd: 12, 24, 36, 48 thang)
 */
// 5 giai đoạn liền nhau phủ đủ 1..tf (bản cũ sinh "Tháng 1-1", và với khung 3 tháng còn ra "Tháng 4-4", "Tháng 5-3")
const computePeriodLabels = (timeframe = 12) => require('./premiumTimeline').planPeriods(timeframe, 5).map(p => p.label);

/**
 * Tao Master Narrative chi tiet, thau cam tam ly va gom day du cac moc thoi gian cho nguoi dung
 */
const generateMasterNarrative = (title, context, timeframe, rawMilestones = [], domain = null, student = null) => {
  const tf = parseInt(timeframe, 10) || 12;
  const [l1, l2, l3, l4, l5] = computePeriodLabels(tf);

  const std = student || extractHolisticStudentContext(context || {});
  const dom = domain || detectDomainProfile(`${context?.decision || ''} ${title || ''} ${context?.otherFactors || ''}`);

  const goal = std.primaryGoal || title || 'Phát triển Chuyên sâu';
  const toolsList = dom.tools && dom.tools.length > 0 ? dom.tools.slice(0, 3).join(', ') : 'công cụ chuyên môn';

  const stressContext = std.stress >= 4
    ? 'Trước áp lực tâm lý tương đối cao hiện tại, lộ trình được thiết kế với nhịp độ tăng dần có điểm nghỉ phục hồi năng lượng, tuyệt đối tránh hiện tượng kiệt sức (burnout).'
    : 'Với tâm lý ổn định và độ tập trung cao, lộ trình sẽ kích hoạt tối đa năng lực tự học và khả năng bứt phá thần tốc.';

  const financeContext = std.personalFinance <= 2
    ? 'Chiến lược tài chính thông minh được tích hợp xuyên suốt: ưu tiên các nguồn học liệu mở, săn học bổng trợ cấp và tối ưu hóa chi phí học tập.'
    : 'Nguồn lực tài chính sẵn sàng là đòn bẩy thuận lợi để bạn đầu tư vào các khóa đào tạo chuẩn quốc tế, chứng chỉ uy tín và công cụ làm việc chuyên nghiệp.';

  const mEvents = rawMilestones.map(m => m && (m.event || m.title)).filter(Boolean);
  const e1 = mEvents[0] ? ` Mục tiêu then chốt: ${mEvents[0]}.` : '';
  const e2 = mEvents[1] ? ` Trọng tâm chuyển hóa: ${mEvents[1]}.` : '';
  const e3 = mEvents[2] ? ` Thử thách đột phá: ${mEvents[2]}.` : '';
  const e4 = mEvents[3] ? ` Đấu trường thực tế: ${mEvents[3]}.` : '';
  const e5 = mEvents[4] ? ` Đích đến thắng lợi: ${mEvents[4]}.` : '';

  return [
    `Bản đồ Chiến lược & La bàn Chuyển hóa Cá nhân hướng tới mục tiêu "${goal}". Báo cáo phân tích chuyên sâu này được hội đồng chuyên gia cố vấn FutureTrace kiến tạo riêng cho bối cảnh học thuật của bạn (${std.stageLabel}). ${stressContext} ${financeContext} Toàn bộ hành trình ${tf} tháng được hiệu chuẩn chính xác thành 5 giai đoạn tiến hóa thực chất:`,
    `${l1}: Giai đoạn Khởi tạo Nền tảng & Tái cân bằng Tâm lý.${e1} Bước đầu tiên không phải là lao vào áp lực thi cử hay việc làm ngay lập tức, mà là thiết lập nhịp sinh học và phương pháp tư duy khoa học. Bạn sẽ hệ thống hóa toàn diện kiến thức cốt lõi ngành ${dom.name}, định vị các lỗ hổng kiến thức và thiết lập môi trường tự học kỷ luật (15-20h/tuần) với sự hỗ trợ của các công cụ quản trị tiến độ hiện đại.`,
    `${l2}: Giai đoạn Tăng tốc Thực chiến & Bứt phá Vượt ngưỡng.${e2} Đây là giai đoạn chuyển dịch từ hiểu biết lý thuyết sang năng lực thao tác thực tế. Bạn bắt tay vào thực hành chuyên sâu cùng các công cụ chuẩn ngành (${toolsList}), triển khai các bài tập tình huống hoặc dự án mô phỏng có độ khó tăng dần. Vượt qua sự trì hoãn và cảm giác hoài nghi bản thân bằng việc nghiệm thu sản phẩm thực tế mỗi tuần.`,
    `${l3}: Giai đoạn Tôi luyện Bản lĩnh & Chuẩn hóa Hồ sơ Đột phá.${e3} Áp lực cạnh tranh bắt đầu gia tăng đòi hỏi một tâm thế vững vàng. Bạn tập trung hoàn thiện sản phẩm dấu ấn cá nhân (portfolio / điểm số thi thử vượt ngưỡng / chứng chỉ chuyên môn uy tín), đồng thời tham vấn ý kiến từ Cố vấn chuyên môn để loại bỏ các điểm mù và tối ưu hóa giải pháp theo chuẩn mực cao nhất của ngành.`,
    `${l4}: Giai đoạn Thử lửa Đấu trường Thực tế & Nắm bắt Thời cơ.${e4} Đưa toàn bộ năng lực đã rèn giũa vào môi trường cạnh tranh khắt khe: tham gia kỳ thi chuẩn mực, nộp hồ sơ xét tuyển chiến lược hoặc ứng tuyển vào các vị trí thực tập / dự án tiềm năng. Kiểm soát tâm lý phòng thi / phỏng vấn bằng các bài tập thở điều hòa và chiến lược 3 tầng an toàn đã được tính toán kỹ.`,
    `${l5}: Bứt phá Đỉnh cao, Đóng gói Thành quả & Bước đệm Dài hạn.${e5} Nghiệm thu trọn vẹn lộ trình ${tf} tháng, tự tin bước vào cánh cửa mới với nền tảng chuyên môn vững như bàn thạch và phong thái đĩnh đạc của một nhân sự chất lượng cao. Bạn sở hữu cả năng lực nghề nghiệp thực chiến ngành ${dom.name} lẫn sức bền tâm lý để tiếp tục vươn tới các cột mốc 3-5 năm rực rỡ tiếp theo.`
  ].join('\n\n');
};

const generateFallbackNarrative = generateMasterNarrative;

/**
 * Kiến tạo Bản đồ Chiến lược & Tường thuật Tái cấu trúc (Pivot Re-Planning Master Narrative)
 * Chuẩn hóa 5 giai đoạn liên tục, thấu hiểu tâm lý, kết nối liền mạch các cột mốc đã hoàn thành
 * với phương án xử lý khủng hoảng cấp bách và tăng tốc về đích.
 */
const generatePivotMasterNarrative = ({
  currentReport,
  completedMilestones = [],
  feedback = '',
  feedbackHistory = [],
  context = {},
  timeframe = 12,
  remainingMilestones = [],
  domain,
  student
}) => {
  const std = student || extractHolisticStudentContext(context || {});
  const dom = domain || detectDomainProfile(`${context?.decision || ''} ${currentReport?.title || ''} ${context?.otherFactors || ''} ${feedback || ''}`);
  const goal = std.primaryGoal || currentReport?.title || 'Phát triển Toàn diện & Tái cấu trúc';
  const toolsList = dom.tools && dom.tools.length > 0 ? dom.tools.slice(0, 3).join(', ') : 'bộ công cụ chuyên môn';
  const completedCount = completedMilestones.length;

  const ALL_PERIODS = computePeriodLabels(timeframe);

  const stressInsight = std.stress >= 4
    ? 'Trước áp lực tâm lý và gánh nặng biến cố hiện tại, lộ trình được thiết kế với liệu pháp sơ cứu tâm lý, tuyệt đối tránh hoảng loạn hay kiệt sức (burnout).'
    : 'Với tinh thần chủ động và nghị lực kiên cường, bạn hoàn toàn có đủ nội lực để chuyển hóa biến cố này thành bệ phóng tiến bộ vượt bậc.';

  const financeInsight = std.personalFinance <= 2
    ? 'Giải pháp tài chính sinh viên khẩn cấp được ưu tiên kích hoạt: nộp đơn trợ cấp khó khăn, tận dụng học liệu mở và cân đối chi tiêu sinh hoạt an toàn.'
    : 'Nguồn lực tài chính cá nhân ổn định sẽ là điểm tựa vững chắc để bạn tập trung cao độ xử lý dứt điểm các vướng mắc học vụ.';

  const intro = `Bản đồ Chiến lược Tái Cấu Trúc Toàn Diện & La bàn Thích Ứng Khủng Hoảng (Pivot Re-Planning) hướng tới mục tiêu "${goal}". Hội đồng chuyên gia cố vấn FutureTrace đã phân tích toàn diện biến cố mới nhất của bạn: "${feedback}". ${stressInsight} ${financeInsight} Trong sự nghiệp và học thuật đỉnh cao, vấp ngã không phải là dấu chấm hết, mà là phép thử bắt buộc về "Bản lĩnh Phản Mong manh" (Antifragility). Toàn bộ lộ trình ${timeframe} tháng được tái hiệu chuẩn thành 5 giai đoạn chuyển dịch mạch lạc, bảo toàn thành quả đã đạt được và mở đường phục hồi vững chắc:`;

  const paragraphs = [intro];

  for (let i = 0; i < 5; i++) {
    const period = ALL_PERIODS[i] || `Giai đoạn ${i + 1}`;
    if (i < completedCount) {
      // Cột mốc đã hoàn thành: Giữ nguyên thành quả và công nhận nỗ lực
      const compM = completedMilestones[i] || {};
      const compEvent = compM.event || compM.title || 'Xây dựng nền móng và kỷ luật học tập';
      paragraphs.push(
        `${period} (Đã hoàn thành xuất sắc): Cột mốc "${compEvent}". Nền móng học thuật và thói quen kỷ luật bạn đã dày công tích lũy trong giai đoạn này là tài sản thực tế và được bảo toàn nguyên vẹn 100%. Đây chính là bệ đỡ tâm lý và kỹ thuật quan trọng nhất, giúp bạn không bị sụp đổ trước biến cố mà có điểm tựa vững vàng để tái tổ chức lại nguồn lực cá nhân.`
      );
    } else if (i === completedCount) {
      // Cột mốc khủng hoảng cấp bách ngay tại thời điểm pivot
      const nextM = remainingMilestones[i - completedCount] || {};
      const nextEvent = nextM.event || nextM.title || 'Tháo gỡ khó khăn cấp bách và ổn định học vụ';
      paragraphs.push(
        `${period}: Giai đoạn Ứng phó Khẩn cấp, Tháo gỡ Nút thắt & Bảo toàn Nhịp độ. Trọng tâm chiến lược: ${nextEvent}. Đối mặt trực diện với thách thức ("${feedback}"), phương án ứng phó được kích hoạt đồng thời trên 3 mặt trận: (1) Hành chính & Học vụ: nhanh chóng liên hệ Phòng Đào tạo / Cố vấn học tập để hoàn tất thủ tục xin học lại/thi lại hoặc gia hạn hỗ trợ tài chính; (2) Giữ nhịp Chuyên môn: không bỏ bẵng chuyên ngành, duy trì tối thiểu 3-5 giờ/tuần thực hành với ${toolsList} để giữ cảm giác kỹ năng; (3) Cấp cứu Tâm lý: loại bỏ cảm giác tội lỗi, thực hành thở Box Breathing và tham vấn Cố vấn để chặn đứng nguy cơ suy sụp tinh thần.`
      );
    } else if (i === completedCount + 1) {
      // Cột mốc phục hồi phong độ học thuật và ổn định ngân sách
      const recM = remainingMilestones[i - completedCount] || {};
      const recEvent = recM.event || recM.title || 'Phục hồi phong độ học thuật và chuẩn hóa đồ án';
      paragraphs.push(
        `${period}: Giai đoạn Phục hồi Phong độ, Trả nợ Môn học & Tái thiết Dòng tiền. Trọng tâm chiến lược: ${recEvent}. Sau khi cơn khủng hoảng ban đầu đã được kiểm soát, đây là thời điểm tổng lực phản công để lấy lại ưu thế: tập trung cao độ ôn luyện để thi lại/trả nợ môn với điểm số mục tiêu >= 7.5, ổn định ngân sách sinh hoạt cá nhân bằng các giải pháp tự chủ. Đồng thời, nâng cấp bài tập thực hành lên đồ án hoàn chỉnh ngành ${dom.name}, chuyển hóa bài học vấp ngã thành câu chuyện truyền cảm hứng trong hồ sơ năng lực.`
      );
    } else if (i === completedCount + 2) {
      // Cột mốc tăng tốc chuyên môn thực chiến
      const accM = remainingMilestones[i - completedCount] || {};
      const accEvent = accM.event || accM.title || 'Tăng tốc chuyên môn thực chiến và mở rộng năng lực';
      paragraphs.push(
        `${period}: Giai đoạn Tăng tốc Chuyên môn, Thử lửa Đấu trường & Bứt phá Giới hạn. Trọng tâm chiến lược: ${accEvent}. Khi mọi vướng mắc học vụ và tâm lý đã hoàn toàn lùi lại phía sau, bạn bước vào quỹ đạo tăng tốc mạnh mẽ nhất. Triển khai các bài toán thực tế chuẩn công nghiệp, làm chủ sâu sắc các công cụ tiên tiến (${toolsList}), và chủ động tham gia các kỳ thi sát hạch chứng chỉ hoặc dự án cộng đồng để khẳng định vị thế và bù đắp hoàn toàn độ trễ tiến độ trước đây.`
      );
    } else {
      // Cột mốc về đích đỉnh cao và tầm nhìn dài hạn
      const capM = remainingMilestones[i - completedCount] || {};
      const capEvent = capM.event || capM.title || 'Về đích toàn diện, đóng gói năng lực và tự tin bước ra thị trường';
      paragraphs.push(
        `${period}: Bứt phá Đỉnh cao, Đóng gói Thành quả & Khởi động Tầm nhìn Dài hạn. Trọng tâm chiến lược: ${capEvent}. Nghiệm thu toàn diện lộ trình chuyển dịch ${timeframe} tháng. Bạn không chỉ hoàn thành xuất sắc các chuẩn đầu ra học thuật ngành ${dom.name} mà còn xây dựng được năng lực phục hồi phi thường trước nghịch cảnh. Với một Portfolio sắc bén, mạng lưới cố vấn tin cậy và tâm thế vững như kiềng ba chân, bạn hoàn toàn sẵn sàng nắm bắt các cơ hội thực tập, việc làm chất lượng cao và tự tin chinh phục các cột mốc sự nghiệp 3-5 năm tiếp theo.`
      );
    }
  }

  return paragraphs.join('\n\n');
};

/**
 * 3-Tier Master Step Engine dành riêng cho Lộ trình Chuyển dịch (Pivot Re-Planning)
 * Tạo ra 3 bước chuyên sâu cho từng cột mốc sau biến cố:
 * - Bước 1: Chiến lược & Hành động khẩn cấp / Học vụ / Thi cử
 * - Bước 2: Thực hành chuyên môn & Bộ công cụ ngành chuẩn mực
 * - Bước 3: Tâm lý học kiên cường, Sơ cứu cảm xúc & Cố vấn đồng hành
 */
const createPivot3TierSteps = ({
  milestoneIdx,
  completedCount,
  period,
  eventTitle,
  advice = '',
  tasks = [],
  domain,
  student,
  feedback
}) => {
  const domName = domain?.name || 'Chuyên môn Công nghệ';
  const tools = domain?.tools && domain.tools.length > 0 ? domain.tools : ['Git / GitHub', 'Visual Studio Code', 'Notion'];

  // Case 1: Cột mốc khủng hoảng cấp bách ngay sau các mốc hoàn thành
  if (milestoneIdx === completedCount) {
    const step1Title = `Tháo gỡ Khủng hoảng Cấp bách, Xử lý Học vụ & Thiết lập Kế hoạch Bù đắp (${period})`;
    const step1Desc = `Tiếp nhận trực diện biến cố: "${feedback}". ${advice ? advice + '. ' : ''}Không né tránh hay tự trách bản thân; nhanh chóng liên hệ Phòng Đào tạo / Ban chủ nhiệm Khoa / Phòng CTSV để hoàn tất thủ tục xin học lại/thi lại hoặc gia hạn nghĩa vụ tài chính, đồng thời thiết lập thời gian biểu tự học 12-15 giờ/tuần giải quyết dứt điểm các lỗ hổng kiến thức.`;

    const step2Title = `Bảo tồn Năng lực Kỹ thuật Cốt lõi (${tools[0]}) & Mini-Project Giữ nhịp`;
    const step2Desc = `Trong giai đoạn biến cố, việc giữ vững đà tiến bộ chuyên môn ngành ${domName} là tối quan trọng để không bị gián đoạn tư duy kỹ thuật. Dành 3-5 giờ/tuần thực hành các bài toán hoặc mini-project trên bộ công cụ ${tools.slice(0, 2).join(', ')} để giữ cảm giác thao tác và nuôi dưỡng sự tự tin.`;

    const step3Title = `Sơ cứu Tâm lý Khủng hoảng, Xóa bỏ Mặc cảm Thất bại & Kiểm toán cùng Cố vấn`;
    const step3Desc = `Biến cố học tập hay áp lực tài chính thường kích hoạt hội chứng lo âu, tự ti và cảm giác tội lỗi trước kỳ vọng gia đình. Áp dụng kỹ thuật thở điều hòa Box Breathing, liệu pháp viết nhật ký phản tư (Reflective Journaling) để bóc tách âu lo, và tham gia phiên làm việc 1-on-1 cùng Cố vấn để tái cấu trúc niềm tin bản thân.`;

    return [
      {
        id: `step_${milestoneIdx + 1}_1`,
        title: step1Title,
        description: step1Desc,
        objectives: [
          `Hoàn tất 100% thủ tục học vụ/tài chính (đơn xin học lại/thi lại, đơn xin gia hạn học phí hoặc vay vốn sinh viên) trong 10-14 ngày đầu.`,
          `Khoanh vùng chính xác 100% lỗ hổng kiến thức cốt lõi dẫn đến kết quả chưa tốt và thiết lập thời gian biểu ôn tập chi tiết 12-15h/tuần.`,
          `Thiết lập ngân sách sinh hoạt khẩn cấp thắt lưng buộc bụng, cắt giảm các khoản chi tiêu không thiết yếu để giảm thiểu áp lực tài chính.`
        ],
        actions: [
          tasks[0] || `Làm việc trực tiếp với Cố vấn học tập (Academic Advisor) hoặc Phòng CTSV trong tuần đầu để nắm rõ quy chế và nộp đơn hỗ trợ.`,
          tasks[1] || `Thu thập lại toàn bộ bài giảng, đề cương và đề thi các năm trước; kết nối với nhóm học tập đồng đẳng để nhận tài liệu ôn thi môn bị trượt.`,
          `Lập bảng theo dõi thu chi trên Google Sheets và khóa các khung giờ tự học cố định (Time-boxing 2-3 tiếng/ngày) trên Google Calendar.`
        ],
        tools: [
          'Cổng thông tin Đào tạo & Phòng Công tác Sinh viên (CTSV)',
          'Google Calendar (Time-boxing lịch học bù 12-15h/tuần)',
          'Google Sheets (Quản lý ngân sách khẩn cấp)',
          'Giáo trình & Bộ đề thi các năm trước'
        ],
        expectedResult: `Được nhà trường phê duyệt kế hoạch học vụ/gia hạn tài chính; nắm chắc 100% đề cương ôn tập và loại bỏ hoàn toàn sự bị động.`,
        completed: false
      },
      {
        id: `step_${milestoneIdx + 1}_2`,
        title: step2Title,
        description: step2Desc,
        objectives: [
          `Duy trì tối thiểu 4 giờ/tuần thực hành kỹ năng chuyên ngành, không để biến cố làm đứt gãy đà tích lũy kiến thức thực chiến.`,
          `Xây dựng 1 sản phẩm thực hành nhỏ (mini-project / bài giải thuật toán / bản thiết kế kỹ thuật) hoàn chỉnh đạt chuẩn kiểm thử.`,
          `Lưu trữ toàn bộ mã nguồn / sản phẩm lên kho lưu trữ trực tuyến để tích lũy minh chứng năng lực cá nhân.`
        ],
        actions: [
          `Cố định 3 buổi/tuần (mỗi buổi 75-90 phút) dành trọn vẹn cho việc thực hành trên ${tools[0]}.`,
          `Triển khai các bài toán thực hành từ nguồn học liệu mở hoặc tài liệu chuyên ngành có độ khó vừa sức để củng cố tự tin.`,
          `Đẩy sản phẩm lên GitHub / Notion / Portfolio cá nhân và ghi chú rõ ràng các bài học kỹ thuật thu được.`
        ],
        tools: tools.slice(0, 3),
        expectedResult: `Một sản phẩm thực hành nhỏ hoàn chỉnh chạy ổn định, minh chứng năng lực chuyên môn không bị thụt lùi giữa biến cố.`,
        completed: false
      },
      {
        id: `step_${milestoneIdx + 1}_3`,
        title: step3Title,
        description: step3Desc,
        objectives: [
          `Kiểm soát mức độ lo âu và căng thẳng tinh thần từ mức báo động (>= 4/5) về mức cân bằng dưới 2.5/5.`,
          `Xóa bỏ hoàn toàn mặc cảm tự ti hay hội chứng kẻ giả mạo (Imposter Syndrome), xác lập tư duy kiên cường (Resilience Mindset).`,
          `Hoàn thành phiên làm việc 1-on-1 Milestone Review 45 phút cùng Cố vấn học thuật hoặc Mentor chuyên môn để thống nhất lộ trình phục hồi.`
        ],
        actions: [
          `Thực hành kỹ thuật thở Box Breathing (4-4-4-4) 10-15 phút mỗi ngày, đặc biệt trước khi học tập hoặc khi xuất hiện cảm giác âu lo.`,
          `Viết nhật ký phản tư (Reflective Journaling) vào cuối ngày: ghi nhận 3 nỗ lực nhỏ đã thực hiện và 1 cách nhìn tích cực về nghịch cảnh.`,
          `Chủ động kết nối và tham gia buổi tham vấn định hướng 1-on-1 với Cố vấn để nhận phản hồi thẳng thắn, đa chiều và sự nâng đỡ tinh thần.`
        ],
        tools: [
          'Kỹ thuật thở điều hòa Box Breathing / Headspace',
          'Nhật ký phản tư (Reflective Journaling / Notion Mindset)',
          'Phiên tham vấn 1-on-1 cùng Cố vấn Chuyên môn (Crisis Audit)',
          'Mạng lưới hỗ trợ bạn bè & người thân (Peer Support Circle)'
        ],
        expectedResult: `Tâm lý được giải tỏa toàn diện, lấy lại sự điềm tĩnh và quyết tâm sắt đá; có biên bản xác nhận kế hoạch phục hồi từ Cố vấn.`,
        completed: false
      }
    ];
  }

  // Case 2: Cột mốc phục hồi phong độ học thuật và ổn định ngân sách
  if (milestoneIdx === completedCount + 1) {
    const step1Title = `Chinh phục Kỳ thi Trả nợ Môn học (Mục tiêu >= 7.5) & Tự chủ Ngân sách Học tập`;
    const step1Desc = `Bước vào giai đoạn tổng lực ôn luyện và thi kết thúc môn với điểm số mục tiêu >= 7.5 để nâng điểm GPA tích lũy. Đồng thời, chủ động tìm kiếm cơ hội trợ giảng, gia sư hoặc học bổng hỗ trợ để ổn định dòng tiền cá nhân lâu dài.`;

    const step2Title = `Xây dựng Đồ án Thực chiến Chuyên sâu với ${tools.slice(0, 2).join(' & ')}`;
    const step2Desc = `Chuyển hóa toàn bộ năng lượng tích lũy sau thời gian ôn tập sang xây dựng một sản phẩm/đồ án thực chiến có độ phức tạp cao, tích hợp công nghệ chuẩn ngành (${tools.slice(0, 3).join(', ')}) để tạo bước đột phá trong Portfolio.`;

    const step3Title = `Tái tạo Thể chất, Nuôi dưỡng Sức bền Tinh thần & Đánh giá Cột mốc cùng Cố vấn`;
    const step3Desc = `Sau nỗ lực thi cử và làm đồ án căng thẳng, việc phục hồi thể lực và củng cố thói quen sinh hoạt khoa học là điều kiện tiên quyết để tránh tái kiệt sức. Lên lịch đánh giá cột mốc cùng Cố vấn để nhìn lại sự chuyển biến vượt bậc của bản thân.`;

    return [
      {
        id: `step_${milestoneIdx + 1}_1`,
        title: step1Title,
        description: step1Desc,
        objectives: [
          `Đạt điểm số >= 7.5 trong kỳ thi trả nợ môn hoặc kỳ đánh giá học phần bù đắp, xóa bỏ hoàn toàn nợ tín chỉ.`,
          `Duy trì GPA học kỳ hiện tại trên 3.0/4.0 (hoặc >= 7.5/10), lấy lại vị thế học thuật ổn định trong lớp/khoa.`,
          `Cân đối bền vững dòng tiền sinh hoạt cá nhân, tìm kiếm tối thiểu 1 nguồn trợ cấp hoặc công việc làm thêm linh hoạt liên quan đến chuyên môn.`
        ],
        actions: [
          tasks[0] || `Luyện giải tối thiểu 5 bộ đề thi các năm trước dưới áp lực thời gian thực, rà soát lại 100% các câu hỏi thường gặp lỗi.`,
          tasks[1] || `Thiết lập nhóm học tập 3-4 thành viên cùng mục tiêu thi cải thiện để kiểm tra chéo kiến thức định kỳ 2 lần/tuần.`,
          `Nộp hồ sơ xin các gói học bổng khuyến khích vượt khó của trường/doanh nghiệp hoặc nhận việc làm thêm hỗ trợ chuyên môn (10-12h/tuần).`
        ],
        tools: [
          'Bộ đề thi & Đáp án chuẩn các năm trước',
          'Notion Study Dashboard (Quản lý tiến độ luyện đề)',
          'Cổng thông tin Học bổng & Việc làm Sinh viên',
          'Kỹ thuật lặp lại ngắt quãng Anki / Flashcards'
        ],
        expectedResult: `Bảng điểm cập nhật với điểm số thi lại đạt >= 7.5; xóa bỏ hoàn toàn rủi ro cảnh báo học vụ; dòng tiền sinh hoạt được kiểm soát an toàn.`,
        completed: false
      },
      {
        id: `step_${milestoneIdx + 1}_2`,
        title: step2Title,
        description: step2Desc,
        objectives: [
          `Làm chủ kỹ năng thực hành nâng cao trên bộ công cụ: ${tools.slice(0, 2).join(', ')}.`,
          `Hoàn thành 1 đồ án thực nghiệm hoàn chỉnh (ứng dụng chuyên ngành / mô hình phân tích / giải pháp kỹ thuật) đạt chuẩn công nghiệp.`,
          `Đóng gói mã nguồn, viết tài liệu README chi tiết và công khai sản phẩm trên GitHub/Portfolio cá nhân.`
        ],
        actions: [
          `Phân tích yêu cầu và thiết kế kiến trúc cho đồ án cá nhân trong 2 tuần đầu tiên của giai đoạn.`,
          `Thực hiện lập trình / triển khai kỹ thuật đều đặn 10-12 giờ/tuần, áp dụng các tiêu chuẩn Clean Code, CI/CD và kiểm thử tự động.`,
          `Tự kiểm thử, khắc phục lỗi và xin ý kiến đánh giá từ các anh chị khóa trên hoặc kỹ sư đang làm việc trong ngành.`
        ],
        tools: tools.slice(0, 3),
        expectedResult: `Một sản phẩm thực tế hoàn chỉnh, có tài liệu minh chứng rõ ràng và đường dẫn demo hoạt động tốt, sẵn sàng đưa vào CV/Portfolio.`,
        completed: false
      },
      {
        id: `step_${milestoneIdx + 1}_3`,
        title: step3Title,
        description: step3Desc,
        objectives: [
          `Duy trì thói quen tập luyện thể chất 3 buổi/tuần (chạy bộ, bơi lội, thể dục tại nhà) để tăng cường sức bền thể lực và độ dẻo dai thần kinh.`,
          `Giữ nhịp sinh học ngủ trước 23:30 và thức dậy sảng khoái, không còn hiện tượng căng thẳng kéo dài ảnh hưởng đến sinh hoạt.`,
          `Hoàn thành phiên làm việc 1-on-1 Milestone Review 45 phút cùng Cố vấn để tổng kết kết quả thi cử và đồ án.`
        ],
        actions: [
          `Dành 25-30 phút mỗi ngày vào sáng sớm hoặc chiều muộn cho hoạt động thể thao giúp tái tạo dopamine tự nhiên.`,
          `Tổng kết lại hành trình phục hồi: ghi lại những bài học đắt giá về kỷ luật cá nhân và khả năng chịu áp lực vào sổ tay phát triển.`,
          `Gặp Cố vấn học thuật hoặc Mentor để trình bày sản phẩm đồ án và bảng điểm mới, nhận định hướng cho chặng đua tăng tốc tiếp theo.`
        ],
        tools: [
          'Ứng dụng theo dõi sức khỏe & Vận động thể chất (Strava / Apple Health)',
          'Nhật ký thành tựu cá nhân (Wins Journal)',
          'Phiên làm việc 1-on-1 Milestone Review cùng Cố vấn',
          'Bảng đánh giá KPI cá nhân'
        ],
        expectedResult: `Chỉ số sức khỏe thể chất và tinh thần đạt trạng thái dồi dào; nhận được sự công nhận và phê duyệt cột mốc từ Cố vấn.`,
        completed: false
      }
    ];
  }

  // Case 3: Cột mốc tăng tốc hoặc bứt phá đỉnh cao (idx 3 hoặc 4)
  if (milestoneIdx === 3) {
    const step1Title = `Tăng tốc Chuyên môn, Chinh phục Chứng chỉ Uy tín hoặc Kỳ thi Chuẩn ngành (${period})`;
    const step1Desc = `Khi nền tảng kiến thức và tâm lý đã hoàn toàn ổn định, bạn dồn toàn lực bứt phá: ôn luyện và chinh phục chứng chỉ nghề nghiệp uy tín hoặc tham gia kỳ thi chuyên môn cấp trường/quốc gia ngành ${domName} để tạo lợi thế vượt trội.`;

    const step2Title = `Chuẩn hóa Hồ sơ Năng lực (Portfolio) Đỉnh cao & Tối ưu hóa Sản phẩm Dấu ấn`;
    const step2Desc = `Đóng gói toàn bộ sản phẩm, đồ án và minh chứng kỹ năng vào một Portfolio chuyên nghiệp chuẩn công nghiệp. Tối ưu hóa mã nguồn, hiệu năng và giao diện người dùng để gây ấn tượng mạnh mẽ với nhà tuyển dụng.`;

    const step3Title = `Thử lửa Phỏng vấn Đấu trường Thực tế, Quản trị Căng thẳng & Mentor Audit`;
    const step3Desc = `Chủ động bước vào môi trường cạnh tranh khắt khe: tham gia các buổi phỏng vấn thử nghiệm (Mock Interview), nộp hồ sơ thực tập hoặc tham gia cuộc thi chuyên môn. Luyện tập kỹ năng làm chủ tâm lý trước hội đồng tuyển dụng.`;

    return [
      {
        id: `step_${milestoneIdx + 1}_1`,
        title: step1Title,
        description: step1Desc,
        objectives: [
          `Đạt chứng chỉ chuyên môn quốc tế hoặc hoàn thành 100% các tín chỉ chuyên ngành nâng cao với điểm trung bình >= 8.0.`,
          `Nắm vững các phương pháp luận và kỹ thuật nâng cao được ứng dụng rộng rãi trong các doanh nghiệp đầu ngành.`,
          `Mở rộng mạng lưới quan hệ học thuật và nghề nghiệp thông qua các hội thảo hoặc diễn đàn chuyên ngành.`
        ],
        actions: [
          tasks[0] || `Đăng ký lộ trình luyện thi chứng chỉ hoặc làm việc với giảng viên hướng dẫn về đề tài nghiên cứu/dự án doanh nghiệp.`,
          tasks[1] || `Thực hiện các bài test chuẩn hóa định kỳ hàng tuần, phân tích sâu các điểm yếu còn sót lại để tối ưu hóa kết quả.`,
          `Tham gia tối thiểu 1 buổi Workshop chuyên môn hoặc Meetup ngành để kết nối với các chuyên gia.`
        ],
        tools: [
          'Hệ thống luyện thi & Nền tảng học tập chuẩn quốc tế (Coursera / Udemy / LeetCode)',
          'Notion Workspace (Hệ thống hóa toàn bộ kiến thức chuyên ngành nâng cao)',
          'Cộng đồng chuyên môn LinkedIn / Discord / GitHub'
        ],
        expectedResult: `Sở hữu chứng chỉ chuyên môn uy tín hoặc bảng điểm chuyên ngành xuất sắc (>= 8.0), sẵn sàng bước vào thị trường việc làm.`,
        completed: false
      },
      {
        id: `step_${milestoneIdx + 1}_2`,
        title: step2Title,
        description: step2Desc,
        objectives: [
          `Hoàn thiện Portfolio cá nhân trực tuyến giới thiệu tối thiểu 3 dự án tiêu biểu có mã nguồn sạch và bản demo chạy thực tế.`,
          `Tối ưu hóa sản phẩm theo các tiêu chuẩn công nghiệp: bảo mật, tốc độ phản hồi, kiến trúc module hóa và tài liệu hóa chuẩn mực.`,
          `Nhận đánh giá và phản hồi tích cực từ ít nhất 2 chuyên gia hoặc kỹ sư cấp cao trong ngành.`
        ],
        actions: [
          `Thiết kế và triển khai trang Portfolio cá nhân, tích hợp các dự án thực tế kèm đường dẫn live demo.`,
          `Tái cấu trúc mã nguồn (Refactoring), viết kiểm thử tự động (Unit Tests) và hoàn thiện tài liệu hướng dẫn sử dụng (Documentation).`,
          `Gửi Portfolio cho Mentor hoặc người đi trước xin góp ý phản biện để nâng cao tính chuyên nghiệp.`
        ],
        tools: tools.slice(0, 3),
        expectedResult: `Trang Portfolio chuyên nghiệp được triển khai trực tuyến, thể hiện trọn vẹn năng lực thực chiến và phong cách làm việc chuẩn mực.`,
        completed: false
      },
      {
        id: `step_${milestoneIdx + 1}_3`,
        title: step3Title,
        description: step3Desc,
        objectives: [
          `Tham gia tối thiểu 2 buổi phỏng vấn thử nghiệm (Mock Interview) về chuyên môn và kỹ năng mềm với chuyên gia.`,
          `Làm chủ tâm lý phòng phỏng vấn, kiểm soát nhịp tim và giao tiếp tự tin, thuyết phục dưới áp lực cao.`,
          `Nghiệm thu toàn diện các chỉ tiêu của giai đoạn ${period} cùng Cố vấn học thuật.`
        ],
        actions: [
          `Soạn thảo ngân hàng 30 câu hỏi phỏng vấn kỹ thuật và tình huống thường gặp trong ngành ${domName} và luyện tập trả lời theo phương pháp STAR.`,
          `Thực hành phỏng vấn trực tiếp cùng bạn học hoặc Mentor, ghi hình lại để phân tích ngôn ngữ cơ thể và ngữ điệu.`,
          `Lên lịch và tham gia phiên làm việc 1-on-1 Milestone Audit 45 phút cùng Cố vấn để nhận xét đánh giá tổng quan.`
        ],
        tools: [
          'Khung phỏng vấn hành vi STAR Method',
          'Phần mềm ghi hình & Phân tích Mock Interview',
          'Phiên làm việc 1-on-1 Milestone Review cùng Cố vấn',
          'CV & Hồ sơ ứng tuyển chuẩn quốc tế'
        ],
        expectedResult: `Kỹ năng phỏng vấn đạt độ nhuần nhuyễn cao; nhận được đánh giá 'Sẵn sàng tuyển dụng' (Job-Ready) từ Cố vấn chuyên môn.`,
        completed: false
      }
    ];
  }

  // Case 4: Cột mốc về đích đỉnh cao (milestoneIdx === 4 hoặc còn lại)
  const step1Title = `Bứt phá Đỉnh cao, Đóng gói Thành quả Khóa luận / Đồ án Tốt nghiệp Xuất sắc`;
  const step1Desc = `Nghiệm thu trọn vẹn lộ trình chuyển dịch 12 tháng. Tập trung hoàn thành xuất sắc đồ án tốt nghiệp, khóa luận hoặc đề án nghiên cứu ứng dụng với điểm số bảo vệ cao nhất.`;

  const step2Title = `Hoàn thiện Bộ Hồ sơ Ứng tuyển Chuyên nghiệp & Định vị Thương hiệu Cá nhân Ngành ${domName}`;
  const step2Desc = `Đồng bộ hóa toàn bộ kênh hiện diện nghề nghiệp (LinkedIn, GitHub, Portfolio) với phong thái của một nhân sự chất lượng cao. Nộp hồ sơ vào các vị trí công việc hoặc chương trình đào tạo sau đại học mục tiêu.`;

  const step3Title = `Nghiệm thu Toàn diện Lộ trình Chuyển dịch, Đúc kết Bản lĩnh Vượt khó & Hoạch định Tầm nhìn 3-5 năm`;
  const step3Desc = `Buổi làm việc cuối cùng cùng Cố vấn chuyên môn để tổng kết toàn bộ hành trình chuyển hóa: từ lúc vấp ngã, đối mặt biến cố đến khi bứt phá về đích rực rỡ. Đúc kết bài học về "Bản lĩnh Phản Mong manh" và lập kế hoạch 3-5 năm tiếp theo.`;

  return [
    {
      id: `step_${milestoneIdx + 1}_1`,
      title: step1Title,
      description: step1Desc,
      objectives: [
        `Bảo vệ thành công đồ án tốt nghiệp hoặc dự án Capstone với điểm số xuất sắc (>= 8.5/10 hoặc tương đương A/A+).`,
        `Đóng gói sản phẩm hoàn chỉnh có thể ứng dụng trực tiếp hoặc chuyển giao vào thực tế sản xuất/kinh doanh.`,
        `Hoàn tất mọi thủ tục tốt nghiệp hoặc chuyển giao công việc với đánh giá cao từ nhà trường và doanh nghiệp đối tác.`
      ],
      actions: [
        tasks[0] || `Tập trung hoàn thiện bản báo cáo đồ án, slide thuyết trình và chuẩn bị kịch bản demo sản phẩm trước hội đồng.`,
        tasks[1] || `Tổ chức buổi báo cáo thử nghiệm trước bạn bè và thầy cô hướng dẫn để dự liệu các câu hỏi phản biện hóc búa.`,
        `Thực hiện bảo vệ chính thức với phong thái đĩnh đạc, tự tin và lập luận logic chặt chẽ.`
      ],
      tools: [
        'Bộ công cụ thuyết trình chuyên nghiệp (Keynote / Canva / LaTeX)',
        'Báo cáo khoa học & Tài liệu nghiệm thu Capstone',
        'Hệ thống demo trực tiếp sản phẩm'
      ],
      expectedResult: `Biên bản bảo vệ đồ án với điểm số xuất sắc (A/A+); sự công nhận từ Hội đồng đánh giá chuyên môn.`,
      completed: false
    },
    {
      id: `step_${milestoneIdx + 1}_2`,
      title: step2Title,
      description: step2Desc,
      objectives: [
        `Chuẩn hóa 100% hồ sơ ứng tuyển: CV ATS-friendly, Cover Letter cá nhân hóa, Portfolio trực tuyến cập nhật mới nhất.`,
        `Kết nối với tối thiểu 10 nhà tuyển dụng, chuyên gia săn đầu người (Headhunter) hoặc cựu sinh viên thành đạt trong ngành.`,
        `Nhận tối thiểu 2-3 lời mời phỏng vấn hoặc đề nghị hợp tác/tuyển dụng chính thức từ các tổ chức uy tín.`
      ],
      actions: [
        `Tối ưu hóa từ khóa chuyên ngành trên hồ sơ LinkedIn và CV để đạt điểm tương thích cao nhất trên hệ thống ATS.`,
        `Chủ động gửi email ứng tuyển trực tiếp đến các vị trí mơ ước kèm Portfolio và câu chuyện vượt khó đầy thuyết phục.`,
        `Theo dõi và phản hồi chuyên nghiệp các lời mời phỏng vấn và cơ hội việc làm.`
      ],
      tools: [
        'LinkedIn Professional Profile',
        'GitHub Profile README & Pinned Projects',
        'Hệ thống kiểm tra ATS Resume (Jobscan / Resume Worded)',
        'Mạng lưới cựu sinh viên (Alumni Network)'
      ],
      expectedResult: `Nhận được các offer tuyển dụng hoặc học bổng chất lượng cao đúng định hướng mục tiêu.`
      , completed: false
    },
    {
      id: `step_${milestoneIdx + 1}_3`,
      title: step3Title,
      description: step3Desc,
      objectives: [
        `Tổng kết toàn diện 100% các cột mốc đã vượt qua, đo lường sự tăng trưởng vượt bậc về chuyên môn và tâm lý.`,
        `Xác lập bản đồ sự nghiệp 3-5 năm tiếp theo với các mục tiêu thăng tiến rõ ràng và kế hoạch học tập suốt đời.`,
        `Hoàn thành buổi tham vấn tổng kết vinh danh cùng Cố vấn cao cấp FutureTrace.`
      ],
      actions: [
        `Viết bài luận tổng kết hành trình chuyển hóa cá nhân (The Turnaround Journey): bài học lãnh đạo bản thân và thích ứng nghịch cảnh.`,
        `Xây dựng kế hoạch tài chính và phát triển nghề nghiệp cho chu kỳ 3 năm đầu tiên đi làm.`,
        `Tham gia phiên tổng kết vinh danh cùng Cố vấn, nhận chứng nhận hoàn thành Lộ trình Tinh hoa FutureTrace.`
      ],
      tools: [
        'Bản đồ sự nghiệp dài hạn (Career Vision Board 3-5 Years)',
        'Bảng cân đối tài chính cá nhân dài hạn',
        'Phiên làm việc tổng kết vinh danh cùng Cố vấn Cao cấp'
      ],
      expectedResult: `Bản kế hoạch 3-5 năm hoàn chỉnh; tâm thế tự tin, vững chãi của một chuyên gia thực chiến sẵn sàng làm chủ tương lai.`,
      completed: false
    }
  ];
};

/**
 * He thong Milestone Templates theo tung giai doan hoc thuat va chuyen mon
 */
const getStageMilestoneTemplates = (std, dom, tf) => {
  const mLabels = computePeriodLabels(tf);

  if (std.stage === 'THPT_ON_THI_DAI_HOC') {
    return [
      {
        month: mLabels[0],
        event: 'Hệ thống hóa toàn bộ kiến thức lớp 11-12 & Lấp lỗ hổng chuyên đề',
        impact: 'High',
        probability: 90,
        advice: 'Tập trung chắc chắn 100% câu hỏi lý thuyết căn bản (8 điểm đầu), tuyệt đối không để mất điểm oan.',
        kpi: 'Điểm kiểm tra thử nghiệm 3 môn tổ hợp đạt >= 25.0 điểm; lấp đầy 100% các lỗ hổng lý thuyết.',
        step1Title: 'Lập ma trận ôn tập 3 môn tổ hợp & Thiết lập thời gian biểu tự học 20-25h/tuần',
        step1Desc: 'Phân tích ma trận cấu trúc đề thi chính thức, lên lịch cố định mỗi tối cho từng môn, chia theo chu kỳ học sâu 50 phút và ghi nhật ký theo dõi tiến độ.',
        step2Title: 'Luyện chuyên đề phân loại & Rèn kỹ năng bấm máy tính giải nhanh',
        step2Desc: 'Thực hành trên các chuyên đề nâng cao, áp dụng các kỹ thuật tính toán tối ưu và ghi chép bảng lỗi sai để tránh lặp lại bẫy đề thi.',
        step3Title: 'Quản trị áp lực phòng thi, Box Breathing & Đánh giá tiến độ cùng Cố vấn',
        step3Desc: 'Thực hành kỹ thuật thở điều hòa Box Breathing để làm dịu thần kinh, cân bằng dinh dưỡng giấc ngủ và định kỳ tham vấn Cố vấn ôn thi để điều chỉnh trọng tâm.'
      },
      {
        month: mLabels[1],
        event: 'Tăng tốc luyện giải đề thi chuẩn cấu trúc bấm giờ thực tế',
        impact: 'High',
        probability: 85,
        advice: 'Mỗi tuần giải từ 3-4 đề chuẩn cấu trúc có bấm giờ như thi thật; phân tích sâu nguyên nhân mỗi câu sai.',
        kpi: 'Điểm trung bình các đề thi thử đạt >= 26.5 điểm; tốc độ làm 35 câu đầu dưới 30 phút.',
        step1Title: 'Luyện giải tối thiểu 20 đề chuẩn có bấm giờ nghiêm ngặt',
        step1Desc: 'Thiết lập không gian thi thử tĩnh lặng, bấm giờ đúng thời gian quy định, rèn luyện thói quen tô phiếu trắc nghiệm chuẩn xác.',
        step2Title: 'Phân tích bảng lỗi sai (Error Log) & Xử lý câu hỏi vận dụng cao 9+',
        step2Desc: 'Mổ xẻ từng câu hỏi bị trừ điểm, phân loại thành: sai lý thuyết, sai tính toán hay bẫy đề bài; tập trung chinh phục các dạng bài phân hóa điểm 9+.',
        step3Title: 'Cân bằng áp lực học tập, Chống quá tải & Kiểm toán sức bền cùng Cố vấn',
        step3Desc: 'Giải phóng căng thẳng thi cử, tham gia các buổi trao đổi cùng Cố vấn học tập để nhận định khách quan về phong độ và loại bỏ âu lo.'
      },
      {
        month: mLabels[2],
        event: 'Chuẩn hóa tâm lý phòng thi & Chốt chiến lược xét tuyển 3 tầng an toàn',
        impact: 'High',
        probability: 80,
        advice: 'Đặt nguyện vọng thông minh theo quy tắc: 1 nguyện vọng ước mơ, 2 nguyện vọng vừa sức, 2 nguyện vọng an toàn chắc chắn đỗ.',
        kpi: 'Điểm thi thử đạt ngưỡng 27.5+; hoàn tất 100% hồ sơ xét tuyển sớm và chốt danh sách NV an toàn.',
        step1Title: 'Thiết lập danh mục nguyện vọng thông minh theo chiến lược 3 tầng an toàn',
        step1Desc: 'Nghiên cứu phổ điểm và chỉ tiêu từng phương thức xét tuyển, sắp xếp thứ tự nguyện vọng tối ưu hóa cơ hội trúng tuyển vào trường mục tiêu.',
        step2Title: 'Rà soát tổng lực ngân hàng đề phân loại & Hoàn thiện hồ sơ xét tuyển',
        step2Desc: 'Tổng ôn các chuyên đề trọng yếu, làm bài thi thử đợt cuối cùng của các trường chuyên uy tín và nộp đầy đủ hồ sơ xét tuyển sớm.',
        step3Title: 'Thiết lập nhịp sinh học thi cử & Tham vấn tâm lý tự tin phòng thi',
        step3Desc: 'Điều chỉnh đồng hồ sinh học trùng với giờ thi chính thức, thực hành hình dung tích cực (Visualization) và kiểm tra sức khỏe tổng quát.'
      },
      {
        month: mLabels[3],
        event: 'Bứt phá kỳ thi chính thức & Trúng tuyển xuất sắc vào ngành mục tiêu',
        impact: 'High',
        probability: 85,
        advice: 'Vào phòng thi với tâm thế bình tĩnh, làm chắc câu dễ, đọc kỹ đề câu khó và tự tin vào sự chuẩn bị của bản thân.',
        kpi: 'Điểm số chính thức đạt ngưỡng trúng tuyển NV1; hoàn tất xác nhận nhập học trực tuyến đúng hạn.',
        step1Title: 'Thực hiện kỳ thi với tâm thế điềm tĩnh, tối đa hóa điểm số từng môn',
        step1Desc: 'Phân bổ thời gian thi chuẩn xác: dành 10 phút kiểm tra lại toàn bộ bài làm, đảm bảo không bỏ sót bất kỳ câu hỏi nào.',
        step2Title: 'Rà soát điểm chuẩn, xác nhận nguyện vọng & Chuẩn bị thủ tục nhập học',
        step2Desc: 'Đối chiếu đáp án chính thức, theo dõi biến động điểm chuẩn và tiến hành thủ tục xác nhận nhập học trực tuyến theo đúng hạn Bộ GD&ĐT.',
        step3Title: 'Phục hồi năng lượng sau mùa thi, Tự hào thành quả & Định vị tâm thế Tân sinh viên',
        step3Desc: 'Nghỉ ngơi tái tạo năng lượng, ghi nhận nỗ lực vượt bậc của bản thân và chuẩn bị tâm lý tự lập trước ngưỡng cửa cuộc sống mới.'
      },
      {
        month: mLabels[4],
        event: 'Thích ứng môi trường đại học, làm quen chuyên ngành & Giữ vững phong độ',
        impact: 'High',
        probability: 85,
        advice: 'Tham gia các câu lạc bộ học thuật chuyên ngành ngay từ đầu kỳ, thiết lập nhóm bạn cùng tiến và duy trì GPA loại Giỏi.',
        kpi: 'Điểm GPA học kỳ đầu tiên đạt >= 3.2/4.0; làm chủ các công cụ học thuật cơ sở và hòa nhập xuất sắc.',
        step1Title: 'Thiết lập thời gian biểu tự học đại học & Kỷ luật quản lý tài chính cá nhân',
        step1Desc: 'Xây dựng kế hoạch học tập tín chỉ, phân bổ chi tiêu sinh hoạt khoa học và làm chủ phương pháp tự nghiên cứu giáo trình.',
        step2Title: `Tiếp cận công cụ và thuật ngữ chuyên ngành cốt lõi (${dom.tools[0] || 'học liệu chuyên ngành'})`,
        step2Desc: 'Làm quen các môn khoa học cơ sở, khai thác thư viện số và thực hành các bài tập môn học đầu tiên đúng chuẩn phương pháp.',
        step3Title: 'Kết nối mạng lưới Mentor học thuật, Giữ gìn sức khỏe & Hoạch định năm 2',
        step3Desc: 'Tham gia hội đồng hương hoặc CLB học thuật, định kỳ tham vấn các anh chị khóa trên để chuẩn bị định hướng học tập cho các năm tiếp theo.'
      }
    ];
  }

  if (std.stage === 'THPT_CHON_TO_HOP') {
    return [
      {
        month: mLabels[0],
        event: 'Đánh giá năng lực tự nhiên/xã hội & Chốt tổ hợp môn học tối ưu',
        impact: 'High',
        probability: 90,
        advice: 'Chọn tổ hợp dựa trên sự giao thoa giữa sở thích đam mê, năng lực học tập thực tế và phổ ngành đại học rộng mở.',
        kpi: 'Xác định chính xác tổ hợp môn KHTN hoặc KHXH với sự đồng thuận 100% từ gia đình và thầy cô.',
        step1Title: 'Làm bài test đánh giá năng lực học tập & Ma trận sở thích nghề nghiệp',
        step1Desc: 'Đánh giá điểm số các môn học lớp 9-10, tham khảo ý kiến giáo viên chủ nhiệm và chuyên gia tư vấn hướng nghiệp.',
        step2Title: `Khảo sát yêu cầu tuyển sinh của các trường đại học đào tạo ngành ${dom.name}`,
        step2Desc: 'Lập bảng thống kê các khối thi xét tuyển của ngành mục tiêu để đảm bảo tổ hợp lựa chọn mở ra nhiều cánh cửa nhất.',
        step3Title: 'Trao đổi định hướng cùng phụ huynh & Thiết lập tâm thế tự giác',
        step3Desc: 'Thảo luận cởi mở với bố mẹ về nguyện vọng cá nhân, giải tỏa các kỳ vọng áp đặt và xây dựng cam kết học tập nghiêm túc.'
      },
      {
        month: mLabels[1],
        event: 'Thiết lập phương pháp tự học sâu chương trình mới & Rèn kỷ luật',
        impact: 'High',
        probability: 85,
        advice: 'Chương trình THPT mới đòi hỏi tư duy phản biện và năng lực tự học cao hơn nhiều so với việc học vẹt.',
        kpi: 'Thời lượng tự học đạt 15h/tuần; 100% bài kiểm tra định kỳ các môn tổ hợp đạt >= 8.0/10.',
        step1Title: 'Xây dựng thời gian biểu tự học cố định và phương pháp ghi chép Cornell',
        step1Desc: 'Áp dụng phương pháp ghi chú khoa học, đọc trước sách giáo khoa trước khi đến lớp và ôn tập kiến thức trong vòng 24h.',
        step2Title: 'Làm bài tập thực hành ứng dụng & Giải quyết các câu hỏi mở',
        step2Desc: 'Chủ động tìm kiếm tài liệu nâng cao, làm quen với các dạng câu hỏi tình huống thực tiễn của các môn trong tổ hợp.',
        step3Title: 'Cân bằng học tập và rèn luyện thể chất, Tránh áp lực thành tích',
        step3Desc: 'Tham gia hoạt động thể thao trường lớp, giữ tinh thần hào hứng với môn học và xây dựng nhóm học tập tương trợ.'
      },
      {
        month: mLabels[2],
        event: 'Bứt phá điểm kiểm tra định kỳ & Nâng cao năng lực ngoại ngữ',
        impact: 'High',
        probability: 80,
        advice: 'Tiếng Anh là chìa khóa xét tuyển sớm cực kỳ quyền lực; đầu tư ngoại ngữ từ lớp 10-11 sẽ giảm 50% áp lực lớp 12.',
        kpi: 'Điểm trung bình học kỳ đạt loại Xuất sắc (>= 8.5); tích lũy nền tảng từ vựng tương đương IELTS 5.5-6.0.',
        step1Title: 'Lập kế hoạch rèn luyện ngoại ngữ hàng ngày (Nghe - Đọc - Từ vựng)',
        step1Desc: 'Dành 45 phút mỗi ngày nghe podcast và luyện đọc báo chuyên ngành tiếng Anh để tích lũy vốn từ học thuật.',
        step2Title: 'Tập trung bứt phá điểm thi giữa kỳ và cuối kỳ các môn trọng tâm',
        step2Desc: 'Rà soát kỹ các kiến thức còn mơ hồ, nhờ thầy cô giải đáp ngay để bảo đảm học bạ THPT có điểm tổng kết tối ưu.',
        step3Title: 'Quản trị thời gian biểu khoa học & Tham vấn Cố vấn học tập',
        step3Desc: 'Đánh giá lại hiệu quả học tập nửa chặng đường, chia sẻ khó khăn với thầy cô cố vấn để tinh chỉnh phương pháp.'
      },
      {
        month: mLabels[3],
        event: 'Trải nghiệm hướng nghiệp thực tế & Tham gia dự án học thuật hè',
        impact: 'Medium',
        probability: 85,
        advice: 'Kỳ nghỉ hè là thời điểm vàng để tham quan các trường đại học, trò chuyện với chuyên gia trong ngành để nuôi dưỡng ước mơ.',
        kpi: 'Hoàn thành 1 dự án cá nhân hoặc tham gia 1 hoạt động ngoại khóa có chứng nhận liên quan tới lĩnh vực mục tiêu.',
        step1Title: 'Tham gia ngày hội Open Day hoặc xưởng trải nghiệm của các trường đại học',
        step1Desc: 'Trực tiếp đến tham quan cơ sở vật chất các trường đại học, gặp gỡ sinh viên ngành mục tiêu để hiểu rõ môi trường học.',
        step2Title: `Xây dựng dự án học thuật nhỏ hoặc bài thu hoạch về lĩnh vực ${dom.name}`,
        step2Desc: 'Tìm hiểu sâu về một chủ đề trong ngành, chuẩn bị bài trình bày hoặc sản phẩm sáng tạo đưa vào hồ sơ ngoại khóa.',
        step3Title: 'Tái tạo năng lượng hè, Rèn luyện kỹ năng mềm & Đọc sách khai phóng',
        step3Desc: 'Dành thời gian cho sở thích cá nhân, rèn luyện kỹ năng giao tiếp thuyết trình và phát triển tư duy phản biện.'
      },
      {
        month: mLabels[4],
        event: 'Khẳng định kết quả học tập xuất sắc & Định vị lộ trình thi cử lớp 12',
        impact: 'High',
        probability: 90,
        advice: 'Bước sang năm học mới với mục tiêu rõ ràng và một tâm thế chủ động đón đầu các kỳ thi đánh giá năng lực.',
        kpi: 'GPA cả năm đạt >= 8.5; vạch sẵn danh sách 3 trường đại học và các phương thức xét tuyển mục tiêu.',
        step1Title: 'Tổng kết kết quả năm học, nghiệm thu điểm học bạ và các chứng chỉ',
        step1Desc: 'Rà soát lại toàn bộ hồ sơ điểm số, bổ sung các điểm còn thiếu sót và đặt mục tiêu cụ thể cho năm học bản lề tiếp theo.',
        step2Title: 'Lên kế hoạch ôn tập sớm cho kỳ thi Đánh giá năng lực (ĐGNL/ĐGTD)',
        step2Desc: 'Tiếp cận cấu trúc đề thi đánh giá tư duy và đánh giá năng lực của các đại học lớn để luyện tập tư duy logic.',
        step3Title: 'Phiên tham vấn hướng nghiệp chuyên sâu cùng Chuyên gia FutureTrace',
        step3Desc: 'Định hình chiến lược đường dài, củng cố sự tự tin và xác định tâm thế sẵn sàng cho các kỳ thi quyết định phía trước.'
      }
    ];
  }

  if (std.stage === 'DU_HOC_QUOC_TE') {
    return [
      {
        month: mLabels[0],
        event: 'Bứt phá chứng chỉ ngoại ngữ chuẩn hóa (IELTS/SAT) & Định vị trường',
        impact: 'High',
        probability: 90,
        advice: 'Điểm thi chuẩn hóa là điều kiện tiên quyết mở khóa các gói học bổng danh giá; tập trung ôn luyện cường độ cao.',
        kpi: 'Đạt điểm mục tiêu IELTS 7.0+ / SAT 1400+; chọn lọc danh sách 8 trường mục tiêu (Dream, Match, Safety).',
        step1Title: 'Luyện thi chứng chỉ quốc tế theo lộ trình cá nhân hóa 20h/tuần',
        step1Desc: 'Tập trung vào kỹ năng Viết và Nói, giải đề thi chuẩn hàng tuần và nhận phản hồi chi tiết từ giáo viên bản ngữ.',
        step2Title: 'Khảo sát quỹ học bổng, chi phí và tiêu chuẩn tuyển sinh các trường',
        step2Desc: 'Lập bảng tính chi tiết so sánh học phí, sinh hoạt phí và mức hỗ trợ tài chính giữa các trường đại học mục tiêu.',
        step3Title: 'Kiểm soát áp lực luyện thi, Cân bằng cảm xúc & Tham vấn gia đình',
        step3Desc: 'Thống nhất phương án tài chính với phụ huynh, thực hành thở giải tỏa căng thẳng trước các bài thi thử áp lực.'
      },
      {
        month: mLabels[1],
        event: 'Xây dựng bài luận cá nhân (SOP/Personal Statement) độc bản & Thư giới thiệu',
        impact: 'High',
        probability: 85,
        advice: 'Bài luận xuất sắc là bài luận kể được câu chuyện độc nhất của bạn, thể hiện rõ góc nhìn phản biện và khát vọng cống hiến.',
        kpi: 'Hoàn thiện 100% bản thảo bài luận chính sau tối thiểu 4 vòng hiệu đính; nhận đủ 2-3 thư giới thiệu uy tín.',
        step1Title: 'Khai mở câu chuyện độc bản và phác thảo đề cương bài luận',
        step1Desc: 'Tìm kiếm điểm giao thoa giữa trải nghiệm cá nhân, thử thách đã vượt qua và lý do lựa chọn ngành nghề tương lai.',
        step2Title: 'Hiệu đính bài luận cùng Mentor và kết nối thầy cô xin Thư giới thiệu',
        step2Desc: 'Làm việc cùng Cố vấn du học để mài giũa từng câu chữ, gửi tóm tắt thành tích cho thầy cô để nhận thư giới thiệu chân thực.',
        step3Title: 'Quản trị hội chứng kẻ giả mạo (Imposter Syndrome) & Giữ vững tự tin',
        step3Desc: 'Tin tưởng vào giá trị bản thân, tránh so sánh với hồ sơ người khác và duy trì sự bình tâm trong suốt quá trình viết luận.'
      },
      {
        month: mLabels[2],
        event: 'Hoàn thiện và nộp hồ sơ xin học bổng vòng sớm (Early Action / Decision)',
        impact: 'High',
        probability: 80,
        advice: 'Nộp hồ sơ vòng sớm giúp tăng tỷ lệ trúng tuyển từ 15-25% so với vòng nộp thông thường (Regular Decision).',
        kpi: 'Nộp thành công 100% hồ sơ ứng tuyển trước hạn chót; chuẩn bị sẵn sàng hồ sơ tài chính (CSS Profile/ISFAA).',
        step1Title: 'Hoàn tất hồ sơ khai báo trực tuyến trên Common App / Cổng thông tin trường',
        step1Desc: 'Rà soát từng mục thông tin hoạt động ngoại khóa, giải thưởng học thuật và tải lên các bản dịch thuật công chứng.',
        step2Title: 'Chuẩn bị hồ sơ chứng minh tài chính minh bạch và chính xác',
        step2Desc: 'Thu thập sao kê ngân hàng, giấy xác nhận thu nhập và hoàn thiện các biểu mẫu hỗ trợ tài chính theo đúng quy định.',
        step3Title: 'Buổi làm việc kiểm toán toàn bộ hồ sơ (Final Audit) cùng Cố vấn',
        step3Desc: 'Thực hiện phiên rà soát chéo mọi tài liệu để bảo đảm không có bất kỳ sai sót kỹ thuật nào trước khi nhấn nút nộp.'
      },
      {
        month: mLabels[3],
        event: 'Phỏng vấn học bổng / Visa & Tập huấn kỹ năng tiền du học',
        impact: 'High',
        probability: 85,
        advice: 'Phỏng vấn không phải là kỳ thi hạch hỏi, mà là cuộc trò chuyện để hội đồng đánh giá mức độ chân thực và trưởng thành của bạn.',
        kpi: 'Nhận thư mời nhập học chính thức với mức học bổng kỳ vọng; phỏng vấn đỗ Visa du học ngay lần đầu.',
        step1Title: 'Luyện tập phỏng vấn thử (Mock Interview) với các bộ câu hỏi tình huống',
        step1Desc: 'Rèn luyện phong thái tự tin, khả năng diễn đạt logic bằng tiếng Anh và cách trả lời thuyết phục về kế hoạch học tập.',
        step2Title: 'Hoàn tất thủ tục nộp hồ sơ xin thị thực du học (Visa) và khám sức khỏe',
        step2Desc: 'Chuẩn bị đầy đủ các giấy tờ gốc, luyện tập trả lời ngắn gọn, trung thực các câu hỏi phỏng vấn của viên chức lãnh sự.',
        step3Title: 'Tập huấn kỹ năng sinh tồn, Nấu ăn, Quản lý chi tiêu & Hòa nhập văn hóa',
        step3Desc: 'Tham gia các hội thảo tiền du học của hội cựu du học sinh, chuẩn bị hành lý và tâm lý sẵn sàng cho cuộc sống tự lập.'
      },
      {
        month: mLabels[4],
        event: 'Xuất cảnh, Nhập học an toàn & Thích ứng môi trường học thuật quốc tế',
        impact: 'High',
        probability: 90,
        advice: 'Chủ động làm quen với các bạn cùng phòng quốc tế, tận dụng văn phòng hỗ trợ sinh viên và duy trì liên lạc với gia đình.',
        kpi: 'Hoàn tất đăng ký môn học kỳ 1; vượt qua sốc văn hóa bước đầu và đạt điểm học phần đầu tiên loại A/B.',
        step1Title: 'Hoàn tất thủ tục nhập học, mở tài khoản ngân hàng và đăng ký bảo hiểm',
        step1Desc: 'Tham gia tuần lễ định hướng (Orientation Week), làm quen khuôn viên trường và thiết lập mạng lưới liên lạc an toàn.',
        step2Title: 'Làm quen phương pháp học tập đại học quốc tế & Hệ thống tra cứu thư viện',
        step2Desc: 'Tham dự đầy đủ các buổi phụ đạo (Office Hours) của Giáo sư, tuân thủ nghiêm ngặt quy định về trích dẫn và liêm chính học thuật.',
        step3Title: 'Duy trì kết nối gia đình, Cân bằng tâm lý nơi xứ người & Hoạch định hè',
        step3Desc: 'Gọi điện định kỳ về nhà, tham gia hội sinh viên Việt Nam tại trường và lên kế hoạch tìm kiếm cơ hội thực tập hè.'
      }
    ];
  }

  if (std.stage === 'THAC_SI_NGHIEN_CUU') {
    return [
      {
        month: mLabels[0],
        event: 'Tổng quan tài liệu chuyên khảo quốc tế & Xác định khoảng trống nghiên cứu',
        impact: 'High',
        probability: 90,
        advice: 'Một đề tài Thạc sĩ xuất sắc bắt nguồn từ việc hiểu thấu đáo những gì thế giới đã làm và chỉ ra chính xác điểm mới của mình.',
        kpi: 'Đọc và tổng hợp tối thiểu 30 bài báo khoa học Q1/Q2; xác định câu hỏi nghiên cứu cốt lõi.',
        step1Title: 'Xây dựng hệ thống quản lý trích dẫn tài liệu với Zotero / Mendeley',
        step1Desc: 'Thiết lập quy trình đọc và ghi chú có hệ thống, phân loại tài liệu theo các trường phái lý thuyết chính.',
        step2Title: 'Viết báo cáo tổng quan tài liệu (Literature Review) sơ bộ',
        step2Desc: 'Chỉ ra các khoảng trống tri thức hiện có và luận chứng tính cấp thiết của đề tài nghiên cứu dự kiến.',
        step3Title: 'Cân đối thời gian giữa công việc và nghiên cứu, Tránh quá tải',
        step3Desc: 'Thảo luận với cơ quan về lộ trình học tập, thiết lập khung giờ nghiên cứu độc lập không bị quấy rầy.'
      },
      {
        month: mLabels[1],
        event: 'Soạn thảo đề cương nghiên cứu (Research Proposal) & Kết nối Giáo sư hướng dẫn',
        impact: 'High',
        probability: 85,
        advice: 'Đề cương cần thể hiện phương pháp luận chặt chẽ, tính khả thi về dữ liệu và sự chuẩn bị nghiêm túc.',
        kpi: 'Hoàn thành bản đề cương 15-20 trang đạt chuẩn; nhận sự đồng ý hướng dẫn từ Giáo sư chuyên ngành.',
        step1Title: 'Thiết kế phương pháp luận nghiên cứu (Định lượng / Định tính)',
        step1Desc: 'Xác định mô hình phân tích, nguồn dữ liệu cần thu thập và các kỹ thuật xử lý số liệu chuẩn mực.',
        step2Title: 'Liên hệ và trao đổi học thuật cùng Giáo sư hướng dẫn tiềm năng',
        step2Desc: 'Gửi email chuyên nghiệp kèm theo CV học thuật và tóm tắt đề cương nghiên cứu, xin lịch trao đổi trực tiếp.',
        step3Title: 'Tiếp nhận phản biện khoa học, Rèn tư duy mở & Giữ vững tự tin',
        step3Desc: 'Xem các câu hỏi phản biện của hội đồng là cơ hội hoàn thiện đề tài, không mang tâm lý phòng vệ cá nhân.'
      },
      {
        month: mLabels[2],
        event: 'Trúng tuyển chương trình Thạc sĩ & Triển khai thu thập dữ liệu thực nghiệm',
        impact: 'High',
        probability: 80,
        advice: 'Dữ liệu là xương sống của nghiên cứu; hãy đảm bảo tính minh bạch, khách quan và đạo đức nghiên cứu.',
        kpi: 'Hoàn thành 100% mẫu khảo sát hoặc tập dữ liệu thực nghiệm đạt chuẩn kiểm định độ tin cậy.',
        step1Title: 'Hoàn thiện hồ sơ trúng tuyển và các học phần lý thuyết nâng cao',
        step1Desc: 'Tham gia đầy đủ các chuyên đề sau đại học, nắm vững phương pháp xử lý số liệu chuyên sâu.',
        step2Title: 'Tiến hành khảo sát, phỏng vấn chuyên gia hoặc thu thập dữ liệu thứ cấp',
        step2Desc: `Làm sạch dữ liệu, kiểm tra các giả định thống kê bằng các công cụ chuyên ngành (${dom.tools[0] || 'phần mềm phân tích'}).`,
        step3Title: 'Quản trị áp lực tiến độ nghiên cứu, Tham vấn định kỳ cùng Người hướng dẫn',
        step3Desc: 'Báo cáo tiến độ hàng tháng với Giáo sư, ghi nhận các chỉ dẫn điều chỉnh để không bị chệch hướng nghiên cứu.'
      },
      {
        month: mLabels[3],
        event: 'Phân tích số liệu chuyên sâu & Viết bản thảo bài báo khoa học đầu tay',
        impact: 'High',
        probability: 85,
        advice: 'Viết bài báo khoa học giúp rèn luyện khả năng lập luận sắc bén và tạo lợi thế cạnh tranh vượt trội khi bảo vệ luận văn.',
        kpi: 'Hoàn thành bản thảo bài báo khoa học đạt chuẩn gửi hội thảo quốc tế hoặc tạp chí chuyên ngành uy tín.',
        step1Title: 'Chạy mô hình phân tích số liệu và thảo luận kết quả nghiên cứu',
        step1Desc: 'Phân tích ý nghĩa thực tiễn và học thuật của các phát hiện nghiên cứu, so sánh với các công trình đi trước.',
        step2Title: 'Chắp bút bài báo khoa học theo cấu trúc IMRaD chuẩn mực',
        step2Desc: 'Viết và hoàn thiện các phần Dẫn nhập, Phương pháp, Kết quả và Thảo luận bằng văn phong học thuật chuẩn mực.',
        step3Title: 'Vượt qua cảm giác bế tắc ý tưởng (Writer’s Block) & Giữ nhịp sinh hoạt',
        step3Desc: 'Chia nhỏ khối lượng viết thành từng đoạn ngắn mỗi ngày, tập thể dục thường xuyên để duy trì sự minh mẫn.'
      },
      {
        month: mLabels[4],
        event: 'Hoàn thiện toàn văn luận văn Thạc sĩ & Bảo vệ xuất sắc trước Hội đồng',
        impact: 'High',
        probability: 90,
        advice: 'Chuẩn bị bài thuyết trình mạch lạc, trả lời thẳng vào trọng tâm câu hỏi của Hội đồng với phong thái của một học giả độc lập.',
        kpi: 'Bảo vệ thành công luận văn Thạc sĩ với điểm số xuất sắc; nhận bằng Thạc sĩ và mở ra cơ hội thăng tiến.',
        step1Title: 'Hoàn thiện toàn văn luận văn, rà soát lỗi chính tả và định dạng chuẩn trường',
        step1Desc: 'Kiểm tra tỷ lệ trùng lặp đạo văn (Turnitin < 15%), xin chữ ký duyệt của Giáo sư hướng dẫn để nộp chấm bảo vệ.',
        step2Title: 'Luyện tập thuyết trình thử nghiệm và chuẩn bị câu trả lời phản biện',
        step2Desc: 'Thiết kế slide thuyết trình ấn tượng, luyện nói trong giới hạn 20 phút và dự liệu các câu hỏi hóc búa của ủy viên phản biện.',
        step3Title: 'Bảo vệ thành công, Tự hào cột mốc học thuật & Hoạch định sự nghiệp tương lai',
        step3Desc: 'Đón nhận tấm bằng Thạc sĩ danh giá, tri ân thầy cô và người thân, chuẩn bị cho các bước tiến sự nghiệp hoặc học tiếp Tiến sĩ.'
      }
    ];
  }

  // Default: University & Professional stage
  return [
    {
      month: mLabels[0],
      event: `Thiết lập nền tảng chuyên sâu & Làm chủ công cụ cốt lõi ngành ${dom.name}`,
      impact: 'High',
      probability: 90,
      advice: 'Tập trung xây dựng gốc rễ kiến thức vững vàng và thành thạo công cụ làm việc thực tế trước khi nhận các dự án phức tạp.',
      kpi: `Hoàn thành 100% các học phần chuyên môn nền tảng; làm chủ thao tác cơ bản trên ${dom.tools[0] || 'công cụ ngành'}.`,
      step1Title: 'Lập kế hoạch tự học chuyên sâu 15-20h/tuần & Hệ thống hóa kiến thức',
      step1Desc: 'Phân bổ thời gian cố định mỗi ngày, nghiên cứu tài liệu chuyên khảo chuẩn mực và ghi chép hệ thống kiến thức có cấu trúc.',
      step2Title: `Thực hành làm chủ công cụ tiêu chuẩn ngành (${dom.tools[0] || 'công cụ chuyên môn'})`,
      step2Desc: 'Hoàn thành các bài tập thực hành theo hướng dẫn mẫu, nắm chắc các phím tắt, quy trình thao tác và chuẩn kỹ thuật của ngành.',
      step3Title: 'Quản trị năng lượng tinh thần, Chống trì hoãn & Thiết lập kỷ luật cá nhân',
      step3Desc: 'Áp dụng phương pháp Pomodoro để duy trì sự tập trung sâu, cân bằng thời gian nghỉ ngơi và chia sẻ mục tiêu với người đồng hành.'
    },
    {
      month: mLabels[1],
      event: 'Triển khai đồ án thực chiến độc lập & Tích lũy sản phẩm Portfolio',
      impact: 'High',
      probability: 85,
      advice: 'Một sản phẩm thực tế hoàn chỉnh có giá trị thuyết phục hơn hàng trăm dòng lý thuyết trên CV.',
      kpi: 'Hoàn thành 1 đồ án/dự án cá nhân hoàn chỉnh đạt chuẩn kiểm thử; đóng gói đưa lên Portfolio trực tuyến.',
      step1Title: 'Lên ý tưởng, đặc tả yêu cầu và lập kế hoạch triển khai đồ án thực chiến',
      step1Desc: 'Xác định bài toán thực tế cần giải quyết, lập kế hoạch các mốc nhiệm vụ theo tuần và thu thập tài nguyên cần thiết.',
      step2Title: `Triển khai xây dựng sản phẩm mẫu bằng ${dom.tools.slice(0, 2).join(' & ')}`,
      step2Desc: 'Áp dụng các kiến thức đã học để hoàn thiện tính năng, tối ưu hóa hiệu năng và tuân thủ các chuẩn mực thiết kế/kỹ thuật.',
      step3Title: 'Vượt qua giai đoạn nản lòng (Mid-journey Fatigue) & Nhận phản biện từ Mentor',
      step3Desc: 'Chủ động tìm kiếm nhận xét từ giảng viên hoặc đàn anh đi trước để tháo gỡ bế tắc kỹ thuật và nâng tầm chất lượng sản phẩm.'
    },
    {
      month: mLabels[2],
      event: 'Nâng cấp sản phẩm phức tạp & Luyện kỹ năng phỏng vấn chuyên môn',
      impact: 'High',
      probability: 80,
      advice: 'Tập trung rèn luyện tư duy giải quyết vấn đề và khả năng trình bày giải pháp một cách tự tin, mạch lạc.',
      kpi: 'Portfolio đạt tiêu chuẩn ứng tuyển chuyên nghiệp; hoàn thành 3 buổi phỏng vấn thử nghiệm đạt kết quả tốt.',
      step1Title: 'Nâng cấp tính năng nâng cao và tối ưu hóa giải pháp cho đồ án',
      step1Desc: 'Thử thách bản thân với các yêu cầu kỹ thuật phức tạp hơn, xử lý các trường hợp ngoại lệ và viết tài liệu hướng dẫn hoàn chỉnh.',
      step2Title: 'Chuẩn hóa CV chuyên nghiệp, Portfolio trực tuyến & Hồ sơ LinkedIn',
      step2Desc: 'Trình bày rõ vai trò cá nhân, công nghệ sử dụng, số liệu kết quả đạt được và đính kèm link minh chứng trực tiếp.',
      step3Title: 'Luyện tập kỹ năng phỏng vấn kỹ thuật (Mock Interview) & Giữ tâm thế tự tin',
      step3Desc: 'Thực hành trả lời các câu hỏi tình huống chuyên sâu, rèn luyện ngôn ngữ cơ thể và kỹ năng đàm phán quyền lợi.'
    },
    {
      month: mLabels[3],
      event: 'Gia nhập doanh nghiệp thực tập / Tham gia dự án thực tế quy mô lớn',
      impact: 'High',
      probability: 85,
      advice: 'Hãy là người chủ động đặt câu hỏi, tích cực quan sát cách tổ chức vận hành và luôn hoàn thành công việc trước thời hạn.',
      kpi: 'Trúng tuyển vào vị trí thực tập tại tổ chức mục tiêu; hoàn thành tốt các nhiệm vụ được giao trong 2 tháng đầu.',
      step1Title: 'Nộp hồ sơ ứng tuyển chiến lược vào các doanh nghiệp mục tiêu hàng đầu',
      step1Desc: 'Cá nhân hóa thư ứng tuyển (Cover Letter) cho từng vị trí, theo dõi sát sao tình trạng hồ sơ và phản hồi thư mời phỏng vấn nhanh chóng.',
      step2Title: 'Hòa nhập nhanh với môi trường làm việc thực tế & Làm quen quy trình nghiệp vụ',
      step2Desc: 'Nắm vững nội quy, công cụ phối hợp nhóm và chủ động nhận các đầu việc phù hợp để chứng minh giá trị đóng góp.',
      step3Title: 'Xử lý áp lực công việc thực tế, Cân bằng cảm xúc & Học hỏi từ đồng nghiệp',
      step3Desc: 'Lắng nghe góp ý của cấp trên với thái độ cầu thị, xây dựng mối quan hệ tốt đẹp với đồng nghiệp và bảo vệ sức khỏe.'
    },
    {
      month: mLabels[4],
      event: 'Nghiệm thu kết quả, Tốt nghiệp xuất sắc & Đón nhận cơ hội việc làm chính thức',
      impact: 'High',
      probability: 90,
      advice: 'Khẳng định vị thế cá nhân, tự tin đảm nhận các bài toán độc lập và mở rộng tầm nhìn sự nghiệp 3-5 năm tới.',
      kpi: 'Nhận đánh giá xuất sắc từ người hướng dẫn / lời mời làm việc chính thức; sẵn sàng cho chặng đường thăng tiến.',
      step1Title: 'Hoàn thành báo cáo tổng kết thực tập / Khóa luận tốt nghiệp với điểm số cao',
      step1Desc: 'Tổng hợp các bài học kinh nghiệm, phân tích số liệu đóng góp thực tế và trình bày báo cáo chỉn chu trước hội đồng/công ty.',
      step2Title: 'Đàm phán chuyển giao sang vị trí nhân viên chính thức hoặc bước tiến mới',
      step2Desc: 'Tổng kết các thành tựu nổi bật đã cống hiến, tự tin trao đổi về lộ trình phát triển sự nghiệp và mức đãi ngộ xứng đáng.',
      step3Title: 'Tự hào thành quả 12 tháng, Tri ân Cố vấn & Hoạch định mục tiêu 3 năm tiếp theo',
      step3Desc: 'Nhìn lại hành trình nỗ lực bền bỉ, thưởng cho bản thân thời gian nghỉ ngơi xứng đáng và phác thảo các mục tiêu lớn tiếp theo.'
    }
  ];
};

/**
 * Dam bao Premium Analysis response luon co du field, khong bao gio rong, khong bao gio dinh placeholder.
 * Tich hop Bo may 3-Tier Master Step Engine, Tam ly hoc phan tich chuyen sau va Metric dinh luong.
 */
const normalizePremiumAnalysisResponse = (data, fallbackInfo = {}) => {
  if (!data || typeof data !== 'object') {
    data = {};
  }

  const { title = 'Lộ trình Chuyên sâu', description = '', context = {}, timeframe = 12, ragData = null } = fallbackInfo;

  const student = extractHolisticStudentContext(context || {});
  const domain = detectDomainProfile(`${context?.decision || ''} ${title || ''} ${context?.otherFactors || ''}`, ragData);

  // 1. Raw milestones array extraction
  let rawMilestones = Array.isArray(data.milestones) ? data.milestones : [];
  if (rawMilestones.length === 0 && typeof data.milestones === 'object' && data.milestones !== null) {
    rawMilestones = Object.values(data.milestones);
  }

  // 2. detailedNarrative: Dam bao 5 pha ro rang, giau cam xuc va thau hieu tam ly
  let narrative = (typeof data.detailedNarrative === 'string' && data.detailedNarrative.trim())
    ? data.detailedNarrative.trim()
    : '';

  const phaseMatches = (narrative.match(/tháng\s+\d+/gi) || []).length;
  if (isEchoedPlaceholder(narrative) || phaseMatches < 3 || narrative.length < 120) {
    narrative = generateMasterNarrative(title, context, timeframe, rawMilestones, domain, student);
  }

  // 3. Stage-aware Milestone Templates & 3-Tier Step Engine
  const stageTemplates = getStageMilestoneTemplates(student, domain, timeframe);
  const milestones = [];

  const seenEventTitles = new Set();
  for (let idx = 0; idx < 5; idx++) {
    const rawM = rawMilestones[idx] || {};
    const tmpl = stageTemplates[idx];

    let candidateEvent = (typeof rawM.event === 'string' && rawM.event.trim() && !isEchoedPlaceholder(rawM.event) && rawM.event.length >= 10)
      ? rawM.event.trim()
      : (typeof rawM.title === 'string' && rawM.title.trim() && !isEchoedPlaceholder(rawM.title) && rawM.title.length >= 10)
        ? rawM.title.trim()
        : null;

    let eventName;
    if (candidateEvent && !seenEventTitles.has(candidateEvent.toLowerCase())) {
      eventName = candidateEvent;
    } else {
      eventName = tmpl.event;
    }
    seenEventTitles.add(eventName.toLowerCase());

    const tfNum = parseInt(timeframe, 10) || 12;
    let monthStr = tmpl.month;
    if (typeof rawM.month === 'string' && rawM.month.trim() && !isEchoedPlaceholder(rawM.month)) {
      const trimmed = rawM.month.trim();
      // Neu nguoi dung chon timeframe khac 12 (vd: 24, 36, 48) ma model van in nhan cung cua 12 thang
      const isFixed12Month = /tháng\s*(1-2|3-4|5-6|7-9|10-12)\b/i.test(trimmed);
      if (tfNum !== 12 && isFixed12Month) {
        monthStr = tmpl.month;
      } else {
        monthStr = trimmed;
      }
    }

    let impactVal = ['High', 'Medium', 'Low'].includes(rawM.impact) ? rawM.impact : tmpl.impact;
    let probVal = typeof rawM.probability === 'number'
      ? rawM.probability
      : (parseInt(rawM.probability, 10) || tmpl.probability);

    const aiAdvice = (rawM.advice && !isEchoedPlaceholder(rawM.advice)) ? rawM.advice.trim() : tmpl.advice;
    const aiKpi = (rawM.kpi && !isEchoedPlaceholder(rawM.kpi)) ? rawM.kpi.trim() : tmpl.kpi;
    const aiTasks = Array.isArray(rawM.tasks)
      ? rawM.tasks.filter(t => t && typeof t === 'string' && !isEchoedPlaceholder(t)).map(t => t.trim())
      : [];

    // Check existing steps for completion state or custom content
    const existingSteps = Array.isArray(rawM.details) ? rawM.details : [];
    const isPastCompletedMilestone = rawM.completed === true;
    const isStep1Completed = existingSteps[0]?.completed === true || isPastCompletedMilestone;
    const isStep2Completed = existingSteps[1]?.completed === true || isPastCompletedMilestone;
    const isStep3Completed = existingSteps[2]?.completed === true || isPastCompletedMilestone;

    // Check if raw step titles/descriptions are rich (e.g. from custom inputs or previous saves)
    const customStep1Title = (existingSteps[0]?.title && !isEchoedPlaceholder(existingSteps[0].title) && existingSteps[0].title.length >= 15 && !/^(nhiệm vụ|bước|hành động|mục tiêu)\s*\d/i.test(existingSteps[0].title))
      ? existingSteps[0].title
      : null;
    const customStep2Title = (existingSteps[1]?.title && !isEchoedPlaceholder(existingSteps[1].title) && existingSteps[1].title.length >= 15 && !/^(nhiệm vụ|bước|hành động|mục tiêu)\s*\d/i.test(existingSteps[1].title))
      ? existingSteps[1].title
      : null;
    const customStep3Title = (existingSteps[2]?.title && !isEchoedPlaceholder(existingSteps[2].title) && existingSteps[2].title.length >= 15 && !/^(nhiệm vụ|bước|hành động|mục tiêu)\s*\d/i.test(existingSteps[2].title))
      ? existingSteps[2].title
      : null;

    // --- STEP 1: Chiến Lược & KPI Định Lượng (Execution Strategy & Quantitative KPIs) ---
    const step1 = {
      id: existingSteps[0]?.id || `step_${idx + 1}_1`,
      title: customStep1Title || tmpl.step1Title,
      description: (existingSteps[0]?.description && existingSteps[0].description.length >= 40 && !isEchoedPlaceholder(existingSteps[0].description))
        ? existingSteps[0].description
        : `${tmpl.step1Desc} Lời khuyên cố vấn: ${aiAdvice}. Mục tiêu định lượng: ${aiKpi}.`,
      objectives: (Array.isArray(existingSteps[0]?.objectives) && existingSteps[0].objectives.length > 0)
        ? existingSteps[0].objectives
        : [
          `Hoàn thành 100% khối lượng học tập/công việc của giai đoạn ${monthStr}, đáp ứng chuẩn đầu ra: ${aiKpi}.`,
          `Duy trì kỷ luật tự học 15-20 giờ/tuần được phân bổ cố định qua phương pháp Time-boxing.`,
          `Hệ thống hóa toàn bộ kiến thức và ghi nhận tiến độ định kỳ mỗi tuần.`
        ],
      actions: (Array.isArray(existingSteps[0]?.actions) && existingSteps[0].actions.length > 0)
        ? existingSteps[0].actions
        : [
          aiTasks[0] || `Lên lịch học/làm việc cố định trên Google Calendar, chia nhỏ các phiên làm việc 50 phút tập trung.`,
          `Nghiên cứu tài liệu chuyên môn, thực hiện các bài tập áp dụng từ cơ bản đến nâng cao.`,
          `Tổng kết tiến độ vào tối Chủ nhật hàng tuần trên bảng theo dõi cá nhân để kịp thời khắc phục các đầu việc chậm trễ.`
        ],
      tools: (Array.isArray(existingSteps[0]?.tools) && existingSteps[0].tools.length > 0)
        ? existingSteps[0].tools
        : ['Notion Dashboard (Quản lý tiến độ OKR)', 'Google Calendar (Time-boxing)', 'Kỹ thuật Pomodoro / Forest app', 'Bảng theo dõi KPI cá nhân'],
      expectedResult: (existingSteps[0]?.expectedResult && !isEchoedPlaceholder(existingSteps[0].expectedResult))
        ? existingSteps[0].expectedResult
        : `Báo cáo nghiệm thu hoàn tất các nhiệm vụ trọng tâm giai đoạn ${monthStr}; đạt chỉ số KPI: ${aiKpi}.`,
      completed: isStep1Completed
    };

    // --- STEP 2: Thực Chiến Chuyên Ngành & Hồ Sơ Năng Lực (Practical Domain Mastery & Portfolio) ---
    const step2 = {
      id: existingSteps[1]?.id || `step_${idx + 1}_2`,
      title: customStep2Title || tmpl.step2Title,
      description: (existingSteps[1]?.description && existingSteps[1].description.length >= 40 && !isEchoedPlaceholder(existingSteps[1].description))
        ? existingSteps[1].description
        : `${tmpl.step2Desc} Ứng dụng thực hành trên bộ công cụ tiêu chuẩn ngành (${domain.tools.slice(0, 2).join(', ')}).`,
      objectives: (Array.isArray(existingSteps[1]?.objectives) && existingSteps[1].objectives.length > 0)
        ? existingSteps[1].objectives
        : [
          `Làm chủ kỹ năng thực hành trên các công cụ chuẩn ngành: ${domain.tools.slice(0, 2).join(', ')}.`,
          `Tạo ra sản phẩm thực nghiệm hoàn chỉnh (bài giải chuyên đề nâng cao / đồ án mẫu / sản phẩm số) đạt chuẩn kiểm thử.`,
          `Đóng gói sản phẩm vào Hồ sơ năng lực (Portfolio) để chứng minh năng lực thực chiến với nhà tuyển dụng/hội đồng.`
        ],
      actions: (Array.isArray(existingSteps[1]?.actions) && existingSteps[1].actions.length > 0)
        ? existingSteps[1].actions
        : [
          aiTasks[1] || `Thực hành triển khai sản phẩm hoặc giải các bài toán/đề thi chuyên sâu theo tiêu chuẩn ngành.`,
          `Tự kiểm thử, sửa lỗi (debug) và tối ưu hóa giải pháp theo góp ý từ chuẩn mực công nghiệp.`,
          `Ghi lại quy trình thực hiện, đóng gói mã nguồn / bản vẽ / tài liệu minh chứng lên kho lưu trữ trực tuyến.`
        ],
      tools: (Array.isArray(existingSteps[1]?.tools) && existingSteps[1].tools.length > 0)
        ? existingSteps[1].tools
        : domain.tools.slice(0, 3),
      expectedResult: (existingSteps[1]?.expectedResult && !isEchoedPlaceholder(existingSteps[1].expectedResult))
        ? existingSteps[1].expectedResult
        : `Sản phẩm thực tế hoàn chỉnh được nghiệm thu đạt chất lượng cao, sẵn sàng đưa vào hồ sơ năng lực (Portfolio).`,
      completed: isStep2Completed
    };

    // --- STEP 3: Tâm Lý Học Vững Vàng, Quản Trị Căng Thẳng & Cố Vấn (Psychological Resilience, Stress Management & Mentor Audit) ---
    const stressObj = student.stress >= 4
      ? `Kiểm soát mức độ căng thẳng tinh thần dưới ngưỡng 2.5/5, thiết lập nhịp thở Box Breathing và ngủ đủ 7-8 tiếng/ngày.`
      : `Duy trì năng lượng tinh thần tích cực, giải tỏa âu lo và loại bỏ hội chứng kẻ giả mạo (Imposter Syndrome).`;
    const financeObj = student.personalFinance <= 2
      ? `Tối ưu hóa ngân sách chi tiêu học tập, chủ động tiếp cận các nguồn học bổng/trợ cấp để an tâm tài chính.`
      : `Duy trì sự cân bằng cuộc sống - học tập bền vững, bảo vệ sức khỏe thể chất và tinh thần dài hạn.`;

    const step3 = {
      id: existingSteps[2]?.id || `step_${idx + 1}_3`,
      title: customStep3Title || tmpl.step3Title,
      description: (existingSteps[2]?.description && existingSteps[2].description.length >= 40 && !isEchoedPlaceholder(existingSteps[2].description))
        ? existingSteps[2].description
        : `${tmpl.step3Desc} Giữ gìn sức bền tinh thần, chủ động phòng ngừa hội chứng kiệt sức (burnout) và kiểm toán tiến độ cùng Cố vấn chuyên môn.`,
      objectives: (Array.isArray(existingSteps[2]?.objectives) && existingSteps[2].objectives.length > 0)
        ? existingSteps[2].objectives
        : [
          stressObj,
          financeObj,
          `Hoàn thành phiên làm việc 1-on-1 Milestone Review 45 phút cùng Cố vấn hoặc Mentor chuyên môn để nghiệm thu kết quả cột mốc.`
        ],
      actions: (Array.isArray(existingSteps[2]?.actions) && existingSteps[2].actions.length > 0)
        ? existingSteps[2].actions
        : [
          `Dành 10-15 phút mỗi ngày thực hành kỹ thuật thở điều hòa thần kinh Box Breathing và viết nhật ký phản tư (Reflective Journaling).`,
          `Duy trì ranh giới rõ ràng giữa giờ học tập/làm việc và thời gian phục hồi năng lượng; vận động thể chất nhẹ nhàng 20 phút mỗi ngày.`,
          `Lên lịch và tham gia phiên làm việc 1-on-1 cùng Cố vấn học thuật hoặc nhóm học tập đồng đẳng để nhận xét, phản biện đa chiều về kết quả ${monthStr}.`
        ],
      tools: (Array.isArray(existingSteps[2]?.tools) && existingSteps[2].tools.length > 0)
        ? existingSteps[2].tools
        : ['Kỹ thuật thở điều hòa Box Breathing / Headspace', 'Nhật ký phản tư (Reflective Journaling)', 'Phiên làm việc 1-on-1 cùng Cố vấn (Milestone Audit)', 'Mạng lưới hỗ trợ đồng đẳng (Peer Support Circle)'],
      expectedResult: (existingSteps[2]?.expectedResult && !isEchoedPlaceholder(existingSteps[2].expectedResult))
        ? existingSteps[2].expectedResult
        : `Chỉ số phục hồi tinh thần và năng lượng thể chất đạt trạng thái tối ưu; hoàn tất biên bản nghiệm thu cột mốc với xác nhận đồng thuận từ Cố vấn.`,
      completed: isStep3Completed
    };

    milestones.push({
      month: monthStr,
      event: eventName,
      impact: impactVal,
      probability: probVal,
      completed: isPastCompletedMilestone,
      details: [step1, step2, step3]
    });
  }

  // 4. influencingFactors: luon co 4 nhan to thuc te, ca nhan hoa theo boi canh va chuyen nganh
  let rawFactors = Array.isArray(data.influencingFactors) ? data.influencingFactors : [];
  const defaultFactors = synthesizeUniversalFactors(title, context);

  const influencingFactors = defaultFactors.map((df, i) => {
    const f = rawFactors[i];
    if (f && f.factor && !isEchoedPlaceholder(f.factor) && f.description && !isEchoedPlaceholder(f.description)) {
      return {
        category: f.category || df.category,
        factor: f.factor,
        influence: ['High', 'Medium', 'Low'].includes(f.influence) ? f.influence : df.influence,
        description: f.description
      };
    }
    return df;
  });

  // 5. strategicPivotPoints: luon co 3 phuong an du phong If-Then chat luong cao
  let rawPivots = Array.isArray(data.strategicPivotPoints) ? data.strategicPivotPoints : [];
  const defaultPivots = [
    {
      condition: student.stage === 'THPT_ON_THI_DAI_HOC'
        ? 'Nếu điểm thi thử 3 tháng đầu chênh lệch thấp hơn 2 điểm so với mục tiêu trúng tuyển NV1'
        : 'Nếu kết quả đánh giá chuyên môn hoặc tiến độ dự án trong 3 tháng đầu chậm hơn dự kiến',
      action: student.stage === 'THPT_ON_THI_DAI_HOC'
        ? 'Dừng ngay việc giải đề dàn trải, rà soát lại toàn bộ 100% câu sai lý thuyết căn bản, tham vấn trực tiếp giáo viên bộ môn và dồn 80% thời lượng vào các chuyên đề trọng điểm.'
        : 'Tiến hành kiểm toán nguyên nhân gốc rễ (Root Cause Audit), giản lược các đầu việc thứ yếu, tập trung vào 20% kỹ năng cốt lõi tạo ra 80% kết quả và xin hướng dẫn trực tiếp từ Mentor.'
    },
    {
      condition: student.personalFinance <= 2
        ? 'Nếu phát sinh chi phí đột xuất hoặc áp lực tài chính gia đình gia tăng ảnh hưởng đến việc học'
        : student.stress >= 4
          ? 'Nếu mức độ căng thẳng chạm ngưỡng quá tải (Stress >= 4/5) dẫn đến mất ngủ hoặc suy giảm khả năng tập trung'
          : 'Nếu gặp khó khăn về thời gian biểu, lịch học/làm việc bị chồng chéo hoặc áp lực gia tăng đột biến',
      action: student.personalFinance <= 2
        ? 'Kích hoạt phương án tài chính dự phòng: nộp hồ sơ xin trợ cấp khó khăn/học bổng vượt khó của trường, tìm kiếm cơ hội trợ giảng/việc làm thêm gắn liền với chuyên môn ngành để vừa có thu nhập vừa tích lũy kinh nghiệm.'
        : student.stress >= 4
          ? 'Chủ động áp dụng quy tắc giãn tiến độ 1 tuần cho các mục tiêu phụ, dành trọn 48 giờ "ngắt kết nối số" để phục hồi hệ thần kinh, tham vấn chuyên gia tâm lý và tái thiết lập ranh giới công việc - nghỉ ngơi.'
          : 'Tái cấu trúc ma trận ưu tiên Eisenhower: chỉ giữ lại 3 nhiệm vụ quan trọng nhất của cột mốc hiện tại, đàm phán xin gia hạn các bài tập phụ và duy trì kỷ luật nghỉ ngơi để bảo toàn sức bền dài hạn.'
    },
    {
      condition: student.stage === 'THPT_ON_THI_DAI_HOC'
        ? 'Nếu điểm thi thử các kỳ đợt giữa đạt ngưỡng xuất sắc (>= 27.5-28.0) vượt kỳ vọng ban đầu'
        : 'Nếu đạt thành tích đột phá sớm hoặc xuất hiện cơ hội học bổng / dự án / việc làm chất lượng cao ngoài kế hoạch',
      action: student.stage === 'THPT_ON_THI_DAI_HOC'
        ? 'Giữ vững sự điềm tĩnh và kỷ luật phòng thi, tránh chủ quan; rèn luyện thêm kỹ năng bấm máy tính giải nhanh câu phân loại 9+ và nộp hồ sơ xét tuyển thẳng/học bổng tài năng.'
        : `Đánh giá mức độ đóng góp của cơ hội này đối với tầm nhìn 3-5 năm ngành ${domain.name}; nếu tạo bước đòn bẩy lớn thì sẵn sàng linh hoạt tăng tốc lộ trình, nhận lời tham gia để tích lũy lợi thế cạnh tranh tiên phong.`
    }
  ];

  const strategicPivotPoints = defaultPivots.map((dp, i) => {
    const p = rawPivots[i];
    if (typeof p === 'string' && p.trim() && !isEchoedPlaceholder(p)) {
      const parts = p.split(/:\s*/);
      const cond = parts.length > 1 ? parts[0].trim() : '';
      const act = parts.length > 1 ? parts.slice(1).join(': ').trim() : p.trim();
      const isValidCond = cond && !/^(chiến lược|phương án|kế hoạch)\s*\d/i.test(cond) && cond.length >= 10;
      return {
        condition: isValidCond ? cond : dp.condition,
        action: (act && act.length >= 20) ? act : dp.action
      };
    }
    if (p && typeof p === 'object') {
      const cond = (p.condition || p.if || p.trigger || '').trim();
      const act = (p.action || p.then || p.solution || '').trim();
      const isValidCond = cond && !/^(chiến lược|phương án|kế hoạch)\s*\d/i.test(cond) && cond.length >= 10;
      if (isValidCond && act && !isEchoedPlaceholder(act) && act.length >= 20) {
        return { condition: cond, action: act };
      }
    }
    return dp;
  });

  // 6. longTermProjection: Tam nhin 3-5 nam thuc te, day cam hung
  let longTermProjection = (typeof data.longTermProjection === 'string' && data.longTermProjection.trim())
    ? data.longTermProjection.trim()
    : '';

  if (!longTermProjection || isEchoedPlaceholder(longTermProjection) || longTermProjection.length < 40) {
    const goalName = student.primaryGoal || title;
    longTermProjection = `Trong tầm nhìn 3-5 năm tới, sau khi hoàn thành xuất sắc lộ trình hướng tới "${goalName}", bạn sẽ sở hữu nền tảng chuyên môn vững chắc ngành ${domain.name}, tư duy thực chiến cùng bản lĩnh tâm lý vượt trội. Đây là bệ phóng quan trọng giúp bạn tiếp cận các vị trí công việc có thu nhập hấp dẫn, mở rộng cơ hội thăng tiến và tự tin làm chủ con đường sự nghiệp dài hạn.`;
  }

  return {
    detailedNarrative: narrative,
    milestones,
    influencingFactors,
    strategicPivotPoints,
    longTermProjection
  };
};

const generatePremiumAnalysis = async (title, description, context, timeframe) => {
  const ai = getAI();

  const primaryGoal = sanitizeDecision(context?.decision || '') || title || '';

  // RAG: Multi-Channel Hybrid Retrieval - anchor on primaryGoal to ensure domain precision
  const premiumSearchText = `${primaryGoal} ${title || ''} ${description || ''} ${context?.otherFactors || ''} ${context?.location || ''}`;
  const { ragData: premiumRagData, ragSnippet: premiumRagContext } = ragService.getAugmentedContext(primaryGoal, premiumSearchText);
  if (premiumRagData) {
    console.log(`[RAG Premium] ✅ Activated channels for scenario "${title}" (Goal: ${primaryGoal.slice(0, 50)}...)`);
  }

  const prompt = `
    Generate a PREMIUM DETAILED SCENARIO REPORT for the following scenario:
    Title: ${title}
    Context: ${description}
    ${context ? `
    User Context:
    - Current Situation: ${context.decision}
    - Stress Level: ${context.stress}/5
    - Financial Status: ${context.personalFinance}/5
    - Academic Performance: ${context.academicPerformance}/5
    - Risk Tolerance: ${context.risk}/5
    - Other Factors: ${context.otherFactors || 'None'}
    ` : ''}
    ${timeframe ? `Target Completion Timeframe: ${timeframe} months.` : ''}
    ${timeframe ? `FIXED PHASES (cover the whole timeframe, in order): ${computePeriodLabels(timeframe).join(' | ')}. Milestone i MUST use phase i label exactly as its "month" and describe the result reached at the END of phase i. detailedNarrative MUST have exactly 5 paragraphs, paragraph i starting with phase i label followed by a colon (e.g. "${computePeriodLabels(timeframe)[0]}: ...").` : ''}

    ${premiumRagContext ? premiumRagContext + '\n\n    HƯỚNG DẪN SỬ DỤNG DỮ LIỆU: Các cột mốc, mức lương kỳ vọng, và nhận định thị trường trong báo cáo PHẢI được dựa trên bộ dữ liệu thực tế ở trên. Không được tự bịa đặt con số.' : ''}

    CRITICAL INSTRUCTION FOR MILESTONES:
    - The milestones MUST be realistic based on the user's current situation, age/grade, and academic performance.
    - ${timeframe ? `The ENTIRE roadmap must be compressed or expanded to fit exactly within ${timeframe} months.` : 'The timeline should be logical and progressive.'}
    - For example, if the user is in Grade 10 (lớp 10), do not suggest university entrance exams within 12 months. Instead, suggest milestones like "Kết thúc học kỳ 1 lớp 10", "Chọn khối thi", "Ôn tập hè", etc.
    - The report must include:
      1. detailedNarrative: A long, detailed chronological description of how the next ${timeframe || 12} months (or relevant period) will unfold. It MUST be structured into chronological paragraphs where each paragraph starts with its FIXED PHASE label and a colon (Vietnamese).
      2. milestones: 5 key events with month, description, impact level, probability (0-100). The "details" field MUST be a JSON array of exactly 3 structured step objects. Each step object must have:
         - id: A unique string ID like "step_X_Y" (where X is milestone index 1-5, Y is step index 1-5), e.g. "step_1_1", "step_1_2".
         - title: Tên công việc cụ thể (Vietnamese).
         - description: Mô tả ngắn gọn nhiệm vụ (Vietnamese).
         - objectives: Mảng chứa 2-3 mục tiêu chính (Vietnamese).
         - actions: Mảng chứa 2-3 hành động cơ bản (Vietnamese).
         - tools: Mảng chứa 2-3 công cụ cơ bản đề xuất (Vietnamese).
         - expectedResult: Kết quả đầu ra cơ bản (Vietnamese).
         - completed: false.
      3. influencingFactors: 4 external or internal factors (Economic, Personal, Social, or Technical) with their influence level (High, Medium, Low).
      4. strategicPivotPoints: 3 critical "If/Then" decision points.
      5. longTermProjection: A final outlook on the 3-5 year horizon.

    - BẮT BUỘC: Không được để trống bất kỳ trường nào trong kết quả trả về. Mọi cột mốc phải có đầy đủ month, event, impact, probability và details.
    - TUYỆT ĐỐI KHÔNG sử dụng các cụm từ như "tương tự như trên", "không thay đổi" hoặc để trống chuỗi. Mọi nội dung phải được viết chi tiết bằng tiếng Việt.

    Language: Vietnamese. Use a professional, analytical tone.
  `;

  const provider = getAiProvider();

  // 1. Uu tien goi Local Model Ollama truoc
  if (provider === 'ollama' || provider === 'hybrid') {
    try {
      const health = await checkOllamaHealth();
      if (health.online && health.hasModel) {
        console.log(`[AI Premium] 🚀 Using Local Fine-Tuned Model via Ollama (PREMIUM TIER)`);
        const student = extractHolisticStudentContext(context || {});
        const domain = detectDomainProfile(`${context?.decision || ''} ${title || ''} ${context?.otherFactors || ''}`, premiumRagData);

        const ragSnippet = premiumRagContext ? `\nTHÔNG TIN THỊ TRƯỜNG LAO ĐỘNG THỰC TẾ (RAG):\n${premiumRagContext}\n` : '';
        const tfNum = parseInt(timeframe, 10) || 12;
        const periods = computePeriodLabels(tfNum);
        const periodsMarkers = periods.map(p => `'${p}:'`).join(', ');

        const ollamaPremiumPrompt = `Bạn là Chuyên gia Cố vấn Chiến lược Học thuật & Sự nghiệp Cấp cao FutureTrace (Master Academic & Career Strategist).
Nhiệm vụ: Hoạch định Báo cáo Lộ trình Chuyên sâu ĐẲNG CẤP, TOÀN DIỆN cho mục tiêu:
"${primaryGoal}"
- Định hướng kịch bản: ${title} - ${description}
- Giai đoạn: ${student.stageLabel} | Ngành: ${domain.name}
- Công cụ chuẩn ngành: ${domain.tools.slice(0, 3).join(', ')}
${context ? `- Chỉ số hồ sơ: Học lực ${context.academicPerformance}/5 | Tài chính ${context.personalFinance}/5 | Áp lực ${context.stress}/5 | Rủi ro ${context.risk}/5` : ''}
- Khung thời gian hoàn thành: ${tfNum} tháng.${ragSnippet}

YÊU CẦU BẮT BUỘC:
1. ĐÚNG CHUYÊN MÔN & GIAI ĐOẠN: Đúng ngành "${primaryGoal}" và đối tượng "${student.stageLabel}". Tuyệt đối không khuyên lạc giai đoạn (ví dụ học sinh phổ thông ôn thi ĐH thì không khuyên đi làm/thực tập công ty).
2. TƯỜNG THUẬT CHIẾN LƯỢC: "detailedNarrative" 120-150 từ, thấu cảm tâm lý người học, phân bổ theo đúng 5 giai đoạn của ${tfNum} tháng: ${periodsMarkers}.
3. Trả về DUY NHẤT một chuỗi JSON hợp lệ bắt đầu bằng { và kết thúc bằng }:
{
  "detailedNarrative": "Tường thuật 120-150 từ thấu cảm tâm lý người học, phân tích theo: ${periods.join(', ')}.",
  "milestones": [
    {
      "month": "${periods[0]}",
      "event": "Tên cột mốc 1 đúng chuyên môn và giai đoạn",
      "impact": "High",
      "probability": 90,
      "advice": "Lời khuyên cố vấn đắt giá cho cột mốc 1",
      "tasks": ["Đầu việc then chốt 1", "Đầu việc then chốt 2"],
      "kpi": "Chỉ số định lượng cụ thể cần đạt"
    },
    {
      "month": "${periods[1]}",
      "event": "Tên cột mốc 2 đúng chuyên môn và giai đoạn",
      "impact": "High",
      "probability": 85,
      "advice": "Lời khuyên cố vấn đắt giá cho cột mốc 2",
      "tasks": ["Đầu việc then chốt 1", "Đầu việc then chốt 2"],
      "kpi": "Chỉ số định lượng cụ thể cần đạt"
    },
    {
      "month": "${periods[2]}",
      "event": "Tên cột mốc 3 đúng chuyên môn và giai đoạn",
      "impact": "High",
      "probability": 80,
      "advice": "Lời khuyên cố vấn đắt giá cho cột mốc 3",
      "tasks": ["Đầu việc then chốt 1", "Đầu việc then chốt 2"],
      "kpi": "Chỉ số định lượng cụ thể cần đạt"
    },
    {
      "month": "${periods[3]}",
      "event": "Tên cột mốc 4 đúng chuyên môn và giai đoạn",
      "impact": "Medium",
      "probability": 75,
      "advice": "Lời khuyên cố vấn đắt giá cho cột mốc 4",
      "tasks": ["Đầu việc then chốt 1", "Đầu việc then chốt 2"],
      "kpi": "Chỉ số định lượng cụ thể cần đạt"
    },
    {
      "month": "${periods[4]}",
      "event": "Tên cột mốc 5 đúng chuyên môn và giai đoạn",
      "impact": "High",
      "probability": 85,
      "advice": "Lời khuyên cố vấn đắt giá cho cột mốc 5",
      "tasks": ["Đầu việc then chốt 1", "Đầu việc then chốt 2"],
      "kpi": "Chỉ số định lượng cụ thể cần đạt"
    }
  ],
  "strategicPivotPoints": [
    { "condition": "Nếu gặp khó khăn chuyên môn hoặc tiến độ chậm hơn 2 tuần", "action": "Giải pháp ứng phó cụ thể..." },
    { "condition": "Nếu phát sinh biến động tài chính hoặc áp lực căng thẳng gia tăng", "action": "Giải pháp cân bằng cụ thể..." },
    { "condition": "Nếu đạt kết quả bứt phá hoặc có cơ hội học bổng/việc làm sớm", "action": "Giải pháp tăng tốc cụ thể..." }
  ],
  "longTermProjection": "Tầm nhìn 3-5 năm (40-60 từ) về sự nghiệp, năng lực chuyên môn và mức thu nhập kỳ vọng đúng ngành ${primaryGoal}."
}`;
        const premiumSysPrompt = 'Bạn là Chuyên gia Cấp cao FutureTrace. Trả về duy nhất một chuỗi JSON hợp lệ bắt đầu bằng { và kết thúc bằng }.';
        const localRes = await generateWithOllama(ollamaPremiumPrompt, premiumSysPrompt, {
          temperature: 0.25, maxTokens: 950, numCtx: 2560, timeout: 240000
        });
        const parsed = parseAndRepairJson(localRes.text, 'premium');
        const normalized = normalizePremiumAnalysisResponse(parsed, { title, description, context, timeframe, ragData: premiumRagData });
        normalized.modelUsed = localRes.modelUsed;
        console.log(`[AI Premium] ✅ Local OK. Milestones: ${normalized.milestones?.length || 0}`);
        return normalized;
      }
    } catch (ollamaErr) {
      console.warn('[AI Premium] Local Ollama failed, attempting fallback to Gemini:', ollamaErr.message);
      if (provider === 'ollama' && !process.env.GEMINI_API_KEYS && !process.env.GEMINI_API_KEY) throw ollamaErr;
    }
  }

  // 2. Fallback Gemini Cloud
  try {
    const response = await callGeminiWithRetry(
      GEMINI_FALLBACK_MODELS,
      prompt,
      {
        responseMimeType: 'application/json',
        maxOutputTokens: 8192,
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            detailedNarrative: { type: Type.STRING },
            milestones: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  month: { type: Type.STRING },
                  event: { type: Type.STRING },
                  impact: { type: Type.STRING },
                  probability: { type: Type.NUMBER },
                  details: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        id: { type: Type.STRING },
                        title: { type: Type.STRING },
                        description: { type: Type.STRING },
                        objectives: {
                          type: Type.ARRAY,
                          items: { type: Type.STRING }
                        },
                        actions: {
                          type: Type.ARRAY,
                          items: { type: Type.STRING }
                        },
                        tools: {
                          type: Type.ARRAY,
                          items: { type: Type.STRING }
                        },
                        expectedResult: { type: Type.STRING },
                        completed: { type: Type.BOOLEAN }
                      },
                      required: ['id', 'title', 'description', 'objectives', 'actions', 'tools', 'expectedResult', 'completed']
                    }
                  }
                },
                required: ['month', 'event', 'impact', 'probability', 'details']
              }
            },
            influencingFactors: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  category: { type: Type.STRING },
                  factor: { type: Type.STRING },
                  influence: { type: Type.STRING },
                  description: { type: Type.STRING }
                },
                required: ['category', 'factor', 'influence', 'description']
              }
            },
            strategicPivotPoints: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  condition: { type: Type.STRING },
                  action: { type: Type.STRING }
                },
                required: ['condition', 'action']
              }
            },
            longTermProjection: { type: Type.STRING }
          },
          required: ['detailedNarrative', 'milestones', 'influencingFactors', 'strategicPivotPoints', 'longTermProjection']
        }
      }
    );

    let text = "";
    try {
      if (typeof response.text === 'string') {
        text = response.text.trim();
      } else if (typeof response.text === 'function') {
        text = response.text().trim();
      } else if (response.response && typeof response.response.text === 'function') {
        text = response.response.text().trim();
      }
    } catch (e) {
      console.error('[AI Text Extraction Error]:', e);
    }

    if (!text) {
      throw new Error('AI không trả về nội dung văn bản. Vui lòng thử lại.');
    }

    const parsed = parseAndRepairJson(text, 'premium');
    const normalized = normalizePremiumAnalysisResponse(parsed, { title, description, context, timeframe, ragData: premiumRagData });
    normalized.modelUsed = response.modelUsed;
    normalized.usage = response.usage;
    return normalized;
  } catch (error) {
    console.error('[AI Error Details - Premium]:', error);
    throw error;
  }
};

const pivotPremiumAnalysis = async (currentReport, completedMilestones, feedback, context, timeframe, feedbackHistory = []) => {
  const ai = getAI();

  // RAG: Retrieve grounded real-world knowledge for user feedback & new circumstances
  const pivotSearchText = `${feedback || ''} ${context?.decision || ''} ${context?.otherFactors || ''} ${currentReport?.detailedNarrative || ''}`;
  const { ragData: pivotRagData, ragSnippet: pivotRagSnippet } = ragService.getAugmentedContext(feedback, pivotSearchText);

  const prompt = `
    RE-PLANNING REQUIRED based on user feedback.
    
    ORIGINAL SCENARIO:
    - Narrative: ${currentReport.detailedNarrative}
    
    COMPLETED MILESTONES (DO NOT CHANGE THESE):
    ${JSON.stringify(completedMilestones)}
    
    ${feedbackHistory && feedbackHistory.length > 0 ? `
    PAST FEEDBACKS (What the user faced and reported previously in this scenario):
    ${feedbackHistory.map((fb, i) => `[Pivot ${i + 1}]: "${fb}"`).join('\n    ')}
    ` : ''}

    CURRENT FEEDBACK/DIFFICULTIES (What they are facing right now):
    "${feedback}"
    
    ${context ? `
    User Context:
    - Current Situation: ${context.decision}
    - Stress Level: ${context.stress}/5
    - Financial Status: ${context.personalFinance}/5
    - Academic Performance: ${context.academicPerformance}/5
    - Risk Tolerance: ${context.risk}/5
    - Other Factors: ${context.otherFactors || 'None'}
    ` : ''}
    ${timeframe ? `Target Completion Timeframe: ${timeframe} months.` : ''}

    ${pivotRagSnippet ? `${pivotRagSnippet}\n\n    HƯỚNG DẪN RAG: Hãy tham khảo các số liệu tuyển sinh, chi phí sinh hoạt và mức lương ở trên để giải quyết thấu đáo khó khăn của người dùng.` : ''}

    TASK:
    - BẮT BUỘC: Giữ nguyên 100% nội dung của các cột mốc trong danh sách "COMPLETED MILESTONES" ở trên. Copy chính xác từng trường (month, event, impact, probability, details) vào mảng milestones mới ở các vị trí đầu tiên.
    - Dựa vào chuỗi biến cố từ "PAST FEEDBACKS" (nếu có) kéo dài đến "CURRENT FEEDBACK" ("${feedback}") và bối cảnh các bước đã hoàn thành, hãy GIẢ LẬP và TẠO MỚI các cột mốc còn thiếu để hoàn thiện lộ trình.
    - Phải có tính nối tiếp: Nếu trước đó người dùng đã báo cáo khó khăn X, và giờ lại gặp biến cố Y, hãy thể hiện sự thấu hiểu chuỗi biến cố này trong \`detailedNarrative\`.
    - Điều chỉnh 'detailedNarrative', 'influencingFactors', 'strategicPivotPoints' và 'longTermProjection' để phản ánh sự thay đổi này nhưng không được mâu thuẫn với quá khứ. Đảm bảo \`detailedNarrative\` luôn được chia thành các đoạn văn bắt đầu bằng mốc thời gian rõ ràng (ví dụ: 'Tháng X:', 'Tháng X-Y:').
    - Đảm bảo tổng số milestones trong kết quả trả về luôn là 5.
    - BẮT BUỘC: Không được để trống bất kỳ trường nào. Mọi cột mốc (kể cả cũ và mới) đều phải có đầy đủ month, event, impact, probability và details.
    - The "details" field for any NEW milestones MUST be a JSON array of exactly 3 structured step objects. Each step object must have:
      - id: A unique string ID like "step_X_Y" (where X is milestone index 1-5, Y is step index 1-5), e.g. "step_1_1", "step_1_2".
      - title: Tên công việc cụ thể (Vietnamese).
      - description: Mô tả ngắn gọn nhiệm vụ (Vietnamese).
      - objectives: Mảng chứa 2-3 mục tiêu chính (Vietnamese).
      - actions: Mảng chứa 2-3 hành động cơ bản (Vietnamese).
      - tools: Mảng chứa 2-3 công cụ cơ bản đề xuất (Vietnamese).
      - expectedResult: Kết quả đầu ra cơ bản (Vietnamese).
      - completed: false.
    - TUYỆT ĐỐI KHÔNG lười biếng: Không viết "giữ nguyên", "như cũ" hay để trống. Phải copy lại đúng nội dung hoặc viết mới chi tiết.

    Return ONLY a valid JSON object matching the PremiumAnalysisReport interface.
     Ngôn ngữ: Tiếng Việt.
  `;

  const provider = getAiProvider();

  // 1. Uu tien goi Local Model Ollama truoc
  if (provider === 'ollama' || provider === 'hybrid') {
    try {
      const health = await checkOllamaHealth();
      if (health.online && health.hasModel) {
        console.log(`[AI Pivot] 🚀 Using Local Fine-Tuned Model via Ollama (PIVOT RE-PLANNING TIER)`);

        const student = extractHolisticStudentContext(context || {});
        const domain = detectDomainProfile(`${context?.decision || ''} ${context?.otherFactors || ''} ${feedback || ''}`, pivotRagData);

        const tfNum = parseInt(timeframe, 10) || 12;
        const ALL_PERIODS = computePeriodLabels(tfNum);
        const completedCount = completedMilestones.length;
        const remainingPeriods = ALL_PERIODS.slice(completedCount);
        const neededCount = Math.max(1, 5 - completedCount);

        const completedSummary = completedCount > 0
          ? completedMilestones.map(m => `- ${m.month}: ${m.event}`).join('\n')
          : 'Chưa có cột mốc nào hoàn thành';
        const pastFeedbackText = feedbackHistory && feedbackHistory.length > 0
          ? feedbackHistory.map((fb, i) => `Pivot ${i + 1}: "${fb}"`).join(' | ')
          : '';

        const ragPivotSnippet = pivotRagSnippet ? `\nTHÔNG TIN THỰC TẾ HỖ TRỢ (RAG):\n${pivotRagSnippet}\n` : '';

        const ollamaPivotPrompt = `Bạn là Chuyên gia Tái Cấu Trúc Lộ Trình FutureTrace.
BỐI CẢNH:
- Đối tượng: ${student.stageLabel} (${context?.decision || currentReport.title || 'Người học'})
- Ngành nghề: ${domain.name} | Công cụ: ${domain.tools.slice(0, 3).join(', ')}
- Chỉ số: Học lực ${context?.academicPerformance || 3}/5 | Tài chính ${context?.personalFinance || 3}/5 | Áp lực ${context?.stress || 3}/5 | Rủi ro ${context?.risk || 3}/5
- Đã hoàn thành ${completedCount} cột mốc:
${completedSummary}
${pastFeedbackText ? `- Lịch sử biến cố trước đó: ${pastFeedbackText}\n` : ''}
BIẾN CỐ MỚI CẦN THÁO GỠ:
"${feedback}"
${ragPivotSnippet}
NHIỆM VỤ: Sinh ĐÚNG ${neededCount} cột mốc tiếp theo (${remainingPeriods.join(', ')}) để giải quyết dứt điểm biến cố trên.
LƯU Ý BẮT BUỘC:
- Các cột mốc tiếp theo TUYỆT ĐỐI KHÔNG ĐƯỢC lặp lại tên hoặc nội dung của các cột mốc đã hoàn thành.
- Mỗi cột mốc mới phải là một bước tiến mới thực tế để giải quyết khó khăn "${feedback}".

YÊU CẦU: Trả về DUY NHẤT một chuỗi JSON hợp lệ bắt đầu bằng { và kết thúc bằng }:
{
  "strategicPivotPoints": [
    {
      "condition": "Nếu ... (tình huống phát sinh cụ thể khi xử lý biến cố)",
      "action": "Thì ... (hành động xử lý dứt điểm thấu đáo)"
    },
    {
      "condition": "Nếu ... (tình huống phát sinh thứ hai)",
      "action": "Thì ... (hành động xử lý dứt điểm)"
    },
    {
      "condition": "Nếu ... (tình huống thuận lợi bứt phá)",
      "action": "Thì ... (hành động tận dụng bứt phá)"
    }
  ],
  "adjustedMilestones": [
${remainingPeriods.map(p => `    {
      "month": "${p}",
      "event": "Tên cột mốc cụ thể cho ${p} giải quyết khó khăn",
      "impact": "High",
      "probability": 85,
      "advice": "Lời khuyên chiến lược giải quyết biến cố cho ${p}",
      "tasks": [
        "Hành động thực tế trọng tâm 1",
        "Hành động thực tế trọng tâm 2"
      ]
    }`).join(',\n')}
  ],
  "longTermProjection": "Dự báo viễn cảnh 3-5 năm (35-45 từ) sau khi kiên cường vượt qua biến cố này."
}`;

        const pivotSysPrompt = 'Bạn là Chuyên gia Tái Cấu Trúc Lộ Trình FutureTrace. Trả về duy nhất một chuỗi JSON hợp lệ bắt đầu bằng { và kết thúc bằng }. Không giải thích.';

        const localRes = await generateWithOllama(ollamaPivotPrompt, pivotSysPrompt, {
          temperature: 0.35,
          maxTokens: 600,
          numCtx: 2048,
          timeout: 240000
        });

        const parsed = parseAndRepairJson(localRes.text, 'premium');

        // Dynamic synthesis recombination:
        // 1. Giữ nguyên 100% các cột mốc đã hoàn thành
        const finalMilestones = completedMilestones.map(m => ({
          ...m,
          completed: true,
          details: Array.isArray(m.details)
            ? m.details.map(s => ({ ...s, completed: true }))
            : []
        }));

        const rawAdjusted = Array.isArray(parsed.adjustedMilestones)
          ? parsed.adjustedMilestones
          : (Array.isArray(parsed.milestones) ? parsed.milestones : []);

        const completedEventTitles = new Set(
          completedMilestones.map(m => (m.event || m.title || '').trim().toLowerCase())
        );
        const completedMonths = new Set(
          completedMilestones.map(m => (m.month || '').trim().toLowerCase())
        );

        // Filter rawAdjusted to remove items that duplicate completed months or titles
        const cleanAdjusted = rawAdjusted.filter(m => {
          const mEvent = (m.event || m.title || '').trim().toLowerCase();
          const mMonth = (m.month || '').trim().toLowerCase();
          if (completedMonths.has(mMonth)) return false;
          if (completedEventTitles.has(mEvent)) return false;
          return true;
        });

        // Track used titles to guarantee no two milestones have the same name
        const usedMilestoneTitles = new Set([...completedEventTitles]);

        // 2. Mở rộng các cột mốc tiếp theo bằng 3-Tier Master Step Engine chuyên sâu cho Pivot
        for (let i = completedCount; i < 5; i++) {
          const period = ALL_PERIODS[i];
          const adjIndex = i - completedCount;
          const aiM = cleanAdjusted.find(m => m.month && (m.month.includes(period) || period.includes(m.month))) || cleanAdjusted[adjIndex] || {};

          let rawTitle = (aiM.event || aiM.title || '').trim();
          const isDuplicate = !rawTitle || usedMilestoneTitles.has(rawTitle.toLowerCase());

          const eventTitle = !isDuplicate ? rawTitle : (
            i === completedCount ? `Tháo gỡ biến cố: Tập trung giải quyết "${(feedback || '').slice(0, 45)}" (${period})` :
              i === completedCount + 1 ? `Phục hồi phong độ học thuật và ổn định tiến độ (${period})` :
                i === completedCount + 2 ? `Tăng tốc chuyên môn thực chiến và mở rộng năng lực (${period})` :
                  `Bứt phá đỉnh cao và đóng gói thành quả dài hạn (${period})`
          );
          usedMilestoneTitles.add(eventTitle.toLowerCase());

          const details = createPivot3TierSteps({
            milestoneIdx: i,
            completedCount,
            period,
            eventTitle,
            advice: aiM.advice || '',
            tasks: Array.isArray(aiM.tasks) ? aiM.tasks : [],
            domain,
            student,
            feedback
          });

          finalMilestones.push({
            month: period,
            event: eventTitle,
            impact: aiM.impact || (i <= completedCount ? 'High' : 'Medium'),
            probability: typeof aiM.probability === 'number' ? aiM.probability : 85,
            details
          });
        }

        // 3. Tường thuật chiến lược liên tục 5 giai đoạn (generatePivotMasterNarrative)
        const narrative = generatePivotMasterNarrative({
          currentReport,
          completedMilestones,
          feedback,
          feedbackHistory,
          context,
          timeframe,
          remainingMilestones: rawAdjusted,
          domain,
          student
        });

        // 4. Xử lý strategic pivot points chuẩn If/Then 3 tầng
        const defaultPivotPoints = [
          {
            condition: `Nếu thủ tục xin gia hạn học phí, hỗ trợ tài chính khó khăn hoặc đơn học vụ bị kéo dài hơn 2 tuần`,
            action: `Chủ động làm việc trực tiếp với Ban chủ nhiệm Khoa xin giấy xác nhận hoàn cảnh để tạm hoãn nghĩa vụ tài chính, đồng thời liên hệ Ngân hàng Chính sách Xã hội kích hoạt gói vay vốn sinh viên ưu đãi.`
          },
          {
            condition: `Nếu khối lượng học bù và làm bài tập chuyên ngành gây quá tải (Stress >= 4/5) hoặc điểm thi thử dưới 6.5`,
            action: `Giản lược ngay 1 mục tiêu phụ chưa cấp thiết, đăng ký tham gia nhóm phụ đạo trợ giảng (TA) 3 buổi/tuần và áp dụng kỹ thuật Time-boxing 50/10 để chia nhỏ áp lực bài vở.`
          },
          {
            condition: `Nếu hoàn thành kỳ thi trả nợ môn với điểm số xuất sắc (>= 8.0) và dòng tiền cá nhân sớm ổn định`,
            action: `Tái phân bổ ngay 10 giờ/tuần sang thực chiến dự án mã nguồn mở chuẩn ngành trên ${domain.tools[0] || 'GitHub'} và nộp hồ sơ xét học bổng khuyến khích học tập kỳ tiếp theo.`
          }
        ];

        let pivots = [];
        if (Array.isArray(parsed.strategicPivotPoints) && parsed.strategicPivotPoints.length > 0) {
          pivots = parsed.strategicPivotPoints.map((p, idx) => {
            const fallback = defaultPivotPoints[idx % defaultPivotPoints.length];
            if (typeof p === 'string') {
              const parts = p.split(/:\s*/);
              const cond = parts.length > 1 ? parts[0].trim() : '';
              const act = parts.length > 1 ? parts.slice(1).join(': ').trim() : p.trim();
              const isValidCond = cond && !/^(chiến lược|phương án|kế hoạch)\s*\d/i.test(cond) && cond.length >= 10;
              return {
                condition: isValidCond ? cond : fallback.condition,
                action: (act && act.length >= 20) ? act : fallback.action
              };
            }
            if (p && typeof p === 'object') {
              const cond = (p.condition || p.if || p.trigger || '').trim();
              const act = (p.action || p.then || p.solution || '').trim();
              const isValidCond = cond && !/^(chiến lược|phương án|kế hoạch)\s*\d/i.test(cond) && cond.length >= 10;
              return {
                condition: isValidCond ? cond : fallback.condition,
                action: (act && act.length >= 20) ? act : fallback.action
              };
            }
            return fallback;
          });
        }
        while (pivots.length < 3) {
          pivots.push(defaultPivotPoints[pivots.length]);
        }

        const synthesized = {
          influencingFactors: parsed.influencingFactors || currentReport.influencingFactors || [],
          detailedNarrative: narrative,
          milestones: finalMilestones,
          strategicPivotPoints: pivots,
          longTermProjection: parsed.longTermProjection || `Sau 3-5 năm kiên trì vượt khó và thích ứng linh hoạt, bạn sẽ xây dựng được bản lĩnh vững vàng trong ngành ${domain.name}, sở hữu năng lực chuyên môn thực chiến và tự tin nắm bắt các cơ hội nghề nghiệp xuất sắc.`
        };

        const normalized = normalizePremiumAnalysisResponse(synthesized, {
          title: currentReport.title || 'Lộ trình Tái cấu trúc',
          context,
          timeframe,
          ragData: pivotRagData
        });
        normalized.modelUsed = localRes.modelUsed;
        console.log(`[AI Pivot] ✅ Local OK. Preserved: ${completedCount}, Total Milestones: ${normalized.milestones?.length || 0}`);
        return normalized;
      }
    } catch (ollamaErr) {
      if (provider === 'ollama') throw ollamaErr;
      console.warn('[AI Pivot] Local Ollama failed, falling back to Gemini:', ollamaErr.message);
    }
  }

  // 2. Fallback Gemini Cloud
  try {
    const response = await callGeminiWithRetry(
      GEMINI_FALLBACK_MODELS,
      prompt,
      {
        responseMimeType: 'application/json',
        maxOutputTokens: 8192,
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            detailedNarrative: { type: Type.STRING },
            milestones: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  month: { type: Type.STRING },
                  event: { type: Type.STRING },
                  impact: { type: Type.STRING },
                  probability: { type: Type.NUMBER },
                  details: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        id: { type: Type.STRING },
                        title: { type: Type.STRING },
                        description: { type: Type.STRING },
                        objectives: {
                          type: Type.ARRAY,
                          items: { type: Type.STRING }
                        },
                        actions: {
                          type: Type.ARRAY,
                          items: { type: Type.STRING }
                        },
                        tools: {
                          type: Type.ARRAY,
                          items: { type: Type.STRING }
                        },
                        expectedResult: { type: Type.STRING },
                        completed: { type: Type.BOOLEAN }
                      },
                      required: ['id', 'title', 'description', 'objectives', 'actions', 'tools', 'expectedResult', 'completed']
                    }
                  }
                },
                required: ['month', 'event', 'impact', 'probability', 'details']
              }
            },
            influencingFactors: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  category: { type: Type.STRING },
                  factor: { type: Type.STRING },
                  influence: { type: Type.STRING },
                  description: { type: Type.STRING }
                },
                required: ['category', 'factor', 'influence', 'description']
              }
            },
            strategicPivotPoints: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  condition: { type: Type.STRING },
                  action: { type: Type.STRING }
                },
                required: ['condition', 'action']
              }
            },
            longTermProjection: { type: Type.STRING }
          },
          required: ['detailedNarrative', 'milestones', 'influencingFactors', 'strategicPivotPoints', 'longTermProjection']
        }
      }
    );

    let text = "";
    try {
      if (typeof response.text === 'string') {
        text = response.text.trim();
      } else if (typeof response.text === 'function') {
        text = response.text().trim();
      } else if (response.response && typeof response.response.text === 'function') {
        text = response.response.text().trim();
      }
    } catch (e) {
      console.error('[AI Text Extraction Error]:', e);
    }

    if (!text) {
      throw new Error('AI không trả về nội dung văn bản. Vui lòng thử lại.');
    }

    const parsed = parseAndRepairJson(text);
    const normalized = normalizePremiumAnalysisResponse(parsed, {
      title: currentReport.title || 'Lộ trình Tái cấu trúc',
      context,
      timeframe
    });
    normalized.modelUsed = response.modelUsed;
    normalized.usage = response.usage;
    return normalized;
  } catch (error) {
    if (error.message.includes('AI tra ve du lieu khong hop le')) {
      throw error;
    }
    console.error('[AI Error Details - Pivot]:', error);
    throw new Error('Loi khi xu ly du lieu tu AI. Vui long thu lai sau.');
  }
};


/**
 * Chuẩn hóa và làm giàu chi tiết SOP cho từng bước, đảm bảo không bao giờ rỗng hay lỗi
 */
const normalizeStepDetail = (parsed, fallbackInfo = {}) => {
  const { stepTitle = 'Nhiệm vụ trọng tâm', stepDescription = '', scenarioTitle = '' } = fallbackInfo;
  const p = parsed && typeof parsed === 'object' ? parsed : {};

  const description = (p.description && typeof p.description === 'string' && p.description.trim().length > 25 && !isEchoedPlaceholder(p.description))
    ? p.description.trim()
    : (stepDescription && stepDescription.length > 20
      ? `${stepDescription} Đây là nhiệm vụ trọng tâm đóng vai trò đòn bẩy trong giai đoạn này. Hãy tập trung cao độ, chuẩn bị kỹ lưỡng về tài liệu và thời gian để đạt kết quả xuất sắc.`
      : `Nhiệm vụ "${stepTitle}" đóng vai trò bản lề trong việc hoàn thành mục tiêu giai đoạn. Việc nắm vững các bước triển khai cụ thể sẽ giúp bạn chủ động thời gian, giảm thiểu sai sót và tối ưu hóa hiệu quả thực thi.`);

  let objectives = Array.isArray(p.objectives) ? p.objectives.filter(o => typeof o === 'string' && o.trim() && !isEchoedPlaceholder(o)) : [];
  if (objectives.length === 0) {
    objectives = [
      `Nắm vững quy trình và tiêu chuẩn đầu ra của nhiệm vụ "${stepTitle}"`,
      `Hoàn thành sản phẩm hoặc đồ án thực hành đúng hạn và đạt chất lượng cao`,
      `Tích lũy kinh nghiệm giải quyết vấn đề và bài học thực tiễn giá trị`
    ];
  }

  let actions = Array.isArray(p.actions) ? p.actions.filter(a => typeof a === 'string' && a.trim() && !isEchoedPlaceholder(a)) : [];
  if (actions.length === 0) {
    actions = [
      `Bước 1: Tìm hiểu tài liệu chuyên môn và các hướng dẫn chuẩn trên các nền tảng học tập uy tín (Coursera, Udemy, tài liệu chính thức).`,
      `Bước 2: Chuẩn bị công cụ, phần mềm làm việc cần thiết và thiết lập môi trường thực hành.`,
      `Bước 3: Bắt tay triển khai từng hạng mục nhỏ, ghi chép tiến độ và các lỗi gặp phải.`,
      `Bước 4: Tự kiểm thử hoặc nhờ bạn bè, mentor đánh giá và góp ý hoàn thiện.`,
      `Bước 5: Lưu trữ sản phẩm, tổng kết kết quả và rút ra kinh nghiệm cải tiến.`
    ];
  }

  let tools = Array.isArray(p.tools) ? p.tools.filter(t => typeof t === 'string' && t.trim() && !isEchoedPlaceholder(t)) : [];
  if (tools.length === 0) {
    tools = [
      'Notion / Trello (Quản lý tiến độ công việc)',
      'Công cụ thực hành chuyên ngành (IDE, phần mềm thiết kế hoặc nền tảng trực tuyến)',
      'Google Drive / GitHub (Lưu trữ và chia sẻ sản phẩm)'
    ];
  }

  const expectedResult = (p.expectedResult && typeof p.expectedResult === 'string' && p.expectedResult.trim().length > 10 && !isEchoedPlaceholder(p.expectedResult))
    ? p.expectedResult.trim()
    : `Sản phẩm thực tế của nhiệm vụ "${stepTitle}" được hoàn thành đầy đủ, đáp ứng yêu cầu chất lượng và sẵn sàng đưa vào hồ sơ năng lực (Portfolio).`;

  return {
    description,
    objectives,
    actions,
    tools,
    expectedResult
  };
};

const expandStepDetail = async (scenarioTitle, milestoneEvent, stepTitle, stepDescription, context) => {
  // RAG: Multi-Channel context for step execution SOP
  const stepSearch = `${stepTitle || ''} ${stepDescription || ''} ${milestoneEvent || ''} ${scenarioTitle || ''}`;
  const { ragData: stepRagData, ragSnippet: stepRagSnippet } = ragService.getAugmentedContext(stepTitle, stepSearch);

  const prompt = `
    Bạn là một chuyên gia tư vấn hướng nghiệp chuyên sâu và cố vấn học tập hàng đầu.
    Nhiệm vụ của bạn là tối ưu hóa và viết hướng dẫn cực kỳ chi tiết cho một bước cụ thể trong lộ trình phát triển.

    Thông tin bối cảnh:
    - Kịch bản tổng thể: ${scenarioTitle}
    - Cột mốc hiện tại: ${milestoneEvent}
    - Tên nhiệm vụ cần chi tiết hóa: ${stepTitle}
    - Mô tả sơ bộ hiện tại: ${stepDescription}
    ${context ? `- Bối cảnh cá nhân của học sinh: ${JSON.stringify(context)}` : ''}
    ${stepRagSnippet ? `\n    ${stepRagSnippet}\n` : ''}

    YÊU CẦU:
    Hãy mở rộng và viết lại nhiệm vụ này thành một hướng dẫn thực thi thực tế, chi tiết và vô cùng rõ ràng. Bạn PHẢI trả về một đối tượng JSON chứa các trường sau:
    1. description: Mô tả cực kỳ chi tiết và sâu sắc về nhiệm vụ, giải thích tại sao nhiệm vụ này quan trọng, cần lưu ý điều gì, làm thế nào để chuẩn bị tâm lý/kiến thức trước khi thực hiện. (Viết chi tiết bằng Tiếng Việt, độ dài từ 80 đến 150 từ).
    2. objectives: Danh sách gồm 3 đến 5 mục tiêu cụ thể, định lượng được và thực tế cần đạt được khi hoàn thành nhiệm vụ này. (Viết bằng Tiếng Việt).
    3. actions: Danh sách gồm 5 đến 8 hành động cực kỳ chi tiết từng bước một để thực hiện nhiệm vụ. Mỗi hành động phải là một chỉ dẫn thực tế rõ ràng:
       - Chỉ rõ CÁCH LÀM (làm như thế nào, phương pháp cụ thể).
       - Chỉ rõ LÀM Ở ĐÂU (ở website nào, học ở đâu, sử dụng tài nguyên/nền tảng cụ thể nào, ví dụ: Udemy, Coursera, Figma, VS Code, W3Schools, các trang web chính thức,...).
       - TUYỆT ĐỐI KHÔNG ghi chung chung như "đọc sách", "học kỹ năng", "xem video". Mỗi hành động phải dài ít nhất 15-20 từ.
    4. tools: Danh sách gồm 3 đến 5 công cụ, phần mềm, website hoặc tài nguyên học tập cụ thể khuyên dùng để làm nhiệm vụ này. (Viết bằng Tiếng Việt).
    5. expectedResult: Kết quả đầu ra mong muốn và sản phẩm thực tế cụ thể (ví dụ: một chứng chỉ hoàn thành khóa học, một project code trên GitHub, một bản thiết kế Figma link public,...) để người dùng tự đánh giá đã đạt yêu cầu hay chưa. (Viết bằng Tiếng Việt).

    Return ONLY a valid JSON object matching this schema:
    {
      "description": string,
      "objectives": string[],
      "actions": string[],
      "tools": string[],
      "expectedResult": string
    }

    Ngôn ngữ: Tiếng Việt.
  `;

  const provider = getAiProvider();

  // 1. Ưu tiên gọi Local Model Ollama trước
  if (provider === 'ollama' || provider === 'hybrid') {
    try {
      const health = await checkOllamaHealth();
      if (health.online && health.hasModel) {
        console.log(`[AI Step Detail] 🚀 Using Local Fine-Tuned Model via Ollama (DEEP STEP SOP)`);
        const ragStepSnippet = stepRagSnippet ? `\nTHÔNG TIN THỰC TẾ:\n${stepRagSnippet}\n` : '';
        const ollamaStepPrompt = `Bạn là CỐ VẤN HƯỚNG DẪN THỰC THI CHI TIẾT của FutureTrace.
Nhiệm vụ: Viết cẩm nang hướng dẫn hành động chuyên sâu (SOP) cho bước cụ thể trong lộ trình.

BỐI CẢNH:
- Kịch bản: ${scenarioTitle}
- Cột mốc: ${milestoneEvent}
- Nhiệm vụ: ${stepTitle}
- Mô tả ban đầu: ${stepDescription}
${context ? `- Bối cảnh cá nhân: ${JSON.stringify(context)}` : ''}${ragStepSnippet}

BẮT BUỘC: Bạn PHẢI trả về duy nhất một chuỗi JSON hợp lệ. Bắt đầu ngay bằng { và kết thúc bằng }:
{
  "description": "Mô tả chi tiết 80-120 từ giải thích tầm quan trọng, lưu ý cốt lõi và tư duy cần chuẩn bị khi thực hiện nhiệm vụ này.",
  "objectives": [
    "Mục tiêu định lượng cụ thể 1",
    "Mục tiêu định lượng cụ thể 2",
    "Mục tiêu định lượng cụ thể 3"
  ],
  "actions": [
    "Hành động 1: Chỉ rõ cách làm và địa chỉ học/thực hành (nền tảng, website, tài liệu cụ thể).",
    "Hành động 2: Chỉ rõ cách làm và địa chỉ học/thực hành (nền tảng, website, tài liệu cụ thể).",
    "Hành động 3: Chỉ rõ cách làm và địa chỉ học/thực hành (nền tảng, website, tài liệu cụ thể).",
    "Hành động 4: Chỉ rõ cách làm và địa chỉ học/thực hành (nền tảng, website, tài liệu cụ thể).",
    "Hành động 5: Chỉ rõ cách làm và địa chỉ học/thực hành (nền tảng, website, tài liệu cụ thể)."
  ],
  "tools": [
    "Công cụ hoặc phần mềm 1",
    "Công cụ hoặc phần mềm 2",
    "Công cụ hoặc phần mềm 3"
  ],
  "expectedResult": "Sản phẩm đầu ra cụ thể, có thể đo lường và đưa vào Portfolio."
}`;
        const stepSystemPrompt = 'Bạn là CỐ VẤN HƯỚNG DẪN THỰC THI CHI TIẾT của FutureTrace. Chỉ trả về JSON thuần túy bắt đầu bằng { và kết thúc bằng }.';
        const localRes = await generateWithOllama(ollamaStepPrompt, stepSystemPrompt, {
          temperature: 0.2,
          maxTokens: 500,
          numCtx: 2048,
          timeout: 120000
        });
        const parsed = parseAndRepairJson(localRes.text, 'step');
        const normalized = normalizeStepDetail(parsed, { stepTitle, stepDescription, scenarioTitle });
        normalized.modelUsed = localRes.modelUsed;
        return normalized;
      }
    } catch (ollamaErr) {
      if (provider === 'ollama') throw ollamaErr;
      console.warn('[AI Step Detail] Local Ollama failed, falling back to Gemini:', ollamaErr.message);
    }
  }

  // 2. Fallback Gemini Cloud
  try {
    const response = await callGeminiWithRetry(
      GEMINI_FALLBACK_MODELS,
      prompt,
      {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            description: { type: Type.STRING },
            objectives: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            },
            actions: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            },
            tools: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            },
            expectedResult: { type: Type.STRING }
          },
          required: ['description', 'objectives', 'actions', 'tools', 'expectedResult']
        }
      }
    );

    let text = "";
    try {
      if (typeof response.text === 'string') {
        text = response.text.trim();
      } else if (typeof response.text === 'function') {
        text = response.text().trim();
      } else if (response.response && typeof response.response.text === 'function') {
        text = response.response.text().trim();
      } else if (response.candidates && response.candidates[0]?.content?.parts?.[0]?.text) {
        text = response.candidates[0].content.parts[0].text.trim();
      }
    } catch (e) {
      console.error('[AI Text Extraction Error]:', e);
    }

    if (!text) {
      throw new Error('AI không trả về nội dung văn bản. Vui lòng thử lại.');
    }

    const parsed = parseAndRepairJson(text, 'step');
    const normalized = normalizeStepDetail(parsed, { stepTitle, stepDescription, scenarioTitle });
    normalized.modelUsed = response.modelUsed;
    normalized.usage = response.usage;
    return normalized;
  } catch (error) {
    console.error('[AI Expand Step Detail Error]:', error);
    throw error;
  }
};

module.exports = {
  generateSimulation,
  generatePremiumAnalysis,
  pivotPremiumAnalysis,
  expandStepDetail,
  analyzeInputReadiness,
  normalizeSimulationResponse,
  normalizePremiumAnalysisResponse,
  parseAndRepairJson,
  checkOllamaHealth,
  generateWithOllama,
  detectDomainProfile,
  extractHolisticStudentContext,
  computePeriodLabels,
  sanitizeDecision,
  buildCareerQuant,
  formatQuantSnippet
};
