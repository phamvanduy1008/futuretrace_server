/**
 * FutureTrace Career ROI Engine
 * =========================================================================
 * Thay thế các chỉ số careerGrowth / roi cố định (92/90, 78/75, 58/52) bằng
 * phép tính định lượng, minh bạch, kiểm chứng được:
 *
 *  - Lương: FT-Salary (careerModelService) - phân vị P25/P50/P75 theo ngành,
 *    chức danh, kinh nghiệm, học vấn, khu vực.
 *  - 3 kịch bản = 3 phân vị lương thực tế của thị trường:
 *      Positive  -> P75, tìm việc 2 tháng      (~25% người học đạt mức này hoặc cao hơn)
 *      Neutral   -> P50, tìm việc 4 tháng      (~50% nằm quanh vùng P25-P75)
 *      Risk      -> P25, tìm việc 9 tháng, trễ 1 năm học
 *  - ROI kinh tế (human-capital ROI, Becker 1964; Psacharopoulos & Patrinos 2018):
 *      ROI = (PV[thu nhập có bằng - thu nhập phản thực tế] - PV[học phí + thu nhập bỏ lỡ]) / PV[chi phí]
 *    Thu nhập phản thực tế = lương dự báo của người chỉ tốt nghiệp THPT đi làm ngay.
 *  - Chi phí sinh hoạt KHÔNG tính vào ROI (người học vẫn phải sống dù có đi học hay không),
 *    nhưng được tính vào "nhu cầu tiền mặt" để đối chiếu năng lực tài chính gia đình.
 *
 * Mọi giả định nằm trong ASSUMPTIONS và được trả về cùng kết quả để người dùng / hội đồng
 * thẩm định có thể kiểm tra lại.
 * =========================================================================
 */

const careerModelService = require('./careerModelService');

const ASSUMPTIONS = {
  discountRate: 0.07,              // ~ lãi suất tiết kiệm 12 tháng + lạm phát kỳ vọng
  lensYears: 20,                   // khung 20 năm: đủ dài cho đầu tư giáo dục, vẫn trong vùng dữ liệu (kinh nghiệm <= 15 năm)
  marketSalaryGrowthCap: [-0.02, 0.08],
  maxSupportedExpYears: 8,
  // Học phí trung bình/năm (triệu VND) khi chưa có dữ liệu trường cụ thể
  tuitionPerYearMillion: {
    default: 30,                   // ĐH công lập tự chủ phổ biến 2025-2026
    DU_HOC_QUOC_TE: 600,
    THAC_SI_NGHIEN_CUU: 45
  },
  // Ngân sách sinh hoạt sinh viên (triệu VND/tháng) khi RAG không khớp được thành phố.
  // Nguồn chính là data/rag/living_costs_index.json (build_rag_knowledge.py, cùng công thức).
  studentLivingMonthlyMillion: { reg_hn: 5.9, reg_hcm: 6.0, reg_dn: 6.7, other: 4.5 },
  // Khả năng chi trả/năm (triệu VND) theo thang tài chính 1-5 người dùng tự đánh giá
  familyCapacityPerYearMillion: { 1: 15, 2: 40, 3: 80, 4: 150, 5: 300 },
  counterfactual: { title: 'Nhân viên', industry: 'Lao động phổ thông', eduLevel: 1, posLevel: 1 }
};

// [năm còn lại trước khi bắt đầu học có chi phí, số năm học có học phí]
const STAGE_TIMING = {
  THPT_CHON_TO_HOP: { preYears: 2, studyYears: 4 },
  THPT_ON_THI_DAI_HOC: { preYears: 1, studyYears: 4 },
  DAI_HOC_DAI_CUONG: { preYears: 0, studyYears: 3 },
  DAI_HOC_CHUYEN_NGANH_THUC_TAP: { preYears: 0, studyYears: 1 },
  CHUYEN_NGANH_SONG_BANG: { preYears: 0, studyYears: 2 },
  THAC_SI_NGHIEN_CUU: { preYears: 0, studyYears: 2 },
  DU_HOC_QUOC_TE: { preYears: 1, studyYears: 4 },
  KHOI_NGHIEP_FREELANCE: { preYears: 0, studyYears: 0 },
  CHUYEN_NGANH_DI_LAM: { preYears: 0, studyYears: 0 }
};

const SCENARIOS = {
  Positive: { quantile: 'p75', searchMonths: 2, extraYears: 0, promoteAtExp: 4, probability: 25 },
  Neutral: { quantile: 'p50', searchMonths: 4, extraYears: 0, promoteAtExp: 6, probability: 50 },
  Risk: { quantile: 'p25', searchMonths: 9, extraYears: 1, promoteAtExp: 99, probability: 25 }
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round1 = (v) => Math.round(v * 10) / 10;

const detectRegionKey = (text) => {
  const { flagsOf, REGIONS } = careerModelService.internals;
  const flags = flagsOf(text, REGIONS);
  return ['reg_hn', 'reg_hcm', 'reg_dn'].find(k => flags[k]) || 'other';
};

/**
 * @param {object} p
 * @param {string} p.stage          - stage từ extractHolisticStudentContext
 * @param {string} p.decisionText   - mô tả quyết định của người học
 * @param {string} p.industryText   - ngành (khớp market_intelligence / domains)
 * @param {string} p.roleTitle      - chức danh mục tiêu (nếu RAG tìm được)
 * @param {string} p.locationText
 * @param {number} p.personalFinance (1-5)
 * @param {number} p.tuitionPerYearMillion (tùy chọn, ghi đè mặc định)
 * @returns {object|null} quant theo từng kịch bản
 */
const computeCareerQuant = (p = {}) => {
  if (!careerModelService.isReady()) return null;

  const timing = STAGE_TIMING[p.stage] || STAGE_TIMING.DAI_HOC_DAI_CUONG;
  const tuition = p.tuitionPerYearMillion
    ?? ASSUMPTIONS.tuitionPerYearMillion[p.stage]
    ?? ASSUMPTIONS.tuitionPerYearMillion.default;
  const tuitionSource = p.tuitionPerYearMillion != null
    ? (p.tuitionSource || 'program')
    : 'default';
  const regionKey = detectRegionKey(`${p.locationText || ''} ${p.decisionText || ''}`);
  const living = p.livingMonthlyMillion ?? ASSUMPTIONS.studentLivingMonthlyMillion[regionKey];
  const locationText = p.locationText || p.decisionText || '';
  const title = `${p.roleTitle || ''} ${p.decisionText || ''}`.trim();
  const eduLevel = 4; // dữ liệu tuyển dụng gộp ĐH / Thạc sĩ vào cùng một mức

  const trend = careerModelService.industryTrend(p.industryText);
  const [gLo, gHi] = ASSUMPTIONS.marketSalaryGrowthCap;
  const marketGrowth = clamp(trend?.salaryCagr ?? 0.04, gLo, gHi);
  const momentum = trend?.demandMomentumCagr ?? 0;

  const salaryCache = new Map();
  const salaryAt = (rawExpYears, posLevel, isCounterfactual = false) => {
    // Tin tuyển dụng > 8 năm kinh nghiệm rất thưa; sau mốc này chỉ tăng theo lương thị trường
    const expYears = Math.min(rawExpYears, ASSUMPTIONS.maxSupportedExpYears);
    const key = `${expYears}|${posLevel}|${isCounterfactual}`;
    if (!salaryCache.has(key)) {
      const profile = isCounterfactual
        ? { ...ASSUMPTIONS.counterfactual, expYears, location: locationText }
        : { title, industry: p.industryText, expYears, eduLevel, posLevel, location: locationText };
      salaryCache.set(key, careerModelService.predictSalary(profile));
    }
    return salaryCache.get(key);
  };

  const entry = salaryAt(0.5, 1);
  const confidence = entry.evidence.matchedSegments.length > 0
    ? (entry.evidence.matchedTokens.length > 0 ? 'high' : 'medium')
    : (entry.evidence.matchedTokens.length > 0 ? 'medium' : 'low');

  const results = {};
  for (const [type, cfg] of Object.entries(SCENARIOS)) {
    const studyYears = timing.studyYears + cfg.extraYears;
    const workStart = timing.preYears + studyYears;
    let pvCost = 0;
    let pvBenefit = 0;
    let cashNeed = 0;
    let cumulative = 0;
    let paybackYear = null;

    for (let t = 0; t < ASSUMPTIONS.lensYears; t++) {
      const df = Math.pow(1 + ASSUMPTIONS.discountRate, -t);
      const growth = Math.pow(1 + marketGrowth, t);
      // Người phản thực tế đi làm từ khi lẽ ra bắt đầu học (sau preYears)
      const cfExp = t - timing.preYears;
      const cfAnnual = cfExp >= 0 ? salaryAt(Math.max(0, cfExp), 1, true).p50 * 12 * growth : 0;
      let flow = 0;

      if (t >= timing.preYears && t < workStart) {
        const direct = tuition * (cfg.extraYears && t === workStart - 1 ? 0.5 : 1);
        pvCost += (direct + cfAnnual) * df;
        cashNeed += direct + living * 12;
        flow = -(direct + cfAnnual);
      } else if (t >= workStart) {
        const exp = t - workStart + 0.5;
        const pos = exp >= cfg.promoteAtExp ? 2 : 1;
        const employed = t === workStart ? 1 - cfg.searchMonths / 12 : 1;
        const degreeAnnual = salaryAt(exp, pos)[cfg.quantile] * 12 * growth * employed;
        const gain = degreeAnnual - cfAnnual;
        if (gain >= 0) pvBenefit += gain * df; else pvCost += -gain * df;
        flow = gain;
      }
      cumulative += flow;
      if (paybackYear === null && t >= workStart && cumulative >= 0) paybackYear = t + 1;
    }

    const roiRatio = pvCost > 0 ? (pvBenefit - pvCost) / pvCost : 0;
    const startSal = salaryAt(0.5, 1)[cfg.quantile];
    const fiveYearSal = salaryAt(5.5, 5 >= cfg.promoteAtExp ? 2 : 1)[cfg.quantile];
    const growthRatio = fiveYearSal / Math.max(salaryAt(0.5, 1).p50, 0.1);

    // Ưu tiên ngân sách người dùng nhập (triệu/năm); không có thì suy từ thang tài chính 1-5
    const capacity = p.budgetPerYearMillion > 0
      ? p.budgetPerYearMillion
      : ASSUMPTIONS.familyCapacityPerYearMillion[clamp(Math.round(p.personalFinance ?? 3), 1, 5)];
    const cashNeedPerYear = studyYears > 0 ? cashNeed / studyYears : 0;

    const salaryBand = (exp) => {
      const s = salaryAt(exp, exp >= cfg.promoteAtExp ? 2 : 1);
      return { min: round1(s.p25), avg: round1(s.p50), max: round1(s.p75) };
    };

    results[type] = {
      // Điểm 0-100 cho giao diện: ROI = 0 -> 50, 100% -> 65, 300% -> 84, 700% -> 94 (không bão hòa sớm)
      roiScore: Math.round(clamp(50 + 45 * Math.tanh(roiRatio / 3), 5, 98)),
      // Động lượng nhu cầu chỉ là tín hiệu phụ (dữ liệu trộn nguồn, nhãn ngành trôi theo năm): tối đa ±10 điểm
      careerGrowthScore: Math.round(clamp(20 + 60 * Math.log(growthRatio) / Math.log(3) + 40 * momentum, 5, 98)),
      probability: cfg.probability,
      roi: {
        ratio: Math.round(roiRatio * 100) / 100,
        pvCostMillion: Math.round(pvCost),
        pvBenefitMillion: Math.round(pvBenefit),
        paybackYearFromNow: paybackYear,
        lensYears: ASSUMPTIONS.lensYears
      },
      salary: {
        quantile: cfg.quantile,
        startMonthlyMillion: round1(startSal),
        year5MonthlyMillion: round1(fiveYearSal),
        counterfactualStartMillion: round1(salaryAt(0, 1, true).p50)
      },
      // Khớp schema SimulationScenario.expected_salary (số năm kinh nghiệm sau khi tốt nghiệp)
      expectedSalary: { year_3: salaryBand(3), year_5: salaryBand(5), year_10: salaryBand(10) },
      affordability: {
        cashNeedPerYearMillion: Math.round(cashNeedPerYear),
        familyCapacityPerYearMillion: capacity,
        gapPerYearMillion: Math.max(0, Math.round(cashNeedPerYear - capacity)),
        affordable: cashNeedPerYear <= capacity
      }
    };
  }

  return {
    model: careerModelService.model.version,
    confidence,
    evidence: entry.evidence,
    market: trend ? {
      segments: trend.segments,
      period: trend.period,
      demandMomentumPercentPerYear: Math.round(momentum * 1000) / 10,
      salaryGrowthPercentPerYear: Math.round(trend.salaryCagr * 1000) / 10,
      postingsAnalyzed: trend.totalPostings
    } : null,
    assumptions: {
      discountRate: ASSUMPTIONS.discountRate,
      lensYears: ASSUMPTIONS.lensYears,
      tuitionPerYearMillion: tuition,
      tuitionSource,
      studentLivingMonthlyMillion: living,
      region: regionKey,
      stageTiming: timing,
      marketSalaryGrowth: Math.round(marketGrowth * 1000) / 10
    },
    scenarios: results
  };
};

/**
 * Chỉ số hạnh phúc: không có dữ liệu thị trường đo được, nên dùng giá trị AI nếu hợp lệ,
 * ngược lại dùng heuristic minh bạch từ áp lực & khả năng tài chính. Luôn ghi rõ nguồn.
 */
const estimateHappiness = (type, aiValue, ctx = {}, quantScenario = null) => {
  if (typeof aiValue === 'number' && aiValue >= 20 && aiValue <= 99) {
    return { value: Math.round(aiValue), source: 'ai' };
  }
  const base = { Positive: 74, Neutral: 70, Risk: 56 }[type] ?? 65;
  const stressPenalty = 4 * ((ctx.stress ?? 3) - 3);
  const financeAdj = quantScenario ? (quantScenario.affordability.affordable ? 4 : -6) : 0;
  return { value: Math.round(clamp(base - stressPenalty + financeAdj, 10, 95)), source: 'heuristic' };
};

module.exports = {
  computeCareerQuant,
  estimateHappiness,
  detectRegionKey,
  ASSUMPTIONS
};
