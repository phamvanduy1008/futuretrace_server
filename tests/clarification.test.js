/**
 * Câu hỏi "Làm rõ thông tin": theo giai đoạn học + ngành đích, không bắt nhầm từ khóa.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const quiet = console.log;
console.log = () => {};
const { analyzeInputReadiness } = require('../services/geminiService');
const { majorNames, detectDomains } = require('../services/clarificationService');
console.log = quiet;

const ask = async (decision) => analyzeInputReadiness({ decision });
const text = (r) => JSON.stringify(r.questions);

test('sinh viên chuyển ngành: hỏi cách chuyển + lý do, dùng đúng tên ngành, không hỏi khối Kinh tế', async () => {
  const r = await ask('Em là sinh viên năm 2 ngành Quản trị - Luật, đang muốn chuyển sang ngành Quản trị văn phòng. Em muốn sau này có thu nhập cao.');
  assert.equal(r.status, 'needs_clarification');
  assert.match(r.questions[0].question, /chuyển ngành theo cách nào/);
  assert.match(r.questions[1].question, /Quản trị văn phòng/);
  assert.match(text(r), /Quản trị - Luật/);
  assert.match(r.questions[2].question, /thu nhập/);
  assert.doesNotMatch(text(r), /khối Kinh tế|Fintech|MNCs/);
});

test('ngành đích là phần sau "chuyển sang", không phải ngành đang học', () => {
  const t = 'Em học ngành Ngôn ngữ Anh nhưng muốn chuyển sang Logistics';
  assert.deepEqual(majorNames(t), { current: 'Ngôn ngữ Anh', target: 'Logistics' });
  assert.equal(detectDomains(t).target.key, 'business');
  assert.equal(detectDomains(t).current.key, 'language');
});

test('"tài chính", "hai", "lại" không bị nhận là CNTT; "quản trị văn phòng" không phải Kinh doanh', () => {
  assert.equal(detectDomains('Em muốn học tài chính, hai năm nữa lại thi').target.key, 'business');
  assert.equal(detectDomains('Em muốn học quản trị văn phòng').target.key, 'office_admin');
  assert.equal(detectDomains('Em muốn học quản trị khách sạn').target.key, 'hospitality');
  assert.equal(detectDomains('Em muốn học AI').target.key, 'it');
});

test('không rõ giai đoạn thì hỏi giai đoạn; tên ngành "ngân hàng" không bị coi là tên trường', async () => {
  const r = await ask('Em muốn học tài chính ngân hàng');
  assert.equal(r.status, 'needs_clarification');
  assert.match(r.questions[0].question, /giai đoạn/);
});

test('lớp 12 có trường + điểm: đủ thông tin; lớp 12 chưa có trường: hỏi điểm dự kiến', async () => {
  assert.equal((await ask('Em lớp 12 muốn thi Đại học Bách khoa Hà Nội ngành Kỹ thuật điện, điểm dự kiến 25')).status, 'ready');
  const r = await ask('Em lớp 12 muốn thi ngành CNTT');
  assert.match(text(r), /Công nghệ thông tin/);
  assert.match(text(r), /Điểm thi tốt nghiệp THPT/);
});

test('mọi câu hỏi có 2-4 lựa chọn, tối đa 3 câu', async () => {
  for (const d of ['Em muốn học y', 'Em lớp 11 thích vẽ', 'Em đi làm 2 năm muốn chuyển sang lập trình', 'Em muốn du học Úc', 'Em là sinh viên năm 3 ngành Kế toán']) {
    const r = await ask(d);
    assert.ok(r.questions.length >= 1 && r.questions.length <= 3, d);
    for (const q of r.questions) assert.ok(q.options.length >= 2 && q.options.length <= 4, `${d}: ${q.question}`);
  }
});
