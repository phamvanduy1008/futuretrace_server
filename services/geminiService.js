const { GoogleGenAI, Type } = require('@google/genai');
const path = require('path');
const fs = require('fs');

/**
 * Utility to repair truncated JSON by closing open brackets
 */
const repairJson = (str) => {
  let json = str.trim();
  const stack = [];
  let isInsideString = false;
  let isEscaped = false;

  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    if (char === '"' && !isEscaped) {
      isInsideString = !isInsideString;
    }
    if (isInsideString) {
      isEscaped = (char === '\\' && !isEscaped);
      continue;
    }
    if (char === '{') stack.push('}');
    else if (char === '[') stack.push(']');
    else if (char === '}' || char === ']') {
      if (stack.length > 0 && stack[stack.length - 1] === char) {
        stack.pop();
      }
    }
  }

  // Close open string if truncated mid-string
  if (isInsideString) json += '"';

  // Close all open brackets in reverse order
  while (stack.length > 0) {
    json += stack.pop();
  }
  return json;
};

/**
 * Parse and repair JSON returned by Gemini AI
 */
const parseAndRepairJson = (text) => {
  if (!text || typeof text !== 'string') {
    throw new Error('Dữ liệu AI trả về trống hoặc không hợp lệ.');
  }

  let cleaned = text.trim();

  // Strip markdown code blocks if present
  if (cleaned.includes('```')) {
    const matches = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (matches && matches[1]) {
      cleaned = matches[1].trim();
    } else {
      cleaned = cleaned.replace(/```json/g, '').replace(/```/g, '').trim();
    }
  }

  // Extract from the first '{' to the last '}'
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.warn('[AI JSON Parse] Parsing failed, trying to repair truncated JSON...');
    try {
      const repaired = repairJson(cleaned);
      return JSON.parse(repaired);
    } catch (repairError) {
      console.error('[AI JSON Repair Error]:', repairError);
      console.error('[Raw AI text failed]:', text);
      throw new Error('Dữ liệu AI trả về không đúng định dạng cấu trúc JSON.');
    }
  }
};

/**
 * Ensures the simulation result has all required fields to prevent frontend crashes
 */
const normalizeSimulationResponse = (data) => {
  const defaults = {
    isEnterprise: false,
    summary: "Báo cáo phân tích tương lai từ FutureTrace.",
    scenarios: [],
    timeline: {
      start: "Bắt đầu hành trình.",
      sixMonths: "Giai đoạn thích nghi.",
      oneYear: "Giai đoạn ổn định.",
      threeYears: "Giai đoạn phát triển."
    }
  };

  const normalized = { ...defaults, ...data };

  // Deep merge for timeline
  normalized.timeline = { ...defaults.timeline, ...(data.timeline || {}) };

  // Ensure scenarios is an array and each scenario has required structure
  if (!Array.isArray(normalized.scenarios)) {
    normalized.scenarios = [];
  }

  normalized.scenarios = normalized.scenarios.map(s => ({
    title: s.title || "Kịch bản tiềm năng",
    description: s.description || "Phân tích kịch bản chưa hoàn thiện.",
    careerGrowth: s.careerGrowth || 0,
    happiness: s.happiness || 0,
    roi: s.roi || 0,
    type: s.type || "Neutral",
    deepAnalysis: {
      swot: Array.isArray(s.deepAnalysis?.swot) ? s.deepAnalysis.swot : [],
      resources: Array.isArray(s.deepAnalysis?.resources) ? s.deepAnalysis.resources : [],
      sprint90: Array.isArray(s.deepAnalysis?.sprint90) ? s.deepAnalysis.sprint90 : [],
      criticalAdvice: s.deepAnalysis?.criticalAdvice || "Đang cập nhật lời khuyên..."
    }
  }));

  return normalized;
};

// =========================================================
// RAG (Retrieval-Augmented Generation) Knowledge Base Layer
// =========================================================

let _knowledgeBase = null;
const getKnowledgeBase = () => {
  if (!_knowledgeBase) {
    try {
      const kbPath = path.join(__dirname, '../data/knowledge_base.json');
      _knowledgeBase = JSON.parse(fs.readFileSync(kbPath, 'utf-8'));
    } catch (e) {
      console.warn('[RAG] Could not load knowledge_base.json:', e.message);
      _knowledgeBase = { fields: {} };
    }
  }
  return _knowledgeBase;
};

/**
 * Detect the relevant field from user's decision text
 * Returns the field data object or null if no match
 */
const detectFieldFromText = (text) => {
  if (!text) return null;
  const kb = getKnowledgeBase();
  const lowerText = text.toLowerCase();
  for (const [, fieldData] of Object.entries(kb.fields)) {
    const keywords = fieldData.keywords || [];
    if (keywords.some(kw => lowerText.includes(kw.toLowerCase()))) {
      return fieldData;
    }
  }
  return null;
};

/**
 * Build a RAG context string from the matched field data to inject into prompt
 */
const buildRAGContext = (fieldData) => {
  if (!fieldData) return '';
  const s = fieldData.salary || {};
  const fresher = s.fresher_0_1year || s.bac_si_cong_lap || {};
  const mid = s.mid_3_5year || {};
  return `
--- DỮ LIỆU THỰC TẾ THỊ TRƯỜNG LAO ĐỘNG VIỆT NAM 2024 (BẮT BUỘC THAM KHẢO) ---
Ngành: ${fieldData.name}
Nguồn dữ liệu: ${(fieldData.source || []).join(', ')}

💰 Mức lương thực tế:
- Fresher (0-1 năm KN): ${fresher.min || '?'}–${fresher.max || '?'} triệu/tháng (TB: ~${fresher.avg || '?'} triệu)
- 3-5 năm KN: ${mid.min || '?'}–${mid.max || '?'} triệu/tháng (TB: ~${mid.avg || '?'} triệu)
${fieldData.salary?.marketAverage ? `- Trung bình toàn thị trường ngành: ${fieldData.salary.marketAverage} triệu/tháng` : ''}
${fieldData.salary?.bac_si_tu_nhan ? `- Bác sĩ khu vực tư nhân: ${fieldData.salary.bac_si_tu_nhan.min}–${fieldData.salary.bac_si_tu_nhan.max} triệu/tháng` : ''}
${fieldData.salary?.fresher_tu_nhan ? `- Fresher khu vực tư nhân/quốc tế: ${fieldData.salary.fresher_tu_nhan.min}–${fieldData.salary.fresher_tu_nhan.max} triệu/tháng` : ''}

📊 Thị trường lao động:
- Tỉ lệ có việc làm sau tốt nghiệp: ~${fieldData.employmentRate || '?'}%
- Tỉ lệ thất nghiệp: ~${fieldData.unemploymentRate || '?'}%
${fieldData.shortage ? `- ⚠️ ${fieldData.shortage}` : ''}

🎯 Kỹ năng cần thiết: ${(fieldData.topSkills || []).slice(0, 5).join(', ')}
${(fieldData.trendingFields || []).length > 0 ? `📈 Xu hướng nổi bật: ${fieldData.trendingFields.join(', ')}` : ''}

🏫 Điểm chuẩn 2024: ${fieldData.entranceScore2024?.note || `TB ~${fieldData.entranceScore2024?.avg || '?'} điểm`}

📌 Nhận định thị trường: ${fieldData.outlook || fieldData.outlet || ''}
${fieldData.trainingDuration ? `⏱️ Thời gian đào tạo: ${JSON.stringify(fieldData.trainingDuration)}` : ''}
--- KẾT THÚC DỮ LIỆU THỰC TẾ ---
`.trim();
};

// =========================================================

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

  console.log(`[AI] Using API Key starting with: ${apiKey.substring(0, 7) + '...'}`);
  return new GoogleGenAI({ apiKey });
};

const callGeminiWithRetry = async (modelNames, contents, config, maxRetries = 2) => {
  const models = Array.isArray(modelNames) ? modelNames : [modelNames];
  let lastError;

  for (const model of models) {
    console.log(`[AI] Attempting call with model: ${model}`);
    let success = false;
    let response;

    for (let i = 0; i <= maxRetries; i++) {
      try {
        const ai = getAI();
        response = await ai.models.generateContent({
          model: model,
          contents: contents,
          config: config
        });
        response.modelUsed = model;
        success = true;
        break;
      } catch (error) {
        lastError = error;
        console.warn(`[AI Retry ${i}/${maxRetries}] Failed with model "${model}":`, error.message);

        if (error.status === 400 && !error.message.includes('API key not valid')) {
          throw error;
        }

        const errorMsgLower = error.message ? error.message.toLowerCase() : '';
        const isModelNotFoundError = error.status === 404 ||
          errorMsgLower.includes('not found') ||
          errorMsgLower.includes('not supported') ||
          errorMsgLower.includes('denied access') ||
          error.status === 403;

        if (isModelNotFoundError) {
          console.warn(`[AI Fallback] Model "${model}" is not available or access is denied. Switching to fallback.`);
          break;
        }

        if (i < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
        }
      }
    }

    if (success) {
      console.log(`[AI Success] Successfully generated content using model: ${model}`);
      return response;
    }
  }

  if (lastError && typeof lastError === 'object') {
    try {
      lastError.modelUsed = models[0];
    } catch (e) {
      // ignore
    }
  }
  throw lastError;
};

const analyzeInputReadiness = async (data) => {
  const ai = getAI();
  const prompt = `
    Bạn là AI phân tích đầu vào của hệ thống FutureTrace chuyên tư vấn lộ trình học tập, sự nghiệp cho học sinh/sinh viên Việt Nam.
    
    ĐẦU VÀO CỦA NGƯỜI DÙNG:
    "${data.decision}"
    
    NHIỆM VỤ:
    Đánh giá xem nội dung trên đã ĐỦ CHI TIẾT để tư vấn một lộ trình cụ thể hay chưa.
    - Một nội dung ĐỦ CHI TIẾT thường sẽ nói rõ về: Ngành học quan tâm, định hướng công việc mong muốn, hoặc bối cảnh phân vân giữa 2 lựa chọn rõ ràng.
    - Một nội dung QUÁ NGẮN/CHUNG CHUNG (ví dụ: "Em muốn học IT", "Nên làm gì để giàu", "Học Marketing") là KHÔNG ĐỦ để cá nhân hóa lộ trình.
    
    Nếu ĐỦ CHI TIẾT:
    Trả về status "ready" và để mảng questions trống.
    
    Nếu THIẾU CHI TIẾT (QUÁ NGẮN/CHUNG CHUNG):
    Trả về status "needs_clarification".
    Sinh ra từ 1 đến 2 câu hỏi (question) mang tính chất gợi mở, MỖI CÂU HỎI phải kèm theo từ 2 đến 4 lựa chọn (options) rõ ràng để người dùng có thể bấm chọn ngay.
    Mục đích của câu hỏi là để đào sâu thêm ý định, mong muốn cụ thể hoặc chuyên ngành hẹp mà họ quan tâm.
    
    OUTPUT PHẢI LÀ JSON HỢP LỆ THEO SCHEMA YÊU CẦU.
  `;

  try {
    const response = await callGeminiWithRetry(
      ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'],
      prompt,
      {
        responseMimeType: 'application/json',
        maxOutputTokens: 2048,
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            status: { type: Type.STRING, description: "Must be 'ready' or 'needs_clarification'" },
            questions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  question: { type: Type.STRING },
                  options: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING }
                  }
                },
                required: ['question', 'options']
              }
            }
          },
          required: ['status', 'questions']
        }
      }
    );

    let text = "";
    try {
      if (typeof response.text === 'string') {
        text = response.text.trim();
      } else if (typeof response.text === 'function') {
        text = response.text().trim();
      } else if (response.response && typeof response.response.text === 'function') {
        text = response.response.text().trim();
      } else if (response.candidates && response.candidates[0]?.content?.parts?.[0]?.text) {
        text = response.candidates[0].content.parts[0].text.trim();
      }
    } catch (e) {
      console.error('[AI Text Extraction Error]:', e);
    }

    const parsed = parseAndRepairJson(text);
    parsed.modelUsed = response.modelUsed;
    return parsed;
  } catch (error) {
    console.error('[AI Pre-check Error]:', error);
    // Fallback to ready if error so the flow doesn't break completely
    return { status: 'ready', questions: [] };
  }
};

const generateSimulation = async (data, onStreamEvent) => {
  const ai = getAI();

  // --- BƯỚC 1: GỌI BỘ NÃO PYTHON (OLLAMA + QDRANT) ĐỂ LẤY TRI THỨC (STREAMING) ---
  let agentAdvice = "";
  try {
    const query = `Người dùng cần tư vấn: ${data.decision}. \nNgữ cảnh: \n- Tài chính: ${data.personalFinance}/5 \n- Học lực: ${data.academicPerformance}/5 \n- Áp lực: ${data.stress}/5 \n- Sở thích: ${data.otherFactors || "Không có"} \nBạn hãy đưa ra kịch bản và lời khuyên chi tiết.`;

    console.log("[AGENT] Đang gửi yêu cầu sang Local Python API (Ollama) dạng Stream...");
    const axios = require('axios');
    const agentRes = await axios.post("http://localhost:8000/api/analyze/stream", { query }, { responseType: 'stream' });

    agentAdvice = await new Promise((resolve, reject) => {
      let accumulatedText = "";
      let buffer = "";

      agentRes.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n\n');
        buffer = lines.pop(); // Keep incomplete chunk in buffer

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const dataStr = line.substring(6).trim();
              if (!dataStr) continue;
              const parsed = JSON.parse(dataStr);

              if (onStreamEvent) onStreamEvent(parsed);

              if (parsed.event === 'token') {
                accumulatedText += parsed.text;
              }
            } catch (e) {
              console.error("[AGENT] Lỗi parse SSE JSON:", e.message);
            }
          }
        }
      });

      agentRes.data.on('end', () => resolve(accumulatedText));
      agentRes.data.on('error', (err) => reject(err));
    });
    console.log("[AGENT] Nhận hoàn tất luồng dữ liệu từ Local LLM!");

  } catch (err) {
    console.error("[AGENT] Không thể kết nối tới Python API Stream:", err.message);
    agentAdvice = "Lỗi kết nối Local AI. Hãy dùng kiến thức chung của bạn để phân tích.";
    if (onStreamEvent) onStreamEvent({ event: 'status', message: 'Lỗi kết nối AI nội bộ. Đang dùng dự phòng...' });
  }

  // --- BƯỚC 2: DÙNG GEMINI NHƯ MỘT FORMATTER CHUYÊN NGHIỆP ---
  const prompt = `
    Bạn là chuyên gia ĐỊNH DẠNG DỮ LIỆU (JSON Formatter) của hệ thống FutureTrace.
    
    NHIỆM VỤ: Đọc bản phân tích thô từ chuyên gia Local AI dưới đây và ép nó vào cấu trúc JSON siêu nghiêm ngặt. Tuyệt đối không được bỏ sót thông tin.
    
    [BẢN PHÂN TÍCH TỪ CHUYÊN GIA LOCAL AI]:
    """
    ${agentAdvice}
    """
    
    Dữ liệu người dùng (dùng để cá nhân hóa thêm nếu bản phân tích bị thiếu):
    - Quyết định/Vấn đề: ${data.decision}
    - Tâm trạng hiện tại: ${data.mood || 'Bình thường'} (Ảnh hưởng tới giọng văn summary)
    - Tầm nhìn dự báo: ${data.timeHorizon || 5} năm.
    - Học vấn: ${data.educationLevel || 'Học sinh/Sinh viên'}

    QUY TẮC PHÂN LOẠI:
    - Nếu đối tượng là người đi làm, đặt isEnterprise = true và điền summary thông báo không hỗ trợ.

    YÊU CẦU ĐẦU RA (JSON - BẮT BUỘC):
    - isEnterprise: false.
    - summary: Dùng giọng văn dựa trên \`mood\`. Tóm tắt lại bản phân tích của chuyên gia. (~40-50 từ).
    - scenarios: BẮT BUỘC PHẢI CÓ CHÍNH XÁC 3 KỊCH BẢN KHÁC NHAU. (Gồm: 1 kịch bản Tối ưu/Positive, 1 kịch bản Cân bằng/Neutral, 1 kịch bản Rủi ro/Risk). Lấy cảm hứng từ Bản phân tích ở trên.
    - timeline: 4 mốc (start, sixMonths, oneYear, threeYears). ĐỘ DÀI: Mỗi mốc đúng 30-40 từ, phân tích rõ ràng hành động cần làm. Đảm bảo 4 cột có độ dài text tương đồng để UI hiển thị cân đối.
    - deepAnalysis cho mỗi kịch bản (BẮT BUỘC):
      + swot: Mảng BẮT BUỘC 4 phần tử: 'S', 'W', 'O', 'T'. TRỌNG TÂM: Nội dung phải cực kỳ CHI TIẾT.
      + sprint90 (Chiến thuật cơ bản 12 tháng): Lấy dữ liệu từ "Lộ Trình Hành Động 90 Ngày" của chuyên gia.
      + resources: Mảng 3 nguồn lực trọng tâm cần chuẩn bị.

    Lưu ý: Viết súc tích, chuyên nghiệp. Không viết lan man. Tuân thủ tuyệt đối cấu trúc JSON.
  `;

  try {
    const response = await callGeminiWithRetry(
      ['gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'],
      prompt,
      {
        responseMimeType: 'application/json',
        maxOutputTokens: 8192,
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            isEnterprise: { type: Type.BOOLEAN },
            summary: { type: Type.STRING },
            scenarios: {
              type: Type.ARRAY,
              description: "Mảng BẮT BUỘC chứa ĐÚNG 3 phần tử (Positive, Neutral, Risk). Không được thiếu.",
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  description: { type: Type.STRING },
                  careerGrowth: { type: Type.NUMBER },
                  happiness: { type: Type.NUMBER },
                  roi: { type: Type.NUMBER, description: "Tỷ suất hoàn vốn đầu tư dự kiến (ROI) sau đúng " + (data.timeHorizon || 5) + " năm" },
                  type: { type: Type.STRING, description: "Must be exactly 'Positive', 'Neutral', or 'Risk'" },
                  deepAnalysis: {
                    type: Type.OBJECT,
                    properties: {
                      swot: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            label: { type: Type.STRING },
                            value: { type: Type.STRING },
                            color: { type: Type.STRING },
                            type: { type: Type.STRING, description: "Must be exactly 'S', 'W', 'O', or 'T'" }
                          }
                        }
                      },
                      resources: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            label: { type: Type.STRING },
                            value: { type: Type.NUMBER },
                            unit: { type: Type.STRING },
                            icon: { type: Type.STRING },
                            ghostLabel: { type: Type.STRING }
                          }
                        }
                      },
                      sprint90: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            phase: { type: Type.STRING },
                            tasks: { type: Type.ARRAY, items: { type: Type.STRING } }
                          }
                        }
                      },
                      criticalAdvice: { type: Type.STRING }
                    }
                  },
                  marketFit: {
                    type: Type.OBJECT,
                    properties: {
                      score: { type: Type.NUMBER, description: "Score from 0 to 100 representing how well the market trend fits this user." },
                      analysis: { type: Type.STRING, description: "Detailed analysis comparing the user's capabilities, core values, and location with the market trend." }
                    },
                    required: ['score', 'analysis']
                  }
                },
                required: ['title', 'description', 'careerGrowth', 'happiness', 'roi', 'type', 'deepAnalysis', 'marketFit']
              }
            },
            timeline: {
              type: Type.OBJECT,
              properties: {
                start: { type: Type.STRING },
                sixMonths: { type: Type.STRING },
                oneYear: { type: Type.STRING },
                threeYears: { type: Type.STRING }
              },
              required: ['start', 'sixMonths', 'oneYear', 'threeYears']
            }
          },
          required: ['isEnterprise', 'summary', 'scenarios', 'timeline']
        }
      }
    );

    // Safe text extraction handling potential SDK variations
    let text = "";
    try {
      if (typeof response.text === 'string') {
        text = response.text.trim();
      } else if (typeof response.text === 'function') {
        text = response.text().trim();
      } else if (response.response && typeof response.response.text === 'function') {
        text = response.response.text().trim();
      } else if (response.candidates && response.candidates[0]?.content?.parts?.[0]?.text) {
        text = response.candidates[0].content.parts[0].text.trim();
      }
    } catch (e) {
      console.error('[AI Text Extraction Error]:', e);
    }

    if (!text) {
      console.error('[AI RESPONSE STRUCTURE ERROR]: Could not extract text. Keys:', Object.keys(response));
      throw new Error('AI không trả về nội dung văn bản. Vui lòng thử lại.');
    }

    const parsed = parseAndRepairJson(text);
    const normalized = normalizeSimulationResponse(parsed);
    normalized.modelUsed = response.modelUsed;
    return normalized;
  } catch (error) {
    console.error('[AI Error Details - Simulation]:', error);
    throw error;
  }
}

const generatePremiumAnalysis = async (title, description, context, timeframe) => {
  const ai = getAI();

  // RAG: Detect and inject relevant field knowledge
  const premiumSearchText = `${title || ''} ${description || ''} ${context?.decision || ''} ${context?.otherFactors || ''}`;
  const premiumFieldData = detectFieldFromText(premiumSearchText);
  const premiumRagContext = buildRAGContext(premiumFieldData);
  if (premiumFieldData) console.log(`[RAG Premium] Matched field: ${premiumFieldData.name}`);


  const prompt = `
    Generate a PREMIUM DETAILED SCENARIO REPORT for the following scenario:
    Title: ${title}
    Context: ${description}
    ${context ? `
    User Context:
    - Current Situation: ${context.decision}
    - Stress Level: ${context.stress}/5
    - Financial Status: ${context.personalFinance}/5
    - Academic Performance: ${context.academicPerformance}/5
    - Risk Tolerance: ${context.risk}/5
    - Other Factors: ${context.otherFactors || 'None'}
    ` : ''}
    ${timeframe ? `Target Completion Timeframe: ${timeframe} months.` : ''}

    ${premiumRagContext ? premiumRagContext + '\n\n    HƯỚNG DẪN SỬ DỤNG DỮ LIỆU: Các cột mốc, mức lương kỳ vọng, và nhận định thị trường trong báo cáo PHẢI được dựa trên bộ dữ liệu thực tế ở trên. Không được tự bịa đặt con số.' : ''}

    CRITICAL INSTRUCTION FOR MILESTONES:
    - The milestones MUST be realistic based on the user's current situation, age/grade, and academic performance.
    - ${timeframe ? `The ENTIRE roadmap must be compressed or expanded to fit exactly within ${timeframe} months.` : 'The timeline should be logical and progressive.'}
    - For example, if the user is in Grade 10 (lớp 10), do not suggest university entrance exams within 12 months. Instead, suggest milestones like "Kết thúc học kỳ 1 lớp 10", "Chọn khối thi", "Ôn tập hè", etc.
    - The report must include:
      1. detailedNarrative: A long, detailed chronological description of how the next ${timeframe || 12} months (or relevant period) will unfold. It MUST be structured into chronological paragraphs where each paragraph starts with a clear time phase marker like "Tháng X:", "Tháng X-Y:" or "Giai đoạn từ tháng X-Y:" to outline the roadmap clearly (Vietnamese).
      2. milestones: 5 key events with month, description, impact level, probability (0-100). The "details" field MUST be a JSON array of exactly 3 structured step objects. Each step object must have:
         - id: A unique string ID like "step_X_Y" (where X is milestone index 1-5, Y is step index 1-5), e.g. "step_1_1", "step_1_2".
         - title: Tên công việc cụ thể (Vietnamese).
         - description: Mô tả ngắn gọn nhiệm vụ (Vietnamese).
         - objectives: Mảng chứa 2-3 mục tiêu chính (Vietnamese).
         - actions: Mảng chứa 2-3 hành động cơ bản (Vietnamese).
         - tools: Mảng chứa 2-3 công cụ cơ bản đề xuất (Vietnamese).
         - expectedResult: Kết quả đầu ra cơ bản (Vietnamese).
         - completed: false.
      3. influencingFactors: 4 external or internal factors (Economic, Personal, Social, or Technical) with their influence level (High, Medium, Low).
      4. strategicPivotPoints: 3 critical "If/Then" decision points.
      5. longTermProjection: A final outlook on the 3-5 year horizon.

    - BẮT BUỘC: Không được để trống bất kỳ trường nào trong kết quả trả về. Mọi cột mốc phải có đầy đủ month, event, impact, probability và details.
    - TUYỆT ĐỐI KHÔNG sử dụng các cụm từ như "tương tự như trên", "không thay đổi" hoặc để trống chuỗi. Mọi nội dung phải được viết chi tiết bằng tiếng Việt.

    Language: Vietnamese. Use a professional, analytical tone.
  `;

  try {
    const response = await callGeminiWithRetry(
      ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.1-flash-lite'],
      prompt,
      {
        responseMimeType: 'application/json',
        maxOutputTokens: 8192,
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            detailedNarrative: { type: Type.STRING },
            milestones: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  month: { type: Type.STRING },
                  event: { type: Type.STRING },
                  impact: { type: Type.STRING },
                  probability: { type: Type.NUMBER },
                  details: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        id: { type: Type.STRING },
                        title: { type: Type.STRING },
                        description: { type: Type.STRING },
                        objectives: {
                          type: Type.ARRAY,
                          items: { type: Type.STRING }
                        },
                        actions: {
                          type: Type.ARRAY,
                          items: { type: Type.STRING }
                        },
                        tools: {
                          type: Type.ARRAY,
                          items: { type: Type.STRING }
                        },
                        expectedResult: { type: Type.STRING },
                        completed: { type: Type.BOOLEAN }
                      },
                      required: ['id', 'title', 'description', 'objectives', 'actions', 'tools', 'expectedResult', 'completed']
                    }
                  }
                },
                required: ['month', 'event', 'impact', 'probability', 'details']
              }
            },
            influencingFactors: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  category: { type: Type.STRING },
                  factor: { type: Type.STRING },
                  influence: { type: Type.STRING },
                  description: { type: Type.STRING }
                },
                required: ['category', 'factor', 'influence', 'description']
              }
            },
            strategicPivotPoints: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  condition: { type: Type.STRING },
                  action: { type: Type.STRING }
                },
                required: ['condition', 'action']
              }
            },
            longTermProjection: { type: Type.STRING }
          },
          required: ['detailedNarrative', 'milestones', 'influencingFactors', 'strategicPivotPoints', 'longTermProjection']
        }
      }
    );

    let text = "";
    try {
      if (typeof response.text === 'string') {
        text = response.text.trim();
      } else if (typeof response.text === 'function') {
        text = response.text().trim();
      } else if (response.response && typeof response.response.text === 'function') {
        text = response.response.text().trim();
      }
    } catch (e) {
      console.error('[AI Text Extraction Error]:', e);
    }

    if (!text) {
      throw new Error('AI không trả về nội dung văn bản. Vui lòng thử lại.');
    }

    const parsed = parseAndRepairJson(text);
    parsed.modelUsed = response.modelUsed;
    return parsed;
  } catch (error) {
    console.error('[AI Error Details - Premium]:', error);
    throw error;
  }
};

const pivotPremiumAnalysis = async (currentReport, completedMilestones, feedback, context, timeframe, feedbackHistory = []) => {
  const ai = getAI();

  const prompt = `
    RE-PLANNING REQUIRED based on user feedback.
    
    ORIGINAL SCENARIO:
    - Narrative: ${currentReport.detailedNarrative}
    
    COMPLETED MILESTONES (DO NOT CHANGE THESE):
    ${JSON.stringify(completedMilestones)}
    
    ${feedbackHistory && feedbackHistory.length > 0 ? `
    PAST FEEDBACKS (What the user faced and reported previously in this scenario):
    ${feedbackHistory.map((fb, i) => `[Pivot ${i + 1}]: "${fb}"`).join('\n    ')}
    ` : ''}

    CURRENT FEEDBACK/DIFFICULTIES (What they are facing right now):
    "${feedback}"
    
    ${context ? `
    User Context:
    - Current Situation: ${context.decision}
    - Stress Level: ${context.stress}/5
    - Financial Status: ${context.personalFinance}/5
    - Academic Performance: ${context.academicPerformance}/5
    - Risk Tolerance: ${context.risk}/5
    - Other Factors: ${context.otherFactors || 'None'}
    ` : ''}
    ${timeframe ? `Target Completion Timeframe: ${timeframe} months.` : ''}

    TASK:
    - BẮT BUỘC: Giữ nguyên 100% nội dung của các cột mốc trong danh sách "COMPLETED MILESTONES" ở trên. Copy chính xác từng trường (month, event, impact, probability, details) vào mảng milestones mới ở các vị trí đầu tiên.
    - Dựa vào chuỗi biến cố từ "PAST FEEDBACKS" (nếu có) kéo dài đến "CURRENT FEEDBACK" ("${feedback}") và bối cảnh các bước đã hoàn thành, hãy GIẢ LẬP và TẠO MỚI các cột mốc còn thiếu để hoàn thiện lộ trình.
    - Phải có tính nối tiếp: Nếu trước đó người dùng đã báo cáo khó khăn X, và giờ lại gặp biến cố Y, hãy thể hiện sự thấu hiểu chuỗi biến cố này trong \`detailedNarrative\`.
    - Điều chỉnh 'detailedNarrative', 'influencingFactors', 'strategicPivotPoints' và 'longTermProjection' để phản ánh sự thay đổi này nhưng không được mâu thuẫn với quá khứ. Đảm bảo \`detailedNarrative\` luôn được chia thành các đoạn văn bắt đầu bằng mốc thời gian rõ ràng (ví dụ: 'Tháng X:', 'Tháng X-Y:').
    - Đảm bảo tổng số milestones trong kết quả trả về luôn là 5.
    - BẮT BUỘC: Không được để trống bất kỳ trường nào. Mọi cột mốc (kể cả cũ và mới) đều phải có đầy đủ month, event, impact, probability và details.
    - The "details" field for any NEW milestones MUST be a JSON array of exactly 3 structured step objects. Each step object must have:
      - id: A unique string ID like "step_X_Y" (where X is milestone index 1-5, Y is step index 1-5), e.g. "step_1_1", "step_1_2".
      - title: Tên công việc cụ thể (Vietnamese).
      - description: Mô tả ngắn gọn nhiệm vụ (Vietnamese).
      - objectives: Mảng chứa 2-3 mục tiêu chính (Vietnamese).
      - actions: Mảng chứa 2-3 hành động cơ bản (Vietnamese).
      - tools: Mảng chứa 2-3 công cụ cơ bản đề xuất (Vietnamese).
      - expectedResult: Kết quả đầu ra cơ bản (Vietnamese).
      - completed: false.
    - TUYỆT ĐỐI KHÔNG lười biếng: Không viết "giữ nguyên", "như cũ" hay để trống. Phải copy lại đúng nội dung hoặc viết mới chi tiết.

    Return ONLY a valid JSON object matching the PremiumAnalysisReport interface.
     Ngôn ngữ: Tiếng Việt.
  `;

  try {
    const response = await callGeminiWithRetry(
      ['gemini-2.5-flash-lite', 'gemini-3.1-flash-lite'],
      prompt,
      {
        responseMimeType: 'application/json',
        maxOutputTokens: 8192,
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            detailedNarrative: { type: Type.STRING },
            milestones: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  month: { type: Type.STRING },
                  event: { type: Type.STRING },
                  impact: { type: Type.STRING },
                  probability: { type: Type.NUMBER },
                  details: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        id: { type: Type.STRING },
                        title: { type: Type.STRING },
                        description: { type: Type.STRING },
                        objectives: {
                          type: Type.ARRAY,
                          items: { type: Type.STRING }
                        },
                        actions: {
                          type: Type.ARRAY,
                          items: { type: Type.STRING }
                        },
                        tools: {
                          type: Type.ARRAY,
                          items: { type: Type.STRING }
                        },
                        expectedResult: { type: Type.STRING },
                        completed: { type: Type.BOOLEAN }
                      },
                      required: ['id', 'title', 'description', 'objectives', 'actions', 'tools', 'expectedResult', 'completed']
                    }
                  }
                },
                required: ['month', 'event', 'impact', 'probability', 'details']
              }
            },
            influencingFactors: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  category: { type: Type.STRING },
                  factor: { type: Type.STRING },
                  influence: { type: Type.STRING },
                  description: { type: Type.STRING }
                },
                required: ['category', 'factor', 'influence', 'description']
              }
            },
            strategicPivotPoints: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  condition: { type: Type.STRING },
                  action: { type: Type.STRING }
                },
                required: ['condition', 'action']
              }
            },
            longTermProjection: { type: Type.STRING }
          },
          required: ['detailedNarrative', 'milestones', 'influencingFactors', 'strategicPivotPoints', 'longTermProjection']
        }
      }
    );

    let text = "";
    try {
      if (typeof response.text === 'string') {
        text = response.text.trim();
      } else if (typeof response.text === 'function') {
        text = response.text().trim();
      } else if (response.response && typeof response.response.text === 'function') {
        text = response.response.text().trim();
      }
    } catch (e) {
      console.error('[AI Text Extraction Error]:', e);
    }

    if (!text) {
      throw new Error('AI không trả về nội dung văn bản. Vui lòng thử lại.');
    }

    const parsed = parseAndRepairJson(text);
    parsed.modelUsed = response.modelUsed;
    return parsed;
  } catch (error) {
    if (error.message.includes('AI trả về dữ liệu không hợp lệ')) {
      throw error;
    }
    console.error('[AI Error Details - Pivot]:', error);
    throw new Error('Lỗi khi xử lý dữ liệu từ AI. Vui lòng thử lại sau.');
  }
};

const expandStepDetail = async (scenarioTitle, milestoneEvent, stepTitle, stepDescription, context) => {
  const prompt = `
    Bạn là một chuyên gia tư vấn hướng nghiệp chuyên sâu và cố vấn học tập hàng đầu.
    Nhiệm vụ của bạn là tối ưu hóa và viết hướng dẫn cực kỳ chi tiết cho một bước cụ thể trong lộ trình phát triển.

    Thông tin bối cảnh:
    - Kịch bản tổng thể: ${scenarioTitle}
    - Cột mốc hiện tại: ${milestoneEvent}
    - Tên nhiệm vụ cần chi tiết hóa: ${stepTitle}
    - Mô tả sơ bộ hiện tại: ${stepDescription}
    ${context ? `- Bối cảnh cá nhân của học sinh: ${JSON.stringify(context)}` : ''}

    YÊU CẦU:
    Hãy mở rộng và viết lại nhiệm vụ này thành một hướng dẫn thực thi thực tế, chi tiết và vô cùng rõ ràng. Bạn PHẢI trả về một đối tượng JSON chứa các trường sau:
    1. description: Mô tả cực kỳ chi tiết và sâu sắc về nhiệm vụ, giải thích tại sao nhiệm vụ này quan trọng, cần lưu ý điều gì, làm thế nào để chuẩn bị tâm lý/kiến thức trước khi thực hiện. (Viết chi tiết bằng Tiếng Việt, độ dài từ 80 đến 150 từ).
    2. objectives: Danh sách gồm 3 đến 5 mục tiêu cụ thể, định lượng được và thực tế cần đạt được khi hoàn thành nhiệm vụ này. (Viết bằng Tiếng Việt).
    3. actions: Danh sách gồm 5 đến 8 hành động cực kỳ chi tiết từng bước một để thực hiện nhiệm vụ. Mỗi hành động phải là một chỉ dẫn thực tế rõ ràng:
       - Chỉ rõ CÁCH LÀM (làm như thế nào, phương pháp cụ thể).
       - Chỉ rõ LÀM Ở ĐÂU (ở website nào, học ở đâu, sử dụng tài nguyên/nền tảng cụ thể nào, ví dụ: Udemy, Coursera, Figma, VS Code, W3Schools, các trang web chính thức,...).
       - TUYỆT ĐỐI KHÔNG ghi chung chung như "đọc sách", "học kỹ năng", "xem video". Mỗi hành động phải dài ít nhất 15-20 từ.
    4. tools: Danh sách gồm 3 đến 5 công cụ, phần mềm, website hoặc tài nguyên học tập cụ thể khuyên dùng để làm nhiệm vụ này. (Viết bằng Tiếng Việt).
    5. expectedResult: Kết quả đầu ra mong muốn và sản phẩm thực tế cụ thể (ví dụ: một chứng chỉ hoàn thành khóa học, một project code trên GitHub, một bản thiết kế Figma link public,...) để người dùng tự đánh giá đã đạt yêu cầu hay chưa. (Viết bằng Tiếng Việt).

    Return ONLY a valid JSON object matching this schema:
    {
      "description": string,
      "objectives": string[],
      "actions": string[],
      "tools": string[],
      "expectedResult": string
    }

    Ngôn ngữ: Tiếng Việt.
  `;

  try {
    const response = await callGeminiWithRetry(
      ['gemini-2.5-flash', 'gemini-3.1-flash-lite'],
      prompt,
      {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            description: { type: Type.STRING },
            objectives: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            },
            actions: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            },
            tools: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            },
            expectedResult: { type: Type.STRING }
          },
          required: ['description', 'objectives', 'actions', 'tools', 'expectedResult']
        }
      }
    );

    let text = "";
    try {
      if (typeof response.text === 'string') {
        text = response.text.trim();
      } else if (typeof response.text === 'function') {
        text = response.text().trim();
      } else if (response.response && typeof response.response.text === 'function') {
        text = response.response.text().trim();
      } else if (response.candidates && response.candidates[0]?.content?.parts?.[0]?.text) {
        text = response.candidates[0].content.parts[0].text.trim();
      }
    } catch (e) {
      console.error('[AI Text Extraction Error]:', e);
    }

    if (!text) {
      throw new Error('AI không trả về nội dung văn bản. Vui lòng thử lại.');
    }

    const parsed = parseAndRepairJson(text);
    parsed.modelUsed = response.modelUsed;
    return parsed;
  } catch (error) {
    console.error('[AI Expand Step Detail Error]:', error);
    throw error;
  }
};

module.exports = { generateSimulation, generatePremiumAnalysis, pivotPremiumAnalysis, expandStepDetail, analyzeInputReadiness };
