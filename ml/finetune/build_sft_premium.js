/**
 * Sinh dữ liệu huấn luyện premium v3 (khung + 5 mốc) bằng teacher open-weight, có lọc và thử lại.
 *
 *   TEACHER_ORDER=modal MODAL_LLM_URL=<teacher> MODAL_LLM_MODEL=teacher MODAL_DISABLE_THINKING=1 \
 *     node ml/finetune/build_sft_premium.js --n 1200 --concurrency 12 --out data/sft_premium
 *   node ml/finetune/build_sft_premium.js --pack --out data/sft_premium
 *
 * Đầu vào: hồ sơ + một kịch bản (Positive/Neutral/Risk) lấy từ dữ liệu mô phỏng v3 đã sinh (data/sft_v3/samples.jsonl),
 * khung thời gian lấy mẫu theo giai đoạn (3-60 tháng như giao diện). Mỗi cặp (hồ sơ, kịch bản) = 1 khung + 5 mốc.
 * Tập test: 25 hồ sơ vàng giữ riêng (data/sft_gold/test_profiles.jsonl), kịch bản Neutral của mẫu vàng, 12 tháng.
 */
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../../.env') });
process.env.LLM_ORDER = process.env.TEACHER_ORDER || 'modal';

const quiet = console.log;
console.log = () => { };
const builder = require('./build_sft_dataset');
const llmGateway = require('../../services/llmGateway');
const slotRenderer = require('../../services/slotRenderer');
const premiumEngine = require('../../services/premiumEngine');
const premiumTask = require('../../services/prompts/premiumTask');
const { checkPremiumSection } = require('./premiumCheck');
console.log = quiet;

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--')
  ? [...acc, [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : acc), []));
const N = Number(args.n || 50);
const CONCURRENCY = Number(args.concurrency || 8);
const RETRIES = Number(args.retries ?? 2);
const OUT = path.resolve(args.out || path.join(__dirname, '../../data/sft_premium'));
const GPU_USD_HOUR = Number(args['gpu-usd-hour'] || 3.95);
const ROOT = path.join(__dirname, '../..');
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);

let seed = 20261023;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const TIMEFRAMES = {
  THPT_CHON_TO_HOP: [6, 12, 18, 24, 36],
  THPT_ON_THI_DAI_HOC: [3, 6, 9, 12, 12],
  DAI_HOC_DAI_CUONG: [6, 12, 12, 18, 24, 36],
  DAI_HOC_CHUYEN_NGANH_THUC_TAP: [6, 12, 12, 18, 24],
  CHUYEN_NGANH_SONG_BANG: [6, 12, 18, 24, 36],
  default: [6, 12, 24, 36, 48, 60]
};

/** (hồ sơ, kịch bản) từ dữ liệu mô phỏng v3 đã đạt lọc; kịch bản được điền slot thành văn bản thật */
const loadPairs = () => {
  const sim = readJsonl(path.join(ROOT, 'data/sft_v3/samples.jsonl'));
  const byPid = {};
  for (const s of sim) (byPid[s.pid] = byPid[s.pid] || {})[s.section] = s;
  const pool = new Map(Array.from({ length: 6000 }, (_, i) => builder.sampleProfile(i)).map(p => [p.id, p]));
  const pids = Object.keys(byPid).filter(pid => ['Positive', 'Neutral', 'Risk'].some(t => byPid[pid][t])).sort();
  return pids.map(pid => {
    const types = ['Positive', 'Neutral', 'Risk'].filter(t => byPid[pid][t]);
    return { pid, profile: pool.get(pid), type: pick(types), sim: byPid[pid] };
  }).filter(x => x.profile);
};

const scenarioText = (pair, prep) => {
  const raw = JSON.parse(pair.sim[pair.type].messages[2].content);
  const r = slotRenderer.renderJson(raw, prep.slotCtx, pair.type).json;
  return { title: r.title, description: r.description };
};

/** Tập test giữ riêng: 25 hồ sơ vàng, kịch bản Neutral của mẫu vàng, khung 12 tháng */
const writeTestCases = () => {
  const goldTest = new Set(readJsonl(path.join(ROOT, 'data/sft_gold/test_profiles.jsonl')).map(r => r.id));
  const gold = builder.loadGold().filter(g => goldTest.has(g.id));
  const tests = gold.map(g => {
    const full = JSON.parse(g.messages[2].content);
    const sc = (full.scenarios || []).find(s => s.type === 'Neutral') || full.scenarios?.[0] || {};
    return { id: g.id, context: g.input, scenario: { title: sc.title, description: sc.description }, timeframe: 12 };
  });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'test_cases.jsonl'), tests.map(t => JSON.stringify(t)).join('\n') + '\n');
  return tests;
};

const pack = () => {
  const samples = readJsonl(path.join(OUT, 'samples.jsonl'));
  const pairIds = [...new Set(samples.map(s => s.pair))].sort();
  const valPairs = new Set(pairIds.filter((_, i) => i % 20 === 0));
  const strip = (m) => JSON.stringify({ messages: m });
  // --milestone-cap N: giữ mọi khung (phần khó nhất), chỉ lấy tối đa N mẫu mốc (giới hạn thời gian/chi phí huấn luyện)
  const cap = Number(args['milestone-cap'] || Infinity);
  let kept = 0;
  const trainRows = samples.filter(s => !valPairs.has(s.pair)).filter(s => s.id.endsWith(':plan') || kept++ < cap);
  const train = trainRows.map(s => s.messages);
  const val = samples.filter(s => valPairs.has(s.pair)).slice(0, 150).map(s => s.messages);
  let sd = 11;
  const r = () => ((sd = (sd * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = train.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [train[i], train[j]] = [train[j], train[i]]; }
  fs.writeFileSync(path.join(OUT, 'train.jsonl'), train.map(strip).join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'val.jsonl'), val.map(strip).join('\n') + '\n');
  const tests = writeTestCases();
  quiet(`train ${train.length} (khung ${trainRows.filter(s => s.id.endsWith(':plan')).length}) | val ${val.length} | test ${tests.length} lộ trình (hồ sơ vàng giữ riêng) -> ${OUT}`);
};

const main = async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const SAMPLES = path.join(OUT, 'samples.jsonl');
  const REJECTS = path.join(OUT, 'rejects.jsonl');
  const PAIRS = path.join(OUT, 'pairs.jsonl');
  const ERRORS = path.join(OUT, 'errors.jsonl');
  const done = new Set([...readJsonl(SAMPLES).map(r => r.pair), ...readJsonl(REJECTS).filter(r => r.final).map(r => r.pair)]);
  const queue = loadPairs().filter(p => !done.has(p.pid)).slice(0, N);
  quiet(`[premium] ${queue.length} lộ trình (khung + 5 mốc), teacher = ${process.env.LLM_ORDER} (${process.env.MODAL_LLM_MODEL || ''}), concurrency ${CONCURRENCY}`);

  const t0 = Date.now();
  const stat = { ok: 0, rejected: 0, attempts: 0, outTokens: 0, reasons: {}, plans: { ok: 0, total: 0 }, milestones: { ok: 0, total: 0 } };
  let consecutiveErrors = 0;

  /** Sinh + lọc + thử lại một phần; trả về json đạt hoặc null */
  const runPart = async (id, pairId, system, prompt, schema, maxTokens, check) => {
    let reason = null;
    let last = null;
    const failed = [];
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      const hint = reason ? `\n\nLẦN TRƯỚC BỊ LOẠI VÌ: ${reason}. Viết lại toàn bộ JSON của phần này và sửa đúng lỗi.` : '';
      const gen = await llmGateway.generate({ system, prompt: prompt + hint, schema, maxTokens, temperature: Math.min(0.9, 0.6 + 0.1 * attempt) });
      consecutiveErrors = 0;
      stat.attempts++;
      stat.outTokens += gen.usage?.outputTokens || 0;
      last = gen;
      reason = check(gen.json);
      if (!reason) break;
      failed.push({ json: gen.json, reason });
      const k = reason.split(':')[0];
      stat.reasons[k] = (stat.reasons[k] || 0) + 1;
    }
    const messages = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
    if (reason) {
      fs.appendFileSync(REJECTS, JSON.stringify({ id, pair: pairId, reason, attempts: failed }) + '\n');
      return null;
    }
    fs.appendFileSync(SAMPLES, JSON.stringify({ id, pair: pairId, teacher: last.model, messages: [...messages, { role: 'assistant', content: JSON.stringify(last.json) }] }) + '\n');
    for (const f of failed) fs.appendFileSync(PAIRS, JSON.stringify({ id, prompt: messages, chosen: JSON.stringify(last.json), rejected: JSON.stringify(f.json), reason: f.reason }) + '\n');
    return last.json;
  };

  const worker = async () => {
    while (queue.length) {
      const pair = queue.shift();
      try {
        const { prep, slotText } = premiumEngine.buildContext(pair.profile.input);
        const timeframe = pick(TIMEFRAMES[prep.student.stage] || TIMEFRAMES.default);
        const scenario = scenarioText(pair, prep);
        const prompts = premiumEngine.buildPremiumPrompts({ prep, slotText, scenario, timeframe });
        stat.plans.total++;
        const plan = await runPart(`${pair.pid}:plan`, pair.pid, prompts.system, prompts.plan, premiumTask.PLAN_SCHEMA, 2200,
          (j) => checkPremiumSection('plan', j, prep, { timeframe }));
        if (!plan) {
          stat.rejected++;
          fs.appendFileSync(REJECTS, JSON.stringify({ pair: pair.pid, final: true, reason: 'plan_failed' }) + '\n');
          continue;
        }
        stat.plans.ok++;
        const results = await Promise.all(plan.milestones.map((_, i) => runPart(`${pair.pid}:m${i + 1}`, pair.pid, prompts.system,
          prompts.milestone(plan, i), premiumTask.MILESTONE_SCHEMA, 1600, (j) => checkPremiumSection('milestone', j, prep, { timeframe }))));
        stat.milestones.total += 5;
        stat.milestones.ok += results.filter(Boolean).length;
        stat.ok++;
      } catch (err) {
        fs.appendFileSync(ERRORS, JSON.stringify({ pair: pair.pid, error: String(err.message).slice(0, 200) }) + '\n');
        if (++consecutiveErrors >= 10) { quiet('[premium] 10 lỗi liên tiếp: teacher không phản hồi, dừng.'); queue.length = 0; }
      }
      if ((stat.ok + stat.rejected) % 10 === 0) report();
    }
  };
  const report = () => {
    const hours = (Date.now() - t0) / 3600000;
    const parts = stat.plans.ok + stat.milestones.ok;
    quiet(`[premium] lộ trình ${stat.ok} (khung bỏ ${stat.rejected}) | khung đạt ${stat.plans.ok}/${stat.plans.total} | mốc đạt ${stat.milestones.ok}/${stat.milestones.total} | lượt gọi ${stat.attempts} | ` +
      `${Math.round(stat.outTokens / Math.max(hours * 3600, 1))} token ra/giây | ${(hours * 60).toFixed(1)} phút ~ $${(hours * GPU_USD_HOUR).toFixed(2)} -> $${((hours * GPU_USD_HOUR) / Math.max(parts, 1)).toFixed(4)}/phần | lý do: ${JSON.stringify(stat.reasons)}`);
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  report();
};

if (require.main !== module) { /* chỉ chạy khi gọi trực tiếp */ } else if (args.pack) pack();
else if (args['tests-only']) quiet(`test ${writeTestCases().length} lộ trình -> ${OUT}`);
else main().catch((e) => { quiet(e); process.exit(1); });
