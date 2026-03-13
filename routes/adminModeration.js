const express = require('express');

const ContentReport = require('../models/ContentReport');
const CommunityPost = require('../models/CommunityPost');
const CommunityComment = require('../models/CommunityComment');
const User = require('../models/User');
const adminAuth = require('../middleware/adminAuth');
const requireRoles = require('../middleware/requireRoles');
const { createAuditLog } = require('../services/auditService');
const { formatDateTime } = require('../services/adminFormatters');

const router = express.Router();

const serializeReport = (item) => ({
  id: item._id.toString(),
  type: item.target_type,
  targetId: item.target_id,
  targetTitle: item.target_title,
  authorName: item.author_name || 'Unknown',
  priority: item.priority,
  reason: item.reason,
  reportsCount: item.reports_count,
  status: item.status,
  createdAt: formatDateTime(item.created_at),
});

router.get('/reports', adminAuth, requireRoles('super_admin', 'community_moderator'), async (req, res) => {
  try {
    const reports = await ContentReport.find({}).sort({ created_at: -1 }).limit(100);
    if (reports.length > 0) {
      return res.json(reports.map(serializeReport));
    }

    const flaggedPosts = await CommunityPost.find({ status: 'flagged' }).sort({ created_at: -1 }).limit(50);
    const authors = await User.find({ _id: { $in: flaggedPosts.map((item) => item.user_id) } }).select('full_name');
    const authorMap = new Map(authors.map((item) => [item._id.toString(), item.full_name]));

    res.json(
      flaggedPosts.map((item) => ({
        id: `flagged-post-${item._id.toString()}`,
        type: 'post',
        targetId: item._id.toString(),
        targetTitle: item.title,
        authorName: authorMap.get(item.user_id?.toString()) || 'Unknown',
        priority: 'medium',
        reason: 'Nội dung đang ở trạng thái flagged và cần moderator review.',
        reportsCount: Math.max((item.flagged_by || []).length, 1),
        status: 'pending',
        createdAt: formatDateTime(item.created_at),
      })),
    );
  } catch (error) {
    console.error('Admin moderation reports error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi lấy moderation queue.' });
  }
});

router.post('/reports/:id/resolve', adminAuth, requireRoles('super_admin', 'community_moderator'), async (req, res) => {
  try {
    const report = await ContentReport.findById(req.params.id);
    if (!report) {
      return res.status(404).json({ message: 'Không tìm thấy content report.' });
    }

    const before = report.toObject();
    report.status = 'resolved';
    report.handled_by_id = req.admin.userId;
    report.handled_by_name = req.admin.email;
    report.handled_at = new Date();
    report.resolution = req.body.resolution || '';
    await report.save();

    if (req.body.resolutionAction && report.target_type === 'post') {
      const post = await CommunityPost.findById(report.target_id);
      if (post) {
        post.status = req.body.resolutionAction === 'published' ? 'active' : 'removed';
        await post.save();
      }
    }

    if (req.body.resolutionAction && report.target_type === 'comment') {
      await CommunityComment.findById(report.target_id);
    }

    await createAuditLog({
      actor: req.admin,
      action: 'resolve_content_report',
      resourceType: 'content_report',
      resourceId: report._id,
      resourceName: report.target_title,
      summary: 'Resolve mot content report trong moderation queue.',
      severity: 'warning',
      reason: req.body.reason || '',
      before,
      after: report.toObject(),
      req,
    });

    res.json(serializeReport(report));
  } catch (error) {
    console.error('Admin moderation resolve error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi resolve moderation report.' });
  }
});

module.exports = router;
