/**
 * Backtest + hiệu chỉnh FT-Admit trên dữ liệu điểm chuẩn nhiều năm (data/knowledge/programs.json -> history).
 *
 * Với mỗi năm mục tiêu T (vd 2025, 2026): chỉ dùng dữ liệu các năm < T để
 *   - chọn w (trọng số năm gần nhất) và sigma theo nhóm ngành (độ lệch năm-qua-năm),
 *   - dự báo điểm chuẩn năm T, rồi so với điểm chuẩn thật năm T.
 * Chỉ số: MAE điểm chuẩn (so với baseline "lấy điểm năm trước"); Brier score của xác suất trúng tuyển trên
 * lưới thí sinh giả định (điểm = điểm năm trước ± 0..3, bước 0,5; nhãn = điểm >= điểm chuẩn thật năm T),
 * so với baseline "đỗ nếu điểm >= điểm năm trước"; độ hiệu chỉnh theo 5 nhóm xác suất.
 * Tham số cuối cùng (fit trên toàn bộ dữ liệu) ghi vào data/ml/admit_model.json kèm metrics.
 *
 * Chạy: node ml/backtest_admit.js
 */
const fs = require('fs');
const path = require('path');

const quiet = console.log;
console.log = () => {};
const admit = require('../services/admitModelService');
console.log = quiet;

const argOf = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const programs = JSON.parse(fs.readFileSync(argOf('--programs') || path.join(__dirname, '../data/knowledge/programs.json'), 'utf-8'));
const OUT = argOf('--out') || path.join(__dirname, '../data/ml/admit_model.json');

// Mỗi chuỗi lịch sử (trường, mã, phương thức) chỉ tính một lần dù có nhiều tổ hợp hiển thị
const seen = new Set();
const series = [];
for (const p of programs) {
  const key = `${p.school_id}|${p.program_code}|${p.method}`;
  if (seen.has(key) || !(p.history?.length >= 2)) continue;
  seen.add(key);
  series.push({ group: p.major_code ? p.major_code.slice(0, 3) : 'na', majorCode: p.major_code, history: p.history });
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

/** Ước lượng tham số chỉ từ dữ liệu các năm < cutoffYear */
const fitParams = (cutoffYear) => {
  const residuals = { all: [] };
  const byW = { 1.0: [], 0.8: [], 0.6: [] };
  for (const s of series) {
    const h = s.history.filter(x => x.year < cutoffYear);
    for (let i = 1; i < h.length; i++) {
      const prev = h.slice(0, i);
      for (const w of Object.keys(byW)) {
        const fc = admit.forecast(prev, s.majorCode, { ...admit.DEFAULTS, weightLast: Number(w), sigmaGlobal: 1, regimeMultiplier: 1, now: new Date(h[i].year - 1, 8, 1) });
        byW[w].push(Math.abs(h[i].cutoff - fc.mu));
      }
      const fc1 = admit.forecast(prev, s.majorCode, { ...admit.DEFAULTS, weightLast: 1, sigmaGlobal: 1, regimeMultiplier: 1, now: new Date(h[i].year - 1, 8, 1) });
      const r = h[i].cutoff - fc1.mu;
      residuals.all.push(r);
      (residuals[s.group] ||= []).push(r);
    }
  }
  if (residuals.all.length < 30) return null;
  const weightLast = Number(Object.entries(byW).sort((a, b) => median(a[1]) - median(b[1]))[0][0]);
  // sigma bền vững: 1.4826 * MAD; nhóm ít dữ liệu co về sigma toàn cục (shrinkage)
  const robustSigma = (r) => 1.4826 * median(r.map(x => Math.abs(x - median(r))));
  const sigmaGlobal = Math.max(0.5, robustSigma(residuals.all));
  const sigmaByGroup = {};
  for (const [g, r] of Object.entries(residuals)) {
    if (g === 'all' || r.length < 5) continue;
    const k = r.length / (r.length + 20);
    sigmaByGroup[g] = Math.round((k * robustSigma(r) + (1 - k) * sigmaGlobal) * 100) / 100;
  }
  return { ...admit.DEFAULTS, calibrated: true, weightLast, sigmaGlobal: Math.round(sigmaGlobal * 100) / 100, sigmaByGroup, nResiduals: residuals.all.length };
};

const evaluateYear = (T) => {
  const params = fitParams(T);
  if (!params) return null;
  let absModel = 0;
  let absNaive = 0;
  let n = 0;
  let brierModel = 0;
  let brierNaive = 0;
  let m = 0;
  const bins = Array.from({ length: 5 }, () => ({ p: 0, y: 0, n: 0 }));
  for (const s of series) {
    const prev = s.history.filter(x => x.year < T);
    const actual = s.history.find(x => x.year === T);
    if (!prev.length || !actual) continue;
    const fc = admit.forecast(prev, s.majorCode, { ...params, now: new Date(T - 1, 8, 1) });
    const last = prev[prev.length - 1].cutoff;
    absModel += Math.abs(actual.cutoff - fc.mu);
    absNaive += Math.abs(actual.cutoff - last);
    n++;
    for (let d = -3; d <= 3; d += 0.5) {
      const score = last + d;
      const y = score >= actual.cutoff ? 1 : 0;
      const p = admit.normCdf((score - fc.mu) / fc.sigma);
      brierModel += (p - y) ** 2;
      brierNaive += ((score >= last ? 1 : 0) - y) ** 2;
      m++;
      const b = bins[Math.min(4, Math.floor(p * 5))];
      b.p += p; b.y += y; b.n++;
    }
  }
  if (!n) return null;
  return {
    targetYear: T,
    programs: n,
    maeCutoffModel: Math.round((absModel / n) * 100) / 100,
    maeCutoffNaiveLastYear: Math.round((absNaive / n) * 100) / 100,
    brierModel: Math.round((brierModel / m) * 1000) / 1000,
    brierNaiveStep: Math.round((brierNaive / m) * 1000) / 1000,
    calibration: bins.filter(b => b.n).map((b, i) => ({ bin: `${i * 20}-${i * 20 + 20}%`, predicted: Math.round((b.p / b.n) * 100), observed: Math.round((b.y / b.n) * 100), n: b.n })),
    params: { weightLast: params.weightLast, sigmaGlobal: params.sigmaGlobal }
  };
};

const years = [...new Set(series.flatMap(s => s.history.map(h => h.year)))].sort();
quiet(`[FT-Admit] ${series.length} chuỗi điểm chuẩn có >= 2 năm, các năm: ${years.join(', ') || '(chưa có)'}`);

const backtests = years.slice(2).map(evaluateYear).filter(Boolean);
const finalParams = fitParams(Infinity);
const output = finalParams
  // 'calibrated' chỉ khi có backtest ngoài mẫu (cần >= 3 năm); với 2 năm thì sigma học từ biến động năm-qua-năm nhưng chưa kiểm chứng
  ? { ...finalParams, calibrated: backtests.length > 0, sigmaLearned: true, version: 'ft-admit-1', trainedAt: new Date().toISOString().slice(0, 10), seriesUsed: series.length, years, backtests,
    note: backtests.length ? undefined : `Sigma học từ biến động ${years.join('->')} của ${series.length} chương trình; chưa backtest ngoài mẫu (cần >= 3 năm điểm chuẩn).` }
  : { ...admit.DEFAULTS, trainedAt: new Date().toISOString().slice(0, 10), seriesUsed: series.length, years, backtests: [],
    note: 'Chưa đủ dữ liệu nhiều năm (cần >= 30 cặp năm liên tiếp). Đang dùng tham số mặc định, chưa hiệu chỉnh.' };

fs.writeFileSync(OUT, JSON.stringify(output, null, 2));
quiet(JSON.stringify({ calibrated: output.calibrated, weightLast: output.weightLast, sigmaGlobal: output.sigmaGlobal, backtests: output.backtests, note: output.note }, null, 2));
