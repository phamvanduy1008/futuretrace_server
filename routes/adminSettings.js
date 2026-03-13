const express = require('express');

const SystemSetting = require('../models/SystemSetting');
const adminAuth = require('../middleware/adminAuth');
const requireRoles = require('../middleware/requireRoles');
const { createAuditLog } = require('../services/auditService');
const { systemSettings: defaultSystemSettings } = require('../services/adminDefaults');
const { formatDateTime } = require('../services/adminFormatters');

const router = express.Router();

const serializeSettingGroup = (group) => ({
  id: group._id.toString(),
  groupKey: group.group_key,
  title: group.title,
  description: group.description,
  updatedAt: formatDateTime(group.updated_at || group.created_at),
  updatedBy: group.updated_by_name || '',
  fields: group.fields,
});

const ensureDefaults = async () => {
  const count = await SystemSetting.countDocuments();
  if (count > 0) return;

  await SystemSetting.insertMany(defaultSystemSettings);
};

router.get('/', adminAuth, requireRoles('super_admin', 'ops_support', 'ai_operator'), async (req, res) => {
  try {
    await ensureDefaults();
    const items = await SystemSetting.find({}).sort({ group_key: 1 });
    res.json(items.map(serializeSettingGroup));
  } catch (error) {
    console.error('Admin get settings error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi lấy system settings.' });
  }
});

router.put('/:groupKey', adminAuth, requireRoles('super_admin', 'ops_support', 'ai_operator'), async (req, res) => {
  try {
    const group = await SystemSetting.findOne({ group_key: req.params.groupKey });
    if (!group) {
      return res.status(404).json({ message: 'Không tìm thấy nhóm cài đặt.' });
    }

    const before = group.toObject();
    if (req.body.title !== undefined) group.title = req.body.title;
    if (req.body.description !== undefined) group.description = req.body.description;
    if (Array.isArray(req.body.fields)) group.fields = req.body.fields;
    group.updated_by_id = req.admin.userId;
    group.updated_by_name = req.admin.email;
    await group.save();

    await createAuditLog({
      actor: req.admin,
      action: 'update_system_setting_group',
      resourceType: 'system_setting',
      resourceId: group._id,
      resourceName: group.group_key,
      summary: 'Cap nhat mot nhom system settings trong admin.',
      severity: 'warning',
      reason: req.body.reason || '',
      before,
      after: group.toObject(),
      req,
    });

    res.json(serializeSettingGroup(group));
  } catch (error) {
    console.error('Admin update settings error:', error);
    res.status(500).json({ message: 'Loi he thong khi cap nhat system settings.' });
  }
});

module.exports = router;
