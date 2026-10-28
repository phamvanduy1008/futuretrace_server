/**
 * Test luồng mô phỏng streaming (SSE) + LLM Gateway (fallback, circuit breaker, hủy) với máy chủ LLM giả:
 *  - /v1/chat/completions: chuẩn OpenAI/vLLM (giống Qwen fine-tune trên Modal), stream SSE
 *  - /api/chat: chuẩn Ollama (NDJSON)
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');

process.env.JWT_SECRET = 'test-secret';
process.env.SIM_MODE = 'single'; // máy LLM giả trả một JSON đầy đủ (luồng v2); luồng 4 phần + slot kiểm ở tests/slots.test.js
delete process.env.GEMINI_API_KEYS;
delete process.env.GEMINI_API_KEY;

const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

const quiet = console.log;
console.log = () => {};
const app = require('../server');
const llmGateway = require('../services/llmGateway');
console.log = quiet;
const User = require('../models/User');
const SimulationScenario = require('../models/SimulationScenario');

const AI_JSON = JSON.stringify({
  summary: 'Ngành Kế toán có lương khởi điểm trung vị khoảng 9,5 triệu/tháng [F3]; cần cân nhắc chi phí học so với khả năng tài chính gia đình.',
  scenarios: ['Positive', 'Neutral', 'Risk'].map(type => ({
    type,
    title: `Kịch bản ${type} ngành Kế toán`,
    description: 'Người học theo đuổi ngành Kế toán, xây dựng nền tảng Excel và chuẩn mực kế toán, tham gia câu lạc bộ học thuật và tích lũy kinh nghiệm thực tế trước khi tốt nghiệp để tăng khả năng có việc làm sớm.',
    criticalAdvice: 'Lập kế hoạch học bổng ngay từ năm nhất và luyện Excel nâng cao mỗi tuần.',
    marketAnalysis: 'Nhu cầu tuyển kế toán ổn định với hơn hai mươi tám nghìn tin tuyển dụng trong giai đoạn gần đây.',
    swot: ['S', 'W', 'O', 'T'].map(t => ({ type: t, value: `Nhận định ${t} cụ thể cho người học ngành Kế toán tại Đà Nẵng.` })),
    sprint90: [1, 2, 3].map(i => ({ phase: `Tháng ${i}`, tasks: ['Việc một cụ thể', 'Việc hai cụ thể', 'Việc ba cụ thể'] }))
  })),
  timeline: {
    start: 'Bắt đầu ôn thi các môn trong tổ hợp xét tuyển và tìm hiểu chương trình đào tạo ngành Kế toán.',
    sixMonths: 'Hoàn thành kỳ thi tốt nghiệp, đăng ký nguyện vọng theo chiến lược an toàn ba tầng.',
    oneYear: 'Là sinh viên năm nhất, làm quen phương pháp học tín chỉ và giữ điểm trung bình tốt.',
    threeYears: 'Thực tập tại doanh nghiệp, hoàn thiện kỹ năng phần mềm kế toán và chuẩn bị hồ sơ xin việc.'
  }
});

let fakeMode = { modal: 'ok', ollama: 'ok', delayMs: 0 };
let fakeHits = { modal: 0, ollama: 0 };
const chunksOf = (s, n = 12) => Array.from({ length: n }, (_, i) => s.slice(Math.floor(i * s.length / n), Math.floor((i + 1) * s.length / n)));

const fakeLLM = http.createServer(async (req, res) => {
  const which = req.url.startsWith('/v1/') ? 'modal' : req.url.startsWith('/api/chat') ? 'ollama' : 'health';
  if (which === 'health') return res.end('ok');
  fakeHits[which]++;
  if (fakeMode[which] === 'fail') {
    res.writeHead(500);
    return res.end('boom');
  }
  if (which === 'modal') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const c of chunksOf(AI_JSON)) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
      await new Promise(r => setTimeout(r, fakeMode.delayMs));
    }
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 700 } })}\n\n`);
    return res.end('data: [DONE]\n\n');
  }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  for (const c of chunksOf(AI_JSON)) res.write(JSON.stringify({ message: { content: c }, done: false }) + '\n');
  res.end(JSON.stringify({ done: true, eval_count: 700, prompt_eval_count: 900 }) + '\n');
});

let mongod;
let server;
let base;

const createUser = (token = 300) => User.create({
  email: `u${crypto.randomBytes(3).toString('hex')}@test.vn`, password_hash: 'x', full_name: 'U',
  code_invite: crypto.randomBytes(4).toString('hex'),
  token,
  consent: { version: 'test', accepted_at: new Date(), birth_year: 2008 }
});
const bearer = (u) => `Bearer ${jwt.sign({ userId: u._id, email: u.email }, process.env.JWT_SECRET, { expiresIn: '5m' })}`;
const INPUT = { decision: 'Em lớp 12 muốn thi ngành Kế toán ở Đại học Kinh tế Đà Nẵng', personalFinance: 2, stress: 4, location: 'Đà Nẵng' };

/** Đọc toàn bộ SSE, trả về danh sách {event, data} (có thể hủy sau N event) */
const readSSE = async (res, { abortAfter, controller } = {}) => {
  const events = [];
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const ev = /^event: (.+)$/m.exec(block);
        const data = /^data: (.+)$/m.exec(block);
        if (ev) events.push({ event: ev[1], data: data ? JSON.parse(data[1]) : null });
        if (abortAfter && ev?.[1] === abortAfter) controller.abort();
      }
    }
  } catch (e) {
    if (!controller?.signal.aborted) throw e;
  }
  return events;
};

const stream = (user, signal) => fetch(`${base}/api/simulations/stream`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: bearer(user) },
  body: JSON.stringify(INPUT),
  signal
});

before(async () => {
  await new Promise(r => fakeLLM.listen(0, r));
  const llmUrl = `http://127.0.0.1:${fakeLLM.address().port}`;
  process.env.MODAL_LLM_URL = llmUrl;
  process.env.MODAL_LLM_TOKEN = 't';
  process.env.OLLAMA_BASE_URL = llmUrl;
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  fakeLLM.close();
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(() => {
  fakeMode = { modal: 'ok', ollama: 'ok', delayMs: 0 };
  fakeHits = { modal: 0, ollama: 0 };
  for (const b of Object.values(llmGateway._breakers)) {
    b.state = 'closed';
    b.failures = [];
  }
});

test('stream: facts đến trước, sau đó partial, cuối cùng done; dùng model chính (modal) và lưu DB', async () => {
  process.env.LLM_ORDER = 'modal';
  const user = await createUser();
  const res = await stream(user);
  assert.equal(res.status, 200);
  const events = await readSSE(res);
  const names = events.map(e => e.event);
  assert.ok(names.indexOf('facts') < names.indexOf('partial'), 'facts phải đến trước văn bản AI');
  assert.equal(names.at(-1), 'done');

  const facts = events.find(e => e.event === 'facts').data;
  assert.ok(facts.facts.length >= 3);
  assert.ok(facts.scenarios.Positive.salary.startMonthlyMillion > 0);

  const done = events.at(-1).data;
  assert.equal(done.quality.provider, 'modal');
  assert.equal(done.quality.aiCoverage, 1);
  assert.equal(done.scenarios.length, 3);
  assert.equal(await SimulationScenario.countDocuments({ simulation_id: done.simulationId }), 3);
  assert.equal((await User.findById(user._id)).token, 300 - 80);
});

test('feedback: chủ mô phỏng gửi được 👍/👎 (gửi lại = cập nhật), người khác không gửi được', async () => {
  process.env.LLM_ORDER = 'modal';
  const owner = await createUser();
  const other = await createUser();
  const done = (await readSSE(await stream(owner))).at(-1).data;
  const scenarioId = done.scenarios[0].id;
  const send = (u, body) => fetch(`${base}/api/simulations/${done.simulationId}/feedback`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: bearer(u) }, body: JSON.stringify(body)
  });
  assert.equal((await send(owner, { scenarioId, rating: 1, numbersPlausible: true, reasons: ['clear_numbers'] })).status, 200);
  assert.equal((await send(owner, { scenarioId, rating: -1, reasons: ['generic'] })).status, 200);
  assert.equal((await send(other, { scenarioId, rating: 1 })).status, 404);
  const Feedback = require('../models/Feedback');
  const rows = await Feedback.find({ simulation_id: done.simulationId });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rating, -1);
  assert.equal(rows[0].provider, 'modal');
});

test('fallback: model chính lỗi thì chuyển sang provider dự phòng; breaker mở sau 3 lỗi', async () => {
  process.env.LLM_ORDER = 'modal,ollama';
  fakeMode.modal = 'fail';
  const user = await createUser(1000);
  for (let i = 0; i < 4; i++) {
    const events = await readSSE(await stream(user));
    assert.equal(events.at(-1).event, 'done');
    assert.equal(events.at(-1).data.quality.provider, 'ollama');
  }
  assert.equal(fakeHits.modal, 3, 'sau 3 lỗi, breaker mở nên lượt thứ 4 không gọi modal nữa');
  assert.equal(llmGateway.status().modal.breaker.state, 'open');
});

test('tất cả provider lỗi: event error và hoàn token', async () => {
  process.env.LLM_ORDER = 'modal';
  fakeMode.modal = 'fail';
  const user = await createUser(300);
  const events = await readSSE(await stream(user));
  assert.equal(events.at(-1).event, 'error');
  assert.equal(events.at(-1).data.type, 'OVERLOADED');
  assert.equal((await User.findById(user._id)).token, 300);
});

test('người dùng hủy giữa chừng: dừng sinh và hoàn token', async () => {
  process.env.LLM_ORDER = 'modal';
  fakeMode.delayMs = 150;
  const user = await createUser(300);
  const controller = new AbortController();
  await readSSE(await stream(user, controller.signal), { abortAfter: 'facts', controller });
  await new Promise(r => setTimeout(r, 600));
  assert.equal((await User.findById(user._id)).token, 300);
});
