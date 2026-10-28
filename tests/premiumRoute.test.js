/**
 * Route tạo lộ trình premium: PREMIUM_ENGINE=v3 dùng engine theo phần (model riêng);
 * lỗi hoặc quá ngân sách thời gian thì quay về bản Gemini cũ. Không gọi mạng.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const quiet = console.log;
console.log = () => {};
const geminiService = require('../services/geminiService');
const legacyCalls = [];
geminiService.generatePremiumAnalysis = async (...a) => { legacyCalls.push(a); return { legacy: true }; };
const premiumEngine = require('../services/premiumEngine');
const router = require('../routes/premium');
console.log = quiet;

const scenario = { id: 's1', title: 'Ổn định', description: 'Trung tính' };
const withEnv = async (env, fn) => {
  const old = { ...process.env };
  Object.assign(process.env, env);
  try { return await fn(); } finally { for (const k of Object.keys(env)) { if (k in old) process.env[k] = old[k]; else delete process.env[k]; } }
};

test('mặc định (legacy): dùng bản Gemini cũ', async () => {
  legacyCalls.length = 0;
  await withEnv({ PREMIUM_ENGINE: 'legacy' }, async () => {
    const r = await router.generatePremiumReport(scenario, {}, 12);
    assert.equal(r.legacy, true);
    assert.equal(legacyCalls.length, 1);
  });
});

test('v3: gọi engine theo phần với adapter premium và order từ env', async () => {
  const orig = premiumEngine.generatePremium;
  let req = null;
  premiumEngine.generatePremium = async (r) => { req = r; return { v3: true }; };
  try {
    await withEnv({ PREMIUM_ENGINE: 'v3', PREMIUM_ORDER: 'modal, gemini' }, async () => {
      const r = await router.generatePremiumReport(scenario, { decision: 'x' }, '18');
      assert.equal(r.v3, true);
      assert.deepEqual(req.order, ['modal', 'gemini']);
      assert.equal(req.modalModel, 'premium');
      assert.equal(req.timeframe, 18);
      assert.ok(req.signal, 'phải truyền signal để hủy khi quá ngân sách');
    });
  } finally { premiumEngine.generatePremium = orig; }
});

test('v3 quá ngân sách thời gian: hủy engine mới rồi dùng bản cũ', async () => {
  const orig = premiumEngine.generatePremium;
  let aborted = false;
  premiumEngine.generatePremium = ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')); });
  });
  legacyCalls.length = 0;
  try {
    await withEnv({ PREMIUM_ENGINE: 'v3', PREMIUM_V3_BUDGET_MS: '50' }, async () => {
      const r = await router.generatePremiumReport(scenario, {}, 12);
      assert.equal(aborted, true);
      assert.equal(r.legacy, true);
      assert.equal(legacyCalls.length, 1);
    });
  } finally { premiumEngine.generatePremium = orig; }
});
