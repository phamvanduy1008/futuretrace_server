/**
 * Đánh giá chất lượng engine sinh văn bản trên bộ hồ sơ test giữ riêng (không dùng để huấn luyện).
 *
 * Hệ thống so sánh (--systems, phân tách bằng dấu phẩy):
 *   modal   - Qwen fine-tune trên Modal (cần MODAL_LLM_URL); đặt MODAL_LLM_MODEL khác để đo Qwen gốc
 *   gemini  - Gemini Flash-Lite (engine dự phòng)
 *   ollama  - model cục bộ
 *   legacy  - pipeline cũ (geminiService.generateSimulation, prompt + template cũ)
 *
 * Chỉ số mỗi hệ: tỷ lệ thành công, JSON hợp lệ không cần sửa, độ đầy đủ do AI viết (aiCoverage),
 * groundedness (số liệu có căn cứ), số câu bị loại, số tên trường/tổ chức ngoài Fact Sheet,
 * độ trễ P50/P95, thời gian token đầu P50/P95, chi phí; tùy chọn --judge: điểm rubric 1-5 do Gemini chấm
 * (lưu ý thiên lệch khi Gemini chấm chính nó: bổ sung chấm mù bởi người trên 50 mẫu).
 *
 * Chạy: node ml/eval/run_llm_eval.js --profiles data/sft_t1/test_profiles.jsonl --systems modal,gemini --n 150 --judge
 */
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const quiet = console.log;
console.log = () => {};
const runner = require('../../services/simulationRunner');
const llmGateway = require('../../services/llmGateway');
const task = require('../../services/prompts/simulationTask');
const { verifyText, collectAllowed } = require('../../services/groundingService');
const geminiService = require('../../services/geminiService');
console.log = quiet;

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : acc), []));
const PROFILES = path.resolve(args.profiles || path.join(__dirname, '../../data/sft_t1/test_profiles.jsonl'));
const SYSTEMS = String(args.systems || 'gemini').split(',');
const N = Number(args.n || 150);
const JUDGE = !!args.judge;
// --mode sections: đánh giá luồng v3 (4 phần + slot); mặc định single (1 JSON đầy đủ)
const MODE = String(args.mode || 'single');
const OUT = path.resolve(args.out || path.join(__dirname, '../../data/ml/llm_eval_report.json'));

const SCHOOL_MENTION = /(Đại học|ĐH|Học viện|Trường)\s+([A-ZĐÂĂÊÔƠƯ][\wÀ-ỹ]*(?:\s+[A-ZĐÂĂÊÔƠƯ][\wÀ-ỹ]*){0,5})/g;

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

const textsOf = (json) => {
  const out = [json?.summary, ...Object.values(json?.timeline || {})];
  for (const s of json?.scenarios || []) {
    out.push(s.title, s.description, s.criticalAdvice, s.marketAnalysis, s.deepAnalysis?.criticalAdvice);
    (s.swot || s.deepAnalysis?.swot || []).forEach(x => out.push(x?.value));
    (s.sprint90 || s.deepAnalysis?.sprint90 || []).forEach(ph => (ph?.tasks || []).forEach(t => out.push(t)));
  }
  return out.filter(x => typeof x === 'string');
};

const RUBRIC = `Bạn là chuyên gia hướng nghiệp chấm điểm một bản tư vấn do AI viết cho học sinh/sinh viên Việt Nam.
Chấm từng tiêu chí thang 1-5 (5 = xuất sắc) và trả JSON {"specificity":n,"faithfulness":n,"actionability":n,"empathy":n,"fluency":n}.
- specificity: cụ thể theo ngành/trường/hoàn cảnh, không chung chung
- faithfulness: chỉ dùng số liệu có trong FACT SHEET/SỐ LIỆU ĐỊNH LƯỢNG, không bịa
- actionability: lời khuyên và kế hoạch 90 ngày làm được, đo được
- empathy: giọng văn thấu cảm, phù hợp tuổi và áp lực của người học
- fluency: tiếng Việt tự nhiên, đúng ngữ pháp`;
const RUBRIC_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(['specificity', 'faithfulness', 'actionability', 'empathy', 'fluency'].map(k => [k, { type: 'integer' }])),
  required: ['specificity', 'faithfulness', 'actionability', 'empathy', 'fluency']
};

const judge = async (prompt, json) => {
  const gen = await llmGateway.generate({
    system: RUBRIC,
    prompt: `ĐẦU VÀO ĐƯỢC CUNG CẤP CHO AI:\n${prompt}\n\nBẢN TƯ VẤN AI ĐÃ VIẾT (JSON):\n${JSON.stringify(json)}`,
    schema: RUBRIC_SCHEMA,
    maxTokens: 200,
    temperature: 0,
    order: ['gemini']
  });
  return gen.json;
};

const runOne = async (system, profile) => {
  const prep = runner.prepare(profile.input);
  const t0 = Date.now();
  if (system === 'legacy') {
    const out = await geminiService.generateSimulation(profile.input);
    return { prep, json: out, strictJson: true, latencyMs: Date.now() - t0, firstTokenMs: null, costUsd: out.usage?.costUsd || 0, provider: 'legacy' };
  }
  if (MODE === 'sections') {
    // v3: 4 phần song song + slot; JSON "strict" khi cả 4 phần parse được không cần sửa
    const out = await runner.generateSections(prep, { order: [system] });
    const strict = out.gens.every(g => { try { JSON.parse(g.text); return true; } catch { return false; } });
    return {
      prep, json: out.json, strictJson: strict, unknownSlots: out.unknownSlots.length,
      latencyMs: Math.max(...out.gens.map(g => g.latencyMs || 0)),
      firstTokenMs: Math.min(...out.gens.map(g => g.firstTokenMs ?? Infinity)),
      costUsd: out.gens.reduce((a, g) => a + (g.usage?.costUsd || 0), 0), provider: out.gens[0].provider
    };
  }
  const gen = await llmGateway.generate({
    system: prep.system, prompt: prep.prompt, schema: task.SIMULATION_SCHEMA, maxTokens: 4096, temperature: 0.35, order: [system]
  });
  let strictJson = true;
  try { JSON.parse(gen.text); } catch { strictJson = false; }
  return { prep, json: gen.json, strictJson, latencyMs: gen.latencyMs, firstTokenMs: gen.firstTokenMs, costUsd: gen.usage?.costUsd || 0, provider: gen.provider };
};

const main = async () => {
  const profiles = fs.readFileSync(PROFILES, 'utf8').split('\n').filter(Boolean).map(JSON.parse).slice(0, N);
  const report = { generatedAt: new Date().toISOString(), profiles: profiles.length, task: task.TASK_ID, systems: {} };

  for (const system of SYSTEMS) {
    quiet(`[Eval] ${system}: ${profiles.length} hồ sơ`);
    const rows = [];
    for (const profile of profiles) {
      try {
        const r = await runOne(system, profile);
        const allowed = collectAllowed({ facts: r.prep.factSheet.facts, quant: r.prep.quant, input: r.prep.cleanData });
        const texts = textsOf(r.json);
        let claims = 0;
        let grounded = 0;
        let removed = 0;
        for (const t of texts) {
          const v = verifyText(t, allowed);
          claims += v.claims;
          grounded += v.grounded;
          removed += v.removed.length;
        }
        const known = `${r.prep.factSheet.school?.name || ''} ${r.prep.cleanData.decision}`.toLowerCase();
        const unknownEntities = texts.flatMap(t => [...t.matchAll(SCHOOL_MENTION)])
          .filter(m => !known.includes(m[2].toLowerCase().split(' ').slice(0, 2).join(' '))).length;
        const scores = JUDGE ? await judge(r.prep.prompt, r.json).catch(() => null) : null;
        rows.push({
          ok: true, strictJson: r.strictJson, aiCoverage: system === 'legacy' ? null : runner.measureAiCoverage(r.json),
          groundedness: claims ? grounded / claims : 1, claims, removed, unknownEntities,
          latencyMs: r.latencyMs, firstTokenMs: r.firstTokenMs, costUsd: r.costUsd, scores, unknownSlots: r.unknownSlots ?? null
        });
      } catch (err) {
        rows.push({ ok: false, error: String(err.message).slice(0, 160) });
      }
      if (rows.length % 10 === 0) quiet(`  ${rows.length}/${profiles.length}`);
    }
    const ok = rows.filter(r => r.ok);
    const judged = ok.filter(r => r.scores);
    report.systems[system] = {
      successRate: ok.length / rows.length,
      strictJsonRate: mean(ok.map(r => (r.strictJson ? 1 : 0))),
      aiCoverage: mean(ok.filter(r => r.aiCoverage !== null).map(r => r.aiCoverage)),
      groundedness: mean(ok.map(r => r.groundedness)),
      numericClaimsPerOutput: mean(ok.map(r => r.claims)),
      removedSentencesPerOutput: mean(ok.map(r => r.removed)),
      unknownEntitiesPerOutput: mean(ok.map(r => r.unknownEntities)),
      ...(MODE === 'sections' ? { unknownSlotsPerOutput: mean(ok.map(r => r.unknownSlots || 0)), mode: 'sections' } : {}),
      latencyMs: { p50: pct(ok.map(r => r.latencyMs), 0.5), p95: pct(ok.map(r => r.latencyMs), 0.95) },
      firstTokenMs: { p50: pct(ok.map(r => r.firstTokenMs).filter(Boolean), 0.5), p95: pct(ok.map(r => r.firstTokenMs).filter(Boolean), 0.95) },
      costUsdPerOutput: mean(ok.map(r => r.costUsd)),
      rubric: judged.length ? Object.fromEntries(Object.keys(RUBRIC_SCHEMA.properties).map(k => [k, mean(judged.map(r => r.scores[k]))])) : null,
      errors: rows.filter(r => !r.ok).map(r => r.error).slice(0, 5)
    };
    quiet(JSON.stringify(report.systems[system], null, 1));
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  quiet(`[Eval] Đã ghi ${OUT}`);
};

main().catch((e) => {
  quiet(e);
  process.exit(1);
});
