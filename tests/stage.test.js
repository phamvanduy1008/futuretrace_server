/**
 * Hồi quy nhận diện giai đoạn học (quyết định timing của Career ROI Engine).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const quiet = console.log;
console.log = () => {};
const { extractHolisticStudentContext } = require('../services/geminiService');
console.log = quiet;

const stage = (decision) => extractHolisticStudentContext({ decision }).stage;

test('tên chương trình không làm lệch giai đoạn', () => {
  assert.equal(stage('Em học lớp 12, muốn thi ngành Kinh tế quốc tế ở Đại học Kinh Tế.'), 'THPT_ON_THI_DAI_HOC');
  assert.equal(stage('Em học lớp 12, muốn thi ngành Xây dựng đường sắt tốc độ cao.'), 'THPT_ON_THI_DAI_HOC');
  assert.equal(stage('Em là sinh viên năm 2 ngành CNTT, chuyên ngành Thiết kế vi mạch.'), 'DAI_HOC_DAI_CUONG');
});

test('sinh viên năm 1-2 nói "ra trường" vẫn là đại cương', () => {
  assert.equal(stage('Em là sinh viên năm 1 ngành Sư phạm Tiếng Anh. Em sợ ra trường khó xin việc.'), 'DAI_HOC_DAI_CUONG');
});

test('chuyển ngành và du học vẫn nhận đúng', () => {
  assert.equal(stage('Em là sinh viên năm 2 ngành Điều dưỡng, muốn chuyển sang ngành Tự động hóa.'), 'CHUYEN_NGANH_SONG_BANG');
  assert.equal(stage('Em muốn du học Nhật và cần IELTS.'), 'DU_HOC_QUOC_TE');
  assert.equal(stage('Em năm 4 sắp ra trường.'), 'DAI_HOC_CHUYEN_NGANH_THUC_TAP');
});
