const User = require('../models/User');

let runtimeProvider = (process.env.AI_PROVIDER || 'hybrid').toLowerCase();

/**
 * Lấy AI Provider hiện tại đang hoạt động ('ollama', 'gemini', hoặc 'hybrid')
 */
const getAiProvider = () => {
  return runtimeProvider;
};

/**
 * Cập nhật AI Provider ngay trong lúc runtime mà không cần restart server
 */
const setAiProvider = (newProvider) => {
  const normalized = String(newProvider || '').toLowerCase().trim();
  if (['ollama', 'gemini', 'hybrid'].includes(normalized)) {
    runtimeProvider = normalized;
    process.env.AI_PROVIDER = normalized;
    console.log(`[AI Config] 🔄 AI Provider updated to: ${runtimeProvider.toUpperCase()}`);
    return runtimeProvider;
  }
  throw new Error(`Provider không hợp lệ: ${newProvider}. Chỉ chấp nhận: ollama, gemini, hybrid.`);
};

module.exports = {
  getAiProvider,
  setAiProvider
};
