/**
 * Hồi quy cho Knowledge Layer v2: nhận diện trường/ngành từ câu tự do và Fact Sheet.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const quiet = console.log;
console.log = () => {};
const knowledge = require('../services/knowledgeService');
console.log = quiet;

const resolve = (text) => knowledge.resolveFromText(text);

test('nhận diện trường + ngành khi tên ngành trùng một phần tên trường ("kinh tế")', () => {
  const r = resolve('Em lớp 12 muốn thi ngành Kế toán ở Đại học Kinh tế Đà Nẵng');
  assert.equal(r.school?.id, 'dai-hoc-kinh-te-dai-hoc-da-nang');
  assert.equal(r.majorCode, '7340301');
});

test('"y khoa ở Huế" không khớp nhầm sang ĐH Khoa học Huế', () => {
  const r = resolve('Em muốn học y khoa ở Huế');
  assert.notEqual(r.school?.id, 'dai-hoc-khoa-hoc-dai-hoc-hue');
  assert.equal(r.majorCode, '7720101');
});

test('chuyển ngành: lấy ngành đích', () => {
  const r = resolve('Sinh viên năm 2 ngành Marketing ở TP.HCM muốn chuyển sang Logistics');
  assert.equal(r.majorCode, '7510605');
});

test('viết tắt và tên trường không đầy đủ', () => {
  assert.equal(resolve('Em muốn học quản trị khách sạn ở Duy Tân').school?.id, 'dai-hoc-dan-lap-duy-tan');
  const bk = resolve('Em muốn vào Bách khoa Đà Nẵng học ngành CNTT');
  assert.equal(bk.school?.id, 'dai-hoc-bach-khoa-dai-hoc-da-nang');
  assert.equal(bk.majorCode, '7480201');
});

test('Fact Sheet: mọi fact có ID duy nhất và nguồn; không có số giữ chỗ 8/13/18', () => {
  const sheet = knowledge.buildFactSheet({ decisionText: 'Em muốn học Công nghệ thông tin ở Hà Nội', regionKey: 'reg_hn' });
  assert.ok(sheet.facts.length >= 3);
  assert.equal(new Set(sheet.facts.map(f => f.id)).size, sheet.facts.length);
  for (const f of sheet.facts) assert.ok(f.source, `fact ${f.id} thiếu nguồn`);
  const salary = sheet.facts.find(f => f.kind === 'salary_all');
  assert.ok(salary && !(salary.range[0] === 8 && salary.value === 13 && salary.range[1] === 18));
});

test('autocomplete trường và ngành không phân biệt dấu', () => {
  assert.equal(knowledge.search('kinh te da nang', { type: 'school' })[0]?.id, 'dai-hoc-kinh-te-dai-hoc-da-nang');
  assert.ok(knowledge.search('cong nghe thong tin').length > 0);
});

test('câu băn khoăn ("nhà em kinh tế không dư dả") và tên ngành trùng tên trường không làm lệch ngành', () => {
  const r = resolve('Em lớp 11, đang định hướng chọn tổ hợp để sau này học ngành Điều dưỡng. Nhà em kinh tế không dư dả.');
  assert.equal(r.majorCode, '7720301');
  assert.equal(r.school, null);
});
