/**
 * Đặc tả tác vụ T1 - Mô phỏng 3 kịch bản (dùng chung cho production, sinh dữ liệu fine-tune và đánh giá).
 *
 * Phân vai rõ ràng:
 *  - Con số (lương, ROI, điểm chuẩn, chi phí) do Knowledge Layer + FT-Salary + Career ROI Engine tính,
 *    đưa vào prompt dưới dạng Fact Sheet [F#] và khối định lượng.
 *  - LLM (Qwen fine-tune / Gemini dự phòng) chỉ viết phần diễn giải: tóm tắt, mô tả kịch bản, SWOT,
 *    kế hoạch 90 ngày, lời khuyên, lộ trình thời gian. Mọi con số trong văn bản phải trích từ Fact Sheet.
 */

const SYSTEM_PROMPT = `Bạn là FutureTrace - cố vấn hướng nghiệp cho học sinh, sinh viên Việt Nam.
Nguyên tắc bắt buộc:
1. Chỉ dùng con số có trong FACT SHEET hoặc khối SỐ LIỆU ĐỊNH LƯỢNG; khi dùng số phải ghi mã nguồn, ví dụ "khoảng 13,5 triệu/tháng [F3]". Không tự tạo lương, điểm chuẩn, tỷ lệ việc làm.
2. Thiếu dữ liệu thì nói rõ "chưa có dữ liệu" thay vì đoán.
3. Viết tiếng Việt tự nhiên, cụ thể theo ngành, trường, giai đoạn học và hoàn cảnh tài chính của người dùng; tránh câu chung chung dùng được cho mọi ngành.
4. Ba kịch bản là ba KẾT CỤC có thể xảy ra của CÙNG một lựa chọn trong hồ sơ (không phải ba trường hay ba nguyện vọng khác nhau): Positive = người học đạt nhóm 25% kết quả tốt nhất (lương P75), Neutral = mức điển hình (P50), Risk = nhóm 25% kém nhất (P25), chậm tìm việc khoảng 9 tháng và có thể trễ 1 năm học. Chiến lược nguyện vọng (nếu là học sinh lớp 12) đưa vào lời khuyên/kế hoạch, không dùng làm kịch bản.
5. Không nêu tên trường, ngành, công ty hay học bổng cụ thể nếu không có trong FACT SHEET hoặc hồ sơ người dùng.
6. Nếu nhãn lương/số tin ghi "nhóm nghề tham chiếu" (gần đúng hoặc chỉ mang tính tham khảo) thì phải nói rõ đó là mốc tham khảo của nhóm nghề gần nhất, chưa phản ánh đúng ngành học; không diễn giải như lương chắc chắn của ngành.
7. Chỉ trả về một đối tượng JSON đúng schema, không markdown.`;

const STAGE_GUIDANCE = {
  THPT_CHON_TO_HOP: 'Học sinh lớp 10-11: tập trung chọn tổ hợp môn, phương pháp học, giữ học bạ. Không gợi ý đi làm hay thực tập.',
  THPT_ON_THI_DAI_HOC: 'Học sinh lớp 12: chiến lược ôn thi tốt nghiệp/ĐGNL, đặt nguyện vọng an toàn 3 tầng. Không gợi ý thực tập hay viết CV.',
  DU_HOC_QUOC_TE: 'Du học: chứng chỉ quốc tế, bài luận, hồ sơ tài chính, học bổng.',
  THAC_SI_NGHIEN_CUU: 'Cao học: đề cương nghiên cứu, giảng viên hướng dẫn, công bố khoa học.',
  DAI_HOC_CHUYEN_NGANH_THUC_TAP: 'Sinh viên năm 3-4: công cụ chuyên ngành, portfolio, thực tập, chuyển thành nhân viên chính thức.',
  DAI_HOC_DAI_CUONG: 'Sinh viên năm 1-2: phương pháp học tín chỉ, GPA, ngoại ngữ chuẩn đầu ra, công cụ nền tảng.',
  KHOI_NGHIEP_FREELANCE: 'Khởi nghiệp/freelance: kiểm chứng ý tưởng, dòng tiền, kỹ năng bán hàng.',
  CHUYEN_NGANH_SONG_BANG: 'Song bằng/chuyển ngành: cân đối thời gian, tận dụng nền tảng cũ.',
  CHUYEN_NGANH_DI_LAM: 'Đã đi làm: chuyển đổi nghề nghiệp, nâng cấp kỹ năng.'
};

/** JSON Schema chuẩn (vLLM `response_format`, Ollama `format`); Gemini dùng bản chuyển đổi toGeminiSchema */
const SIMULATION_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    scenarios: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['Positive', 'Neutral', 'Risk'] },
          title: { type: 'string' },
          description: { type: 'string' },
          criticalAdvice: { type: 'string' },
          marketAnalysis: { type: 'string' },
          swot: {
            type: 'array',
            minItems: 4,
            maxItems: 4,
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['S', 'W', 'O', 'T'] },
                value: { type: 'string' }
              },
              required: ['type', 'value']
            }
          },
          sprint90: {
            type: 'array',
            minItems: 3,
            maxItems: 3,
            items: {
              type: 'object',
              properties: {
                phase: { type: 'string' },
                tasks: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string' } }
              },
              required: ['phase', 'tasks']
            }
          }
        },
        required: ['type', 'title', 'description', 'criticalAdvice', 'marketAnalysis', 'swot', 'sprint90']
      }
    },
    timeline: {
      type: 'object',
      properties: {
        start: { type: 'string' },
        sixMonths: { type: 'string' },
        oneYear: { type: 'string' },
        threeYears: { type: 'string' }
      },
      required: ['start', 'sixMonths', 'oneYear', 'threeYears']
    }
  },
  required: ['summary', 'scenarios', 'timeline']
};

const levelText = (v) => (v === undefined || v === null ? 'chưa rõ' : `${v}/5`);

/**
 * @param {object} p
 * @param {object} p.input    dữ liệu người dùng (decision, stress, personalFinance, ...)
 * @param {object} p.student  extractHolisticStudentContext(input)
 * @param {string} p.domainName
 * @param {string} p.factSheetText  knowledgeService.formatFactSheet(...)
 * @param {string} p.quantText      formatQuantSnippet(...)
 * @param {string} p.qualitativeText ragService.formatQualitativeSnippet(...)
 */
const buildUserPrompt = ({ input = {}, student = {}, domainName = '', factSheetText = '', quantText = '', qualitativeText = '' }) => {
  const profile = [
    `- Mong muốn / quyết định: ${input.decision || ''}`,
    `- Giai đoạn: ${student.stageLabel || 'chưa rõ'}${domainName ? ` | Lĩnh vực: ${domainName}` : ''}`,
    `- Học lực ${levelText(input.academicPerformance)} | Tài chính gia đình ${levelText(input.personalFinance)} | Áp lực ${levelText(input.stress)} | Chấp nhận rủi ro ${levelText(input.risk)}`,
    input.expectedScore ? `- Điểm thi dự kiến: ${input.expectedScore}/30` : null,
    input.budgetPerYearMillion ? `- Ngân sách gia đình cho việc học: ${input.budgetPerYearMillion} triệu/năm` : null,
    input.location ? `- Khu vực: ${input.location}` : null,
    input.otherFactors ? `- Bổ sung: ${input.otherFactors}` : null
  ].filter(Boolean).join('\n');

  return `HỒ SƠ NGƯỜI HỌC:
${profile}

ĐỊNH HƯỚNG THEO GIAI ĐOẠN: ${STAGE_GUIDANCE[student.stage] || STAGE_GUIDANCE.DAI_HOC_DAI_CUONG}

${factSheetText || '(Chưa có Fact Sheet phù hợp: không đưa ra con số cụ thể)'}

${quantText}

${qualitativeText}

YÊU CẦU ĐẦU RA (JSON):
- summary: 50-70 từ, nêu đánh đổi chính và con số quan trọng nhất (kèm [F#]).
- scenarios: đúng 3 phần tử theo thứ tự Positive, Neutral, Risk. Mỗi phần tử:
  title (tên cụ thể, không chung chung), description (60-90 từ), criticalAdvice (30-50 từ, hành động cụ thể),
  marketAnalysis (30-50 từ, dựa trên Fact Sheet), swot (4 mục S/W/O/T, mỗi mục 20-35 từ),
  sprint90 (3 giai đoạn 30 ngày, mỗi giai đoạn 3 việc cụ thể, đo được).
- timeline: 4 mốc (start, sixMonths, oneYear, threeYears), mỗi mốc 25-40 từ, đúng giai đoạn học của người dùng.`;
};

// ---------------------------------------------------------------- v3: viết theo PHẦN + SLOT (services/slotRenderer.js)
// Mỗi hồ sơ = 4 lần gọi ngắn (tổng quan + 3 kịch bản, chạy song song). Model không viết số, chỉ viết slot {{...}}.

const SECTION_SYSTEM_PROMPT = `Bạn là FutureTrace - cố vấn hướng nghiệp cho học sinh, sinh viên Việt Nam, xưng "em" với người học.
Nguyên tắc bắt buộc:
1. KHÔNG tự viết con số dữ liệu (lương, điểm, phần trăm, ROI, tiền, số tin, năm hoàn vốn). Khi cần số, viết đúng TÊN SLOT trong bảng SLOT, ví dụ "lương khởi điểm khoảng {{start}}", "mức chuẩn năm 2025 là {{F1}}", "hoàn vốn vào {{payback}}". Slot tự điền số, đơn vị và mã nguồn [F#]: không viết thêm đơn vị hay [F#] sau slot. Chỉ dùng slot có trong bảng.
2. Được viết số thời gian chung (30/60/90 ngày, 6 tháng, 1 năm, 3 năm, 5 năm, 20 năm, khoảng 9 tháng) và thang điểm trong hồ sơ (vd 3/5).
3. Viết tiếng Việt tự nhiên, cụ thể theo ngành, trường, giai đoạn học, khu vực và hoàn cảnh tài chính; tránh câu chung chung dùng được cho mọi ngành. Trung thực khi tài chính không đủ, ROI âm hoặc điểm thấp hơn mức chuẩn, kèm phương án thay thế.
4. Ba kịch bản là ba KẾT CỤC của CÙNG một lựa chọn: Positive = nhóm 25% tốt nhất (P75), Neutral = điển hình (P50), Risk = nhóm 25% kém nhất (P25), chậm tìm việc khoảng 9 tháng.
5. Không nêu tên trường, ngành, công ty, học bổng nếu không có trong hồ sơ hoặc bảng SLOT.
6. Nếu lương/số tin thuộc "nhóm nghề tham chiếu" (gần đúng hoặc chỉ tham khảo) thì phải nói rõ đó là mốc tham khảo, dùng cụm "tham khảo" hoặc "gần đúng".
7. Chỉ trả về một đối tượng JSON đúng schema, không markdown.`;

const SWOT_SCHEMA = {
  type: 'array', minItems: 4, maxItems: 4,
  items: { type: 'object', properties: { type: { type: 'string', enum: ['S', 'W', 'O', 'T'] }, value: { type: 'string' } }, required: ['type', 'value'] }
};
const SPRINT_SCHEMA = {
  type: 'array', minItems: 3, maxItems: 3,
  items: { type: 'object', properties: { phase: { type: 'string' }, tasks: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string' } } }, required: ['phase', 'tasks'] }
};
const SECTION_SCHEMAS = {
  overview: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      timeline: SIMULATION_SCHEMA.properties.timeline
    },
    required: ['summary', 'timeline']
  },
  scenario: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      criticalAdvice: { type: 'string' },
      marketAnalysis: { type: 'string' },
      swot: SWOT_SCHEMA,
      sprint90: SPRINT_SCHEMA
    },
    required: ['title', 'description', 'criticalAdvice', 'marketAnalysis', 'swot', 'sprint90']
  }
};

const SCENARIO_LABEL = {
  Positive: 'Positive (P75): người học đạt nhóm 25% kết quả tốt nhất',
  Neutral: 'Neutral (P50): kết quả điển hình',
  Risk: 'Risk (P25): nhóm 25% kém nhất, chậm tìm việc khoảng 9 tháng, có thể trễ 1 năm học'
};

/** Yêu cầu riêng của từng phần */
const sectionInstruction = (section, { hedge = false } = {}) => {
  const hedgeLine = hedge ? '\n- BẮT BUỘC nói rõ lương/số tin là mốc tham khảo của nhóm nghề gần nhất (dùng cụm "tham khảo" hoặc "gần đúng").' : '';
  if (section === 'overview') {
    return `PHẦN CẦN VIẾT: TỔNG QUAN (JSON {summary, timeline}).
- summary: 50-70 từ, nêu đánh đổi chính, dùng ít nhất 2 slot khác nhau (vd {{F1}} và {{P50.start}}).
- timeline: start, sixMonths, oneYear, threeYears; mỗi mốc 25-40 từ, việc cụ thể đúng giai đoạn học của người dùng.${hedgeLine}`;
  }
  return `PHẦN CẦN VIẾT: KỊCH BẢN ${SCENARIO_LABEL[section]} (JSON {title, description, criticalAdvice, marketAnalysis, swot, sprint90}).
- title: tên cụ thể của kết cục này, không chung chung.
- description: 60-90 từ, mô tả con đường dẫn tới kết cục, dùng các slot của kịch bản này ({{start}}, {{year5}}, {{roi}}, {{payback}}, {{cash}}...).
- criticalAdvice: 30-50 từ, hành động cụ thể để đạt (hoặc tránh) kết cục này.
- marketAnalysis: 30-50 từ, dựa trên các slot fact {{F#}} về lương/nhu cầu tuyển dụng.
- swot: đúng 4 mục theo thứ tự S, W, O, T; mỗi mục 20-35 từ, gắn với hồ sơ.
- sprint90: đúng 3 giai đoạn "Ngày 1-30: ...", "Ngày 31-60: ...", "Ngày 61-90: ...", mỗi giai đoạn 3 việc cụ thể, đo được (mỗi việc từ 6 từ).${hedgeLine}`;
};

/** Prompt người dùng cho một phần: hồ sơ + định hướng giai đoạn + bảng SLOT + kiến thức định tính + yêu cầu phần */
const buildSectionPrompt = ({ input = {}, student = {}, domainName = '', slotText = '', qualitativeText = '', section = 'overview', hedge = false }) => {
  const profile = [
    `- Mong muốn / quyết định: ${input.decision || ''}`,
    `- Giai đoạn: ${student.stageLabel || 'chưa rõ'}${domainName ? ` | Lĩnh vực: ${domainName}` : ''}`,
    `- Học lực ${levelText(input.academicPerformance)} | Tài chính gia đình ${levelText(input.personalFinance)} | Áp lực ${levelText(input.stress)} | Chấp nhận rủi ro ${levelText(input.risk)}`,
    input.expectedScore ? '- Điểm thi dự kiến: {{score}}' : null,
    input.location ? `- Khu vực: ${input.location}` : null,
    input.otherFactors ? `- Bổ sung: ${input.otherFactors}` : null
  ].filter(Boolean).join('\n');
  return `HỒ SƠ NGƯỜI HỌC:
${profile}

ĐỊNH HƯỚNG THEO GIAI ĐOẠN: ${STAGE_GUIDANCE[student.stage] || STAGE_GUIDANCE.DAI_HOC_DAI_CUONG}

${slotText || '(Chưa có số liệu: không nêu con số cụ thể, nói rõ "chưa có dữ liệu")'}

${qualitativeText}

${sectionInstruction(section, { hedge })}`;
};

/** Chuyển JSON Schema chuẩn sang định dạng responseSchema của Gemini (@google/genai Type) */
const toGeminiSchema = (schema) => {
  if (!schema || typeof schema !== 'object') return schema;
  const out = { type: String(schema.type).toUpperCase() };
  if (schema.enum) out.enum = schema.enum;
  if (schema.properties) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    out.propertyOrdering = Object.keys(schema.properties);
  }
  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (schema.required) out.required = schema.required;
  if (schema.minItems !== undefined) out.minItems = String(schema.minItems);
  if (schema.maxItems !== undefined) out.maxItems = String(schema.maxItems);
  return out;
};

module.exports = {
  TASK_ID: 'simulation_v2',
  SECTION_TASK_ID: 'simulation_v3_sections',
  SYSTEM_PROMPT,
  SECTION_SYSTEM_PROMPT,
  SIMULATION_SCHEMA,
  SECTION_SCHEMAS,
  SECTIONS: ['overview', 'Positive', 'Neutral', 'Risk'],
  buildUserPrompt,
  buildSectionPrompt,
  toGeminiSchema
};
