/**
 * Khung thời gian lộ trình premium: 5 giai đoạn liền nhau phủ đủ 1..T với mọi khung 3-60 tháng (bước 3 như giao diện),
 * không có nhãn "Tháng 1-1"; tường thuật mỗi giai đoạn đúng 1 đoạn; pivot nối tiếp sau mốc đã hoàn thành.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const quiet = console.log;
console.log = () => {};
const t = require('../services/premiumTimeline');
const { computePeriodLabels } = require('../services/geminiService');
const llmGateway = require('../services/llmGateway');
const premiumEngine = require('../services/premiumEngine');
const { monthsOf } = require('../ml/finetune/premiumCheck');
console.log = quiet;

const DEGENERATE = /Tháng (\d+)-\1(?!\d)/;

test('mọi khung 1-120 tháng: 5 giai đoạn liền nhau, phủ đủ, không vượt, không có nhãn "Tháng a-a"', () => {
  for (let T = 1; T <= 120; T++) {
    const p = t.planPeriods(T);
    assert.equal(p.length, 5, `T=${T}`);
    assert.deepEqual(t.coverage(p.map(x => ({ month: x.label })), T), { ok: true }, `T=${T}: ${p.map(x => x.label)}`);
    assert.ok(p.every(x => !DEGENERATE.test(x.label)), `T=${T}: ${p.map(x => x.label)}`);
  }
  assert.deepEqual(t.planPeriods(12).map(x => x.label), ['Tháng 1-2', 'Tháng 3-4', 'Tháng 5-7', 'Tháng 8-10', 'Tháng 11-12']);
  assert.deepEqual(t.planPeriods(6).map(x => x.label), ['Tháng 1', 'Tháng 2', 'Tháng 3-4', 'Tháng 5', 'Tháng 6']);
  assert.deepEqual(t.planPeriods(3).map(x => x.label), ['Tháng 1 (tuần 1-2)', 'Tháng 1 (tuần 3-4)', 'Tháng 2 (tuần 1-2)', 'Tháng 2 (tuần 3-4)', 'Tháng 3']);
});

test('hàm cũ computePeriodLabels không còn sinh "Tháng 1-1" hay nhãn vượt khung', () => {
  assert.deepEqual(computePeriodLabels(6), ['Tháng 1', 'Tháng 2', 'Tháng 3-4', 'Tháng 5', 'Tháng 6']);
  for (const T of [3, 6, 9]) assert.ok(computePeriodLabels(T).every(l => !DEGENERATE.test(l) && Math.max(...monthsOf(l)) <= T), `T=${T}`);
});

test('nhãn có tuần được đọc đúng tháng (không bị coi là vượt khung)', () => {
  assert.deepEqual(monthsOf('Tháng 1 (tuần 3-4)'), [1]);
  assert.deepEqual(monthsOf('Tháng 4-6'), [4, 6]);
  assert.equal(t.tidyLabel('Tháng 1-1'), 'Tháng 1');
  assert.equal(t.tidyLabel('Tháng 5-3'), 'Tháng 3-5');
});

test('tường thuật: mỗi giai đoạn đúng 1 đoạn theo thứ tự, gán theo tháng mở đầu, giai đoạn thiếu được viết bù', () => {
  const periods = t.planPeriods(12);
  const ms = periods.map((p, i) => ({ month: p.label, event: `Mục tiêu số ${i + 1}` }));
  const out = t.alignNarrative('Mở đầu. Tháng 1: em học nền tảng. Tháng 2-3: em luyện đề. Giai đoạn từ tháng 7-9: em đi thực tập.', periods, ms);
  const paras = out.split('\n\n');
  assert.equal(paras[0], 'Mở đầu.');
  assert.deepEqual(paras.slice(1).map(p => p.split(':')[0]), periods.map(p => p.label));
  assert.match(paras[1], /^Tháng 1-2: Em học nền tảng\. Em luyện đề\./);   // tháng 1 và 2-3 cùng thuộc "Tháng 1-2"
  assert.match(paras[3], /^Tháng 5-7: Em đi thực tập/);             // tháng 7 thuộc "Tháng 5-7"
  assert.match(paras[5], /^Tháng 11-12: .*mục tiêu số 5/);          // không có đoạn nào: viết bù từ mốc 5
});

test('pivot: mốc đã xong giữ nguyên, mốc mới chia phần còn lại tới hết khung', () => {
  const report = {
    detailedNarrative: 'Tháng 1-2: xong. Tháng 3-4: xong. Tháng 5: mới.',
    milestones: ['Tháng 1-2', 'Tháng 3-4', 'Tháng 6', 'Tháng 9', 'Tháng 10'].map((month, i) => ({ month, event: `Mốc ${i + 1}` }))
  };
  const out = t.applyTimeline(report, 12, { keep: 2 });
  assert.deepEqual(out.milestones.map(m => m.month), ['Tháng 1-2', 'Tháng 3-4', 'Tháng 5-7', 'Tháng 8-9', 'Tháng 10-12']);
  assert.deepEqual(t.coverage(out.milestones, 12), { ok: true });
});

test('engine v3: tháng của mốc do code chốt dù model tự chọn tháng khác; tường thuật phủ đủ khung', async () => {
  const plan = {
    detailedNarrative: 'Tháng 1: em ôn nền tảng. Tháng 3: em luyện đề và làm dự án nhỏ. Tháng 5: em hoàn thiện hồ sơ cá nhân.',
    milestones: [1, 3, 4, 5, 8].map((m, i) => ({ month: `Tháng ${m}`, event: `Mốc ${i + 1} hoàn thành việc quan trọng`, impact: 'High', probability: 70 })),
    influencingFactors: [['Economic', 'Tài chính'], ['Personal', 'Thời gian'], ['Social', 'Bạn bè'], ['Technical', 'Phần mềm']].map(([c, f]) => ({ category: c, factor: f, influence: 'Medium', description: `Ảnh hưởng của ${f} tới lộ trình khá rõ ràng.` })),
    strategicPivotPoints: [1, 2, 3].map(i => ({ condition: `Nếu tình huống ${i} xảy ra`, action: `Thì em đổi sang phương án dự phòng ${i}.` })),
    longTermProjection: 'Trong 3-5 năm em vững nghề.'
  };
  const ms = { details: [1, 2, 3].map(j => ({ title: `Bước ${j} cụ thể`, description: `Mô tả bước ${j}`, objectives: ['a', 'b'], actions: ['c', 'd'], tools: ['Excel', 'MISA'], expectedResult: 'Có kết quả' })) };
  const orig = llmGateway.generate;
  const prompts = [];
  llmGateway.generate = async (req) => {
    prompts.push(req.prompt);
    const json = JSON.parse(JSON.stringify(req.schema.properties.milestones ? plan : ms));
    return { json, text: JSON.stringify(json), provider: 'modal', model: 'premium', usage: {} };
  };
  try {
    for (const T of [3, 6, 12, 24, 60]) {
      prompts.length = 0;
      const out = await premiumEngine.generatePremium({ title: 'Ổn định', description: 'Trung tính', context: { decision: 'Em là sinh viên năm 2 ngành Kế toán.' }, timeframe: T, order: ['modal'] });
      const labels = t.planPeriods(T).map(p => p.label);
      assert.deepEqual(out.milestones.map(m => m.month), labels, `T=${T}`);
      assert.deepEqual(t.coverage(out.milestones, T), { ok: true }, `T=${T}`);
      for (const l of labels) assert.ok(prompts[0].includes(l), `prompt khung phải liệt kê giai đoạn ${l}`);
      for (const l of labels) assert.ok(out.detailedNarrative.includes(`${l}:`), `T=${T}: tường thuật thiếu "${l}:"`);
      assert.match(out.quality.monthsFollowed, /^[0-5]\/5$/);
      assert.deepEqual(out.influencingFactors.map(f => f.category), ['Kinh tế', 'Cá nhân', 'Xã hội', 'Kỹ thuật']);
    }
  } finally { llmGateway.generate = orig; }
});
