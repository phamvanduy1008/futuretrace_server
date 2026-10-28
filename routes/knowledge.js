const express = require('express');
const knowledgeService = require('../services/knowledgeService');
const careerModelService = require('../services/careerModelService');
const admitModelService = require('../services/admitModelService');

const router = express.Router();

// GET /api/knowledge/search?q=...&type=school|program&schoolId=...  (autocomplete cho form có cấu trúc)
router.get('/search', (req, res) => {
  const q = String(req.query.q || '').slice(0, 80);
  const type = req.query.type === 'school' ? 'school' : 'program';
  const schoolId = req.query.schoolId ? String(req.query.schoolId) : null;
  const limit = Math.min(Number(req.query.limit) || 8, 20);
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ results: knowledgeService.search(q, { type, schoolId, limit }) });
});

// GET /api/knowledge/methodology: model card + chất lượng dữ liệu (trang /methodology, công khai)
router.get('/methodology', (req, res) => {
  const report = careerModelService.getReport();
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    data: knowledgeService.quality,
    sources: knowledgeService.sources,
    marketSource: knowledgeService.marketFacts?.source || null,
    salaryModel: report ? {
      model: report.model,
      data: report.data,
      split: report.split,
      testAll: report.test_all,
      testFresher: report.test_fresher_graduates,
      maeReductionVsCurrentPercent: report.mae_reduction_vs_current_percent,
      calibration: report.calibration || null,
      topFeatures: report.top_features_by_gain?.slice(0, 10)
    } : null,
    admitModel: (() => {
      const p = admitModelService.params;
      return { version: p.version, calibrated: !!p.calibrated, sigmaGlobal: p.sigmaGlobal, weightLast: p.weightLast, backtests: p.backtests || [], note: p.note || null };
    })()
  });
});

module.exports = router;
