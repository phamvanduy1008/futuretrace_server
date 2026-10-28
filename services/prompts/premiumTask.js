/**
 * Đặc tả tác vụ T2 - Lộ trình chuyên sâu (premium) v3: viết theo phần + slot, dùng chung cho production,
 * sinh dữ liệu huấn luyện (teacher) và đánh giá.
 *
 *  1. plan       : tường thuật, 5 mốc (tiêu đề), 4 yếu tố ảnh hưởng, 3 điểm rẽ nhánh, tầm nhìn
 *  2. milestone i: 3 bước chi tiết cho mốc thứ i (5 lần gọi song song sau khi có plan)
 * Con số dữ liệu (lương, điểm chuẩn, học phí, ROI...) chỉ qua slot {{...}}; mục tiêu cá nhân (vd "đạt 7,0 IELTS",
 * "học 2 giờ mỗi ngày") được viết trực tiếp.
 */

const IMPACT = ['High', 'Medium', 'Low'];

const SYSTEM_PROMPT = `Bạn là FutureTrace - cố vấn chiến lược học tập và hướng nghiệp cho học sinh, sinh viên Việt Nam, gọi người học là "em"; không tự xưng chị/anh/tôi/mình, không mở đầu bằng lời chào.
Nhiệm vụ: lập LỘ TRÌNH CHUYÊN SÂU, khả thi, theo đúng giai đoạn học và hoàn cảnh của người học.
Nguyên tắc bắt buộc:
1. KHÔNG tự viết con số dữ liệu thị trường/tuyển sinh/tài chính (lương, điểm chuẩn, học phí, chi phí, nhu cầu tiền mặt, ROI, xác suất đỗ, số tin tuyển dụng), kể cả số tự tính ra (chênh lệch, tổng, trung bình). Mọi khoản tiền "triệu" đều phải là slot. Khi cần, viết đúng TÊN SLOT trong bảng SLOT (vd "{{F1}}", "{{P50.start}}"); slot tự điền số, đơn vị và mã nguồn. Mục tiêu cá nhân (số giờ học, số bài tập, điểm mục tiêu của bản thân) được viết trực tiếp.
2. Thời gian thực tế: "Tháng X" là THÁNG THỨ X TÍNH TỪ BÂY GIỜ (Tháng 1 = tháng đầu tiên của lộ trình), KHÔNG phải tháng dương lịch; mốc theo thứ tự "Tháng X" hoặc "Tháng X-Y", tăng dần, không vượt khung thời gian. Đúng giai đoạn: học sinh lớp 10-11 không thi đại học trong lộ trình ngắn; học sinh lớp 12 tập trung ôn thi, nguyện vọng; sinh viên xây nền, thực tập, chứng chỉ.
3. Cụ thể theo ngành, trường, khu vực, học lực, tài chính, áp lực trong hồ sơ và kịch bản đã chọn; tránh câu dùng được cho mọi ngành.
4. Không nêu tên trường, công ty, học bổng không có trong hồ sơ hoặc bảng SLOT. Không viết đường link.
5. Nhóm nghề tham chiếu gần đúng thì nói rõ số lương/số tin chỉ là mốc tham khảo.
6. Viết tiếng Việt tự nhiên, thấu cảm nhưng thẳng thắn. Chỉ trả về một đối tượng JSON đúng schema, không markdown.`;

const STAGE_GUIDANCE = {
  THPT_CHON_TO_HOP: 'Học sinh lớp 10-11: chọn tổ hợp, phương pháp học, giữ học bạ, khám phá ngành. Không đi làm, không thực tập.',
  THPT_ON_THI_DAI_HOC: 'Học sinh lớp 12: ôn thi tốt nghiệp/ĐGNL theo lịch thi, chiến lược nguyện vọng an toàn 3 tầng, chuẩn bị nhập học.',
  DAI_HOC_DAI_CUONG: 'Sinh viên năm 1-2: GPA, ngoại ngữ chuẩn đầu ra, kỹ năng nền, CLB, việc làm thêm vừa sức.',
  DAI_HOC_CHUYEN_NGANH_THUC_TAP: 'Sinh viên năm 3-4: chuyên môn sâu, portfolio, thực tập, chuyển thành nhân viên chính thức.',
  CHUYEN_NGANH_SONG_BANG: 'Chuyển ngành/song bằng: thủ tục, tín chỉ công nhận, cân đối thời gian và chi phí, tận dụng nền cũ.',
  CHUYEN_NGANH_DI_LAM: 'Đã đi làm: chuyển đổi nghề, học thêm kỹ năng, xây hồ sơ năng lực.',
  KHOI_NGHIEP_FREELANCE: 'Khởi nghiệp/freelance: kiểm chứng ý tưởng, dòng tiền, khách hàng đầu tiên.',
  DU_HOC_QUOC_TE: 'Du học: chứng chỉ, bài luận, hồ sơ tài chính, học bổng.',
  THAC_SI_NGHIEN_CUU: 'Cao học: đề cương, giảng viên hướng dẫn, công bố.'
};

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    detailedNarrative: { type: 'string' },
    milestones: {
      type: 'array', minItems: 5, maxItems: 5,
      items: {
        type: 'object',
        properties: {
          month: { type: 'string' },
          event: { type: 'string' },
          impact: { type: 'string', enum: IMPACT },
          probability: { type: 'integer' }
        },
        required: ['month', 'event', 'impact', 'probability']
      }
    },
    influencingFactors: {
      type: 'array', minItems: 4, maxItems: 4,
      items: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['Economic', 'Personal', 'Social', 'Technical'] },
          factor: { type: 'string' },
          influence: { type: 'string', enum: IMPACT },
          description: { type: 'string' }
        },
        required: ['category', 'factor', 'influence', 'description']
      }
    },
    strategicPivotPoints: {
      type: 'array', minItems: 3, maxItems: 3,
      items: { type: 'object', properties: { condition: { type: 'string' }, action: { type: 'string' } }, required: ['condition', 'action'] }
    },
    longTermProjection: { type: 'string' }
  },
  required: ['detailedNarrative', 'milestones', 'influencingFactors', 'strategicPivotPoints', 'longTermProjection']
};

const MILESTONE_SCHEMA = {
  type: 'object',
  properties: {
    details: {
      type: 'array', minItems: 3, maxItems: 3,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          objectives: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string' } },
          actions: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string' } },
          tools: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string' } },
          expectedResult: { type: 'string' }
        },
        required: ['title', 'description', 'objectives', 'actions', 'tools', 'expectedResult']
      }
    }
  },
  required: ['details']
};

const levelText = (v) => (v === undefined || v === null || v === '' ? 'chưa rõ' : `${v}/5`);

/** Phần đầu dùng chung cho mọi lần gọi của một lộ trình (prefix cache của vLLM tận dụng được) */
const buildBase = ({ input = {}, student = {}, scenario = {}, timeframe = 12, slotText = '' }) => `HỒ SƠ NGƯỜI HỌC:
- Mong muốn / quyết định: ${input.decision || ''}
- Giai đoạn: ${student.stageLabel || 'chưa rõ'}
- Học lực ${levelText(input.academicPerformance)} | Tài chính gia đình ${levelText(input.personalFinance)} | Áp lực ${levelText(input.stress)} | Chấp nhận rủi ro ${levelText(input.risk)}
${input.location ? `- Khu vực: ${input.location}\n` : ''}${input.otherFactors ? `- Bổ sung: ${input.otherFactors}\n` : ''}
KỊCH BẢN ĐÃ CHỌN ĐỂ LẬP LỘ TRÌNH:
- ${scenario.title || ''}
- ${String(scenario.description || '').replace(/\s+/g, ' ').trim()}

KHUNG THỜI GIAN: ${timeframe} tháng, đếm từ bây giờ (Tháng 1 = tháng đầu tiên; mốc cuối không vượt Tháng ${timeframe}).
ĐỊNH HƯỚNG THEO GIAI ĐOẠN: ${STAGE_GUIDANCE[student.stage] || STAGE_GUIDANCE.DAI_HOC_DAI_CUONG}

${slotText}`;

/** Giai đoạn do code chia (premiumTimeline.planPeriods): mốc i = giai đoạn i, tường thuật đúng 1 đoạn/giai đoạn */
const periodRules = (periods) => `- CÁC GIAI ĐOẠN CỐ ĐỊNH (phủ đủ toàn bộ khung, theo đúng thứ tự):
${periods.map((p, i) => `  ${i + 1}. ${p.label}`).join('\n')}
- detailedNarrative: 180-350 từ, đúng ${periods.length} đoạn, đoạn i mở đầu ĐÚNG nhãn giai đoạn i và dấu hai chấm (vd "${periods[0].label}: ..."), kể em sẽ làm gì trong giai đoạn đó, khó khăn và cách vượt qua; không nhắc tháng nằm ngoài khung.
- milestones: đúng ${periods.length} mốc, mốc i là kết quả cần đạt khi KẾT THÚC giai đoạn i, month ghi ĐÚNG nhãn giai đoạn i; event 8-20 từ, cụ thể, khớp với việc làm được trong giai đoạn đó; impact High/Medium/Low; probability là số nguyên 0-100 (khả năng em đạt mốc).`;

const planInstruction = (timeframe, hedge, periods = null) => `PHẦN CẦN VIẾT: KHUNG LỘ TRÌNH (JSON {detailedNarrative, milestones, influencingFactors, strategicPivotPoints, longTermProjection}).
${periods ? periodRules(periods) : `- detailedNarrative: 180-350 từ, 4-6 đoạn theo thứ tự thời gian, mỗi đoạn mở đầu bằng "Tháng ...:", kể em sẽ làm gì, khó khăn và cách vượt qua.
- milestones: đúng 5 mốc tăng dần trong ${timeframe} tháng; month dạng "Tháng X" hoặc "Tháng X-Y"; event 8-20 từ, cụ thể; impact High/Medium/Low; probability là số nguyên 0-100 (khả năng em đạt mốc).`}
- influencingFactors: đúng 4 yếu tố, category lần lượt trong Economic/Personal/Social/Technical; factor ngắn gọn; description 20-45 từ gắn với hồ sơ.
- strategicPivotPoints: đúng 3 điểm; condition bắt đầu bằng "Nếu"; action 15-40 từ, hành động cụ thể.
- longTermProjection: 50-100 từ, tầm nhìn 3-5 năm.${hedge ? '\n- BẮT BUỘC nói rõ lương/số tin là mốc tham khảo của nhóm nghề gần nhất (cụm "tham khảo" hoặc "gần đúng") nếu có nhắc tới.' : ''}`;

const milestoneInstruction = (plan, index) => `KHUNG LỘ TRÌNH ĐÃ CHỐT:
${(plan.milestones || []).map((m, i) => `${i + 1}. [${m.month}] ${m.event}`).join('\n')}

PHẦN CẦN VIẾT: 3 BƯỚC CHI TIẾT CHO MỐC ${index + 1} "[${plan.milestones?.[index]?.month}] ${plan.milestones?.[index]?.event}" (JSON {details}).
- details: đúng 3 bước theo thứ tự thực hiện, nối tiếp mốc trước và chuẩn bị cho mốc sau. Mỗi bước:
  title 5-15 từ; description 30-70 từ (làm gì, vì sao, lưu ý); objectives 2-3 mục tiêu đo được (8-25 từ mỗi mục);
  actions 2-3 hành động (12-35 từ mỗi mục, nói rõ cách làm và công cụ/nền tảng); tools 2-3 tên công cụ, nền tảng hoặc tài nguyên có thật;
  expectedResult 12-35 từ, sản phẩm hoặc kết quả cụ thể.`;

module.exports = {
  TASK_ID: 'premium_v3_sections',
  SYSTEM_PROMPT,
  PLAN_SCHEMA,
  MILESTONE_SCHEMA,
  buildBase,
  planInstruction,
  periodRules,
  milestoneInstruction,
  IMPACT
};
