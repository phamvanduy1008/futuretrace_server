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
  if (count === 0) {
    await SystemSetting.insertMany(defaultSystemSettings);
    return;
  }

  // Tự động kiểm tra và nâng cấp nhóm 'ai' nếu đang dùng cấu trúc cũ chỉ có gemini
  const aiDefault = defaultSystemSettings.find((g) => g.group_key === 'ai');
  if (aiDefault) {
    const aiGroup = await SystemSetting.findOne({ group_key: 'ai' });
    if (!aiGroup) {
      await SystemSetting.create(aiDefault);
    } else {
      const hasAiProvider = Array.isArray(aiGroup.fields) && aiGroup.fields.some((f) => f.key === 'ai_provider');
      if (!hasAiProvider) {
        console.log('[SystemSettings] 🚀 Phát hiện cấu hình AI cũ (chỉ có Gemini). Đang nâng cấp sang mô hình Local Ollama (futuretrace-ai) + Hybrid Fallback...');
        aiGroup.title = aiDefault.title;
        aiGroup.description = aiDefault.description;
        aiGroup.fields = aiDefault.fields;
        await aiGroup.save();
        console.log('[SystemSettings] ✅ Đã nâng cấp thành công nhóm cài đặt AI trong MongoDB.');
      }
    }
  }
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
    if (Array.isArray(req.body.fields)) {
      group.fields = req.body.fields;

      // Đồng bộ runtime nếu nhóm cài đặt là 'ai'
      if (group.group_key === 'ai') {
        const providerField = req.body.fields.find((f) => f.key === 'ai_provider');
        if (providerField && providerField.value) {
          try {
            const { setAiProvider } = require('../services/aiProviderConfig');
            setAiProvider(providerField.value);
          } catch (syncErr) {
            console.warn('[Settings] Cảnh báo đồng bộ AI Provider:', syncErr.message);
          }
        }

        const localModelField = req.body.fields.find((f) => f.key === 'local_model');
        if (localModelField && localModelField.value) {
          process.env.OLLAMA_MODEL = String(localModelField.value).trim();
        }

        const endpointField = req.body.fields.find((f) => f.key === 'ollama_endpoint');
        if (endpointField && endpointField.value) {
          process.env.OLLAMA_BASE_URL = String(endpointField.value).trim();
        }
      }
    }

    group.updated_by_id = req.admin.userId;
    group.updated_by_name = req.admin.email;
    await group.save();

    await createAuditLog({
      actor: req.admin,
      action: 'update_system_setting_group',
      resourceType: 'system_setting',
      resourceId: group._id,
      resourceName: group.group_key,
      summary: `Cập nhật nhóm cài đặt: ${group.title} (${group.group_key})`,
      severity: 'warning',
      reason: req.body.reason || '',
      before,
      after: group.toObject(),
      req,
    });

    res.json(serializeSettingGroup(group));
  } catch (error) {
    console.error('Admin update settings error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi cập nhật system settings: ' + error.message });
  }
});

module.exports = router;
