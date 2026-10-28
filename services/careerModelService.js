/**
 * FutureTrace Career Model Service (FT-Salary)
 * =========================================================================
 * Chạy model dự báo phân phối lương P25/P50/P75 (triệu VND/tháng) được huấn luyện
 * bởi ml/train_salary_model.py trên 606.878 tin tuyển dụng (2022-2026).
 *
 * Các hàm chuẩn hóa dưới đây là bản mirror 1-1 của ml/features.py.
 * Sửa ở một bên thì PHẢI sửa bên kia và chạy lại: node ml/check_parity.js
 * =========================================================================
 */

const fs = require('fs');
const path = require('path');

const ML_DIR = path.join(__dirname, '../data/ml');

const normText = (s) => {
  if (s === null || s === undefined) return '';
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
};

const parseExperience = (raw) => {
  const n = normText(raw);
  if (!n) return null;
  if (n.includes('duoi 1')) return 0.5;
  const nums = (n.match(/\d+(?:\.\d+)?/g) || []).slice(0, 2).map(Number);
  if (nums.length) return Math.min(nums.reduce((a, b) => a + b, 0) / nums.length, 20);
  if (n.startsWith('khong') || n.includes('chua co')) return 0;
  return null;
};

const EDU_RULES = [
  [['dai hoc', 'cu nhan', 'ky su', 'thac si'], 4],
  [['cao dang'], 3],
  [['trung cap'], 2],
  [['chung chi'], 1.5],
  [['trung hoc', 'thpt'], 1],
  [['khong'], 0]
];

const POSITION_RULES = [
  [['pho giam doc', 'giam doc', 'director'], 4],
  [['truong phong', 'pho phong', 'quan ly', 'manager'], 3],
  [['truong nhom', 'giam sat', 'to truong', 'leader', 'truong ca'], 2],
  [['chuyen gia'], 2.5],
  [['chuyen vien'], 1.5],
  [['thuc tap'], 0],
  [['cong tac vien'], 0.5],
  [['nhan vien'], 1]
];

const matchRules = (raw, rules) => {
  const n = normText(raw);
  for (const [keys, val] of rules) {
    if (keys.some(k => n.includes(k))) return val;
  }
  return null;
};

const REGIONS = {
  reg_hcm: ['ho chi minh', 'hcm', 'sai gon', 'thu duc'],
  reg_hn: ['ha noi'],
  reg_dn: ['da nang'],
  reg_south_ind: ['binh duong', 'dong nai', 'long an', 'ba ria', 'vung tau'],
  reg_north_ind: ['bac ninh', 'hai phong', 'hung yen', 'hai duong', 'vinh phuc', 'bac giang', 'quang ninh']
};

const JOB_TYPES = {
  jt_fulltime: ['toan thoi gian'],
  jt_parttime: ['ban thoi gian', 'thoi vu', 'theo ca'],
  jt_intern: ['thuc tap'],
  jt_remote: ['remote']
};

const flagsOf = (raw, table) => {
  const padded = ` ${normText(raw)} `;
  const out = {};
  for (const [k, kws] of Object.entries(table)) {
    out[k] = kws.some(kw => padded.includes(` ${kw} `)) ? 1 : 0;
  }
  return out;
};

const titleTokens = (raw) => {
  const words = normText(raw).split(' ').filter(w => w && !/^\d+$/.test(w));
  const toks = new Set(words);
  for (let i = 0; i + 1 < words.length; i++) toks.add(`${words[i]} ${words[i + 1]}`);
  return toks;
};

const industrySegments = (raw) => {
  if (raw === null || raw === undefined) return new Set();
  return new Set(String(raw).split('/').map(normText).filter(Boolean));
};

const toFloat32 = (x) => Math.fround(x);

const evalTrees = (trees, x) => {
  let total = 0;
  for (const tr of trees) {
    let i = 0;
    while (tr.f[i] !== -1) {
      const val = x[tr.f[i]];
      if (val === null || val === undefined || Number.isNaN(val)) {
        i = tr.m[i];
      } else {
        i = toFloat32(val) < toFloat32(tr.t[i]) ? tr.y[i] : tr.n[i];
      }
    }
    total += tr.v[i];
  }
  return total;
};

class CareerModelService {
  constructor() {
    this.model = null;
    this.trends = null;
    this.report = null;
    this.load();
  }

  load() {
    try {
      const modelPath = path.join(ML_DIR, 'salary_model.json');
      if (!fs.existsSync(modelPath)) {
        console.warn('[Career Model] salary_model.json chưa có. Chạy: python -I ml/train_salary_model.py');
        return;
      }
      this.model = JSON.parse(fs.readFileSync(modelPath, 'utf-8'));
      this.featureIndex = new Map(this.model.feature_names.map((f, i) => [f, i]));
      this.titleVocab = new Set(this.model.vocab.title_tokens);
      this.industryVocab = new Set(this.model.vocab.industry_segments);

      const trendsPath = path.join(ML_DIR, 'market_trends.json');
      if (fs.existsSync(trendsPath)) this.trends = JSON.parse(fs.readFileSync(trendsPath, 'utf-8'));
      const reportPath = path.join(ML_DIR, 'salary_model_report.json');
      if (fs.existsSync(reportPath)) this.report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));

      const nTrees = Object.values(this.model.quantiles).reduce((a, q) => a + q.trees.length, 0);
      console.log(`[Career Model] Loaded ${this.model.version}: ${this.model.feature_names.length} features, ${nTrees} trees`);
    } catch (err) {
      console.error('[Career Model] Load failed:', err.message);
      this.model = null;
    }
  }

  isReady() {
    return !!this.model;
  }

  /**
   * Vector hóa một hồ sơ. Nhận chuỗi thô giống dữ liệu tuyển dụng, hoặc giá trị số
   * đã chuẩn hóa (expYears / eduLevel / posLevel) để mô phỏng lộ trình.
   */
  vectorize(profile = {}) {
    const x = new Array(this.model.feature_names.length).fill(0);
    const set = (name, val) => {
      const i = this.featureIndex.get(name);
      if (i !== undefined) x[i] = val;
    };
    const num = (v) => (v === null || v === undefined ? NaN : v);

    set('exp_years', num(profile.expYears ?? parseExperience(profile.experience)));
    set('edu_level', num(profile.eduLevel ?? matchRules(profile.education, EDU_RULES)));
    set('pos_level', num(profile.posLevel ?? matchRules(profile.position, POSITION_RULES)));
    set('year', profile.year ?? this.trends?.period?.[1] ?? 2025);

    for (const [k, v] of Object.entries(flagsOf(profile.location, REGIONS))) set(k, v);
    for (const [k, v] of Object.entries(flagsOf(profile.jobType ?? 'Toàn thời gian', JOB_TYPES))) set(k, v);

    const matchedSegments = [...industrySegments(profile.industry)].filter(s => this.industryVocab.has(s));
    matchedSegments.forEach(s => set(`ind:${s}`, 1));
    const matchedTokens = [...titleTokens(profile.title)].filter(t => this.titleVocab.has(t));
    matchedTokens.forEach(t => set(`t:${t}`, 1));

    return { x, matchedSegments, matchedTokens };
  }

  predictFromVector(x) {
    const margin = {};
    for (const [name, q] of Object.entries(this.model.quantiles)) {
      margin[name] = q.base_score + evalTrees(q.trees, x);
    }
    // Đảm bảo thứ tự phân vị (quantile crossing), rồi nới khoảng theo hiệu chỉnh conformal (CQR)
    const [m25, m50, m75] = [margin.p25, margin.p50, margin.p75].sort((a, b) => a - b);
    const offset = this.model.calibration?.interval_offset_log || 0;
    return { p25: Math.exp(m25 - offset), p50: Math.exp(m50), p75: Math.exp(m75 + offset) };
  }

  /** Dự báo lương tháng (triệu VND) theo phân vị */
  predictSalary(profile) {
    if (!this.isReady()) return null;
    const { x, matchedSegments, matchedTokens } = this.vectorize(profile);
    const pred = this.predictFromVector(x);
    const round = (v) => Math.round(v * 10) / 10;
    return {
      p25: round(pred.p25),
      p50: round(pred.p50),
      p75: round(pred.p75),
      evidence: { matchedSegments, matchedTokens: matchedTokens.slice(0, 8) }
    };
  }

  /** Động lượng nhu cầu tuyển dụng & tăng trưởng lương danh nghĩa của các ngành khớp */
  industryTrend(industryText) {
    if (!this.trends) return null;
    const segs = [...industrySegments(industryText)].filter(s => this.trends.industries[s]?.reliable);
    if (!segs.length) return null;
    const items = segs.map(s => this.trends.industries[s]);
    const avg = (key) => items.reduce((a, it) => a + it[key], 0) / items.length;
    return {
      segments: segs,
      period: this.trends.period,
      demandMomentumCagr: avg('demand_momentum_cagr'),
      salaryCagr: avg('salary_cagr'),
      totalPostings: items.reduce((a, it) => a + it.total_postings, 0)
    };
  }

  getReport() {
    return this.report;
  }
}

const careerModelService = new CareerModelService();
careerModelService.internals = { normText, parseExperience, titleTokens, industrySegments, flagsOf, evalTrees, REGIONS, JOB_TYPES };
module.exports = careerModelService;
