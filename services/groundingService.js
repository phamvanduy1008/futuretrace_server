/**
 * Grounding Verifier: mọi con số mang tính dữ liệu trong văn bản AI phải có căn cứ.
 *
 * - "Tuyên bố số liệu" = số đi kèm đơn vị dữ liệu: triệu/tr/tỷ (tiền), % (tỷ lệ), điểm (điểm chuẩn), USD.
 *   Số chỉ thời lượng kế hoạch (3 tháng, 90 ngày, 5 năm...) và số thứ tự không bị kiểm.
 * - Căn cứ hợp lệ: giá trị/khoảng trong Fact Sheet, số liệu FT-Salary/ROI đã tính, thông tin người dùng nhập.
 * - Câu chứa tuyên bố không căn cứ bị loại khỏi văn bản; tỷ lệ groundedness được trả về để log và hiển thị.
 */

const CLAIM_RE = /((?<![\d.,])[-−]?\d+(?:[.,]\d+)?)\s*(triệu|tr(?![\p{L}])|tỷ|%|phần trăm|điểm|usd|\$)/giu;

const toNumber = (s) => Number(String(s).replace('−', '-').replace(',', '.'));

/** Thu thập các giá trị số được phép từ Fact Sheet, quant và input người dùng */
const collectAllowed = ({ facts = [], quant = null, input = {} }) => {
  const allowed = [];
  const push = (v) => { if (typeof v === 'number' && Number.isFinite(v)) allowed.push(v); };
  for (const f of facts) {
    push(f.value);
    if (Array.isArray(f.range)) f.range.forEach(push);
  }
  if (quant?.scenarios) {
    for (const s of Object.values(quant.scenarios)) {
      push(s.salary?.startMonthlyMillion);
      push(s.salary?.year5MonthlyMillion);
      push(s.salary?.counterfactualStartMillion);
      push(s.roi && Math.round(s.roi.ratio * 100));
      push(s.affordability?.cashNeedPerYearMillion);
      push(s.affordability?.familyCapacityPerYearMillion);
      push(s.affordability?.gapPerYearMillion);
      push(s.probability);
      for (const band of Object.values(s.expectedSalary || {})) {
        push(band.min); push(band.avg); push(band.max);
      }
    }
    push(quant.market?.demandMomentumPercentPerYear);
    push(quant.market?.salaryGrowthPercentPerYear);
    push(quant.assumptions?.tuitionPerYearMillion);
    push(quant.assumptions?.studentLivingMonthlyMillion);
    push(quant.assumptions?.discountRate && quant.assumptions.discountRate * 100);
  }
  push(input.expectedScore);
  push(input.budgetPerYearMillion);
  return allowed;
};

const isGrounded = (value, allowed) => allowed.some(a => {
  const tol = Math.max(0.3, Math.abs(a) * 0.06); // ±6% (làm tròn khi diễn đạt), tối thiểu 0,3
  return Math.abs(value - a) <= tol;
});

/** Kiểm một đoạn văn: trả về văn bản đã loại câu không căn cứ + thống kê */
const verifyText = (text, allowed) => {
  if (!text || typeof text !== 'string') return { text, claims: 0, grounded: 0, removed: [] };
  const sentences = text.split(/(?<=[.!?…])\s+/);
  let claims = 0;
  let grounded = 0;
  const removed = [];
  const kept = sentences.filter((sentence) => {
    const found = [...sentence.matchAll(CLAIM_RE)];
    if (!found.length) return true;
    let ok = true;
    for (const m of found) {
      claims++;
      if (isGrounded(toNumber(m[1]), allowed)) grounded++;
      else ok = false;
    }
    if (!ok) removed.push(sentence.trim());
    return ok;
  });
  return { text: kept.join(' ').trim(), claims, grounded, removed };
};

/**
 * Kiểm toàn bộ kết quả mô phỏng (summary, mô tả, lời khuyên, SWOT, sprint, timeline). Sửa tại chỗ.
 * @returns {{claims:number, grounded:number, groundedness:number|null, removed:string[]}}
 */
const verifySimulation = (result, context) => {
  const allowed = collectAllowed(context);
  const stats = { claims: 0, grounded: 0, removed: [] };
  const check = (obj, key) => {
    if (!obj || typeof obj[key] !== 'string') return;
    const r = verifyText(obj[key], allowed);
    stats.claims += r.claims;
    stats.grounded += r.grounded;
    stats.removed.push(...r.removed);
    obj[key] = r.text;
  };

  check(result, 'summary');
  for (const k of ['start', 'sixMonths', 'oneYear', 'threeYears']) check(result.timeline, k);
  for (const s of result.scenarios || []) {
    check(s, 'description');
    check(s.deepAnalysis, 'criticalAdvice');
    if (s.marketFit) check(s.marketFit, 'analysis');
    for (const item of s.deepAnalysis?.swot || []) check(item, 'value');
    for (const phase of s.deepAnalysis?.sprint90 || []) {
      if (Array.isArray(phase.tasks)) {
        phase.tasks = phase.tasks.map(t => verifyText(t, allowed)).map((r) => {
          stats.claims += r.claims;
          stats.grounded += r.grounded;
          stats.removed.push(...r.removed);
          return r.text;
        }).filter(Boolean);
      }
    }
  }
  return {
    ...stats,
    groundedness: stats.claims ? Math.round((stats.grounded / stats.claims) * 1000) / 1000 : null
  };
};

/**
 * Bản dành cho lộ trình (premium/pivot/bước): chỉ kiểm câu có số đi kèm TỪ KHÓA DỮ LIỆU (lương, điểm chuẩn, học phí,
 * ROI, xác suất đỗ...). Mục tiêu cá nhân ("đạt 80% bài tập", "đạt 7,0 điểm IELTS") không phải dữ liệu thị trường nên
 * không bị loại.
 */
const DATA_KEYWORDS = /lương|thu nhập|điểm chuẩn|điểm sàn|học phí|chi phí|sinh hoạt phí|\bROI\b|hoàn vốn|xác suất|tỷ lệ (việc làm|thất nghiệp|trúng tuyển|có việc)|tin tuyển|nhu cầu tiền|khả năng chi|lãi suất|khoản vay|mức vay/i;
const isDataSentence = (sentence) => DATA_KEYWORDS.test(sentence) && CLAIM_RE.test(sentence) && (CLAIM_RE.lastIndex = 0, true);
const verifyDataText = (text, allowed) => {
  if (!text || typeof text !== 'string') return { text, claims: 0, grounded: 0, removed: [] };
  const sentences = text.split(/(?<=[.!?…])\s+/);
  let claims = 0;
  let grounded = 0;
  const removed = [];
  const kept = sentences.filter((sentence) => {
    if (!DATA_KEYWORDS.test(sentence)) return true;
    let ok = true;
    for (const m of sentence.matchAll(CLAIM_RE)) {
      claims++;
      if (isGrounded(toNumber(m[1]), allowed)) grounded++;
      else ok = false;
    }
    if (!ok) removed.push(sentence.trim());
    return ok;
  });
  return { text: kept.join(' ').trim(), claims, grounded, removed };
};

module.exports = { verifySimulation, verifyText, verifyDataText, collectAllowed, CLAIM_RE, DATA_KEYWORDS, isDataSentence };
