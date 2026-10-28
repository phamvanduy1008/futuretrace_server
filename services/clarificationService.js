/**
 * Câu hỏi "Làm rõ thông tin" trước khi mô phỏng (không gọi AI, < 1 ms).
 *
 * Nguyên tắc:
 * - Giai đoạn học quyết định bộ câu hỏi (chuyển ngành, lớp 10-11, lớp 12, sinh viên, đã đi làm...).
 *   Mô tả không nói rõ giai đoạn thì hỏi giai đoạn trước.
 * - Ngành được nhận diện theo NGÀNH ĐÍCH (phần sau "chuyển sang", "muốn học", "thi vào"...),
 *   nhóm cụ thể được xét trước nhóm chung (vd "quản trị văn phòng" trước "quản trị"), có ranh giới từ.
 * - Câu hỏi bám mục tiêu người học nêu (vd "thu nhập cao" -> hỏi mức thu nhập kỳ vọng).
 * - Tối đa 3 câu, mỗi câu 3-4 lựa chọn (giao diện chỉ cho chọn, bắt buộc trả lời đủ).
 */

const toAscii = (s) => String(s || '').replace(/đ/g, 'd').replace(/Đ/g, 'D').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Thứ tự quan trọng: nhóm cụ thể trước nhóm chung. Mẫu chạy trên chữ không dấu, có ranh giới từ. */
const DOMAINS = [
  {
    key: 'office_admin', label: 'Hành chính - Văn phòng',
    re: /\b(quan tri van phong|van phong|hanh chinh|van thu|luu tru hoc|thu ky|tro ly giam doc)\b/,
    branches: ['Thư ký - Trợ lý lãnh đạo', 'Hành chính - Nhân sự doanh nghiệp', 'Văn thư - Lưu trữ và quản lý hồ sơ số', 'Chuyên viên hành chính cơ quan nhà nước']
  },
  {
    key: 'hospitality', label: 'Du lịch - Khách sạn - Nhà hàng',
    re: /\b(du lich|khach san|lu hanh|nha hang|f&b|huong dan vien)\b/,
    branches: ['Quản trị khách sạn - resort', 'Lữ hành - Hướng dẫn du lịch', 'Nhà hàng - Ẩm thực - Sự kiện']
  },
  {
    key: 'medical', label: 'Y - Dược - Sức khỏe',
    re: /\b(y khoa|y duoc|y hoc|bac si|duoc hoc|duoc si|nha khoa|rang ham mat|dieu duong|y te|nganh y|hoc y|ky thuat y hoc|xet nghiem)\b/,
    branches: ['Bác sĩ đa khoa', 'Răng - Hàm - Mặt', 'Dược học', 'Điều dưỡng / Kỹ thuật y học']
  },
  {
    key: 'law', label: 'Luật',
    re: /\b(luat|phap ly|phap che|tu phap|luat su)\b/,
    branches: ['Luật kinh tế - Pháp chế doanh nghiệp', 'Luật sư tranh tụng', 'Luật quốc tế - Thương mại quốc tế', 'Công chức tư pháp (tòa án, viện kiểm sát, công chứng)']
  },
  {
    key: 'it', label: 'Công nghệ thông tin',
    re: /\b(cntt|cong nghe thong tin|phan mem|lap trinh|tri tue nhan tao|khoa hoc may tinh|an toan thong tin|an ninh mang|he thong thong tin|khoa hoc du lieu|developer|ky thuat may tinh)\b/,
    // "AI", "IT" chỉ tính khi viết hoa trong câu gốc ("ai", "it" là từ thường trong tiếng Việt không dấu: tài, hai, lại...)
    raw: /\b(AI|IT)\b/,
    branches: ['Kỹ thuật phần mềm', 'Trí tuệ nhân tạo - Khoa học dữ liệu', 'An toàn thông tin', 'Hệ thống thông tin - Quản trị mạng']
  },
  {
    key: 'education', label: 'Sư phạm - Giáo dục',
    re: /\b(su pham|giao duc|giao vien|giang vien|mam non|tieu hoc)\b/,
    branches: ['Giáo viên THCS/THPT', 'Giáo dục mầm non - tiểu học', 'Giảng dạy ngoại ngữ', 'Quản lý giáo dục - Tư vấn học đường']
  },
  {
    key: 'design', label: 'Thiết kế - Kiến trúc - Mỹ thuật',
    re: /\b(thiet ke|do hoa|kien truc|my thuat|noi that|ui\/ux|ux|designer|hoat hinh)\b/,
    branches: ['Thiết kế đồ họa - UI/UX', 'Kiến trúc - Nội thất', 'Hoạt hình - Game - Dựng phim']
  },
  {
    key: 'language', label: 'Ngôn ngữ - Biên phiên dịch',
    re: /\b(ngon ngu|tieng anh|tieng nhat|tieng trung|tieng han|tieng duc|tieng phap|bien dich|phien dich|dong phuong hoc)\b/,
    branches: ['Biên - phiên dịch', 'Làm việc tại doanh nghiệp FDI', 'Giảng dạy ngoại ngữ', 'Du lịch - Dịch vụ cần ngoại ngữ']
  },
  {
    key: 'engineering', label: 'Kỹ thuật - Công nghệ',
    re: /\b(ky thuat|co khi|tu dong hoa|dien tu|vien thong|dien|xay dung|o to|co dien tu|robot|ban dan|vi mach)\b/,
    branches: ['Cơ khí - Cơ điện tử - Tự động hóa', 'Điện - Điện tử - Viễn thông - Bán dẫn', 'Xây dựng - Kết cấu', 'Ô tô - Năng lượng']
  },
  {
    key: 'business', label: 'Kinh tế - Kinh doanh',
    re: /\b(kinh te|marketing|quan tri kinh doanh|qtkd|tai chinh|ngan hang|logistics|chuoi cung ung|thuong mai|kinh doanh|ke toan|kiem toan|nhan su|quan tri)\b/,
    branches: ['Marketing - Thương mại điện tử', 'Tài chính - Ngân hàng', 'Kế toán - Kiểm toán', 'Logistics - Kinh doanh quốc tế']
  }
];

/** Cụm mở đầu ngành đích */
const SWITCH_CUE = /\b(chuyen sang|chuyen qua|doi sang|doi qua|chuyen nganh sang)\b/;
const TARGET_CUE = /\b(muon hoc|muon theo|theo hoc|thi vao|thi nganh|vao nganh|hoc nganh|xet tuyen|dang ky)\b/;
/** Cụm chuyển ngành được ưu tiên: "Em học ngành A nhưng muốn chuyển sang B" -> đích là B */
const findCue = (norm) => norm.match(SWITCH_CUE) || norm.match(TARGET_CUE);

const detectDomain = (text, raw = '') => DOMAINS.find(d => d.re.test(text) || (d.raw && d.raw.test(raw))) || null;

/** Ngành đích (ưu tiên phần sau cụm "chuyển sang/muốn học...") và ngành hiện tại (phần trước) */
const detectDomains = (input) => {
  const decision = String(input || '').normalize('NFC');
  const norm = toAscii(decision);
  const m = findCue(norm);
  if (m) {
    const after = norm.slice(m.index + m[0].length);
    const before = norm.slice(0, m.index);
    // Câu gốc cắt theo cùng vị trí (toAscii giữ nguyên độ dài với chữ tiếng Việt dựng sẵn)
    return { target: detectDomain(after, decision.slice(m.index)) || detectDomain(norm, decision), current: detectDomain(before, decision.slice(0, m.index)) };
  }
  return { target: detectDomain(norm, decision), current: null };
};

/** Giai đoạn rõ ràng trong câu? (bộ dò của geminiService mặc định "đại học năm 1-2" khi không thấy gì) */
const STAGE_SIGNAL = /\b(lop (10|11|12)|thpt|cap 3|on thi|thi dai hoc|xet tuyen|nguyen vong|sinh vien|nam (1|2|3|4|nhat|hai|ba|tu|cuoi)|dai cuong|tan sinh vien|thuc tap|ra truong|tot nghiep|di lam|nhan vien|chuyen nganh|chuyen sang|song bang|van bang 2|thac si|cao hoc|du hoc)\b/;

const Q = (question, options) => ({ question, options });

/** Tên ngành đúng như người học viết: "ngành Quản trị - Luật, ..." -> "Quản trị - Luật" */
const majorPhrase = (segment) => {
  const m = String(segment || '').match(/ngành\s+(.+?)(?=\s*[,.;!?(]|\s+(đang|và|nhưng|vì|để|em|ở|tại|của|nên|thì|mà)(?=[\s,.;!?]|$)|$)/i);
  const name = m ? m[1].trim() : '';
  return name && name.split(/\s+/).length <= 8 ? name : '';
};

/** Tên ngành hiện tại / ngành đích để đặt vào câu hỏi (ưu tiên chữ người học viết, rồi tên nhóm) */
const majorNames = (decision) => {
  const norm = toAscii(decision);
  const m = findCue(norm);
  if (!m) return { current: majorPhrase(decision), target: '' };
  const cueEnd = m.index + m[0].length;
  const after = decision.slice(cueEnd);
  const directTarget = after.match(/^\s*(ngành\s+)?(.+?)(?=\s*[,.;!?(]|\s+(đang|và|nhưng|vì|để|em|ở|tại|của|nên|thì|mà)(?=[\s,.;!?]|$)|$)/i);
  const target = directTarget && directTarget[2].trim().split(/\s+/).length <= 8 ? directTarget[2].trim() : '';
  return { current: majorPhrase(decision.slice(0, m.index)), target };
};

const incomeQuestion = () => Q('Mức thu nhập bạn kỳ vọng sau 2-3 năm đi làm?', [
  'Dưới 10 triệu/tháng, ưu tiên ổn định', '10-15 triệu/tháng', '15-25 triệu/tháng', 'Trên 25 triệu/tháng, chấp nhận áp lực cao'
]);

const branchQuestion = (domain, verb = 'hướng tới') => Q(`Trong nhóm ${domain.label}, bạn ${verb} hướng nào?`, [...domain.branches.slice(0, 3), 'Chưa rõ, muốn được gợi ý']);

/**
 * @param {string} decision mô tả của người học
 * @param {object} student  kết quả extractHolisticStudentContext({decision})
 * @returns {{question: string, options: string[]}[]}
 */
const buildClarificationQuestions = (input, student = {}) => {
  const decision = String(input || '').normalize('NFC');
  const norm = toAscii(decision);
  const { target, current } = detectDomains(decision);
  const names = majorNames(decision);
  const targetName = names.target ? `ngành ${names.target}` : target ? target.label : 'ngành mới';
  const currentName = names.current || (current ? current.label : '');
  const wantsIncome = /\b(thu nhap|luong|kiem nhieu tien|giau)\b/.test(norm);
  let stage = STAGE_SIGNAL.test(norm) ? student.stage : null;
  // Sinh viên nói "chuyển sang/đổi sang ..." là chuyển ngành (bộ dò cũ chỉ bắt "chuyển sang ngành")
  if (SWITCH_CUE.test(norm) && (!stage || ['DAI_HOC_DAI_CUONG', 'DAI_HOC_CHUYEN_NGANH_THUC_TAP'].includes(stage))) stage = 'CHUYEN_NGANH_SONG_BANG';
  const qs = [];

  if (!stage) {
    qs.push(Q('Bạn đang ở giai đoạn nào?', ['Học sinh lớp 10-11', 'Học sinh lớp 12', 'Sinh viên đại học/cao đẳng', 'Đã đi làm, muốn đổi hướng']));
    if (target) qs.push(branchQuestion(target));
    else qs.push(Q('Bạn đang cân nhắc nhóm ngành nào?', ['Kinh tế - Kinh doanh', 'Kỹ thuật - Công nghệ thông tin', 'Y - Dược - Sức khỏe', 'Xã hội - Ngôn ngữ - Luật - Sư phạm']));
  } else if (stage === 'CHUYEN_NGANH_SONG_BANG') {
    qs.push(Q('Bạn định chuyển ngành theo cách nào?', [
      'Chuyển ngành ngay trong trường đang học', 'Thi hoặc xét tuyển lại vào trường khác', 'Học song ngành / văn bằng 2, vẫn giữ ngành hiện tại', 'Chưa rõ, muốn so sánh các cách'
    ]));
    qs.push(Q(`Lý do chính khiến bạn muốn chuyển sang ${targetName}?`, [
      `Ngành hiện tại${currentName ? ` (${currentName})` : ''} không hợp sở thích hoặc năng lực`, 'Ngành mới dễ có việc hoặc thu nhập tốt hơn', 'Gia đình hoặc người thân định hướng', 'Kết quả học tập hiện tại đang gặp khó khăn'
    ]));
    qs.push(wantsIncome ? incomeQuestion()
      : names.target ? Q(`Bạn đã chuẩn bị gì cho ${targetName}?`, ['Chưa tìm hiểu nhiều', 'Đã tự học hoặc làm thử việc liên quan', 'Đã hỏi phòng đào tạo về điều kiện chuyển ngành', 'Đã có kế hoạch học bù tín chỉ'])
        : target ? branchQuestion(target, 'muốn theo') : Q('Bạn đang học năm mấy?', ['Năm 1', 'Năm 2', 'Năm 3', 'Năm 4 trở lên']));
  } else if (stage === 'THPT_CHON_TO_HOP') {
    qs.push(Q('Nhóm môn bạn học tốt nhất?', ['Toán - Lý - Hóa', 'Toán - Hóa - Sinh', 'Toán - Văn - Anh', 'Văn - Sử - Địa / GDKT&PL']));
    qs.push(target ? branchQuestion(target) : Q('Bạn đang nghiêng về nhóm ngành nào?', ['Kinh tế - Kinh doanh', 'Kỹ thuật - Công nghệ thông tin', 'Y - Dược - Sức khỏe', 'Xã hội - Ngôn ngữ - Luật - Sư phạm']));
    if (wantsIncome) qs.push(incomeQuestion());
  } else if (stage === 'THPT_ON_THI_DAI_HOC') {
    if (target) qs.push(branchQuestion(target));
    qs.push(Q('Điểm thi tốt nghiệp THPT bạn dự kiến (tổng 3 môn)?', ['Trên 26 điểm', '23-26 điểm', '19-23 điểm', 'Dưới 19 điểm / chưa ước lượng được']));
    qs.push(Q('Bạn ưu tiên học ở đâu?', ['Hà Nội', 'TP.HCM', 'Đà Nẵng / miền Trung', 'Gần nhà, chi phí thấp']));
  } else if (['DAI_HOC_DAI_CUONG', 'DAI_HOC_CHUYEN_NGANH_THUC_TAP'].includes(stage)) {
    qs.push(Q('Điều bạn đang băn khoăn nhất lúc này?', ['Kết quả học tập (GPA)', 'Chọn chuyên ngành hẹp / hướng đi sau này', 'Thực tập và xin việc sau khi ra trường', 'Tài chính, đi làm thêm']));
    qs.push(Q('Kết quả học tập hiện tại (GPA hệ 4)?', ['Từ 3,2 trở lên', '2,5 - 3,2', 'Dưới 2,5', 'Chưa có điểm / năm nhất']));
    qs.push(wantsIncome ? incomeQuestion() : target ? branchQuestion(target, 'muốn đi sâu') : Q('Sau khi ra trường bạn muốn?', ['Đi làm ngay đúng ngành', 'Học tiếp thạc sĩ / du học', 'Làm trái ngành có thu nhập tốt', 'Khởi nghiệp / làm tự do']));
  } else if (stage === 'CHUYEN_NGANH_DI_LAM') {
    qs.push(Q('Bạn đã đi làm được bao lâu?', ['Dưới 1 năm', '1-3 năm', 'Trên 3 năm']));
    qs.push(Q('Bạn định chuyển hướng bằng cách nào?', ['Tự học / khóa ngắn hạn, vừa học vừa làm', 'Học văn bằng 2 hoặc liên thông', 'Nghỉ việc để học toàn thời gian', 'Chưa rõ, muốn so sánh']));
    qs.push(wantsIncome ? incomeQuestion() : target ? branchQuestion(target, 'muốn theo') : incomeQuestion());
  } else if (stage === 'DU_HOC_QUOC_TE') {
    qs.push(Q('Bạn dự định du học ở bậc nào?', ['Đại học', 'Thạc sĩ', 'Chương trình liên kết / chuyển tiếp']));
    qs.push(Q('Nguồn tài chính dự kiến?', ['Gia đình chi trả toàn bộ', 'Cần học bổng một phần', 'Cần học bổng toàn phần / vừa học vừa làm']));
    qs.push(Q('Trình độ ngoại ngữ hiện tại?', ['IELTS 6.5 trở lên (hoặc tương đương)', 'IELTS 5.5 - 6.0', 'Chưa có chứng chỉ']));
  } else if (stage === 'THAC_SI_NGHIEN_CUU') {
    qs.push(Q('Mục tiêu chính khi học sau đại học?', ['Nghiên cứu / giảng dạy đại học', 'Thăng tiến trong công việc hiện tại', 'Chuyển sang ngành khác']));
    qs.push(Q('Bạn định học theo hình thức nào?', ['Toàn thời gian trong nước', 'Vừa học vừa làm', 'Du học có học bổng']));
  } else if (stage === 'KHOI_NGHIEP_FREELANCE') {
    qs.push(Q('Bạn đang ở bước nào?', ['Mới có ý tưởng', 'Đã làm thử, có vài khách hàng', 'Đã có thu nhập đều từ việc này']));
    qs.push(Q('Vốn và nguồn lực hiện có?', ['Gần như chưa có vốn', 'Có ít vốn tự tích lũy', 'Có gia đình hoặc nhà đầu tư hỗ trợ']));
    if (wantsIncome) qs.push(incomeQuestion());
  } else {
    if (target) qs.push(branchQuestion(target));
    qs.push(Q('Mục tiêu quan trọng nhất với quyết định này?', ['Học đúng sở thích và năng lực', 'Ra trường dễ có việc', 'Thu nhập cao', 'Giảm áp lực tài chính cho gia đình']));
  }
  return qs.slice(0, 3);
};

module.exports = { buildClarificationQuestions, majorNames, detectDomains, detectDomain, toAscii, DOMAINS };
