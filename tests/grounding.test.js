/**
 * Hồi quy cho Grounding Verifier: ROI âm phải khớp có dấu, "5 trường" không phải tuyên bố "5 tr".
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verifyText } = require('../services/groundingService');

const removed = (text, allowed) => verifyText(text, allowed).removed.length;

test('ROI âm khớp đúng dấu', () => {
  assert.equal(removed('ROI 20 năm là -91% và chưa hoàn vốn.', [-91]), 0);
  assert.equal(removed('ROI 20 năm là 91% và đã hoàn vốn.', [-91]), 1);
});

test('khoảng "11-16 triệu" không bị hiểu là số âm', () => {
  assert.equal(removed('Lương khoảng 11-16 triệu/tháng.', [11, 16]), 0);
});

test('"5 trường" (chữ có dấu) không bị tính là tuyên bố "5 tr"', () => {
  assert.equal(removed('Em nên chọn 5 trường dự phòng.', []), 0);
  assert.equal(removed('Lương 12 tr/tháng.', []), 1);
});

test('số không có căn cứ bị loại', () => {
  assert.equal(removed('Lương khởi điểm 25 triệu/tháng.', [12.5]), 1);
});
