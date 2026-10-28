/**
 * Chia mẫu vàng thành train/val/test để huấn luyện QLoRA và đánh giá.
 *   node ml/finetune/split_gold.js [--test 25] [--val 12] [--out data/sft_gold]
 * Ghi: train.jsonl, val.jsonl (chỉ có "messages"), test_profiles.jsonl ({id, input}).
 * Chia ngẫu nhiên có hạt giống cố định, mỗi giai đoạn góp mẫu cho test theo tỷ lệ.
 */
const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []));
const N_TEST = Number(args.test || 25);
const N_VAL = Number(args.val || 12);
const OUT = path.resolve(args.out || path.join(__dirname, '../../data/sft_gold'));
const SRC = path.join(__dirname, '../../data/gold/gold_samples.jsonl');

let seed = 20261021;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const rows = fs.readFileSync(SRC, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }

// Lấy lần lượt từng giai đoạn (round-robin) để test và val phủ nhiều giai đoạn
const byStage = {};
rows.forEach(r => (byStage[r.stage] = byStage[r.stage] || []).push(r));
const stages = Object.keys(byStage);
const pick = n => {
  const out = [];
  while (out.length < n && stages.some(s => byStage[s].length)) {
    for (const s of stages) { if (out.length < n && byStage[s].length) out.push(byStage[s].pop()); }
  }
  return out;
};
const test = pick(N_TEST);
const val = pick(N_VAL);
const train = stages.flatMap(s => byStage[s]);

fs.mkdirSync(OUT, { recursive: true });
const w = (f, a) => fs.writeFileSync(path.join(OUT, f), a.map(x => JSON.stringify(x)).join('\n') + '\n');
w('train.jsonl', train.map(r => ({ messages: r.messages })));
w('val.jsonl', val.map(r => ({ messages: r.messages })));
w('test_profiles.jsonl', test.map(r => ({ id: r.id, input: r.input })));
console.log(`train ${train.length} | val ${val.length} | test ${test.length} -> ${OUT}`);
