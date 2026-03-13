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
    title: 'AI và mô hình',
    description: 'Cấu hình model, timeout và cảnh báo AI.',
    fields: [
      {
        key: 'primary_model',
        label: 'Mô hình chính',
        description: 'Model mặc định cho simulation và premium.',
        type: 'select',
        value: 'gemini-2.5-flash',
        options: ['gemini-2.5-flash'],
      },
      {
        key: 'timeout_seconds',
        label: 'Timeout Gemini (giây)',
        description: 'Ngưỡng timeout trước khi hệ thống đánh dấu failed.',
        type: 'number',
        value: 18,
      },
      {
        key: 'alerts_email',
        label: 'Email nhận cảnh báo',
        description: 'Hộp thư nhận alert khẩn cấp.',
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
