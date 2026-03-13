const express = require('express');

const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const Simulation = require('../models/Simulation');
const PremiumAnalysis = require('../models/PremiumAnalysis');
const CommunityPost = require('../models/CommunityPost');
const adminAuth = require('../middleware/adminAuth');
const requireRoles = require('../middleware/requireRoles');
const { createAuditLog } = require('../services/auditService');
const { formatDate, formatDateTime, getPrimaryRole } = require('../services/adminFormatters');

const router = express.Router();

const serializeUser = async (user) => {
  const [simulationsCount, premiumCount, communityCount, sessionCount] = await Promise.all([
    Simulation.countDocuments({ user_id: user._id }),
    PremiumAnalysis.countDocuments({ user_id: user._id }),
    CommunityPost.countDocuments({ user_id: user._id }),
    RefreshToken.countDocuments({ user_id: user._id }),
  ]);

  return {
    id: user._id.toString(),
    name: user.full_name,
    email: user.email,
    avatar: (user.full_name || 'U')
      .split(' ')
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase(),
    role: getPrimaryRole(user.roles),
    roles: user.roles,
    tier: user.tier,
    status: user.status,
    location: user.location || '',
    joinedAt: formatDate(user.created_at),
    lastLoginAt: formatDateTime(user.last_login),
    simulationsCount,
    premiumCount,
    communityCount,
    sessionCount,
    bio: user.bio || '',
  };
};

router.get('/', adminAuth, requireRoles('super_admin', 'ops_support'), async (req, res) => {
  try {
    const { page = 1, limit = 20, q = '', role = 'all', status = 'all', tier = 'all' } = req.query;
    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const query = {};
    if (status !== 'all') query.status = status;
    if (tier !== 'all') query.tier = tier;
    if (role !== 'all') query.roles = role;
    if (q) {
      query.$or = [
        { email: { $regex: q, $options: 'i' } },
        { full_name: { $regex: q, $options: 'i' } },
      ];
    }

    const [users, total] = await Promise.all([
      User.find(query).sort({ created_at: -1 }).skip(skip).limit(parseInt(limit, 10)),
      User.countDocuments(query),
    ]);

    const items = await Promise.all(users.map((user) => serializeUser(user)));
    res.json({
      items,
      total,
      page: parseInt(page, 10),
      totalPages: Math.ceil(total / parseInt(limit, 10)),
    });
  } catch (error) {
    console.error('Admin users list error:', error);
    res.status(500).json({ message: 'Loi he thong khi lay danh sach users.' });
  }
});

router.get('/:id', adminAuth, requireRoles('super_admin', 'ops_support'), async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'Khong tim thay user.' });
    }

    const [summary, recentSimulations, analyses, posts, sessions] = await Promise.all([
      serializeUser(user),
      Simulation.find({ user_id: user._id }).sort({ created_at: -1 }).limit(5),
      PremiumAnalysis.find({ user_id: user._id }).sort({ updated_at: -1, created_at: -1 }).limit(5),
      CommunityPost.find({ user_id: user._id }).sort({ created_at: -1 }).limit(5),
      RefreshToken.find({ user_id: user._id }).sort({ created_at: -1 }).limit(10),
    ]);

    res.json({
      user: summary,
      simulations: recentSimulations.map((item) => ({
        id: item._id.toString(),
        title: item.title,
        status: item.status === 'processing' ? 'running' : item.status,
        createdAt: formatDateTime(item.created_at),
      })),
      premiumAnalyses: analyses.map((item) => {
        const totalMilestones = item.report?.milestones?.length || 0;
        const completed = item.completed_milestones?.length || 0;
        return {
          id: item._id.toString(),
          title: item.title,
          completionRate: totalMilestones > 0 ? Math.round((completed / totalMilestones) * 100) : 0,
          updatedAt: formatDateTime(item.updated_at || item.created_at),
        };
      }),
      posts: posts.map((item) => ({
        id: item._id.toString(),
        title: item.title,
        status: item.status,
        createdAt: formatDateTime(item.created_at),
      })),
      sessions: sessions.map((item) => ({
        id: item._id.toString(),
        audience: item.audience,
        createdAt: formatDateTime(item.created_at),
        expiresAt: formatDateTime(item.expires_at),
        ipAddress: item.ip_address || '',
        userAgent: item.user_agent || '',
      })),
    });
  } catch (error) {
    console.error('Admin user detail error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi lấy chi tiết user.' });
  }
});

router.get('/:id/sessions', adminAuth, requireRoles('super_admin', 'ops_support'), async (req, res) => {
  try {
    const sessions = await RefreshToken.find({ user_id: req.params.id }).sort({ created_at: -1 });
    res.json(
      sessions.map((item) => ({
        id: item._id.toString(),
        audience: item.audience,
        createdAt: formatDateTime(item.created_at),
        expiresAt: formatDateTime(item.expires_at),
        ipAddress: item.ip_address || '',
        userAgent: item.user_agent || '',
      })),
    );
  } catch (error) {
    console.error('Admin user sessions error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi lấy sessions user.' });
  }
});

router.put('/:id/status', adminAuth, requireRoles('super_admin', 'ops_support'), async (req, res) => {
  try {
    const { status, reason = '' } = req.body;
    if (!['active', 'locked', 'banned'].includes(status)) {
      return res.status(400).json({ message: 'Status user không hợp lệ.' });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'Khong tim thay user.' });
    }

    const before = user.toObject();
    user.status = status;
    if (status === 'active') {
      user.failed_login_attempts = 0;
    }
    await user.save();

    await createAuditLog({
      actor: req.admin,
      action: 'update_user_status',
      resourceType: 'user',
      resourceId: user._id,
      resourceName: user.full_name,
      summary: `Cập nhật trạng thái user thành ${status}.`,
      severity: status === 'active' ? 'info' : 'warning',
      reason,
      before,
      after: user.toObject(),
      req,
    });

    res.json(await serializeUser(user));
  } catch (error) {
    console.error('Admin update user status error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi cập nhật status user.' });
  }
});

router.put('/:id/roles', adminAuth, requireRoles('super_admin'), async (req, res) => {
  try {
    const { roles, reason = '' } = req.body;
    if (!Array.isArray(roles) || roles.length === 0) {
      return res.status(400).json({ message: 'roles phải là một mảng có giá trị.' });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'Khong tim thay user.' });
    }

    const before = user.toObject();
    user.roles = [...new Set(roles)];
    await user.save();

    await createAuditLog({
      actor: req.admin,
      action: 'update_user_roles',
      resourceType: 'user',
      resourceId: user._id,
      resourceName: user.full_name,
      summary: 'Cập nhật roles cho user.',
      severity: 'critical',
      reason,
      before,
      after: user.toObject(),
      req,
    });

    res.json(await serializeUser(user));
  } catch (error) {
    console.error('Admin update user roles error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi cập nhật roles user.' });
  }
});

router.post('/:id/sessions/revoke-all', adminAuth, requireRoles('super_admin', 'ops_support'), async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'Khong tim thay user.' });
    }

    const deleted = await RefreshToken.deleteMany({ user_id: user._id });

    await createAuditLog({
      actor: req.admin,
      action: 'revoke_user_sessions',
      resourceType: 'user',
      resourceId: user._id,
      resourceName: user.full_name,
      summary: `Thu hoi ${deleted.deletedCount || 0} session cua user.`,
      severity: 'warning',
      reason: req.body.reason || '',
      req,
    });

    res.json({ message: 'Da thu hoi toan bo session cua user.', deletedCount: deleted.deletedCount || 0 });
  } catch (error) {
    console.error('Admin revoke user sessions error:', error);
    res.status(500).json({ message: 'Loi he thong khi thu hoi sessions user.' });
  }
});

module.exports = router;
