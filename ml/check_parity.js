/**
 * Kiểm tra parity giữa XGBoost (Python) và bộ đánh giá cây trong careerModelService.js.
 *  1. Margin trên 50 vector đặc trưng do Python dựng sẵn (kiểm tra bộ đánh giá cây).
 *  2. Dựng lại vector từ chuỗi thô bằng hàm JS (kiểm tra mirror feature engineering).
 * Chạy: node ml/check_parity.js
 */
const fs = require('fs');
const path = require('path');
const careerModel = require('../services/careerModelService');

const parity = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/ml/salary_model_parity.json'), 'utf-8'));
const { evalTrees } = careerModel.internals;
let worstTree = 0;
let featureMismatch = 0;

parity.rows.forEach((row, i) => {
  for (const [name, q] of Object.entries(careerModel.model.quantiles)) {
    const margin = q.base_score + evalTrees(q.trees, row);
    worstTree = Math.max(worstTree, Math.abs(margin - parity.expected[name][i]));
  }
  const r = parity.raw[i];
  const { x } = careerModel.vectorize({
    title: r.job_title, industry: r.job_industry, experience: r.experience_level,
    education: r.education_level, position: r.job_position, location: r.location,
    jobType: r.job_type, year: Number(r.year)
  });
  const diff = x.findIndex((v, j) => !(Number.isNaN(v) && row[j] === null) && v !== row[j]);
  if (diff !== -1) {
    featureMismatch++;
    if (featureMismatch <= 3) console.log(`row ${i} feature "${careerModel.model.feature_names[diff]}": js=${x[diff]} py=${row[diff]}`);
  }
});

console.log(`tree evaluator max |margin diff| = ${worstTree.toExponential(2)}`);
console.log(`feature vectors mismatched: ${featureMismatch}/${parity.rows.length}`);
process.exit(worstTree < 1e-3 && featureMismatch === 0 ? 0 : 1);
