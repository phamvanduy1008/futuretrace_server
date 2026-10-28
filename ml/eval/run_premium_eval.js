/**
 * Đánh giá tạo lộ trình premium trên tập test giữ riêng (25 hồ sơ vàng, kịch bản Neutral, 12 tháng).
 *
 * Hệ thống so sánh:
 *   modal   - engine v3 (khung + 5 mốc, slot) chạy adapter "premium" trên Modal (model riêng)
 *   gemini  - cùng engine v3 nhưng LLM là Gemini (đối chứng cùng cách chia việc)
 *   legacy  - bản cũ generatePremiumAnalysis (Gemini một lần gọi), đang chạy trên production
 *
 * Chỉ số (đo trên báo cáo cuối cùng người dùng thấy):
 *   success      tạo được báo cáo (không lỗi)
 *   structure    đủ 5 mốc x 3 bước (mỗi bước có tiêu đề/mô tả, >=2 mục tiêu/hành động/công cụ), 4 yếu tố, 3 điểm rẽ nhánh
 *   timeline     mốc có "Tháng N", không lùi, không vượt khung thời gian
 *   groundedness tỷ lệ số liệu (câu có từ khóa dữ liệu) khớp Fact Sheet/định lượng, cùng bộ kiểm verifyDataText
 *   urls / selfTitle / unknownEntity   link, tự xưng/chào hỏi, tên trường ngoài hồ sơ
 *   latency      P50/P95 thời gian tạo đầy đủ
 *   rubric       (--judge) Gemini chấm 1-5: specificity, faithfulness, actionability, coherence, fluency
 *
 *   node ml/eval/run_premium_eval.js --systems modal,gemini,legacy --n 25 --judge
 */
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const quiet = console.log;
console.log = () => { };
const llmGateway = require('../../services/llmGateway');
const premiumEngine = require('../../services/premiumEngine');
const geminiService = require('../../services/geminiService');
const { verifyDataText, collectAllowed } = require('../../services/groundingService');
const { monthsOf } = require('../finetune/premiumCheck');
const premiumTimeline = require('../../services/premiumTimeline');
console.log = quiet;

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--')
  ? [...acc, [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : acc), []));
const CASES = path.resolve(args.cases || path.join(__dirname, '../../data/sft_premium/test_cases.jsonl'));
const SYSTEMS = String(args.systems || 'modal,gemini,legacy').split(',');
const N = Number(args.n || 25);
const CONCURRENCY = Number(args.concurrency || 3);
const JUDGE = !!args.judge;
const OUT = path.resolve(args.out || path.join(__dirname, '../../data/ml/premium_eval_report.json'));

const SCHOOL_MENTION = /(Đại học|ĐH|Học viện|Trường)\s+([A-ZĐÂĂÊÔƠƯ][\wÀ-ỹ]*(?:\s+[A-ZĐÂĂÊÔƠƯ][\wÀ-ỹ]*){0,5})/g;
const SELF_TITLE = /\b(chị|anh|tôi|mình) (là|sẽ|xin|muốn|nghĩ)|^(chào|xin chào)/i;
const URL_RE = /https?:\/\/|www\./i;

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const mean = (arr) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 1000) / 1000 : null);

/** Mọi đoạn văn trong báo cáo (bỏ trường nhãn như month/category) */
const textsOf = (r) => {
  const out = [r?.detailedNarrative, r?.longTermProjection];
  for (const m of r?.milestones || []) {
    out.push(m?.event);
    for (const d of m?.details || []) out.push(d?.title, d?.description, d?.expectedResult, ...(d?.objectives || []), ...(d?.actions || []), ...(d?.tools || []));
  }
  for (const f of r?.influencingFactors || []) out.push(f?.factor, f?.description);
  for (const p of r?.strategicPivotPoints || []) out.push(p?.condition, p?.action);
  return out.filter(x => typeof x === 'string');
};

const structureOk = (r) => {
  const ms = r?.milestones || [];
  if (ms.length !== 5 || (r?.influencingFactors || []).length !== 4 || (r?.strategicPivotPoints || []).length !== 3) return false;
  if (!String(r?.detailedNarrative || '').trim() || !String(r?.longTermProjection || '').trim()) return false;
  return ms.every(m => String(m?.event || '').trim() && (m?.details || []).length === 3 && m.details.every(d =>
    String(d?.title || '').trim() && String(d?.description || '').trim()
    && ['objectives', 'actions', 'tools'].every(k => Array.isArray(d?.[k]) && d[k].filter(x => String(x || '').trim()).length >= 2)));
};

const timelineOk = (r, timeframe) => {
  let last = 0;
  for (const m of r?.milestones || []) {
    const ms = monthsOf(m?.month);
    if (!ms.length || !/tháng/i.test(m?.month || '') || ms[0] < last || Math.max(...ms) > timeframe) return false;
    last = Math.max(...ms);
  }
  return (r?.milestones || []).length === 5;
};

const RUBRIC = `Bạn là chuyên gia hướng nghiệp chấm một LỘ TRÌNH HÀNH ĐỘNG do AI viết cho học sinh/sinh viên Việt Nam.
Chấm từng tiêu chí thang 1-5 (5 = xuất sắc) và trả JSON {"specificity":n,"faithfulness":n,"actionability":n,"coherence":n,"fluency":n}.
- specificity: cụ thể theo ngành/trường/giai đoạn học/hoàn cảnh của người học, không chung chung
- faithfulness: chỉ dùng số liệu có trong FACT SHEET/SỐ LIỆU ĐỊNH LƯỢNG, không bịa số, không bịa trường/tổ chức
- actionability: các bước làm được ngay, có công cụ và kết quả đo được
- coherence: mốc thời gian hợp lý trong khung, tăng dần, các bước khớp với mốc và kịch bản
- fluency: tiếng Việt tự nhiên, đúng ngữ pháp, xưng hô phù hợp`;
const RUBRIC_KEYS = ['specificity', 'faithfulness', 'actionability', 'coherence', 'fluency'];
const RUBRIC_SCHEMA = { type: 'object', properties: Object.fromEntries(RUBRIC_KEYS.map(k => [k, { type: 'integer' }])), required: RUBRIC_KEYS };

const judge = async (input, report) => {
  const slim = {
    detailedNarrative: report.detailedNarrative, longTermProjection: report.longTermProjection,
    milestones: (report.milestones || []).map(m => ({ month: m.month, event: m.event, details: (m.details || []).map(d => ({ title: d.title, description: d.description, actions: d.actions, tools: d.tools, expectedResult: d.expectedResult })) })),
    influencingFactors: report.influencingFactors, strategicPivotPoints: report.strategicPivotPoints
  };
  const gen = await llmGateway.generate({
    system: RUBRIC,
    prompt: `ĐẦU VÀO (hồ sơ, kịch bản, Fact Sheet):\n${input}\n\nLỘ TRÌNH AI ĐÃ VIẾT (JSON):\n${JSON.stringify(slim)}`,
    schema: RUBRIC_SCHEMA, maxTokens: 200, temperature: 0, order: ['gemini']
  });
  return gen.json;
};

const generate = async (system, tc) => {
  const base = { title: tc.scenario.title, description: tc.scenario.description, context: tc.context, timeframe: tc.timeframe };
  if (system === 'modal') return premiumEngine.generatePremium({ ...base, order: ['modal'], modalModel: args['modal-model'] || 'premium' });
  if (system === 'gemini') return premiumEngine.generatePremium({ ...base, order: ['gemini'] });
  if (system === 'legacy') return geminiService.generatePremiumAnalysis(base.title, base.description, base.context, base.timeframe);
  throw new Error(`hệ thống không hỗ trợ: ${system}`);
};

const runOne = async (system, tc) => {
  const t0 = Date.now();
  const { prep, slotText } = premiumEngine.buildContext(tc.context);
  try {
    const report = await generate(system, tc);
    const latencyMs = Date.now() - t0;
    const allowed = collectAllowed({ facts: prep.factSheet.facts, quant: prep.quant, input: prep.cleanData });
    const texts = textsOf(report);
    let claims = 0;
    let grounded = 0;
    for (const t of texts) {
      const v = verifyDataText(t, allowed);
      claims += v.claims;
      grounded += v.grounded;
    }
    const known = `${prep.factSheet.school?.name || ''} ${prep.cleanData.decision}`.toLowerCase();
    const unknownEntity = texts.flatMap(t => [...t.matchAll(SCHOOL_MENTION)])
      .map(m => m[2].replace(/^(ĐH|Đại học)\s+/i, '').toLowerCase().split(/\s+/).slice(0, 2).join(' '))
      .filter(core => core && !known.includes(core)).length;
    const row = {
      id: tc.id, system, ok: true, latencyMs,
      structure: structureOk(report), timeline: timelineOk(report, tc.timeframe),
      coverage: premiumTimeline.coverage(report.milestones, tc.timeframe).ok,
      monthsFollowed: report.quality?.monthsFollowed || null,
      claims, groundedness: claims ? grounded / claims : null,
      urls: texts.filter(t => URL_RE.test(t)).length,
      selfTitle: texts.filter(t => SELF_TITLE.test(t.trim())).length,
      unknownEntity,
      words: texts.join(' ').split(/\s+/).length,
      providers: report.quality?.providers || [report.modelUsed || 'gemini'],
      v3: report.quality?.task === 'premium_v3_sections' ? { unknownSlots: report.quality.unknownSlots, removedSentences: report.quality.removedSentences, planCheck: report.quality.planCheck } : null,
      outputTokens: report.usage?.outputTokens || null
    };
    if (JUDGE) {
      const input = `${prep.prompt || ''}\n\nKỊCH BẢN: ${tc.scenario.title} - ${tc.scenario.description}\nKHUNG: ${tc.timeframe} tháng\n\nBẢNG SỐ LIỆU:\n${slotText}`;
      // Gemini gói miễn phí giới hạn ~15 request/phút: lỗi 429 thì chờ rồi chấm lại
      for (let i = 0; i < 4 && !row.scores; i++) {
        row.scores = await judge(input, report).catch(() => null);
        if (!row.scores && i < 3) await new Promise(r => setTimeout(r, 30000));
      }
    }
    row.report = report;
    return row;
  } catch (err) {
    return { id: tc.id, system, ok: false, latencyMs: Date.now() - t0, error: String(err.message).slice(0, 300) };
  }
};

const main = async () => {
  if (!fs.existsSync(CASES)) throw new Error(`thiếu ${CASES}: chạy node ml/finetune/build_sft_premium.js --pack trước`);
  const cases = fs.readFileSync(CASES, 'utf8').split('\n').filter(Boolean).map(JSON.parse).slice(0, N);
  const rows = [];
  for (const system of SYSTEMS) {
    quiet(`[premium-eval] ${system}: ${cases.length} lộ trình, concurrency ${CONCURRENCY}`);
    const queue = [...cases];
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const tc = queue.shift();
        const r = await runOne(system, tc);
        rows.push(r);
        quiet(`  ${system} ${tc.id}: ${r.ok ? `ok ${(r.latencyMs / 1000).toFixed(1)}s cấu trúc=${r.structure} thời gian=${r.timeline} phủ đủ=${r.coverage} theo nhãn=${r.monthsFollowed} grounded=${r.groundedness ?? '-'}${r.scores ? ` rubric=${JSON.stringify(r.scores)}` : ''}` : `LỖI ${r.error}`}`);
      }
    }));
  }

  const summary = {};
  for (const system of SYSTEMS) {
    const all = rows.filter(r => r.system === system);
    const ok = all.filter(r => r.ok);
    const judged = ok.filter(r => r.scores);
    const g = ok.filter(r => r.groundedness != null);
    summary[system] = {
      n: all.length,
      success: mean(all.map(r => (r.ok ? 1 : 0))),
      structure: mean(ok.map(r => (r.structure ? 1 : 0))),
      timeline: mean(ok.map(r => (r.timeline ? 1 : 0))),
      coverage: mean(ok.map(r => (r.coverage ? 1 : 0))),
      groundedness: g.length ? Math.round((g.reduce((a, r) => a + r.groundedness * r.claims, 0) / g.reduce((a, r) => a + r.claims, 0)) * 1000) / 1000 : null,
      claimsPerReport: mean(ok.map(r => r.claims)),
      urlsPerReport: mean(ok.map(r => r.urls)),
      selfTitlePerReport: mean(ok.map(r => r.selfTitle)),
      unknownEntityPerReport: mean(ok.map(r => r.unknownEntity)),
      wordsPerReport: mean(ok.map(r => r.words)),
      fallbackToOtherProvider: system === 'modal' ? mean(ok.map(r => (r.providers.some(p => p !== 'modal') ? 1 : 0))) : null,
      latencyP50s: pct(ok.map(r => r.latencyMs), 0.5) / 1000,
      latencyP95s: pct(ok.map(r => r.latencyMs), 0.95) / 1000,
      rubric: judged.length ? Object.fromEntries([...RUBRIC_KEYS.map(k => [k, mean(judged.map(r => r.scores[k]))]),
        ['overall', mean(judged.map(r => RUBRIC_KEYS.reduce((a, k) => a + r.scores[k], 0) / RUBRIC_KEYS.length))]]) : null,
      errors: all.filter(r => !r.ok).map(r => `${r.id}: ${r.error}`).slice(0, 5)
    };
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ createdAt: new Date().toISOString(), cases: CASES, judge: JUDGE ? 'gemini' : null, summary, rows }, null, 2));
  quiet(JSON.stringify(summary, null, 2));
  quiet(`-> ${OUT}`);
};

main().catch((e) => { quiet(e); process.exit(1); });
