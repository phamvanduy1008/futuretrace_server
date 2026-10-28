/**
 * Slot Renderer (v3): model chỉ viết {{slot}}, code điền số thật; số sau khi điền phải qua Grounding Verifier.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const quiet = console.log;
console.log = () => {};
const runner = require('../services/simulationRunner');
const slotRenderer = require('../services/slotRenderer');
const { verifyText, collectAllowed } = require('../services/groundingService');
console.log = quiet;

const prep = runner.prepare({
  decision: 'Em học lớp 12, muốn thi ngành Kế toán ở Đại học Kinh tế - Đại học Đà Nẵng.',
  academicPerformance: 3, personalFinance: 2, stress: 3, risk: 3, location: 'Đà Nẵng', expectedScore: 24
});

test('số Việt: dấu phẩy thập phân, số âm liền dấu', () => {
  assert.equal(slotRenderer.vn(12.4), '12,4');
  assert.equal(slotRenderer.vn(17685), '17685');
  assert.equal(slotRenderer.vn(-1.6), '-1,6');
});

test('fact slot kèm đơn vị và mã nguồn; slot rút gọn theo kịch bản', () => {
  const f = prep.factSheet.facts.find(x => typeof x.value === 'number');
  const r = slotRenderer.renderText(`Mốc là {{${f.id}}}, khởi điểm {{start}}, ROI {{roi}}.`, prep.slotCtx, 'Neutral');
  assert.deepEqual(r.unknown, []);
  assert.ok(r.text.includes(`[${f.id}]`));
  assert.ok(!r.text.includes('{{'));
  const p50 = prep.quant.scenarios.Neutral.salary.startMonthlyMillion;
  assert.ok(r.text.includes(slotRenderer.vn(p50)));
});

test('slot không tồn tại bị báo, mã [F#] trùng sau slot bị gộp', () => {
  const r = slotRenderer.renderText('Sai {{F99}} và {{F1}} [F1].', prep.slotCtx);
  assert.deepEqual(r.unknown, ['F99']);
  assert.ok(!/\[F1\]\s*\[F1\]/.test(r.text));
});

test('mọi slot sau khi điền đều có căn cứ theo Grounding Verifier', () => {
  const allowed = collectAllowed({ facts: prep.factSheet.facts, quant: prep.quant, input: prep.cleanData });
  for (const [key] of prep.slotCtx.slots) {
    const r = slotRenderer.renderText(`Giá trị là {{${key}}}.`, prep.slotCtx);
    const v = verifyText(r.text, allowed);
    assert.equal(v.removed.length, 0, `slot ${key} -> "${r.text}" bị coi là không căn cứ`);
  }
});

test('prompt 4 phần dùng bảng slot, không lộ số trong yêu cầu viết', () => {
  assert.deepEqual(Object.keys(prep.sections), ['overview', 'Positive', 'Neutral', 'Risk']);
  assert.ok(prep.sections.Risk.includes('{{start}}'));
  assert.ok(prep.sections.overview.includes('=== [SLOT SỐ LIỆU'));
});
