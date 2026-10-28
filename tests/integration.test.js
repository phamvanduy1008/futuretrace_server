/**
 * Test tích hợp API trên MongoDB trong bộ nhớ (không chạm DB production, không gọi MoMo/Gemini thật).
 * Chạy: npm test
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.JWT_SECRET = 'test-secret';
process.env.MOMO_ACCESS_KEY = 'test-access';
process.env.MOMO_SECRET_KEY = 'test-secret-key';
process.env.ACCESS_TOKEN_TTL = '30m';

const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

const quiet = console.log;
console.log = () => {};
const app = require('../server');
console.log = quiet;
const User = require('../models/User');
const PremiumAnalysis = require('../models/PremiumAnalysis');
const Transaction = require('../models/Transaction');

let mongod;
let server;
let base;

const createUser = async (email, token = 300) => User.create({
  email,
  password_hash: 'x',
  full_name: email.split('@')[0],
  code_invite: crypto.randomBytes(4).toString('hex'),
  token,
  consent: { version: 'test', accepted_at: new Date(), birth_year: 2008 }
});

const bearer = (user) => `Bearer ${jwt.sign({ userId: user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '5m' })}`;

const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

const signedIpn = (overrides = {}) => {
  const b = {
    partnerCode: 'MOMO', orderId: 'x', requestId: 'r1', amount: 0, orderInfo: 'Mua token FutureTrace',
    orderType: 'momo_wallet', transId: 123, resultCode: 0, message: 'Thành công', payType: 'qr',
    responseTime: Date.now(), extraData: '', ...overrides
  };
  const raw = `accessKey=${process.env.MOMO_ACCESS_KEY}&amount=${b.amount}&extraData=${b.extraData}` +
    `&message=${b.message}&orderId=${b.orderId}&orderInfo=${b.orderInfo}&orderType=${b.orderType}` +
    `&partnerCode=${b.partnerCode}&payType=${b.payType}&requestId=${b.requestId}` +
    `&responseTime=${b.responseTime}&resultCode=${b.resultCode}&transId=${b.transId}`;
  b.signature = crypto.createHmac('sha256', process.env.MOMO_SECRET_KEY).update(raw).digest('hex');
  return b;
};

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});

test('payment: tạo đơn bắt buộc đăng nhập và gói hợp lệ', async () => {
  assert.equal((await post('/api/payment', { tokenAmount: 5000, total_price: 1000 })).status, 401);
  const u = await createUser('pay1@test.vn');
  assert.equal((await post('/api/payment', { tokenAmount: 9999 }, { Authorization: bearer(u) })).status, 400);
});

test('payment: IPN giả chữ ký bị từ chối, trả thiếu tiền không được cộng, trả đủ được cộng đúng 1 lần', async () => {
  const u = await createUser('pay2@test.vn', 0);
  const orderId = `${u._id}_5000_${Date.now()}`;

  const forged = { ...signedIpn({ orderId, amount: 799000 }), signature: 'ab'.repeat(32) };
  assert.equal((await post('/api/payment/callback', forged)).status, 400);

  assert.equal((await post('/api/payment/callback', signedIpn({ orderId, amount: 1000 }))).status, 204);
  assert.equal((await User.findById(u._id)).token, 0);

  const paid = signedIpn({ orderId, amount: 799000 });
  assert.equal((await post('/api/payment/callback', paid)).status, 204);
  assert.equal((await post('/api/payment/callback', paid)).status, 204); // gửi lại (replay)
  assert.equal((await User.findById(u._id)).token, 5000);
  assert.equal(await Transaction.countDocuments({ orderId }), 1);
});

test('premium pivot: không thể sửa lộ trình của người khác và không bị trừ token', async () => {
  const owner = await createUser('owner@test.vn');
  const attacker = await createUser('attacker@test.vn', 300);
  const progress = await PremiumAnalysis.create({
    user_id: owner._id, scenario_id: 's1', title: 'Lộ trình', report: { milestones: [] }, timeframe: 12
  });
  const res = await post('/api/premium/pivot', { progressId: progress._id, feedback: 'đổi hướng' }, { Authorization: bearer(attacker) });
  assert.equal(res.status, 404);
  assert.equal((await User.findById(attacker._id)).token, 300);
});

test('evaluations: /seed yêu cầu quyền admin', async () => {
  const u = await createUser('seed@test.vn');
  assert.equal((await post('/api/evaluations/seed', { questions: [] })).status, 401);
  assert.equal((await post('/api/evaluations/seed', { questions: [] }, { Authorization: bearer(u) })).status, 403);
});

test('auth: access token ngắn hạn, refresh token xoay vòng (token cũ mất hiệu lực)', async () => {
  const bcrypt = require('bcryptjs');
  await User.create({
    email: 'login@test.vn', password_hash: await bcrypt.hash('Passw0rd!', 4), full_name: 'Login',
    code_invite: 'LOGIN1'
  });
  const login = await (await post('/api/auth/login', { email: 'login@test.vn', password: 'Passw0rd!' })).json();
  const decoded = jwt.decode(login.accessToken);
  assert.ok(decoded.exp - decoded.iat <= 30 * 60, 'access token phải sống tối đa 30 phút');
  assert.ok(login.refreshToken);

  const r1 = await post('/api/auth/refresh', { refreshToken: login.refreshToken });
  assert.equal(r1.status, 200);
  const rotated = await r1.json();
  assert.notEqual(rotated.refreshToken, login.refreshToken);
  assert.equal((await post('/api/auth/refresh', { refreshToken: login.refreshToken })).status, 401);
});

test('rate limit: xác thực OTP bị chặn sau 6 lần trong 15 phút', async () => {
  let last;
  for (let i = 0; i < 7; i++) {
    last = await post('/api/auth/register/verify-otp', { email: 'otp@test.vn', otp: '000000' });
  }
  assert.equal(last.status, 429);
});

test('pháp lý: chưa đồng ý thì không gọi AI; dưới 16 tuổi cần phụ huynh xác nhận; xóa tài khoản xóa dữ liệu', async () => {
  const u = await User.create({ email: 'consent@test.vn', password_hash: 'x', full_name: 'C', code_invite: 'CONS01', token: 300 });
  const auth = { Authorization: bearer(u) };
  const sim = await post('/api/simulations/stream', { decision: 'Em muốn học kế toán' }, auth);
  assert.equal(sim.status, 403);
  assert.equal((await sim.json()).code, 'CONSENT_REQUIRED');

  const minorYear = new Date().getFullYear() - 14;
  const noGuardian = await post('/api/auth/consent', { accepted: true, birthYear: minorYear }, auth);
  assert.equal((await noGuardian.json()).code, 'GUARDIAN_REQUIRED');
  assert.equal((await post('/api/auth/consent', { accepted: true, birthYear: minorYear, guardianConfirmed: true }, auth)).status, 200);
  assert.ok((await User.findById(u._id)).consent.accepted_at);

  const del = (body) => fetch(`${base}/api/auth/account`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify(body) });
  assert.equal((await del({ confirm: 'sai' })).status, 400);
  assert.equal((await del({ confirm: 'XOA TAI KHOAN' })).status, 200);
  assert.equal(await User.countDocuments({ _id: u._id }), 0);
});

test('admin: chỉ số nhà đầu tư trả về đủ các nhóm và chặn người không phải admin', async () => {
  const u = await createUser('metrics@test.vn');
  assert.equal((await fetch(`${base}/api/admin/metrics/investor`, { headers: { Authorization: bearer(u) } })).status, 403);
  const adminToken = jwt.sign({ userId: u._id, email: u.email, audience: 'admin', roles: ['super_admin'] }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const res = await fetch(`${base}/api/admin/metrics/investor?days=30`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  for (const k of ['growth', 'engagement', 'aiQuality', 'performance', 'engine', 'unitEconomics']) assert.ok(body[k], k);
});
