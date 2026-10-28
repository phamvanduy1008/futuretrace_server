const axios = require('axios');
const os = require('os');

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'futuretrace-ai';

/**
 * Kiểm tra trạng thái hoạt động của Ollama Local Server
 */
const checkOllamaHealth = async () => {
  try {
    const response = await axios.get(`${OLLAMA_BASE_URL}/api/tags`, { timeout: 3000 });
    const models = response.data?.models || [];
    const hasModel = models.some(
      m => m.name === OLLAMA_MODEL ||
        m.name.startsWith(OLLAMA_MODEL + ':') ||
        m.name.includes(OLLAMA_MODEL)
    );
    return {
      online: true,
      hasModel,
      availableModels: models.map(m => m.name)
    };
  } catch (error) {
    return { online: false, hasModel: false, error: error.message };
  }
};

/**
 * Trích xuất phần JSON từ raw text của model.
 * Model local thường hay echo lại prompt hoặc thêm text thừa trước/sau JSON.
 * Hàm này tìm và trích xuất khối JSON đầu tiên hợp lệ trong output.
 */
const extractJsonFromText = (rawText) => {
  if (!rawText || typeof rawText !== 'string') return null;

  let text = rawText.trim();

  // 1. Strip markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch && fenceMatch[1]) {
    text = fenceMatch[1].trim();
  } else {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }

  // 2. Tim vi tri bat dau cua JSON root ({ hoac [)
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  let startIdx = -1;
  let isObject = true;

  if (firstBrace !== -1 && firstBracket !== -1) {
    if (firstBrace < firstBracket) {
      startIdx = firstBrace;
      isObject = true;
    } else {
      startIdx = firstBracket;
      isObject = false;
    }
  } else if (firstBrace !== -1) {
    startIdx = firstBrace;
    isObject = true;
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
    isObject = false;
  }

  if (startIdx === -1) return text;

  // 3. Dem do sau (depth) de tim dung vi tri dong cua root object/array
  let depth = 0;
  let inString = false;
  let escaped = false;
  let endIdx = -1;

  for (let i = startIdx; i < text.length; i++) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (isObject) {
      if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    } else {
      if (char === '[') depth++;
      else if (char === ']') {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }
  }

  // Neu tim thay dung diem ket thuc cua root JSON -> cat bo sach se phan trailing chatter
  if (endIdx !== -1) {
    return text.substring(startIdx, endIdx + 1);
  }

  // Neu JSON bi cat ngang giua chung (depth > 0), tra ve tu startIdx toi het chuoi,
  // dong string quote neu dang mo, de parser + jsonrepair tu sua
  let candidate = text.substring(startIdx);
  if (inString) {
    candidate += '"';
  }
  return candidate;
};

/**
 * Tự động sửa JSON bị cắt do max_tokens limit
 */
const repairTruncatedJson = (str) => {
  let json = str.trim();
  const stack = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\' && inString) { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if ((c === '}' || c === ']') && stack.length > 0 && stack[stack.length - 1] === c) {
      stack.pop();
    }
  }

  // Đóng string bị cắt giữa chừng
  if (inString) json += '"';

  // Đóng tất cả brackets còn mở
  while (stack.length > 0) json += stack.pop();
  return json;
};

/**
 * Gửi prompt tới Local Model thông qua Ollama API
 *
 * NGUYÊN TẮC THIẾT KẾ:
 * - KHÔNG dùng format:'json' (chuỗi) → Ollama sẽ block output nếu model không tạo JSON strict → rỗng hoàn toàn
 * - options.format = <JSON Schema> (Ollama >= 0.5 structured outputs): giải mã bị ràng buộc bằng grammar,
 *   luôn ra JSON đúng schema → bỏ được phần lớn bước sửa JSON
 * - Không truyền format: raw text generation + trích xuất JSON thủ công như cũ
 * - num_predict đủ lớn để tránh bị truncate; num_ctx phải >= prompt + num_predict
 * - keep_alive giữ model trong RAM/VRAM, tránh nạp lại 4,7 GB mỗi request
 */
const generateWithOllama = async (prompt, systemPrompt = '', options = {}) => {
  const url = `${OLLAMA_BASE_URL}/api/generate`;

  const timeoutMs = options.timeout || 360000; // 6 phút

  const payload = {
    model: options.model || OLLAMA_MODEL,
    prompt: prompt,
    system: systemPrompt || 'Bạn là Chuyên gia Tư vấn Hướng nghiệp FutureTrace. Trả về JSON hợp lệ.',
    stream: false,
    keep_alive: options.keepAlive || '30m',
    ...(options.format && typeof options.format === 'object' ? { format: options.format } : {}),
    options: {
      temperature: options.temperature ?? 0.4,
      top_p: 0.9,
      top_k: 40,
      repeat_penalty: 1.1,
      num_thread: options.numThread || Math.max(1, (os.cpus() || []).length - 1),
      num_ctx: options.numCtx || 2048,
      num_predict: options.maxTokens || 1024,
    }
  };

  let response;
  try {
    response = await axios.post(url, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: timeoutMs
    });
  } catch (axiosErr) {
    if (axiosErr.code === 'ECONNABORTED') {
      throw new Error(`[Ollama] Timeout sau ${timeoutMs / 1000}s. Model quá tải hoặc prompt quá dài.`);
    }
    throw new Error(`[Ollama] Kết nối thất bại: ${axiosErr.message}`);
  }

  const rawText = response.data?.response;
  const doneReason = response.data?.done_reason || 'unknown';
  const evalCount = response.data?.eval_count || 0;

  // Validate output không rỗng
  if (!rawText || rawText.trim() === '') {
    throw new Error(
      `[Ollama] Model trả về output rỗng. ` +
      `done_reason="${doneReason}", eval_count=${evalCount}. ` +
      `Kiểm tra: RAM đủ không? Prompt có quá dài không?`
    );
  }

  // Trích xuất JSON từ output (loại bỏ phần echo prompt nếu có)
  const jsonText = extractJsonFromText(rawText);

  console.log(`[Ollama] ✅ Generated ${rawText.length} chars, eval_count=${evalCount}, done_reason=${doneReason}`);

  return {
    text: jsonText || rawText,    // text đã được clean để parseJSON
    rawText: rawText,              // text gốc để debug nếu cần
    modelUsed: `local:${response.data?.model || OLLAMA_MODEL}`,
    totalDuration: response.data?.total_duration,
    evalCount,
    doneReason
  };
};

module.exports = {
  checkOllamaHealth,
  generateWithOllama,
  extractJsonFromText,
  repairTruncatedJson,
  OLLAMA_BASE_URL,
  OLLAMA_MODEL
};
