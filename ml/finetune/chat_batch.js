/**
 * Sinh dữ liệu SFT bằng cách dán từng lô hồ sơ vào chatbot (Gemini, ChatGPT, Claude, DeepSeek...) thay cho API.
 * Mọi câu trả lời đều qua ĐÚNG bộ lọc của dữ liệu huấn luyện (checkSample: đủ trường, số liệu có căn cứ, trích [F#],
 * nhãn "gần đúng", độ dài); mẫu sai được tạo sẵn lô sửa để dán lại.
 *
 *   node ml/finetune/chat_batch.js instructions            ghi HUONG_DAN_CHATBOT.md (dán 1 lần vào Gem / Project / Custom GPT)
 *   node ml/finetune/chat_batch.js export [--k 3] [--full] [--teacher deepseek-web]
 *                                                           tạo lô mới data/sft_chat/batches/b0001.txt để dán vào chat
 *   node ml/finetune/chat_batch.js import b0001             đọc câu trả lời đã lưu ở batches/b0001.answer.txt, lọc, lưu
 *   node ml/finetune/chat_batch.js status                   thống kê
 *   node ml/finetune/chat_batch.js pack [--goldup 3]        ghi train.jsonl / val.jsonl / test_profiles.jsonl để huấn luyện
 *
 * --full: chèn toàn bộ hướng dẫn vào đầu lô (dùng khi chatbot không có Gem/Project/Custom GPT).
 */
const fs = require('fs');
const path = require('path');

const quiet = console.log;
console.log = () => { };
const builder = require('./build_sft_dataset');
const runner = require('../../services/simulationRunner');
const task = require('../../services/prompts/simulationTask');
const { verifyText, collectAllowed } = require('../../services/groundingService');
console.log = quiet;
const { jsonrepair } = require('jsonrepair');

const ROOT = path.join(__dirname, '../..');
const OUT = path.join(ROOT, 'data/sft_chat');
const BATCH_DIR = path.join(OUT, 'batches');
const STATE = path.join(OUT, 'state.json');
const SAMPLES = path.join(OUT, 'samples.jsonl');
const REJECTS = path.join(OUT, 'rejects.jsonl');
const GOLD_DIR = path.join(ROOT, 'data/gold');
const GOLD_SPLIT = path.join(ROOT, 'data/sft_gold');
const N_TEST = 150;          // hồ sơ p00000-p00149: tập test của build_sft_dataset, không bao giờ sinh
const POOL = 6000;           // số hồ sơ lấy mẫu sẵn (đủ cho ~3000 mẫu sau khi bỏ hồ sơ không hợp lệ)
const MAX_FIX = 2;           // số lần dán lại để sửa một hồ sơ trước khi bỏ

const [cmd, ...rest] = process.argv.slice(2);
const args = Object.fromEntries(rest.reduce((acc, a, i, arr) => (a.startsWith('--')
  ? [...acc, [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : acc), []));
const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--') && rest[i - 1] !== '--full'));

const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
const loadState = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { next: 1, batches: {}, attempts: {} });
const saveState = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 1));
const wc = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

// ---------------------------------------------------------------- hồ sơ (cùng bộ lấy mẫu, cùng seed với build_sft_dataset)
const profiles = Array.from({ length: POOL }, (_, i) => builder.sampleProfile(i));
const byId = new Map(profiles.map(p => [p.id, p]));

const idsOfDir = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).map(f => (f.match(/^(p\d{5})/) || [])[1]).filter(Boolean) : []);
const goldTestIds = new Set(readJsonl(path.join(GOLD_SPLIT, 'test_profiles.jsonl')).map(r => r.id.replace('gold_', '')));
const goldIds = new Set([
  ...builder.loadGold().map(g => g.id.replace('gold_', '')),
  ...idsOfDir(path.join(GOLD_DIR, 'out_removed')),
  ...idsOfDir(path.join(GOLD_DIR, 'prompts_skipped')),   // hồ sơ phi thực tế đã loại khi viết mẫu vàng
]);

const usableProfile = (p) => {
  if (p.input.expectedScore !== undefined && p.input.expectedScore > 30) return false; // điểm vượt thang 30
  return true;
};

// ---------------------------------------------------------------- nội dung dán vào chatbot
const RULES = `# VAI TRÒ
Bạn viết DỮ LIỆU HUẤN LUYỆN cho FutureTrace - cố vấn hướng nghiệp AI cho học sinh, sinh viên Việt Nam. Mỗi hồ sơ tôi gửi gồm: HỒ SƠ NGƯỜI HỌC, FACT SHEET [F1..Fn], SỐ LIỆU ĐỊNH LƯỢNG (lương P25/P50/P75, ROI, nhu cầu tiền mặt) và YÊU CẦU ĐẦU RA. Với MỖI hồ sơ, viết đúng 1 đối tượng JSON tư vấn bằng tiếng Việt, xưng "em" với người học.

# QUY TẮC SỐ LIỆU (vi phạm = mẫu bị loại tự động)
1. Chỉ dùng con số CÓ SẴN trong FACT SHEET hoặc SỐ LIỆU ĐỊNH LƯỢNG của CHÍNH hồ sơ đó. Giữ nguyên giá trị; được viết dấu phẩy thập phân kiểu Việt (12.4 -> 12,4). KHÔNG tự tính (cộng, trừ, nhân, chia, đổi tháng<->năm, tính phần trăm chênh lệch), KHÔNG làm tròn khác đi, KHÔNG thêm số mới (lương, điểm, tỷ lệ, số người, học phí...).
2. Được dùng các số thời gian chung: 30/60/90 ngày, 6 tháng, 1 năm, 3 năm, 5 năm, 20 năm, "khoảng 9 tháng" tìm việc ở kịch bản Risk, "năm thứ N" đúng như số liệu hoàn vốn; các thang điểm trong hồ sơ (vd 3/5).
3. Số âm viết liền dấu trừ đúng như số liệu: "ROI 20 năm -53%", "lương tăng -1,6%/năm" (không viết "giảm 53%").
4. Khi trích số từ FACT SHEET thì ghi mã ngay sau, vd "khoảng 12,4 triệu/tháng [F2]". Toàn bài phải có ít nhất 2 mã [F#] KHÁC NHAU, và chỉ dùng mã có thật trong hồ sơ.
5. Không nêu tên trường, công ty, học bổng, tổ chức nào không có trong hồ sơ hoặc FACT SHEET.
6. Nếu hồ sơ có ghi chú "NHÓM NGHỀ GẦN ĐÚNG" thì văn bản PHẢI nói rõ số lương/số tin là mốc tham khảo của nhóm nghề gần nhất, dùng đúng cụm từ "tham khảo" hoặc "gần đúng".

# NỘI DUNG
- Ba kịch bản là ba KẾT CỤC của CÙNG một lựa chọn: Positive = nhóm 25% tốt nhất (số liệu Tối ưu P75), Neutral = điển hình (Cân bằng P50), Risk = nhóm 25% kém nhất (Thận trọng P25), chậm tìm việc khoảng 9 tháng. Mỗi kịch bản dùng đúng bộ số của nó.
- Cụ thể theo ngành, trường, giai đoạn học, khu vực, học lực, tài chính, áp lực và mối lo trong hồ sơ. Tránh câu dùng được cho mọi ngành. Kế hoạch 90 ngày là việc làm được, đo được, hợp với giai đoạn (lớp 11 chọn tổ hợp; lớp 12 ôn thi và chiến lược nguyện vọng; sinh viên năm 1-2 xây nền và thực tập; chuyển ngành thì cân đối thời gian, tận dụng nền cũ).
- Trung thực: nếu tài chính không đủ, ROI âm, học lực thấp so với điểm chuẩn thì nói thẳng, kèm phương án thay thế.
- Hồ sơ chuyển ngành/song bằng: ROI chưa tính đủ thời gian và học phí phát sinh khi chuyển, hãy nói rõ điều này.
- Giọng văn: ấm áp, thẳng thắn, như anh chị đi trước; tiếng Việt tự nhiên, có dấu, không dùng tiếng Anh khi có từ Việt.

# ĐỘ DÀI (đếm theo từ; NGOÀI khoảng cho phép = bị loại)
- summary: 50-70 từ (cho phép 35-100).
- Mỗi kịch bản: title cụ thể (không chung chung); description 60-90 từ (cho phép 45-120); criticalAdvice 30-50 từ (cho phép 22-70); marketAnalysis 30-50 từ dựa trên FACT SHEET (cho phép 22-70).
- swot: đúng 4 mục theo thứ tự S, W, O, T; MỖI mục 20-35 từ (tối thiểu 14 từ).
- sprint90: đúng 3 giai đoạn ("Ngày 1-30: ...", "Ngày 31-60: ...", "Ngày 61-90: ..."), mỗi giai đoạn đúng 3 việc, MỖI việc ít nhất 6 từ.
- timeline: start, sixMonths, oneYear, threeYears, MỖI mốc 25-40 từ (tối thiểu 18 từ).

# ĐỊNH DẠNG JSON (đúng tên khóa, không thêm khóa khác)
{"summary":"...","scenarios":[{"type":"Positive","title":"...","description":"...","criticalAdvice":"...","marketAnalysis":"...","swot":[{"type":"S","value":"..."},{"type":"W","value":"..."},{"type":"O","value":"..."},{"type":"T","value":"..."}],"sprint90":[{"phase":"Ngày 1-30: ...","tasks":["...","...","..."]},{"phase":"Ngày 31-60: ...","tasks":["...","...","..."]},{"phase":"Ngày 61-90: ...","tasks":["...","...","..."]}]},{"type":"Neutral",...},{"type":"Risk",...}],"timeline":{"start":"...","sixMonths":"...","oneYear":"...","threeYears":"..."}}

# CÁCH TRẢ LỜI (bắt buộc để máy tách được)
Với mỗi hồ sơ, in đúng 3 dòng theo mẫu (thay pXXXXX bằng mã hồ sơ), KHÔNG giải thích gì thêm, không dùng khối \`\`\`:
===BẮT ĐẦU pXXXXX===
{...JSON trên MỘT dòng...}
===KẾT THÚC pXXXXX===
Nếu sắp hết độ dài câu trả lời, hãy viết trọn các hồ sơ đã bắt đầu và dừng ở ranh giới hồ sơ; tôi sẽ gửi tiếp các hồ sơ còn lại.`;

const goldExamples = (n) => {
  // Mẫu vàng làm ví dụ: khác giai đoạn nhau, không lấy mẫu thuộc tập test
  const gold = builder.loadGold().filter(g => !goldTestIds.has(g.id.replace('gold_', '')));
  const seen = new Set();
  const out = [];
  for (const g of gold) {
    if (out.length >= n) break;
    if (seen.has(g.stage)) continue;
    seen.add(g.stage);
    out.push(g);
  }
  return out.map((g, i) => `--- VÍ DỤ ${i + 1}: hồ sơ ---\n${g.messages[1].content}\n--- VÍ DỤ ${i + 1}: đầu ra đạt chuẩn (CHỈ học văn phong, độ dài, cách trích [F#]; KHÔNG chép số sang hồ sơ khác) ---\n${g.messages[2].content}`).join('\n\n');
};

const instructionsText = () => `${RULES}\n\n# VÍ DỤ ĐẠT CHUẨN\n${goldExamples(2)}\n`;

const profileBlock = (p, prep, fixReason) => {
  const fit = prep.factSheet.occupation?.fit;
  const nFacts = prep.factSheet.facts.length;
  const notes = [];
  if (fit === 'approx' || fit === 'weak') notes.push('NHÓM NGHỀ GẦN ĐÚNG: phải nói rõ lương/số tin là mốc tham khảo (dùng cụm "tham khảo" hoặc "gần đúng").');
  if (nFacts >= 3) notes.push(`Trích ít nhất 2 mã khác nhau trong [F1]..[F${nFacts}].`);
  if (prep.student.stage === 'CHUYEN_NGANH_SONG_BANG') notes.push('Hồ sơ chuyển ngành: nói rõ ROI chưa tính đủ thời gian và học phí phát sinh khi chuyển.');
  if (fixReason) notes.push(`LẦN TRƯỚC BỊ LOẠI VÌ: ${fixReason}. Viết lại TOÀN BỘ JSON và sửa đúng lỗi này.`);
  return `######## HỒ SƠ ${p.id} ########\nGHI CHÚ: ${notes.join(' ') || '(không)'}\n${prep.prompt}\n`;
};

/** Chỉ ra đúng chỗ sai để chatbot sửa trúng (câu chứa số không có căn cứ, trường sai độ dài) */
const explain = (json, prep, reason) => {
  const key = reason.split(':')[0];
  if (key === 'ungrounded_number') {
    const allowed = collectAllowed({ facts: prep.factSheet.facts, quant: prep.quant, input: prep.cleanData });
    const bad = [];
    const walk = (s) => { if (typeof s === 'string') bad.push(...verifyText(s, allowed).removed); };
    walk(json.summary); Object.values(json.timeline || {}).forEach(walk);
    for (const s of json.scenarios || []) {
      [s.title, s.description, s.criticalAdvice, s.marketAnalysis].forEach(walk);
      (s.swot || []).forEach(x => walk(x?.value));
      (s.sprint90 || []).forEach(ph => (ph?.tasks || []).forEach(walk));
    }
    const list = bad.slice(0, 3).map(x => `"${String(x.sentence || x.text || x).slice(0, 160)}"`).join('; ');
    return `${reason} -> câu có số không có trong FACT SHEET/SỐ LIỆU ĐỊNH LƯỢNG: ${list}`;
  }
  if (key === 'bad_length') {
    const issues = [];
    const chk = (name, s, lo, hi) => { const n = wc(s); if (n < lo || n > hi) issues.push(`${name} có ${n} từ (cần ${lo}-${hi})`); };
    chk('summary', json.summary, 35, 100);
    (json.scenarios || []).forEach(s => {
      chk(`${s.type}.description`, s.description, 45, 120); chk(`${s.type}.criticalAdvice`, s.criticalAdvice, 22, 70); chk(`${s.type}.marketAnalysis`, s.marketAnalysis, 22, 70);
      (s.swot || []).forEach(x => chk(`${s.type}.swot ${x.type}`, x.value, 14, 999));
      (s.sprint90 || []).forEach(ph => (ph.tasks || []).forEach(t => chk(`${s.type}.sprint90 "${String(t).slice(0, 30)}"`, t, 5, 999)));
    });
    Object.entries(json.timeline || {}).forEach(([k, v]) => chk(`timeline.${k}`, v, 18, 999));
    return `${reason} -> ${issues.slice(0, 5).join('; ')}`;
  }
  return reason;
};

const reasonText = (reason) => {
  const [key, detail] = reason.split(/:(.+)/);
  const base = builder.RETRY_HINTS[key] || reason;
  return detail ? `${base} (chi tiết: ${detail})` : base;
};

const writeBatch = (state, ids, { teacher, full, fixOf, reasons = {} }) => {
  const bid = fixOf ? `${fixOf}-sua${(state.batches[fixOf]?.fixes || 0) + 1}` : `b${String(state.next).padStart(4, '0')}`;
  if (fixOf) state.batches[fixOf].fixes = (state.batches[fixOf].fixes || 0) + 1;
  else state.next += 1;
  const blocks = ids.map(id => profileBlock(byId.get(id), runner.prepare(byId.get(id).input), reasons[id] && reasonText(reasons[id])));
  const head = full ? `${instructionsText()}\n# LÔ HỒ SƠ CẦN VIẾT\n` : 'Làm đúng theo hướng dẫn đã cài sẵn (quy tắc số liệu, độ dài, định dạng ===BẮT ĐẦU/KẾT THÚC===).\n';
  const text = `${head}Viết ${ids.length} hồ sơ sau: ${ids.join(', ')}.\n\n${blocks.join('\n')}`;
  fs.writeFileSync(path.join(BATCH_DIR, `${bid}.txt`), text);
  fs.writeFileSync(path.join(BATCH_DIR, `${bid}.answer.txt`), '');
  state.batches[bid] = { ids, teacher, createdAt: new Date().toISOString(), imported: false };
  return { bid, chars: text.length };
};

// ---------------------------------------------------------------- tách câu trả lời của chatbot
const parseAnswer = (text) => {
  const found = {};
  const clean = text.replace(/```(?:json)?/gi, '');
  // Chấp nhận "=BẮT ĐẦU p..=" (khi copy phần đã hiển thị, chatbot có thể nuốt bớt dấu "=") và nhiều bản cho cùng hồ sơ
  const re = /=+\s*BẮT ĐẦU\s+(p\d{5})\s*=+([\s\S]*?)=+\s*KẾT THÚC\s+\1\s*=+/g;
  for (const m of clean.matchAll(re)) {
    const body = m[2].trim();
    let cand;
    try {
      cand = { json: JSON.parse(body), repaired: false };
    } catch {
      try { cand = { json: JSON.parse(jsonrepair(body)), repaired: true }; } catch (e) { cand = { error: `JSON hỏng: ${e.message.slice(0, 80)}` }; }
    }
    (found[m[1]] = found[m[1]] || []).push(cand);
  }
  return found;
};

// ---------------------------------------------------------------- lệnh
const doneIds = () => new Set([...readJsonl(SAMPLES), ...readJsonl(REJECTS)].map(r => r.id));
const pendingIds = (state) => new Set(Object.values(state.batches).filter(b => !b.imported).flatMap(b => b.ids));

const commands = {
  instructions() {
    // Ô hướng dẫn của Custom GPT giới hạn ~8.000 ký tự: tách quy tắc (dán vào ô hướng dẫn) và ví dụ (tải lên làm tệp kiến thức)
    const rules = path.join(OUT, 'HUONG_DAN_CHATBOT.md');
    const examples = path.join(OUT, 'VI_DU_MAU.md');
    fs.writeFileSync(rules, `${RULES}\n\nNếu có tệp VI_DU_MAU.md: đọc để học văn phong, độ dài, cách trích [F#]; không chép số liệu của ví dụ.\n`);
    fs.writeFileSync(examples, `# VÍ DỤ ĐẠT CHUẨN\n${goldExamples(2)}\n`);
    quiet(`Đã ghi:\n  ${rules} (${fs.readFileSync(rules, 'utf8').length} ký tự): dán vào ô hướng dẫn của Gem / Project / Custom GPT\n  ${examples}: tải lên làm tệp kiến thức (knowledge)\nKhông dùng Gem/Project/GPT thì xuất lô bằng: export --full`);
  },

  export() {
    const state = loadState();
    const k = Number(args.k || 3);
    const count = Number(args.count || 1); // số lô xuất một lần (dán vào nhiều tab/cuộc chat song song)
    const skip = new Set([...doneIds(), ...pendingIds(state), ...goldIds]);
    const made = [];
    let i = N_TEST;
    for (let b = 0; b < count; b++) {
      const ids = [];
      for (; i < profiles.length && ids.length < k; i++) {
        const p = profiles[i];
        if (skip.has(p.id) || goldTestIds.has(p.id) || !usableProfile(p)) continue;
        ids.push(p.id);
      }
      if (!ids.length) break;
      const { bid, chars } = writeBatch(state, ids, { teacher: args.teacher || 'chat', full: !!args.full });
      made.push(`  ${bid}: ${ids.join(', ')} (${chars} ký tự)`);
    }
    saveState(state);
    if (!made.length) return quiet('Hết hồ sơ trong kho lấy mẫu.');
    quiet(`Đã tạo ${made.length} lô:\n${made.join('\n')}\nMỗi lô: copy TOÀN BỘ data/sft_chat/batches/<lô>.txt vào chatbot, dán câu trả lời vào <lô>.answer.txt.\nXong thì chạy: node ml/finetune/chat_batch.js import all`);
  },

  import() {
    if (positional[0] === 'all') {
      // Import mọi lô chưa import đã có câu trả lời (bỏ qua lô chưa dán)
      const pend = Object.entries(loadState().batches).filter(([, b]) => !b.imported).map(([k]) => k);
      const ready = pend.filter(b => fs.existsSync(path.join(BATCH_DIR, `${b}.answer.txt`)) && fs.readFileSync(path.join(BATCH_DIR, `${b}.answer.txt`), 'utf8').trim());
      if (!ready.length) return quiet(`Không có lô nào có câu trả lời (đang chờ: ${pend.join(', ') || 'không'}).`);
      for (const b of ready) { positional[0] = b; commands.import(); }
      return;
    }
    const bid = positional[0];
    const state = loadState();
    const batch = state.batches[bid];
    if (!batch) return quiet(`Không có lô ${bid}.`);
    const file = args.file || path.join(BATCH_DIR, `${bid}.answer.txt`);
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (!text.trim()) return quiet(`Chưa có câu trả lời trong ${file}.`);
    const found = parseAnswer(text);
    const done = doneIds();
    let ok = 0;
    const fix = {};
    const missing = [];
    for (const id of batch.ids) {
      if (done.has(id)) continue;
      const cands = found[id];
      if (!cands) { missing.push(id); continue; }
      const prep = runner.prepare(byId.get(id).input);
      // Nhiều bản cho cùng hồ sơ: lấy bản đầu tiên đạt, không thì báo lỗi của bản đầu tiên
      const checked = cands.map(c => ({ ...c, reason: c.error ? 'incomplete_fields' : builder.checkSample(c.json, prep) }));
      const got = checked.find(c => !c.reason) || checked[0];
      const reason = got.reason;
      if (!reason) {
        fs.appendFileSync(SAMPLES, JSON.stringify({
          id, task: task.TASK_ID, teacher: batch.teacher, batch: bid,
          messages: [{ role: 'system', content: prep.system }, { role: 'user', content: prep.prompt }, { role: 'assistant', content: JSON.stringify(got.json) }]
        }) + '\n');
        ok++;
        quiet(`  ✓ ${id}${got.repaired ? ' (đã sửa JSON nhẹ)' : ''}`);
        continue;
      }
      state.attempts[id] = (state.attempts[id] || 0) + 1;
      quiet(`  ✗ ${id}: ${reason}${got.error ? ` (${got.error})` : ''}`);
      if (state.attempts[id] > MAX_FIX) fs.appendFileSync(REJECTS, JSON.stringify({ id, reason, batch: bid }) + '\n');
      else fix[id] = got.error ? reason : explain(got.json, prep, reason);
    }
    batch.imported = true;
    const out = [`Lô ${bid}: đạt ${ok}/${batch.ids.length}`];
    if (missing.length) {
      // Hồ sơ chatbot chưa viết (hết độ dài): đưa vào lô mới, không tính là lỗi
      const r = writeBatch(state, missing, { teacher: batch.teacher, full: !!args.full });
      out.push(`  Chưa có câu trả lời cho ${missing.join(', ')} -> lô ${r.bid}.txt (dán tiếp)`);
    }
    if (Object.keys(fix).length) {
      const r = writeBatch(state, Object.keys(fix), { teacher: batch.teacher, full: !!args.full, fixOf: bid.split('-')[0], reasons: fix });
      out.push(`  Cần sửa ${Object.keys(fix).length} hồ sơ -> lô ${r.bid}.txt (dán vào CÙNG cuộc chat, rồi import ${r.bid})`);
    }
    saveState(state);
    quiet(out.join('\n'));
    commands.status();
  },

  status() {
    const state = loadState();
    const s = readJsonl(SAMPLES);
    const rj = readJsonl(REJECTS);
    const pend = Object.entries(state.batches).filter(([, b]) => !b.imported).map(([k]) => k);
    const byTeacher = {};
    s.forEach(x => (byTeacher[x.teacher] = (byTeacher[x.teacher] || 0) + 1));
    quiet(`Tổng: ${s.length} mẫu đạt, ${rj.length} hồ sơ bỏ sau ${MAX_FIX} lần sửa | theo nguồn: ${JSON.stringify(byTeacher)}`);
    if (pend.length) quiet(`Lô chưa import: ${pend.join(', ')}`);
  },

  pack() {
    const goldup = Number(args.goldup || 3);
    const samples = readJsonl(SAMPLES);
    const strip = (m) => JSON.stringify({ messages: m });
    // val = 12 mẫu vàng val + 5% mẫu chat; test = 25 hồ sơ vàng giữ riêng (để so sánh với lần đánh giá trước)
    const nVal = Math.round(samples.length * 0.05);
    const goldVal = readJsonl(path.join(GOLD_SPLIT, 'val.jsonl'));
    const goldTrain = builder.loadGold().filter(g => !goldTestIds.has(g.id.replace('gold_', '')))
      .filter(g => !goldVal.some(v => v.messages[2].content === g.messages[2].content));
    const train = [...samples.slice(nVal).map(s => s.messages), ...goldTrain.flatMap(g => Array(goldup).fill(g.messages))];
    const val = [...goldVal.map(v => v.messages), ...samples.slice(0, nVal).map(s => s.messages)];
    fs.writeFileSync(path.join(OUT, 'train.jsonl'), train.map(strip).join('\n') + '\n');
    fs.writeFileSync(path.join(OUT, 'val.jsonl'), val.map(strip).join('\n') + '\n');
    fs.copyFileSync(path.join(GOLD_SPLIT, 'test_profiles.jsonl'), path.join(OUT, 'test_profiles.jsonl'));
    quiet(`train ${train.length} dòng (${samples.length - nVal} mẫu chat + ${goldTrain.length} mẫu vàng x${goldup}) | val ${val.length} | test 25 hồ sơ vàng -> ${OUT}`);
  },
};

fs.mkdirSync(BATCH_DIR, { recursive: true });
if (!commands[cmd]) {
  quiet('Lệnh: instructions | export [--k 3] [--full] [--teacher tên] | import <lô> | status | pack [--goldup 3]');
  process.exit(1);
}
commands[cmd]();
