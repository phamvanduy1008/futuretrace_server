const User = require('../models/User');

/**
 * Chặn các tác vụ AI (xử lý dữ liệu học lực, tài chính, áp lực tâm lý) khi người dùng chưa đồng ý
 * chính sách xử lý dữ liệu cá nhân (Luật BVDLCN 2025). Frontend hiển thị ConsentGate khi nhận CONSENT_REQUIRED.
 */
const requireConsent = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.userId).select('consent').lean();
    if (!user?.consent?.accepted_at) {
      return res.status(403).json({
        message: 'Bạn cần đồng ý chính sách xử lý dữ liệu cá nhân trước khi dùng tính năng phân tích AI.',
        code: 'CONSENT_REQUIRED'
      });
    }
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = requireConsent;
