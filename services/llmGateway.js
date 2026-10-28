/**
 * FutureTrace LLM Gateway
 * =========================================================================
 * Một điểm vào duy nhất cho mọi lời gọi sinh văn bản:
 *   1. modal  - Qwen fine-tune (vLLM, OpenAI-compatible) trên Modal serverless GPU: ENGINE CHÍNH
 *   2. gemini - Gemini Flash-Lite trả phí: dự phòng
 *   3. ollama - model cục bộ: phát triển / demo offline
 *
 * - Circuit breaker cho từng provider (closed -> open sau N lỗi trong cửa sổ -> half-open sau thời gian chờ).
 * - Timeout cho token đầu tiên (GPU nguội cần lâu hơn), quá hạn thì chuyển provider kế tiếp.
 * - Streaming thống nhất qua onToken; nếu provider lỗi giữa chừng sau khi đã stream, gọi onReset để client xóa
 *   phần văn bản dở dang trước khi provider dự phòng stream lại.
 * - Ràng buộc đầu ra bằng JSON Schema ở cả 3 provider (vLLM response_format, Gemini responseSchema, Ollama format).
 * =========================================================================
 */

const { getAI, hasGeminiKey, GEMINI_FALLBACK_MODELS, extractUsage, latencyConfigFor } = require('./geminiClient');
const { toGeminiSchema } = require('./prompts/simulationTask');

let _jsonrepair = null;
const jsonrepair = (s) => {
  if (!_jsonrepair) _jsonrepair = require('jsonrepair').jsonrepair;
  return _jsonrepair(s);
};

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);

const CONFIG = {
  modal: {
    url: () => env('MODAL_LLM_URL', '').replace(/\/$/, ''),
    token: () => env('MODAL_LLM_TOKEN', ''),
    model: () => env('MODAL_LLM_MODEL', 'futuretrace-qwen'),
    // Qwen 3B fine-tune dễ lặp cụm từ trong văn bản dài; 1.1 cắt được vòng lặp mà không làm hỏng JSON (đo 2026-10-22)
    repetitionPenalty: () => Number(env('MODAL_REPETITION_PENALTY', 1.1)),
    // Qwen3/3.5 bật chế độ suy nghĩ mặc định: tắt để trả JSON ngay (teacher sinh dữ liệu, model phục vụ)
    disableThinking: () => ['1', 'true'].includes(String(env('MODAL_DISABLE_THINKING', '0')).toLowerCase()),
    scaledownMs: () => Number(env('MODAL_SCALEDOWN_MS', 5 * 60 * 1000))
  },
  ollama: {
    url: () => env('OLLAMA_BASE_URL', 'http://127.0.0.1:11434').replace(/\/$/, ''),
    model: () => env('OLLAMA_MODEL', 'futuretrace-ai')
  },
  firstTokenWarmMs: () => Number(env('LLM_FIRST_TOKEN_WARM_MS', 8000)),
  firstTokenColdMs: () => Number(env('LLM_FIRST_TOKEN_COLD_MS', 45000)),
  totalTimeoutMs: () => Number(env('LLM_TOTAL_TIMEOUT_MS', 120000))
};

const isConfigured = {
  modal: () => !!CONFIG.modal.url(),
  gemini: () => hasGeminiKey(),
  ollama: () => ['ollama', 'hybrid'].includes(String(env('AI_PROVIDER', '')).toLowerCase()) || env('LLM_ORDER', '').includes('ollama')
};

/** Thứ tự provider: LLM_ORDER (vd "modal,gemini") hoặc mặc định modal -> ollama -> gemini (chỉ cái đã cấu hình) */
const providerOrder = () => {
  const configured = env('LLM_ORDER', 'modal,ollama,gemini').split(',').map(s => s.trim()).filter(Boolean);
  return configured.filter(p => isConfigured[p]?.());
};

// ---------------------------------------------------------------- circuit breaker
class CircuitBreaker {
  constructor(name, { failureThreshold = 3, windowMs = 60000, cooldownMs = 30000 } = {}) {
    Object.assign(this, { name, failureThreshold, windowMs, cooldownMs });
    this.state = 'closed';
    this.failures = [];
    this.openedAt = 0;
    this.stats = { success: 0, failure: 0, lastError: null, lastSuccessAt: 0, lastLatencyMs: null };
  }

  canRequest() {
    if (this.state === 'open' && Date.now() - this.openedAt >= this.cooldownMs) this.state = 'half-open';
    return this.state !== 'open';
  }

  success(latencyMs) {
    this.state = 'closed';
    this.failures = [];
    this.stats.success++;
    this.stats.lastSuccessAt = Date.now();
    this.stats.lastLatencyMs = latencyMs;
  }

  failure(err) {
    const now = Date.now();
    this.stats.failure++;
    this.stats.lastError = { message: String(err?.message || err).slice(0, 300), at: now };
    this.failures = this.failures.filter(t => now - t < this.windowMs).concat(now);
    if (this.state === 'half-open' || this.failures.length >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = now;
      console.warn(`[LLM Gateway] Circuit OPEN for ${this.name}: ${this.stats.lastError.message}`);
    }
  }

  snapshot() {
    return { state: this.state, recentFailures: this.failures.length, openedAt: this.openedAt || null, ...this.stats };
  }
}

const breakers = {
  modal: new CircuitBreaker('modal'),
  gemini: new CircuitBreaker('gemini'),
  ollama: new CircuitBreaker('ollama', { cooldownMs: 60000 })
};

// ---------------------------------------------------------------- stream helpers
async function* readLines(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) yield line;
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

const httpError = async (res, provider) => {
  const text = await res.text().catch(() => '');
  const err = new Error(`[${provider}] HTTP ${res.status}: ${text.slice(0, 200)}`);
  err.status = res.status;
  return err;
};

// ---------------------------------------------------------------- providers
const providers = {
  /** vLLM OpenAI-compatible server trên Modal (Qwen fine-tune) */
  async *modal({ system, prompt, schema, maxTokens, temperature, signal, modalModel }) {
    const res = await fetch(`${CONFIG.modal.url()}/v1/chat/completions`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.modal.token()}` },
      body: JSON.stringify({
        model: modalModel || CONFIG.modal.model(), // model riêng có nhiều adapter (mô phỏng, premium): chọn theo tác vụ
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: maxTokens,
        temperature,
        repetition_penalty: CONFIG.modal.repetitionPenalty(),
        ...(CONFIG.modal.disableThinking() ? { chat_template_kwargs: { enable_thinking: false } } : {}),
        ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: 'output', schema } } } : {})
      })
    });
    if (!res.ok) throw await httpError(res, 'modal');
    for await (const line of readLines(res.body)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') break;
      const evt = JSON.parse(data);
      const delta = evt.choices?.[0]?.delta?.content;
      if (delta) yield { text: delta };
      if (evt.usage) yield { usage: { inputTokens: evt.usage.prompt_tokens, outputTokens: evt.usage.completion_tokens, costUsd: 0 } };
    }
  },

  /** Gemini Flash-Lite (dự phòng), thử lần lượt các model trong GEMINI_FALLBACK_MODELS */
  async *gemini({ system, prompt, schema, maxTokens, temperature, signal }) {
    let lastErr;
    for (const model of GEMINI_FALLBACK_MODELS) {
      try {
        const stream = await getAI().models.generateContentStream({
          model,
          contents: prompt,
          config: {
            systemInstruction: system,
            maxOutputTokens: maxTokens,
            temperature,
            abortSignal: signal,
            ...(schema ? { responseMimeType: 'application/json', responseSchema: toGeminiSchema(schema) } : {}),
            ...latencyConfigFor(model)
          }
        });
        let last = null;
        for await (const chunk of stream) {
          last = chunk;
          if (chunk.text) yield { text: chunk.text, model };
        }
        yield { usage: extractUsage(last, model), model };
        return;
      } catch (err) {
        lastErr = err;
        if (signal?.aborted) throw err;
        const msg = String(err?.message || '').toLowerCase();
        // Model không tồn tại / không có quyền: thử model kế tiếp; lỗi khác cũng thử tiếp một lần
        if (!(err?.status === 404 || err?.status === 403 || msg.includes('not found') || err?.status >= 500 || err?.status === 429)) throw err;
      }
    }
    throw lastErr;
  },

  /** Ollama cục bộ (dev / demo offline) */
  async *ollama({ system, prompt, schema, maxTokens, temperature, signal }) {
    const res = await fetch(`${CONFIG.ollama.url()}/api/chat`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CONFIG.ollama.model(),
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        stream: true,
        keep_alive: '30m',
        ...(schema ? { format: schema } : {}),
        options: { temperature, num_predict: maxTokens, num_ctx: 6144 }
      })
    });
    if (!res.ok) throw await httpError(res, 'ollama');
    for await (const line of readLines(res.body)) {
      const evt = JSON.parse(line);
      if (evt.message?.content) yield { text: evt.message.content };
      if (evt.done) yield { usage: { inputTokens: evt.prompt_eval_count || 0, outputTokens: evt.eval_count || 0, costUsd: 0 } };
    }
  }
};

const modelNameOf = (provider, chunkModel, modalModel = null) => {
  if (provider === 'modal') return `modal:${modalModel || CONFIG.modal.model()}`;
  if (provider === 'ollama') return `local:${CONFIG.ollama.model()}`;
  return chunkModel || GEMINI_FALLBACK_MODELS[0];
};

const parseJsonLoose = (text) => {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(t);
  } catch {
    return JSON.parse(jsonrepair(t));
  }
};

const isModalWarm = () => Date.now() - breakers.modal.stats.lastSuccessAt < CONFIG.modal.scaledownMs() || Date.now() - lastWarmupOkAt < CONFIG.modal.scaledownMs();

/**
 * Sinh văn bản (thường là JSON theo schema) với fallback tự động giữa các provider.
 * @returns {Promise<{text, json, provider, model, usage, latencyMs, firstTokenMs, attempts}>}
 */
const generate = async ({
  system, prompt, schema = null, maxTokens = 2200, temperature = 0.3,
  onToken = null, onReset = null, signal = null, order = null, modalModel = null
}) => {
  const attempts = [];
  const sequence = (order || providerOrder()).filter(p => providers[p] && isConfigured[p]?.());
  if (!sequence.length) throw new Error('Chưa cấu hình nhà cung cấp AI nào (MODAL_LLM_URL / GEMINI_API_KEYS / Ollama).');

  for (const provider of sequence) {
    const breaker = breakers[provider];
    if (!breaker.canRequest()) {
      attempts.push({ provider, skipped: 'circuit_open' });
      continue;
    }
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', onExternalAbort, { once: true });

    // Timeout token đầu theo provider; provider cuối cùng trong chuỗi chỉ bị giới hạn bởi timeout tổng
    const isLast = provider === sequence[sequence.length - 1];
    const firstTokenMs = isLast ? CONFIG.totalTimeoutMs()
      : provider === 'modal' ? (isModalWarm() ? CONFIG.firstTokenWarmMs() : CONFIG.firstTokenColdMs())
        : provider === 'gemini' ? 20000 : 60000;
    let firstTokenTimer = setTimeout(() => controller.abort(new Error(`first token timeout ${firstTokenMs}ms`)), firstTokenMs);
    const totalTimer = setTimeout(() => controller.abort(new Error('total timeout')), CONFIG.totalTimeoutMs());

    const t0 = Date.now();
    let text = '';
    let usage = null;
    let model = null;
    let firstAt = null;
    try {
      for await (const chunk of providers[provider]({ system, prompt, schema, maxTokens, temperature, signal: controller.signal, modalModel: provider === 'modal' ? modalModel : null })) {
        if (chunk.model) model = chunk.model;
        if (chunk.usage) usage = chunk.usage;
        if (chunk.text) {
          if (firstAt === null) {
            firstAt = Date.now() - t0;
            clearTimeout(firstTokenTimer);
            firstTokenTimer = null;
          }
          text += chunk.text;
          onToken?.(chunk.text, provider);
        }
      }
      const json = schema ? parseJsonLoose(text) : null;
      const latencyMs = Date.now() - t0;
      breaker.success(latencyMs);
      attempts.push({ provider, ok: true, latencyMs, firstTokenMs: firstAt });
      return { text, json, provider, model: modelNameOf(provider, model, modalModel), usage, latencyMs, firstTokenMs: firstAt, attempts };
    } catch (err) {
      if (signal?.aborted) {
        const cancelled = new Error('Yêu cầu đã bị hủy.');
        cancelled.type = 'CANCELLED';
        throw cancelled;
      }
      const reason = controller.signal.aborted ? controller.signal.reason?.message || 'aborted' : err.message;
      console.warn(`[LLM Gateway] ${provider} failed (${reason}), falling back...`);
      breaker.failure(new Error(reason));
      attempts.push({ provider, ok: false, error: String(reason).slice(0, 200) });
      if (text) onReset?.(provider);
    } finally {
      if (firstTokenTimer) clearTimeout(firstTokenTimer);
      clearTimeout(totalTimer);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  const err = new Error('Tất cả nhà cung cấp AI đều không phản hồi. Vui lòng thử lại sau ít phút.');
  err.type = 'OVERLOADED';
  err.status = 503;
  err.attempts = attempts;
  throw err;
};

// ---------------------------------------------------------------- warmup (giấu cold start của GPU)
let warmupInFlight = null;
let lastWarmupOkAt = 0;

/** Gọi khi người dùng mở form mô phỏng: khởi động container GPU trong lúc họ đang nhập liệu */
const warmup = () => {
  if (!isConfigured.modal() || isModalWarm() || warmupInFlight) return { started: false, warm: isModalWarm() };
  const t0 = Date.now();
  warmupInFlight = fetch(`${CONFIG.modal.url()}/health`, {
    headers: { Authorization: `Bearer ${CONFIG.modal.token()}` },
    signal: AbortSignal.timeout(180000)
  })
    .then((res) => {
      if (res.ok) {
        lastWarmupOkAt = Date.now();
        console.log(`[LLM Gateway] Modal warm after ${Date.now() - t0}ms`);
      }
    })
    .catch((e) => console.warn('[LLM Gateway] Modal warmup failed:', e.message))
    .finally(() => { warmupInFlight = null; });
  return { started: true, warm: false };
};

const status = () => ({
  order: providerOrder(),
  modal: { configured: isConfigured.modal(), warm: isModalWarm(), model: CONFIG.modal.model(), breaker: breakers.modal.snapshot() },
  gemini: { configured: isConfigured.gemini(), models: GEMINI_FALLBACK_MODELS, breaker: breakers.gemini.snapshot() },
  ollama: { configured: isConfigured.ollama(), model: CONFIG.ollama.model(), breaker: breakers.ollama.snapshot() }
});

module.exports = { generate, warmup, status, parseJsonLoose, CircuitBreaker, _breakers: breakers, _providers: providers };
