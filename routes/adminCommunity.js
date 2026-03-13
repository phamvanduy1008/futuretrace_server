const express = require('express');

const CommunityPost = require('../models/CommunityPost');
const CommunityComment = require('../models/CommunityComment');
const User = require('../models/User');
const SimulationScenario = require('../models/SimulationScenario');
const adminAuth = require('../middleware/adminAuth');
const requireRoles = require('../middleware/requireRoles');
const { createAuditLog } = require('../services/auditService');
const {
  buildExcerpt,
  formatDateTime,
  mapAdminStatusToCommunity,
  mapCommunityStatusToAdmin,
} = require('../services/adminFormatters');

const router = express.Router();

const serializePost = async (post) => {
  const author = await User.findById(post.user_id).select('full_name');

  return {
    id: post._id.toString(),
    authorId: post.user_id?.toString() || '',
    authorName: post.is_anonymous ? 'Người dùng ẩn danh' : author?.full_name || 'Unknown',
    title: post.title,
    excerpt: buildExcerpt(post.content),
    content: post.content,
    category: post.category,
    status: mapCommunityStatusToAdmin(post.status),
    anonymous: post.is_anonymous,
    likes: post.likes_count || 0,
    commentsCount: post.comments_count || 0,
    reliability: post.reliability || 0,
    createdAt: formatDateTime(post.created_at),
    sourceScenarioId: post.scenario_id ? post.scenario_id.toString() : '',
    type: post.type,
    careerGrowth: post.career_growth,
    happiness: post.happiness,
    roi: post.roi,
    deepAnalysis: post.deep_analysis || {},
  };
};

router.get('/posts', adminAuth, requireRoles('super_admin', 'ops_support', 'community_moderator'), async (req, res) => {
  try {
    const { page = 1, limit = 20, q = '', status = 'all', category = 'all' } = req.query;
    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const query = {};
    if (category !== 'all') query.category = category;
    if (status !== 'all') query.status = mapAdminStatusToCommunity(status);
    if (q) {
      query.$or = [
        { title: { $regex: q, $options: 'i' } },
        { content: { $regex: q, $options: 'i' } },
      ];
    }

    const [items, total] = await Promise.all([
      CommunityPost.find(query).sort({ created_at: -1 }).skip(skip).limit(parseInt(limit, 10)),
      CommunityPost.countDocuments(query),
    ]);

    const serialized = await Promise.all(items.map((item) => serializePost(item)));
    res.json({
      items: serialized,
      total,
      page: parseInt(page, 10),
      totalPages: Math.ceil(total / parseInt(limit, 10)),
    });
  } catch (error) {
    console.error('Admin community posts error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi lấy bài viết cộng đồng.' });
  }
});

router.get('/posts/:id', adminAuth, requireRoles('super_admin', 'ops_support', 'community_moderator'), async (req, res) => {
  try {
    const post = await CommunityPost.findById(req.params.id);
    if (!post) {
      return res.status(404).json({ message: 'Không tìm thấy bài viết cộng đồng.' });
    }

    const [serializedPost, comments, sourceScenario] = await Promise.all([
      serializePost(post),
      CommunityComment.find({ post_id: post._id }).sort({ created_at: -1 }).limit(50),
      post.scenario_id ? SimulationScenario.findById(post.scenario_id) : null,
    ]);

    const commentUsers = await User.find({ _id: { $in: comments.map((item) => item.user_id) } }).select('full_name');
    const commentUserMap = new Map(commentUsers.map((item) => [item._id.toString(), item.full_name]));

    res.json({
      post: serializedPost,
      comments: comments.map((item) => ({
        id: item._id.toString(),
        authorId: item.user_id?.toString() || '',
        authorName: commentUserMap.get(item.user_id?.toString()) || 'Unknown',
        content: item.content,
        likes: item.likes || 0,
        createdAt: formatDateTime(item.created_at),
      })),
      sourceScenario: sourceScenario
        ? {
          id: sourceScenario._id.toString(),
          title: sourceScenario.title,
          description: sourceScenario.description,
          type: sourceScenario.scenario_type,
        }
        : null,
    });
  } catch (error) {
    console.error('Admin community post detail error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi lấy chi tiết bài viết cộng đồng.' });
  }
});

router.put('/posts/:id/status', adminAuth, requireRoles('super_admin', 'community_moderator'), async (req, res) => {
  try {
    const { status, reason = '' } = req.body;
    const mappedStatus = mapAdminStatusToCommunity(status);
    if (!['active', 'flagged', 'removed'].includes(mappedStatus)) {
      return res.status(400).json({ message: 'Status moderation bài viết không hợp lệ.' });
    }

    const post = await CommunityPost.findById(req.params.id);
    if (!post) {
      return res.status(404).json({ message: 'Không tìm thấy bài viết cộng đồng.' });
    }

    const before = post.toObject();
    post.status = mappedStatus;
    await post.save();

    await createAuditLog({
      actor: req.admin,
      action: 'update_community_post_status',
      resourceType: 'community_post',
      resourceId: post._id,
      resourceName: post.title,
      summary: `Cập nhật trạng thái bài viết thành ${mappedStatus}.`,
      severity: mappedStatus === 'removed' ? 'critical' : 'warning',
      reason,
      before,
      after: post.toObject(),
      req,
    });

    res.json(await serializePost(post));
  } catch (error) {
    console.error('Admin update post status error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi cập nhật status bài viết.' });
  }
});

module.exports = router;
