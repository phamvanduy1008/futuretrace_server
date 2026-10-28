/**
 * Bộ mẫu vàng (viết tay) cho T1.
 *   node ml/finetune/gold.js export [--n 40]   chọn hồ sơ phân tầng theo giai đoạn -> data/gold/prompts/<id>.txt (+ .input.json)
 *   node ml/finetune/gold.js check             kiểm data/gold/out/<id>.json bằng đúng bộ lọc của dữ liệu huấn luyện
 *   node ml/finetune/gold.js pack              đóng gói mẫu đạt -> data/gold/gold_samples.jsonl (few-shot + trộn vào train)
 */
const fs = require('fs');
const path = require('path');
const quiet = console.log;
console.log = () => { };
const sft = require('./build_sft_dataset');
const runner = require('../../services/simulationRunner');
const task = require('../../services/prompts/simulationTask');
console.log = quiet;

const DIR = path.join(__dirname, '../../data/gold');
const P = path.join(DIR, 'prompts');
const O = path.join(DIR, 'out');
const [cmd = 'check'] = process.argv.slice(2);
const N = Number((process.argv.indexOf('--n') > 0 && process.argv[process.argv.indexOf('--n') + 1]) || 40);

const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const inRange = (s, lo, hi) => { const w = words(s); return w >= lo && w <= hi; };

if (cmd === 'export') {
  fs.mkdirSync(P, { recursive: true });
  fs.mkdirSync(O, { recursive: true });
  // 150 hồ sơ đầu là tập test -> bỏ qua; lấy từ vùng 150..800, phân tầng theo giai đoạn
  const have = new Set(fs.existsSync(O) ? fs.readdirSync(O).map(f => f.replace('.json', '')) : []);
  const pool = Array.from({ length: 800 }, (_, i) => sft.sampleProfile(i)).slice(150).filter(p => !have.has(p.id));
  const byStage = {};
  for (const p of pool) (byStage[runner.prepare(p.input).student.stage] ||= []).push(p);
  const stages = Object.keys(byStage);
  const chosen = [];
  // Hạn ngạch theo tỷ lệ thực tế của đầu vào (lớp 12 ~50%, lớp 11 ~17%, sinh viên ~17%, chuyển ngành ~16%), phần thiếu bù từ nhóm còn dư
  const SHARE = { THPT_ON_THI_DAI_HOC: 0.5, THPT_CHON_TO_HOP: 0.17, DAI_HOC_DAI_CUONG: 0.17, CHUYEN_NGANH_SONG_BANG: 0.16 };
  for (const s of stages) chosen.push(...byStage[s].slice(0, Math.round(N * (SHARE[s] || 0.05))));
  for (let r = 0; chosen.length < N && r < 400; r++) for (const s of stages) { const x = byStage[s][r]; if (x && !chosen.includes(x) && chosen.length < N) chosen.push(x); }
  chosen.length = Math.min(chosen.length, N);
  for (const p of chosen) {
    const prep = runner.prepare(p.input);
    fs.writeFileSync(path.join(P, `${p.id}.txt`), prep.prompt);
    fs.writeFileSync(path.join(P, `${p.id}.input.json`), JSON.stringify({ id: p.id, stage: prep.student.stage, input: p.input }, null, 1));
  }
  quiet(`Đã xuất ${chosen.length} hồ sơ, giai đoạn: ${stages.map(s => `${s}=${chosen.filter(c => byStage[s].includes(c)).length}`).join(', ')}`);
} else {
  const files = fs.existsSync(O) ? fs.readdirSync(O).filter(f => f.endsWith('.json')) : [];
  const ok = [];
  for (const f of files) {
    const id = f.replace('.json', '');
    const meta = JSON.parse(fs.readFileSync(path.join(P, `${id}.input.json`), 'utf8'));
    let json;
    try { json = JSON.parse(fs.readFileSync(path.join(O, f), 'utf8')); } catch (e) { quiet(`✗ ${id}: JSON lỗi ${e.message}`); continue; }
    const prep = runner.prepare(meta.input);
    const issues = [];
    const r = sft.checkSample(json, prep);
    if (r) {
      issues.push(r);
      if (r === 'ungrounded_number') {
        const { verifyText, collectAllowed } = require('../../services/groundingService');
        const allowed = collectAllowed({ facts: prep.factSheet.facts, quant: prep.quant, input: prep.cleanData });
        const strs = [json.summary, ...Object.values(json.timeline || {})];
        for (const sc of json.scenarios || []) { strs.push(sc.title, sc.description, sc.criticalAdvice, sc.marketAnalysis); (sc.swot || []).forEach(x => strs.push(x.value)); (sc.sprint90 || []).forEach(ph => strs.push(...ph.tasks)); }
        for (const t of strs) { const v = verifyText(t, allowed); if (v.removed.length) issues.push('SỐ_LẠ:' + JSON.stringify(v.removed).slice(0, 160)); }
      }
    }
    if (JSON.stringify(json.scenarios?.map(s => s.type)) !== '["Positive","Neutral","Risk"]') issues.push('thứ_tự_kịch_bản');
    if (!inRange(json.summary, 35, 100)) issues.push(`summary:${words(json.summary)}từ`);
    json.scenarios?.forEach((s, i) => {
      if (!inRange(s.description, 45, 120)) issues.push(`desc${i}:${words(s.description)}`);
      if (!inRange(s.criticalAdvice, 22, 70)) issues.push(`advice${i}:${words(s.criticalAdvice)}`);
      if (!inRange(s.marketAnalysis, 22, 70)) issues.push(`market${i}:${words(s.marketAnalysis)}`);
      if (JSON.stringify((s.swot || []).map(x => x.type)) !== '["S","W","O","T"]') issues.push(`swot${i}`);
    });
    if (issues.length) quiet(`✗ ${id}: ${issues.join(' | ')}`);
    else { ok.push({ id, stage: prep.student.stage, prep, json, input: meta.input }); quiet(`✓ ${id}`); }
  }
  quiet(`Đạt ${ok.length}/${files.length}`);
  if (cmd === 'pack') {
    fs.writeFileSync(path.join(DIR, 'gold_samples.jsonl'), ok.map(({ id, stage, prep, json, input }) => JSON.stringify({
      id: `gold_${id}`, task: task.TASK_ID, teacher: "human-claude-reviewed", stage, input,
      messages: [{ role: 'system', content: prep.system }, { role: 'user', content: prep.prompt }, { role: 'assistant', content: JSON.stringify(json) }]
    })).join('\n') + '\n');
    quiet(`Đã ghi ${ok.length} mẫu vàng -> data/gold/gold_samples.jsonl`);
  }
}
