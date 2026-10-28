/**
 * Premium Engine: pivot giữ nguyên tuyệt đối các mốc đã hoàn thành; số liệu qua slot và được kiểm;
 * mở rộng bước gỡ đường link ngoài danh sách tin cậy. LLM được giả lập (không gọi mạng).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const quiet = console.log;
console.log = () => {};
const llmGateway = require('../services/llmGateway');
const premiumEngine = require('../services/premiumEngine');
console.log = quiet;

const context = {
  decision: 'Em là sinh viên năm 2 ngành Kế toán ở Đại học Kinh Tế - Đại học Đà Nẵng, muốn thực tập sớm.',
  academicPerformance: 3, personalFinance: 2, stress: 3, risk: 3, location: 'Đà Nẵng'
};
const step = (t) => ({ id: 'x', title: t, description: `Mô tả ${t}`, objectives: ['a', 'b'], actions: ['c', 'd'], tools: ['e', 'f'], expectedResult: 'g', completed: false });
const oldReport = {
  detailedNarrative: 'Tháng 1-2: học Excel. Tháng 3-4: làm CV. Tháng 5-6: thực tập.',
  milestones: [1, 2, 3, 4, 5].map(i => ({ month: `Tháng ${i * 2}`, event: `Mốc cũ số ${i} với nội dung cụ thể`, impact: 'High', probability: 80, details: [step(`Bước ${i}.1 cụ thể dài`), step(`Bước ${i}.2 cụ thể dài`), step(`Bước ${i}.3 cụ thể dài`)] }))
};

const withFakeLLM = async (json, fn) => {
  const orig = llmGateway.generate;
  const calls = [];
  llmGateway.generate = async (req) => { calls.push(req); return { json, text: JSON.stringify(json), provider: 'gemini', model: 'fake', usage: {} }; };
  try { return await fn(calls); } finally { llmGateway.generate = orig; }
};

test('pivot: mốc đã hoàn thành giữ nguyên tuyệt đối, AI chỉ viết số mốc còn lại, gọi Gemini', async () => {
  const fresh = [1, 2, 3].map(i => ({ month: `Tháng ${5 + i}`, event: `Mốc mới ${i} xử lý khó khăn`, impact: 'Medium', probability: 75, details: [step('Mới a dài dài'), step('Mới b dài dài'), step('Mới c dài dài')] }));
  const ai = {
    detailedNarrative: 'Tháng 5: em gặp khó khăn. Tháng 6-8: em học lại. Tháng 9-12: em thực tập, lương khởi điểm khoảng {{P50.start}}.',
    newMilestones: fresh,
    influencingFactors: [['Economic', 'Tài chính gia đình'], ['Personal', 'Học lại môn'], ['Social', 'Bạn bè'], ['Technical', 'Phần mềm kế toán']].map(([c, f]) => ({ category: c, factor: f, influence: 'High', description: `Ảnh hưởng của ${f} tới lộ trình rất rõ.` })),
    strategicPivotPoints: [1, 2, 3].map(i => ({ condition: `Nếu tình huống số ${i} xảy ra trong học kỳ`, action: `Thì em thực hiện phương án dự phòng số ${i} ngay lập tức.` })),
    longTermProjection: 'Trong 3-5 năm em trở thành kế toán viên vững nghề, có kinh nghiệm thực tế.'
  };
  await withFakeLLM(ai, async (calls) => {
    const out = await premiumEngine.pivot({ currentReport: oldReport, completedMilestones: [0, 1], feedback: 'Em trượt một môn', context, timeframe: 12 });
    assert.deepEqual(calls[0].order, ['gemini']);
    assert.equal(calls[0].schema.properties.newMilestones.minItems, 3);
    assert.ok(calls[0].prompt.includes('Mốc cũ số 1'), 'prompt phải có NỘI DUNG mốc đã xong, không chỉ chỉ số');
    assert.equal(out.milestones.length, 5);
    for (let i = 0; i < 2; i++) {
      assert.equal(out.milestones[i].event, oldReport.milestones[i].event);
      assert.equal(out.milestones[i].completed, true);
      assert.ok(out.milestones[i].details.every(d => d.completed === true));
    }
    assert.equal(out.milestones[2].event, 'Mốc mới 1 xử lý khó khăn');
    assert.equal(out.milestones[2].details[0].id, 'step_3_1');
    assert.ok(!JSON.stringify(out).includes('{{'), 'không còn slot chưa điền');
    assert.equal(out.quality.keptMilestones, 2);
    assert.equal(out.quality.groundedness, 1);
  });
});

test('pivot: số AI tự viết không có căn cứ bị loại khỏi văn bản', async () => {
  const ai = {
    detailedNarrative: 'Tháng 5: em gặp khó khăn. Lương sẽ là 99 triệu/tháng. Tháng 6-12: em học lại và thực tập.',
    newMilestones: [1, 2, 3, 4, 5].map(i => ({ month: `Tháng ${i}`, event: `Mốc ${i} mới cụ thể`, impact: 'Low', probability: 60, details: [step('x dài dài dài'), step('y dài dài dài'), step('z dài dài dài')] })),
    influencingFactors: [], strategicPivotPoints: [], longTermProjection: 'Tầm nhìn 3-5 năm của em là trở thành kế toán viên giỏi.'
  };
  await withFakeLLM(ai, async () => {
    const out = await premiumEngine.pivot({ currentReport: oldReport, completedMilestones: [], feedback: 'x', context, timeframe: 12 });
    assert.ok(!out.detailedNarrative.includes('99 triệu') || out.quality.removedSentences >= 1);
    assert.equal(out.quality.keptMilestones, 0);
  });
});

test('mở rộng bước: gỡ link ngoài danh sách tin cậy, giữ link tin cậy', async () => {
  assert.equal(premiumEngine.isTrustedUrl('https://www.coursera.org/learn/x'), true);
  assert.equal(premiumEngine.isTrustedUrl('https://hust.edu.vn/tuyen-sinh'), true);
  assert.equal(premiumEngine.isTrustedUrl('https://khoa-hoc-ke-toan-gia-re.xyz/abc'), false);
  const ai = {
    description: 'Bước này giúp em nắm vững phần mềm kế toán trước khi đi thực tập tại doanh nghiệp.',
    objectives: ['Mục tiêu 1', 'Mục tiêu 2', 'Mục tiêu 3'],
    actions: ['Học trên https://www.coursera.org/learn/accounting mỗi tối.', 'Xem tại https://khoa-hoc-ke-toan-gia-re.xyz/mien-phi để luyện tập.', 'a', 'b', 'c'],
    tools: ['MISA', 'Excel', 'Coursera'], expectedResult: 'Hoàn thành bộ sổ sách mẫu.'
  };
  await withFakeLLM(ai, async (calls) => {
    const out = await premiumEngine.expandStep({ scenarioTitle: 'K', milestoneEvent: 'M', stepTitle: 'S', stepDescription: 'D', context });
    assert.deepEqual(calls[0].order, ['gemini']);
    assert.ok(out.actions[0].includes('coursera.org'));
    assert.ok(!out.actions[1].includes('xyz'));
  });
});

test('tạo lộ trình v3: 1 khung + 5 mốc, gọi adapter premium theo order, slot được điền, id bước đúng', async () => {
  const plan = {
    detailedNarrative: 'Tháng 1-2: em ôn lại Excel và nguyên lý kế toán. Tháng 3-6: em làm dự án nhỏ. Tháng 7-12: em đi thực tập, lương khởi điểm tham khảo khoảng {{P50.start}}.',
    milestones: [2, 4, 6, 9, 12].map((m, i) => ({ month: `Tháng ${m}`, event: `Mốc ${i + 1} hoàn thành việc quan trọng`, impact: 'High', probability: 70 })),
    influencingFactors: [['Economic', 'Tài chính'], ['Personal', 'Thời gian'], ['Social', 'Bạn bè'], ['Technical', 'Phần mềm']].map(([c, f]) => ({ category: c, factor: f, influence: 'Medium', description: `Ảnh hưởng của ${f} tới lộ trình khá rõ ràng.` })),
    strategicPivotPoints: [1, 2, 3].map(i => ({ condition: `Nếu tình huống ${i} xảy ra`, action: `Thì em đổi sang phương án dự phòng ${i}.` })),
    longTermProjection: 'Trong 3-5 năm em trở thành kế toán viên vững nghề.'
  };
  const ms = { details: [1, 2, 3].map(j => ({ title: `Bước ${j} cụ thể`, description: `Mô tả bước ${j}`, objectives: ['a', 'b'], actions: ['c', 'd'], tools: ['Excel', 'MISA'], expectedResult: 'Có kết quả' })) };
  const orig = llmGateway.generate;
  const calls = [];
  llmGateway.generate = async (req) => {
    calls.push(req);
    const json = req.schema.properties.milestones ? plan : ms;
    return { json, text: JSON.stringify(json), provider: 'modal', model: 'premium', usage: { outputTokens: 10 } };
  };
  try {
    const out = await premiumEngine.generatePremium({ title: 'Ổn định', description: 'Kịch bản trung tính', context, timeframe: 12, order: ['modal', 'gemini'] });
    assert.equal(calls.length, 6, '1 khung + 5 mốc');
    assert.ok(calls.every(c => c.modalModel === 'premium' && c.order.join() === 'modal,gemini'));
    assert.equal(out.milestones.length, 5);
    assert.ok(out.milestones.every(m => m.details.length === 3 && m.completed === false));
    assert.equal(out.milestones[3].details[2].id, 'step_4_3');
    assert.ok(!JSON.stringify(out).includes('{{'), 'không còn slot chưa điền');
    assert.match(out.detailedNarrative, /triệu/);
    assert.equal(out.quality.task, 'premium_v3_sections');
    assert.equal(out.usage.outputTokens, 60);
  } finally { llmGateway.generate = orig; }
});
