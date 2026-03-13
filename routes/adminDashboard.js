const express = require('express');

const User = require('../models/User');
const Simulation = require('../models/Simulation');
const PremiumAnalysis = require('../models/PremiumAnalysis');
const CommunityPost = require('../models/CommunityPost');
const GeminiLog = require('../models/GeminiLog');
const AuditLog = require('../models/AuditLog');
const ContentReport = require('../models/ContentReport');
const adminAuth = require('../middleware/adminAuth');
const requireRoles = require('../middleware/requireRoles');
const {
  formatDateTime,
  mapCommunityStatusToAdmin,
  mapSimulationStatus,
} = require('../services/adminFormatters');

const router = express.Router();

router.get(
  '/overview',
  adminAuth,
  requireRoles('super_admin', 'ops_support', 'community_moderator', 'ai_operator'),
  async (req, res) => {
    try {
      const [
        totalUsers,
        activeUsers,
        simulations,
        premiumAnalyses,
        communityPosts,
        aiLogs,
        auditLogs,
        reports,
      ] = await Promise.all([
        User.countDocuments(),
        User.countDocuments({ status: 'active' }),
        Simulation.find({}).sort({ created_at: -1 }).limit(10),
        PremiumAnalysis.find({}).sort({ updated_at: -1, created_at: -1 }).limit(10),
        CommunityPost.find({}).sort({ created_at: -1 }).limit(10),
        GeminiLog.find({}).sort({ created_at: -1 }).limit(30),
        AuditLog.find({}).sort({ created_at: -1 }).limit(5),
        ContentReport.find({ status: { $in: ['pending', 'escalated'] } }).sort({ created_at: -1 }).limit(10),
      ]);

      const failedSimulations = simulations.filter((item) => item.status === 'failed').length;
      const totalSimulations = await Simulation.countDocuments();
      const totalPremiumAnalyses = await PremiumAnalysis.countDocuments();
      const totalCommunityPosts = await CommunityPost.countDocuments();
      const flaggedCommunityPosts = await CommunityPost.countDocuments({ status: 'flagged' });
      const aiSuccess = aiLogs.filter((item) => item.status === 'success').length;
      const aiFailed = aiLogs.filter((item) => item.status === 'error').length;

      const alerts = [];
      if (failedSimulations > 0) {
        alerts.push({
          id: 'simulation-failure',
          title: 'Có simulation thất bại cần xử lý',
          description: `${failedSimulations} simulation thất bại trong tập dữ liệu gần nhất.`,
          severity: 'critical',
          createdAt: formatDateTime(new Date()),
        });
      }
      if (flaggedCommunityPosts > 0 || reports.length > 0) {
        alerts.push({
          id: 'moderation-backlog',
          title: 'Hàng đợi moderation đang có backlog',
          description: `${Math.max(flaggedCommunityPosts, reports.length)} nội dung cần review.`,
          severity: 'warning',
          createdAt: formatDateTime(new Date()),
        });
      }
      if (aiLogs.length > 0) {
        alerts.push({
          id: 'ai-health',
          title: 'Trạng thái AI runtime',
          description: `${aiSuccess} success / ${aiFailed} failed trong tập log gần nhất.`,
          severity: aiFailed > 0 ? 'warning' : 'info',
          createdAt: formatDateTime(new Date()),
        });
      }

      res.json({
        stats: {
          totalUsers,
          activeUsers,
          totalSimulations,
          failedSimulations,
          totalPremiumAnalyses,
          activePremiumAnalyses: await PremiumAnalysis.countDocuments(),
          totalCommunityPosts,
          communityNeedsReview: flaggedCommunityPosts,
          aiSuccess,
          aiFailed,
        },
        alerts,
        watchlists: {
          simulations: simulations.slice(0, 3).map((item) => ({
            id: item._id.toString(),
            title: item.title,
            status: mapSimulationStatus(item.status),
          })),
          premiumAnalyses: premiumAnalyses.slice(0, 3).map((item) => {
            const totalMilestones = item.report?.milestones?.length || 0;
            const completed = item.completed_milestones?.length || 0;
            return {
              id: item._id.toString(),
              title: item.title,
              completionRate: totalMilestones > 0 ? Math.round((completed / totalMilestones) * 100) : 0,
            };
          }),
          auditLogs: auditLogs.map((item) => ({
            id: item._id.toString(),
            action: item.action,
            actor: item.actor_email,
          })),
          communityReview: communityPosts
            .filter((item) => item.status === 'flagged')
            .slice(0, 3)
            .map((item) => ({
              id: item._id.toString(),
              title: item.title,
              status: mapCommunityStatusToAdmin(item.status),
            })),
        },
      });
    } catch (error) {
      console.error('Admin dashboard error:', error);
      res.status(500).json({ message: 'Lỗi hệ thống khi lấy dashboard admin.' });
    }
  },
);

module.exports = router;
