/**
 * Hồi quy cho crosswalk ngành -> nghề: các cặp từng bị nối sai và quy tắc fit/domain.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const quiet = console.log;
console.log = () => {};
const knowledge = require('../services/knowledgeService');
console.log = quiet;

const cw = (code) => knowledge.crosswalkLookup(code);

test('ngành từng bị nối sai vào biên phiên dịch / tài chính', () => {
  assert.notEqual(cw('7229042').industry, 'Biên phiên dịch');          // Quản lý văn hóa
  assert.notEqual(cw('7229040').industry, 'Biên phiên dịch');          // Văn hóa học
  assert.match(cw('7310106').industry, /Xuất nhập khẩu/);              // Kinh tế quốc tế
  assert.equal(cw('7510302').industry, 'Điện - Điện tử - Điện lạnh');  // Điện tử viễn thông
  assert.equal(cw('7340301').industry, 'Kế toán / Kiểm toán');
});

test('ngành không có thị trường tuyển dụng thì không có nhóm lương', () => {
  assert.equal(cw('7860201').industry, null);   // quân sự
  assert.equal(cw('7210205').industry, null);   // thanh nhạc
  assert.equal(cw('7860201').fit, 'none');
});

test('kiến thức định tính chỉ gắn khi trùng lĩnh vực', () => {
  assert.equal(cw('7340115').domain, 'marketing_truyen_thong');
  assert.equal(cw('7220204').domain, null);     // ngôn ngữ không nhận kiến thức tâm lý
  assert.equal(cw('7340101').domain, null);     // bán hàng không nhận kỹ năng tài chính
  assert.equal(cw('7310401').domain, 'khoa_hoc_xa_hoi');
});

test('mọi chương trình có crosswalk đều dùng nhóm ngành có dữ liệu thị trường (trừ fit=none)', () => {
  const bad = knowledge.programs.filter(p => p.occupation && p.occupation.fit !== 'none' && !knowledge.marketForIndustry(p.occupation.industry));
  assert.equal(bad.length, 0, bad.slice(0, 3).map(p => p.major_name).join('; '));
});

test('tên có nhắc "Kinh tế" trong tên trường không đổi ngành Marketing', () => {
  const r = knowledge.resolveFromText('Em muốn học Marketing ở Đại học Kinh tế Kỹ thuật công nghiệp');
  assert.ok(!r.occupation || r.occupation.domain !== 'kinh_te_tai_chinh');
});

test('nhóm lương lẫn nghề khác (kiểm chứng với tin tuyển dụng) không được gắn "khớp"', () => {
  assert.equal(cw('7720101').fit, 'weak');     // Y khoa: nhóm y tế chủ yếu là trình dược viên, điều dưỡng
  assert.equal(cw('7720201').fit, 'approx');   // Dược học
  assert.equal(cw('7340201').fit, 'approx');   // Tài chính - Ngân hàng
  assert.equal(cw('7810103').fit, 'weak');     // Du lịch lữ hành
  assert.equal(cw('7480201').fit, 'strong');   // CNTT
  assert.equal(cw('7340301').fit, 'strong');   // Kế toán
});

test('ngành không có thị trường tuyển dụng không sinh số liệu lương/ROI', () => {
  const quiet2 = console.log; console.log = () => {};
  const runner = require('../services/simulationRunner');
  console.log = quiet2;
  const p = knowledge.programs.find(x => x.occupation && x.occupation.fit === 'none' && x.major_code);
  const prep = runner.prepare({ decision: `Em học lớp 12, muốn thi ngành ${p.major_name}`, programId: p.id, expectedScore: 22, personalFinance: 3, academicPerformance: 3, stress: 3, risk: 3 });
  assert.equal(prep.quant, null);
  assert.ok(prep.factSheet.facts.some(f => f.kind === 'note' && /không ước lượng lương/.test(f.label)));
  assert.ok(!prep.factSheet.facts.some(f => f.kind === 'salary_fresher'));
});
