/**
 * Sinh dữ liệu SFT cho tác vụ T1 (mô phỏng 3 kịch bản) ĐÚNG định dạng suy luận production.
 *
 *  1. Lấy mẫu hồ sơ thực tế từ dữ liệu thật (trường/ngành trong Knowledge Layer, khu vực, giai đoạn học,
 *     tài chính, áp lực, điểm dự kiến quanh điểm chuẩn), seed cố định để tái lập.
 *  2. Chạy đúng code production (simulationRunner.prepare): Fact Sheet + FT-Salary/ROI + prompt.
 *  3. Teacher viết output JSON theo schema. Khuyến nghị teacher open-weight (TEACHER_ORDER=modal, dựng bằng
 *     ml/finetune/kaggle_teacher.py) + --fewshot 1 (mẫu vàng viết tay ở data/gold). Mặc định vẫn là Gemini: nếu dùng
 *     thì ĐỌC điều khoản Gemini API trước khi dùng output làm dữ liệu huấn luyện.
 *  4. Lọc: JSON đủ trường (aiCoverage = 1), mọi số liệu có căn cứ (groundedness = 1), không nêu trường ngoài
 *     Fact Sheet, đủ tiếng Việt. Mẫu không đạt bị loại (ghi lý do vào rejects.jsonl).
 *  5. Tách: 150 hồ sơ test (chỉ input, dùng cho ml/eval) + train/val.
 *
 * Chạy:  node ml/finetune/build_sft_dataset.js --n 3000 --concurrency 4 --out data/sft_t1
 *        (chạy lại cùng --out sẽ tiếp tục từ chỗ dừng)
 */
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../../.env') });
process.env.LLM_ORDER = process.env.TEACHER_ORDER || 'gemini';

const quiet = console.log;
console.log = () => { };
const knowledge = require('../../services/knowledgeService');
const runner = require('../../services/simulationRunner');
const llmGateway = require('../../services/llmGateway');
const task = require('../../services/prompts/simulationTask');
const { verifyText, collectAllowed } = require('../../services/groundingService');
console.log = quiet;

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []));
const N = Number(args.n || 3000);
const CONCURRENCY = Number(args.concurrency || 4);
const OUT = path.resolve(args.out || path.join(__dirname, '../../data/sft_t1'));
const N_TEST = Number(args.test || 150);
const RETRIES = Number(args.retries ?? 2); // số lần sinh lại khi mẫu bị lọc
const RETRY_HINTS = {
  ungrounded_number: 'có con số không nằm trong FACT SHEET hoặc khối SỐ LIỆU ĐỊNH LƯỢNG (chỉ dùng đúng các số đã cho, ghi [F#])',
  bad_citation: 'trích dẫn [F#] không tồn tại trong FACT SHEET',
  few_citations: 'chưa trích dẫn đủ mã [F#] (cần ít nhất 2 mã khác nhau)',
  missing_hedge: 'nhóm nghề tham chiếu chỉ gần đúng nhưng văn bản chưa nói rõ đó là mốc tham khảo',
  incomplete_fields: 'thiếu trường bắt buộc hoặc sai số lượng phần tử (3 kịch bản, 4 mục SWOT, 3 giai đoạn x 3 việc, 4 mốc timeline)',
  unknown_entity: 'nêu tên trường/tổ chức không có trong hồ sơ hoặc FACT SHEET',
  not_vietnamese: 'không viết bằng tiếng Việt có dấu',
  bad_length: 'văn bản quá ngắn hoặc quá dài so với yêu cầu: summary 50-70 từ, description 60-90 từ, criticalAdvice 30-50 từ, marketAnalysis 30-50 từ, mỗi mục SWOT 20-35 từ, mỗi mốc timeline 25-40 từ, mỗi việc sprint là câu cụ thể đo được'
};
const FEWSHOT = Number(args.fewshot || 0); // số mẫu vàng (data/gold) chèn vào prompt teacher, 0 = tắt
const GOLD_DIR = path.join(__dirname, '../../data/gold');

// ---------------------------------------------------------------- sampling (mulberry32, seed cố định)
const rng = ((seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
})(20261020);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

const PROVINCE_LOCATION = { 'Hà Nội': 'Hà Nội', 'TP HCM': 'TP.HCM', 'Đà Nẵng': 'Đà Nẵng' };
const CONCERNS = [
  'Gia đình muốn em học ngành ổn định hơn.', 'Em sợ ra trường khó xin việc.', 'Nhà em kinh tế không dư dả.',
  'Em chưa chắc mình có hợp ngành này không.', 'Em muốn sau này có thu nhập cao.', 'Em muốn làm việc gần nhà.',
  'Em đang phân vân giữa đi học và đi làm sớm.', 'Bạn bè em đều chọn ngành khác.', '', '', ''
];

const usable = knowledge.programs.filter(p => p.occupation?.industry && p.occupation.fit !== 'none' && !p.is_floor_score && p.major_code);
const isCentral = (p) => ['Đà Nẵng', 'Huế', 'Quảng Nam'].includes(knowledge.schoolById.get(p.school_id)?.province);
const weighted = (list) => list.flatMap(p => (isCentral(p) ? [p, p, p] : [p]));
// Phân tầng theo mức khớp nghề để mô hình học cả hai kiểu: số liệu khớp ngành (45%) và chỉ gần đúng/tham khảo (55%)
const byFit = {
  strong: weighted(usable.filter(p => p.occupation.fit === 'strong')),
  approx: weighted(usable.filter(p => p.occupation.fit === 'approx')),
  weak: weighted(usable.filter(p => p.occupation.fit === 'weak'))
};
const pickProgram = () => {
  const r = rng();
  return pick(r < 0.45 ? byFit.strong : r < 0.85 ? byFit.approx : byFit.weak);
};

const sampleProfile = (i) => {
  const p = pickProgram();
  const school = knowledge.schoolById.get(p.school_id);
  const major = p.major_name.replace(/\(.*?\)/g, '').trim();
  const roll = rng();
  let decision;
  if (roll < 0.55) decision = `Em học lớp 12, muốn thi ngành ${major} ở ${school.name}.`;
  else if (roll < 0.7) decision = `Em lớp 11, đang định hướng chọn tổ hợp để sau này học ngành ${major}.`;
  else if (roll < 0.85) decision = `Em là sinh viên năm ${int(1, 2)} ngành ${major} ở ${school.name}, muốn biết tương lai ngành này ra sao.`;
  else {
    const other = pick(usable);
    decision = `Em là sinh viên năm 2 ngành ${other.major_name.replace(/\(.*?\)/g, '').trim()}, đang muốn chuyển sang ngành ${major}.`;
  }
  return {
    id: `p${String(i).padStart(5, '0')}`,
    input: {
      decision: `${decision} ${pick(CONCERNS)}`.trim(),
      programId: roll < 0.55 ? p.id : undefined,
      academicPerformance: int(1, 5),
      personalFinance: int(1, 5),
      stress: int(1, 5),
      risk: int(1, 5),
      expectedScore: roll < 0.55 ? Math.round((p.cutoff + (rng() * 6 - 3)) * 4) / 4 : undefined,
      location: PROVINCE_LOCATION[school.province] || school.province
    }
  };
};

// ---------------------------------------------------------------- filters
const SCHOOL_MENTION = /(Đại học|ĐH|Học viện|Trường)\s+([A-ZĐÂĂÊÔƠƯ][\wÀ-ỹ]*(?:\s+[A-ZĐÂĂÊÔƠƯ][\wÀ-ỹ]*){0,5})/g;
const VI_CHARS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/gi;
const HEDGE = /tham khảo|gần đúng|chưa (phản ánh|sát)|không (phản ánh|trùng)|nhóm nghề (tham chiếu|gần)|chỉ là mốc/i;

const allStrings = (json) => {
  const out = [json.summary, ...Object.values(json.timeline || {})];
  for (const s of json.scenarios || []) {
    out.push(s.title, s.description, s.criticalAdvice, s.marketAnalysis);
    (s.swot || []).forEach(x => out.push(x?.value));
    (s.sprint90 || []).forEach(ph => (ph?.tasks || []).forEach(t => out.push(t)));
  }
  return out.filter(x => typeof x === 'string');
};

/** Gọi teacher, tự thử lại với lỗi tạm thời (503 quá tải, 429, JSON cụt, mạng) theo chu kỳ chờ 5s, 15s, 45s, 90s */
const TRANSIENT = /503|429|UNAVAILABLE|high demand|không phản hồi|Incomplete JSON|timeout|timed out|ECONN|ETIMEDOUT|fetch failed|overloaded/i;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const generateWithBackoff = async (req) => {
  const waits = [5000, 15000, 45000, 90000];
  for (let i = 0; ; i++) {
    try {
      return await llmGateway.generate(req);
    } catch (err) {
      if (i >= waits.length || !TRANSIENT.test(String(err.message))) throw err;
      await sleep(waits[i] + Math.floor(Math.random() * 3000));
    }
  }
};

const checkSample = (json, prep) => {
  if (runner.measureAiCoverage(json) < 1) return 'incomplete_fields';
  const allowed = collectAllowed({ facts: prep.factSheet.facts, quant: prep.quant, input: prep.cleanData });
  const texts = allStrings(json);
  for (const t of texts) {
    if (verifyText(t, allowed).removed.length) return 'ungrounded_number';
  }
  const known = `${prep.factSheet.school?.name || ''} ${prep.cleanData.decision}`.toLowerCase();
  for (const t of texts) {
    for (const m of t.matchAll(SCHOOL_MENTION)) {
      const name = m[2].toLowerCase();
      if (!known.includes(name.split(' ').slice(0, 2).join(' '))) return `unknown_entity:${m[0]}`;
    }
  }
  const joined = texts.join(' ');
  if ((joined.match(VI_CHARS) || []).length / Math.max(joined.length, 1) < 0.08) return 'not_vietnamese';
  // Trích dẫn [F#] phải trỏ tới mã có thật và có ít nhất 2 mã khác nhau khi Fact Sheet đủ số liệu
  const nFacts = prep.factSheet.facts.length;
  const cited = [...texts.join(' ').matchAll(/\[F(\d+)\]/g)].map(m => Number(m[1]));
  if (cited.some(id => id < 1 || id > nFacts)) return 'bad_citation';
  if (nFacts >= 3 && new Set(cited).size < 2) return 'few_citations';
  // Nhóm nghề tham chiếu gần đúng/yếu thì văn bản phải nói rõ đó là mốc tham khảo
  const fit = prep.factSheet.occupation?.fit;
  if ((fit === 'approx' || fit === 'weak') && !HEDGE.test(texts.join(' '))) return 'missing_hedge';
  // Độ dài tối thiểu/tối đa theo yêu cầu prompt (mẫu quá ngắn dạy mô hình viết sơ sài)
  const wc = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
  const within = (s, lo, hi) => { const n = wc(s); return n >= lo && n <= hi; };
  if (!within(json.summary, 35, 100)) return 'bad_length:summary';
  for (const s of json.scenarios) {
    if (!within(s.description, 45, 120) || !within(s.criticalAdvice, 22, 70) || !within(s.marketAnalysis, 22, 70)) return 'bad_length:scenario';
    if (s.swot.some(x => wc(x.value) < 14)) return 'bad_length:swot';
    if (s.sprint90.some(ph => ph.tasks.some(t => wc(t) < 5))) return 'bad_length:sprint';
  }
  if (Object.values(json.timeline).some(t => wc(t) < 18)) return 'bad_length:timeline';
  return null;
};

// ---------------------------------------------------------------- few-shot từ mẫu vàng (viết tay, đã kiểm)
const loadGold = () => {
  const f = path.join(GOLD_DIR, 'gold_samples.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
};
/** Ưu tiên mẫu vàng cùng giai đoạn; chỉ dạy giọng văn/độ cụ thể, KHÔNG sao chép số liệu */
const fewShotBlock = (gold, stage, k) => {
  if (!k || !gold.length) return '';
  const same = gold.filter(g => g.stage === stage);
  const pool = same.length >= k ? same : gold;
  const chosen = Array.from({ length: k }, () => pool[Math.floor(rng() * pool.length)]);
  return '\n\nVÍ DỤ ĐẦU RA ĐẠT CHUẨN (chỉ học văn phong, độ cụ thể, cấu trúc; số liệu của hồ sơ hiện tại phải lấy từ FACT SHEET của hồ sơ đó, không chép số trong ví dụ):\n' +
    chosen.map((g, i) => `--- Ví dụ ${i + 1} (hồ sơ: ${g.messages[1].content.split('\n')[1] || ''}) ---\n${g.messages[2].content}`).join('\n');
};

// ---------------------------------------------------------------- main
const main = async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const profiles = Array.from({ length: N + N_TEST }, (_, i) => sampleProfile(i));
  const testProfiles = profiles.slice(0, N_TEST);
  fs.writeFileSync(path.join(OUT, 'test_profiles.jsonl'), testProfiles.map(p => JSON.stringify(p)).join('\n') + '\n');

  const samplesPath = path.join(OUT, 'samples.jsonl');
  const rejectsPath = path.join(OUT, 'rejects.jsonl');
  const done = new Set();
  for (const f of [samplesPath, rejectsPath]) {
    if (fs.existsSync(f)) fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).forEach(l => done.add(JSON.parse(l).id));
  }
  const goldIds = new Set(loadGold().map(g => g.id.replace('gold_', '')));
  const queue = profiles.slice(N_TEST).filter(p => !done.has(p.id) && !goldIds.has(p.id)); // hồ sơ đã có mẫu vàng thì không sinh lại
  quiet(`[SFT] ${queue.length} hồ sơ cần sinh (đã có ${done.size}), teacher order = ${process.env.LLM_ORDER}`);

  let ok = 0;
  let rejected = 0;
  let costUsd = 0;
  let consecutiveErrors = 0;
  const gold = FEWSHOT ? loadGold() : [];
  if (FEWSHOT) quiet(`[SFT] few-shot ${FEWSHOT} mẫu vàng, kho có ${gold.length} mẫu`);
  const worker = async () => {
    while (queue.length) {
      const profile = queue.shift();
      const prep = runner.prepare(profile.input);
      try {
        // Thử lại tối đa RETRIES lần khi mẫu bị lọc, kèm gợi ý lý do (chỉ ảnh hưởng prompt của teacher, không vào mẫu lưu)
        let gen = null;
        let reason = null;
        for (let attempt = 0; attempt <= RETRIES; attempt++) {
          const hint = reason ? `\n\nLẦN TRƯỚC BỊ LOẠI VÌ: ${RETRY_HINTS[reason.split(':')[0]] || reason}. Viết lại và tuân thủ.` : '';
          gen = await generateWithBackoff({
            system: prep.system + fewShotBlock(gold, prep.student.stage, FEWSHOT) + hint,
            prompt: prep.prompt, schema: task.SIMULATION_SCHEMA, maxTokens: 4096, temperature: Math.min(0.9, 0.5 + 0.1 * attempt)
          });
          consecutiveErrors = 0;
          costUsd += gen.usage?.costUsd || 0;
          reason = checkSample(gen.json, prep);
          if (!reason) break;
        }
        if (reason) {
          rejected++;
          fs.appendFileSync(rejectsPath, JSON.stringify({ id: profile.id, reason, provider: gen.provider }) + '\n');
          continue;
        }
        ok++;
        fs.appendFileSync(samplesPath, JSON.stringify({
          id: profile.id,
          task: task.TASK_ID,
          teacher: gen.model,
          messages: [
            { role: 'system', content: prep.system },
            { role: 'user', content: prep.prompt },
            { role: 'assistant', content: JSON.stringify(gen.json) }
          ]
        }) + '\n');
      } catch (err) {
        rejected++;
        // Lỗi hạ tầng (teacher sập, hết hạn tunnel...) KHÔNG tính là đã xử lý: ghi riêng để lần chạy sau thử lại hồ sơ này
        fs.appendFileSync(path.join(OUT, 'errors.jsonl'), JSON.stringify({ id: profile.id, error: String(err.message).slice(0, 160) }) + '\n');
        if (++consecutiveErrors >= 15) { quiet('[SFT] 15 lỗi liên tiếp: teacher không phản hồi. Kiểm tra Kaggle/tunnel rồi chạy lại đúng lệnh (tiếp tục từ chỗ dừng).'); queue.length = 0; }
      }
      if ((ok + rejected) % 25 === 0) quiet(`[SFT] ok=${ok} rejected=${rejected} cost≈$${costUsd.toFixed(3)}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Tách train/val 95/5 (giữ nguyên thứ tự xác định theo id)
  if (!fs.existsSync(samplesPath)) fs.writeFileSync(samplesPath, '');
  // Mẫu người duyệt đánh dấu sai (bad_ids.txt) bị loại khỏi train/val, không cần sửa samples.jsonl
  const badPath = path.join(OUT, 'bad_ids.txt');
  const dupPath = path.join(OUT, 'dup_ids.txt');
  const readIds = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split(/\s+/).filter(Boolean) : []);
  const badIds = new Set([...readIds(badPath), ...readIds(dupPath)]);
  const samples = fs.readFileSync(samplesPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(s => !badIds.has(s.id));
  const nVal = samples.length ? Math.max(1, Math.round(samples.length * 0.05)) : 0;
  const strip = (s) => JSON.stringify({ messages: s.messages });
  fs.writeFileSync(path.join(OUT, 'val.jsonl'), samples.slice(0, nVal).map(strip).join('\n') + '\n');
  // Mẫu vàng (viết tay, đã kiểm) trộn vào train với trọng số goldup (mặc định 3), không đưa vào val
  const goldRows = [];
  for (const g of loadGold()) for (let k = 0; k < Number(args.goldup || 3); k++) goldRows.push(g);
  fs.writeFileSync(path.join(OUT, 'train.jsonl'), [...samples.slice(nVal), ...goldRows].map(strip).join('\n') + '\n');
  quiet(`[SFT] Hoàn tất: ${samples.length} mẫu đạt (train ${samples.length - nVal}, val ${nVal}), loại ${rejected} lượt này, chi phí teacher ≈ $${costUsd.toFixed(3)}`);
};

if (require.main === module) {
  main().catch((e) => {
    quiet(e);
    process.exit(1);
  });
}

module.exports = { sampleProfile, checkSample, loadGold, fewShotBlock, RETRY_HINTS };
