const promptTemplates = [
  {
    name: 'Simulation Decision Template',
    type: 'simulation',
    version: 'v2.5',
    status: 'active',
    summary: 'Prompt chính cho mô phỏng quyết định người dùng.',
    content:
      'Phân tích quyết định dựa trên bối cảnh hiện tại, tạo 3 kịch bản và cân bằng logic giữa áp lực, tài chính, năng lực và rủi ro.',
    release_notes: 'Đồng bộ với runtime Gemini 2.5 flash.',
  },
  {
    name: 'Premium Narrative Generator',
    type: 'premium',
    version: 'v1.0',
    status: 'draft',
    summary: 'Prompt tạo premium analysis và roadmap milestones.',
    content:
      'Tạo báo cáo roadmap chi tiết, ưu tiên milestone thực thi, influencing factors, pivot points và projection 3-5 năm.',
    release_notes: 'Bản nhập đầu tiên cho admin review.',
  },
  {
    name: 'Pivot Re-planning Template',
    type: 'pivot',
    version: 'v1.0',
    status: 'rollback_ready',
    summary: 'Prompt tái hoạch định sau feedback người dùng.',
    content:
      'Giữ các milestone đã hoàn thành, tái sinh phần còn lại dựa trên feedback, khó khăn và thay đổi bối cảnh.',
    release_notes: 'Sẵn sàng rollback nếu output regression.',
  },
];

const systemSettings = [
  {
    group_key: 'core',
    title: 'Vận hành lõi',
    description: 'Cấu hình ảnh hưởng trực tiếp đến flow mô phỏng và premium.',
    fields: [
      {
        key: 'simulation_enabled',
        label: 'Cho phép chạy mô phỏng',
        description: 'Bật hoặc tắt flow tạo simulation mới.',
        type: 'toggle',
        value: true,
      },
      {
        key: 'premium_enabled',
        label: 'Cho phép tạo phân tích premium',
        description: 'Khóa hoặc mở premium analysis.',
        type: 'toggle',
        value: true,
      },
      {
        key: 'max_timeframe_months',
        label: 'Thời gian tối đa (tháng)',
        description: 'Ngưỡng tối đa cho timeframe premium.',
        type: 'number',
        value: 60,
      },
    ],
  },
  {
    group_key: 'community',
    title: 'Cộng đồng',
    description: 'Quản lý hiển thị và ngưỡng moderation.',
    fields: [
      {
        key: 'anonymous_posting',
        label: 'Cho phép đăng ẩn danh',
        description: 'Cho phép người dùng đăng bài ẩn danh.',
        type: 'toggle',
        value: true,
      },
      {
        key: 'review_threshold',
        label: 'Ngưỡng chuyển sang review',
        description: 'Số report để nội dung vào review queue.',
        type: 'number',
        value: 3,
      },
      {
        key: 'default_category',
        label: 'Danh mục mặc định',
        description: 'Danh mục gợi ý khi người dùng chưa chọn category.',
        type: 'select',
        value: 'Su nghiep',
        options: ['Sự nghiệp', 'Tài chính', 'Giáo dục', 'Kinh doanh'],
      },
    ],
  },
  {
    group_key: 'ai',
    title: 'Động cơ AI & Mô hình suy luận',
    description: 'Điều phối đa tầng: Local Fine-tuned LLM (Ollama), Hybrid Runtime và Cloud Fallback.',
    fields: [
      {
        key: 'ai_provider',
        label: 'Chế độ động cơ AI (Engine Provider)',
        description: 'Cơ chế điều phối: Hybrid (Ưu tiên Local model, tự động dự phòng Cloud), Local Only (Ollama), hoặc Cloud API (Gemini).',
        type: 'select',
        value: process.env.AI_PROVIDER || 'hybrid',
        options: ['hybrid', 'ollama', 'gemini'],
      },
      {
        key: 'local_model',
        label: 'Mô hình Local chính (Fine-tuned)',
        description: 'Mô hình Ollama được huấn luyện chuyên sâu theo tri thức giáo dục & thị trường lao động FutureTrace.',
        type: 'text',
        value: process.env.OLLAMA_MODEL || 'futuretrace-ai',
      },
      {
        key: 'ollama_endpoint',
        label: 'Endpoint máy chủ Ollama',
        description: 'Địa chỉ cổng kết nối Local LLM Runtime nội bộ.',
        type: 'text',
        value: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
      },
      {
        key: 'cloud_fallback_model',
        label: 'Mô hình Cloud dự phòng (Fallback)',
        description: 'Mô hình đám mây tốc độ cao được kích hoạt khi Local LLM quá tải, timeout hoặc gặp sự cố ngoại lệ.',
        type: 'select',
        value: 'gemini-2.5-flash',
        options: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.1-flash-lite'],
      },
      {
        key: 'timeout_seconds',
        label: 'Ngưỡng Timeout suy luận (giây)',
        description: 'Thời gian chờ tối đa cho mỗi lượt suy luận trước khi kích hoạt cơ chế Fallback hoặc cảnh báo.',
        type: 'number',
        value: 25,
      },
      {
        key: 'alerts_email',
        label: 'Email nhận cảnh báo AI Runtime',
        description: 'Hộp thư tiếp nhận thông báo khi máy chủ Local AI offline hoặc vượt ngưỡng lỗi runtime.',
        type: 'text',
        value: 'ops@futuretrace.vn',
      },
    ],
  },
];

module.exports = {
  promptTemplates,
  systemSettings,
};
