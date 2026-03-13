const express = require('express');

const AuditLog = require('../models/AuditLog');
const adminAuth = require('../middleware/adminAuth');
const requireRoles = require('../middleware/requireRoles');
const { formatDateTime } = require('../services/adminFormatters');

const router = express.Router();

router.get(
  '/',
  adminAuth,
  requireRoles('super_admin', 'ops_support', 'community_moderator', 'ai_operator'),
  async (req, res) => {
    try {
      const { page = 1, limit = 20, severity = 'all', q = '' } = req.query;
      const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

      const query = {};
      if (severity !== 'all') query.severity = severity;
      if (q) {
        query.$or = [
          { actor_email: { $regex: q, $options: 'i' } },
          { resource_name: { $regex: q, $options: 'i' } },
          { summary: { $regex: q, $options: 'i' } },
        ];
      }

      const [items, total] = await Promise.all([
        AuditLog.find(query).sort({ created_at: -1 }).skip(skip).limit(parseInt(limit, 10)),
        AuditLog.countDocuments(query),
      ]);

      res.json({
        items: items.map((item) => ({
          id: item._id.toString(),
          actor: item.actor_email,
          role: (item.actor_roles || []).join(', '),
          action: item.action,
          resourceType: item.resource_type,
          resourceId: item.resource_id,
          resourceName: item.resource_name,
          severity: item.severity,
          summary: item.summary,
          reason: item.reason,
          createdAt: formatDateTime(item.created_at),
        })),
        total,
        page: parseInt(page, 10),
        totalPages: Math.ceil(total / parseInt(limit, 10)),
      });
    } catch (error) {
      console.error('Admin audit logs error:', error);
      res.status(500).json({ message: 'Lỗi hệ thống khi lấy audit logs.' });
    }
  },
);

module.exports = router;
