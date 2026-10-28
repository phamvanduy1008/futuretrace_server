/**
 * Gemini client dùng chung (geminiService + llmGateway): xoay vòng API key, danh sách model dự phòng,
 * cấu hình giảm độ trễ, ước tính chi phí từ usageMetadata.
 */
const { GoogleGenAI } = require('@google/genai');

let currentKeyIndex = 0;
const getAI = () => {
  const keysStr = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY;
  if (!keysStr) {
    console.log('[AI] MISSING API KEY');
    return new GoogleGenAI({ apiKey: '' });
  }
  const keys = keysStr.split(',').map(k => k.trim()).filter(k => k);
  if (keys.length === 0) return new GoogleGenAI({ apiKey: '' });

  const apiKey = keys[currentKeyIndex % keys.length];
  currentKeyIndex++;
  return new GoogleGenAI({ apiKey });
};

const hasGeminiKey = () => !!(process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY);

// Gemini là engine dự phòng: chỉ dùng dòng Flash-Lite (nhanh, rẻ). Ghi đè bằng GEMINI_MODELS nếu cần.
const GEMINI_FALLBACK_MODELS = (process.env.GEMINI_MODELS || 'gemini-2.5-flash-lite,gemini-3.1-flash-lite')
  .split(',').map(m => m.trim()).filter(Boolean);
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 25000;

// Giá USD / 1M token (input, output) để ước tính chi phí trong GeminiLog. Cập nhật theo bảng giá hiện hành.
const GEMINI_PRICE_PER_M = {
  'gemini-2.5-flash-lite': [0.10, 0.40],
  'gemini-2.5-flash': [0.30, 2.50],
  'gemini-3.1-flash-lite': [0.25, 1.50]
};

const extractUsage = (response, model) => {
  const u = response?.usageMetadata || {};
  const input = u.promptTokenCount || 0;
  const output = (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
  const [pIn, pOut] = GEMINI_PRICE_PER_M[model] || [0, 0];
  return { inputTokens: input, outputTokens: output, costUsd: (input * pIn + output * pOut) / 1e6 };
};

// Gemini 2.5 Flash-Lite: tắt "thinking" để giảm độ trễ và token bị tính phí
const latencyConfigFor = (model) => (model.startsWith('gemini-2.5') ? { thinkingConfig: { thinkingBudget: 0 } } : {});

module.exports = {
  getAI,
  hasGeminiKey,
  GEMINI_FALLBACK_MODELS,
  GEMINI_TIMEOUT_MS,
  extractUsage,
  latencyConfigFor
};
