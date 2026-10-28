/**
 * Sinh dữ liệu huấn luyện v3 (viết theo phần + slot) bằng teacher open-weight, có lọc và thử lại.
 *
 *   TEACHER_ORDER=modal MODAL_LLM_URL=<teacher> MODAL_LLM_MODEL=teacher MODAL_DISABLE_THINKING=1 \
 *     node ml/finetune/build_sft_sections.js --n 50 --concurrency 8 --out data/sft_v3 [--gpu-usd-hour 3.95]
 *   node ml/finetune/build_sft_sections.js --pack --out data/sft_v3   # ghi train/val (mẫu teacher + mẫu vàng x3)
 *
 * Mỗi hồ sơ = 4 phần (overview, Positive, Neutral, Risk). Mỗi phần thử tối đa 1 + --retries lần, lần sau kèm lý do
 * bị loại. Lưu: samples.jsonl (đạt), rejects.jsonl (bị loại, giữ nguyên đầu ra), pairs.jsonl (cặp đạt/loại cùng
 * prompt để DPO). Chạy lại cùng --out sẽ tiếp tục, bỏ qua phần đã xong.
 */
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../../.env') });
process.env.LLM_ORDER = process.env.TEACHER_ORDER || 'modal';

const quiet = console.log;
console.log = () => { };
const builder = require('./build_sft_dataset');
const runner = require('../../services/simulationRunner');
const llmGateway = require('../../services/llmGateway');
const task = require('../../services/prompts/simulationTask');
const { checkSection } = require('./sectionCheck');
console.log = quiet;

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--')
  ? [...acc, [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : acc), []));
const N = Number(args.n || 50);
const CONCURRENCY = Number(args.concurrency || 8);
const RETRIES = Number(args.retries ?? 2);
const OUT = path.resolve(args.out || path.join(__dirname, '../../data/sft_v3'));
const GPU_USD_HOUR = Number(args['gpu-usd-hour'] || 3.95);
const N_TEST = 150;
const POOL = 6000;
const ROOT = path.join(__dirname, '../..');

const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
const idsOfDir = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).map(f => (f.match(/^(p\d{5})/) || [])[1]).filter(Boolean) : []);

const pack = () => {
  const goldup = Number(args.goldup || 3);
  const samples = readJsonl(path.join(OUT, 'samples.jsonl'));
  const goldTest = new Set(readJsonl(path.join(ROOT, 'data/sft_gold/test_profiles.jsonl')).map(r => r.id));
  const gold = readJsonl(path.join(ROOT, 'data/gold/sections.jsonl')).filter(r => !goldTest.has(r.source));
  // val: 5% hồ sơ teacher (theo hồ sơ, không tách 4 phần của cùng hồ sơ ra hai tập)
  const pids = [...new Set(samples.map(s => s.pid))].sort();
  const valPids = new Set(pids.filter((_, i) => i % 20 === 0));
  const strip = (m) => JSON.stringify({ messages: m });
  // val cũng lấy 1/20 hồ sơ vàng (theo hồ sơ) để luôn có tập đánh giá, kể cả khi chưa có mẫu teacher
  const goldSrc = [...new Set(gold.map(g => g.source))].sort();
  const goldVal = new Set(goldSrc.filter((_, i) => i % 20 === 0));
  const train = [...samples.filter(s => !valPids.has(s.pid)).map(s => s.messages), ...gold.filter(g => !goldVal.has(g.source)).flatMap(g => Array(goldup).fill(g.messages))];
  const val = [...samples.filter(s => valPids.has(s.pid)).map(s => s.messages), ...gold.filter(g => goldVal.has(g.source)).map(g => g.messages)];
  // Trộn để mỗi batch có đủ loại phần (seed cố định)
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = train.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [train[i], train[j]] = [train[j], train[i]]; }
  fs.writeFileSync(path.join(OUT, 'train.jsonl'), train.map(strip).join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'val.jsonl'), val.map(strip).join('\n') + '\n');
  fs.copyFileSync(path.join(ROOT, 'data/sft_gold/test_profiles.jsonl'), path.join(OUT, 'test_profiles.jsonl'));
  quiet(`train ${train.length} (teacher ${samples.length - val.length} + vàng ${gold.length} x${goldup}) | val ${val.length} | test 25 hồ sơ vàng -> ${OUT}`);
};

const main = async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const SAMPLES = path.join(OUT, 'samples.jsonl');
  const REJECTS = path.join(OUT, 'rejects.jsonl');
  const PAIRS = path.join(OUT, 'pairs.jsonl');
  const ERRORS = path.join(OUT, 'errors.jsonl');
  const done = new Set([...readJsonl(SAMPLES).map(r => r.id), ...readJsonl(REJECTS).filter(r => r.final).map(r => r.id)]);

  const exclude = new Set([
    ...builder.loadGold().map(g => g.id.replace('gold_', '')),
    ...idsOfDir(path.join(ROOT, 'data/gold/out_removed')),
    ...idsOfDir(path.join(ROOT, 'data/gold/prompts_skipped')),
  ]);
  const profiles = Array.from({ length: POOL }, (_, i) => builder.sampleProfile(i))
    .slice(N_TEST)
    .filter(p => !exclude.has(p.id) && !(p.input.expectedScore > 30));
  const queue = [];
  for (const p of profiles) {
    if (queue.length >= N) break;
    if (task.SECTIONS.every(s => done.has(`${p.id}:${s}`))) continue;
    queue.push(p);
  }
  quiet(`[v3] ${queue.length} hồ sơ x 4 phần, teacher = ${process.env.LLM_ORDER} (${process.env.MODAL_LLM_MODEL || ''}), concurrency ${CONCURRENCY}`);

  const t0 = Date.now();
  const stat = { ok: 0, rejected: 0, attempts: 0, outTokens: 0, reasons: {}, bySection: {} };
  let consecutiveErrors = 0;

  const runSection = async (p, prep, section) => {
    const id = `${p.id}:${section}`;
    if (done.has(id)) return;
    const schema = section === 'overview' ? task.SECTION_SCHEMAS.overview : task.SECTION_SCHEMAS.scenario;
    let reason = null;
    let last = null;
    const failed = [];
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      const hint = reason ? `\n\nLẦN TRƯỚC BỊ LOẠI VÌ: ${reason}. Viết lại toàn bộ JSON của phần này và sửa đúng lỗi.` : '';
      const gen = await llmGateway.generate({
        system: prep.sectionSystem,
        prompt: prep.sections[section] + hint,
        schema,
        maxTokens: section === 'overview' ? 900 : 1400,
        temperature: Math.min(0.9, 0.6 + 0.1 * attempt)
      });
      consecutiveErrors = 0;
      stat.attempts++;
      stat.outTokens += gen.usage?.outputTokens || 0;
      last = gen;
      reason = checkSection(section, gen.json, prep);
      if (!reason) break;
      failed.push({ json: gen.json, reason });
      stat.reasons[reason.split(':')[0]] = (stat.reasons[reason.split(':')[0]] || 0) + 1;
    }
    const sec = (stat.bySection[section] = stat.bySection[section] || { ok: 0, total: 0 });
    sec.total++;
    const messages = [{ role: 'system', content: prep.sectionSystem }, { role: 'user', content: prep.sections[section] }];
    if (!reason) {
      stat.ok++;
      sec.ok++;
      fs.appendFileSync(SAMPLES, JSON.stringify({ id, pid: p.id, section, stage: prep.student.stage, teacher: last.model, messages: [...messages, { role: 'assistant', content: JSON.stringify(last.json) }] }) + '\n');
      // Cặp DPO: bản đạt (chosen) và bản bị loại (rejected) cho cùng prompt
      for (const f of failed) fs.appendFileSync(PAIRS, JSON.stringify({ id, prompt: messages, chosen: JSON.stringify(last.json), rejected: JSON.stringify(f.json), reason: f.reason }) + '\n');
    } else {
      stat.rejected++;
      fs.appendFileSync(REJECTS, JSON.stringify({ id, final: true, reason, attempts: failed.map(f => ({ reason: f.reason, json: f.json })) }) + '\n');
    }
  };

  const worker = async () => {
    while (queue.length) {
      const p = queue.shift();
      const prep = runner.prepare(p.input);
      try {
        await Promise.all(task.SECTIONS.map(s => runSection(p, prep, s)));
      } catch (err) {
        fs.appendFileSync(ERRORS, JSON.stringify({ id: p.id, error: String(err.message).slice(0, 200) }) + '\n');
        if (++consecutiveErrors >= 10) { quiet('[v3] 10 lỗi liên tiếp: teacher không phản hồi, dừng (chạy lại đúng lệnh để tiếp tục).'); queue.length = 0; }
      }
      const total = stat.ok + stat.rejected;
      if (total && total % 20 === 0) report();
    }
  };
  const report = () => {
    const hours = (Date.now() - t0) / 3600000;
    const total = stat.ok + stat.rejected;
    quiet(`[v3] phần đạt ${stat.ok}/${total} (${Math.round((stat.ok / Math.max(total, 1)) * 100)}%) | lượt gọi ${stat.attempts} | ${Math.round(stat.outTokens / Math.max(hours * 3600, 1))} token ra/giây | ` +
      `${(hours * 60).toFixed(1)} phút ~ $${(hours * GPU_USD_HOUR).toFixed(2)} GPU -> $${((hours * GPU_USD_HOUR) / Math.max(stat.ok, 1)).toFixed(4)}/phần đạt | lý do: ${JSON.stringify(stat.reasons)} | theo phần: ${JSON.stringify(stat.bySection)}`);
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  report();
};

if (args.pack) pack();
else main().catch((e) => { quiet(e); process.exit(1); });
