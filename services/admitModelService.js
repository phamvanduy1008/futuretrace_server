/**
 * FT-Admit: xác suất trúng tuyển (phương thức điểm thi THPT, thang 30).
 * =========================================================================
 * Điểm chuẩn năm tới C ~ Normal(mu, sigma):
 *   mu    = w * (điểm năm gần nhất) + (1 - w) * (trung bình tối đa 3 năm gần nhất)
 *   sigma = độ biến động năm-qua-năm của nhóm ngành (3 chữ số mã ngành), học từ dữ liệu nhiều năm;
 *           nhân thêm hệ số khi lịch sử vắt qua mốc đổi chương trình 2025 (GDPT 2018, tổ hợp X).
 *   P(đỗ | điểm s) = Phi((s - mu) / sigma)
 * Tham số w, sigma được ml/backtest_admit.js hiệu chỉnh bằng backtest (dự báo năm T chỉ từ dữ liệu < T)
 * và ghi vào data/ml/admit_model.json. Khi chưa đủ dữ liệu nhiều năm, dùng tham số mặc định và gắn
 * `calibrated: false` để giao diện/hội đồng biết đây là ước lượng chưa kiểm chứng.
 * =========================================================================
 */
const fs = require('fs');
const path = require('path');

const MODEL_PATH = path.join(__dirname, '../data/ml/admit_model.json');
const REGIME_YEAR = 2025;

const DEFAULTS = {
  version: 'ft-admit-0',
  calibrated: false,
  weightLast: 1.0,
  sigmaGlobal: 1.5,      // giả định thận trọng khi chưa có backtest (điểm, thang 30)
  sigmaByGroup: {},
  regimeMultiplier: 1.3,
  minSigma: 0.5
};

// Hàm phân phối chuẩn tích lũy (xấp xỉ Abramowitz-Stegun 7.1.26, sai số < 1.5e-7)
const normCdf = (z) => {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
};

class AdmitModelService {
  constructor() {
    this.params = { ...DEFAULTS };
    if (fs.existsSync(MODEL_PATH)) {
      try {
        this.params = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(MODEL_PATH, 'utf-8')) };
      } catch (err) {
        console.warn('[FT-Admit] Không đọc được admit_model.json, dùng tham số mặc định:', err.message);
      }
    }
  }

  /** Dự báo phân phối điểm chuẩn năm tới từ lịch sử [{year, cutoff}] */
  forecast(history = [], majorCode = null, params = this.params) {
    const h = [...history].filter(x => Number.isFinite(x.cutoff)).sort((a, b) => a.year - b.year);
    if (!h.length) return null;
    const last = h[h.length - 1];
    const recent = h.slice(-3);
    const meanRecent = recent.reduce((s, x) => s + x.cutoff, 0) / recent.length;
    const mu = params.weightLast * last.cutoff + (1 - params.weightLast) * meanRecent;
    const group = majorCode ? String(majorCode).slice(0, 3) : null;
    let sigma = params.sigmaByGroup?.[group] ?? params.sigmaGlobal;
    const spansRegime = h.some(x => x.year < REGIME_YEAR) && last.year >= REGIME_YEAR;
    if (spansRegime) sigma *= params.regimeMultiplier;
    // Mùa tuyển sinh kế tiếp: điểm chuẩn năm Y công bố khoảng tháng 8; dữ liệu cũ hơn 1 năm -> bất định tăng theo căn bậc hai
    const now = params.now || new Date();
    const nextSeason = now.getFullYear() + (now.getMonth() >= 7 ? 1 : 0);
    const targetYear = Math.max(last.year + 1, nextSeason);
    sigma *= Math.sqrt(targetYear - last.year);
    return {
      targetYear,
      mu: Math.round(mu * 100) / 100,
      sigma: Math.round(Math.max(params.minSigma, sigma) * 100) / 100,
      yearsOfHistory: h.length,
      lastCutoff: last.cutoff
    };
  }

  /** Xác suất trúng tuyển với điểm dự kiến `score` */
  probability(program, score) {
    if (!program || !Number.isFinite(Number(score))) return null;
    const history = program.history?.length ? program.history : [{ year: program.year, cutoff: program.cutoff }];
    const fc = this.forecast(history, program.major_code);
    if (!fc) return null;
    const p = normCdf((Number(score) - fc.mu) / fc.sigma);
    return {
      ...fc,
      score: Number(score),
      probability: Math.round(Math.min(0.99, Math.max(0.01, p)) * 100),
      calibrated: !!this.params.calibrated && fc.yearsOfHistory >= 2,
      sigmaLearned: !!this.params.sigmaLearned,
      seriesUsed: this.params.seriesUsed || 0,
      floorScore: !!program.is_floor_score,
      model: this.params.version
    };
  }
}

const admitModelService = new AdmitModelService();
admitModelService.normCdf = normCdf;
admitModelService.DEFAULTS = DEFAULTS;
module.exports = admitModelService;
