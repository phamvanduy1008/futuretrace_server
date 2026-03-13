const express = require('express');

const PromptTemplate = require('../models/PromptTemplate');
const adminAuth = require('../middleware/adminAuth');
const requireRoles = require('../middleware/requireRoles');
const { createAuditLog } = require('../services/auditService');
const { promptTemplates: defaultPromptTemplates } = require('../services/adminDefaults');
const { formatDateTime } = require('../services/adminFormatters');

const router = express.Router();

const serializePrompt = (item) => ({
  id: item._id.toString(),
  name: item.name,
  type: item.type,
  version: item.version,
  status: item.status,
  updatedAt: formatDateTime(item.updated_at || item.created_at),
  owner: item.owner_name || '',
  summary: item.summary,
  content: item.content,
  releaseNotes: item.release_notes || '',
});

const ensureDefaults = async () => {
  const count = await PromptTemplate.countDocuments();
  if (count > 0) return;

  await PromptTemplate.insertMany(defaultPromptTemplates);
};

router.get('/', adminAuth, requireRoles('super_admin', 'ops_support', 'ai_operator'), async (req, res) => {
  try {
    await ensureDefaults();

    const { type = 'all', status = 'all' } = req.query;
    const query = {};
    if (type !== 'all') query.type = type;
    if (status !== 'all') query.status = status;

    const items = await PromptTemplate.find(query).sort({ updated_at: -1, created_at: -1 });
    res.json(items.map(serializePrompt));
  } catch (error) {
    console.error('Admin get prompts error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi lấy prompt templates.' });
  }
});

router.post('/', adminAuth, requireRoles('super_admin', 'ai_operator'), async (req, res) => {
  try {
    const { name, type, version, status = 'draft', summary = '', content, releaseNotes = '' } = req.body;

    if (!name || !type || !version || !content) {
      return res.status(400).json({ message: 'name, type, version và content là bắt buộc.' });
    }

    const prompt = await PromptTemplate.create({
      name,
      type,
      version,
      status,
      owner_id: req.admin.userId,
      owner_name: req.admin.email,
      summary,
      content,
      release_notes: releaseNotes,
    });

    await createAuditLog({
      actor: req.admin,
      action: 'create_prompt_template',
      resourceType: 'prompt_template',
      resourceId: prompt._id,
      resourceName: `${prompt.name} ${prompt.version}`,
      summary: 'Tạo prompt template mới cho admin.',
      severity: 'info',
      reason: req.body.reason || '',
      after: prompt.toObject(),
      req,
    });

    res.status(201).json(serializePrompt(prompt));
  } catch (error) {
    console.error('Admin create prompt error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi tạo prompt template.' });
  }
});

router.put('/:id', adminAuth, requireRoles('super_admin', 'ai_operator'), async (req, res) => {
  try {
    const prompt = await PromptTemplate.findById(req.params.id);
    if (!prompt) {
      return res.status(404).json({ message: 'Khong tim thay prompt template.' });
    }

    const before = prompt.toObject();

    const editableFields = ['name', 'type', 'version', 'status', 'summary', 'content', 'release_notes'];
    editableFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        prompt[field] = req.body[field];
      }
    });
    if (req.body.releaseNotes !== undefined) {
      prompt.release_notes = req.body.releaseNotes;
    }
    prompt.owner_id = req.admin.userId;
    prompt.owner_name = req.admin.email;

    await prompt.save();

    await createAuditLog({
      actor: req.admin,
      action: 'update_prompt_template',
      resourceType: 'prompt_template',
      resourceId: prompt._id,
      resourceName: `${prompt.name} ${prompt.version}`,
      summary: 'Cập nhật prompt template.',
      severity: 'warning',
      reason: req.body.reason || '',
      before,
      after: prompt.toObject(),
      req,
    });

    res.json(serializePrompt(prompt));
  } catch (error) {
    console.error('Admin update prompt error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi cập nhật prompt template.' });
  }
});

router.post('/:id/release', adminAuth, requireRoles('super_admin', 'ai_operator'), async (req, res) => {
  try {
    const prompt = await PromptTemplate.findById(req.params.id);
    if (!prompt) {
      return res.status(404).json({ message: 'Không tìm thấy prompt template.' });
    }

    const before = prompt.toObject();
    await PromptTemplate.updateMany(
      { type: prompt.type, _id: { $ne: prompt._id }, status: 'active' },
      { status: 'archived' },
    );

    prompt.status = 'active';
    prompt.released_at = new Date();
    prompt.owner_id = req.admin.userId;
    prompt.owner_name = req.admin.email;
    await prompt.save();

    await createAuditLog({
      actor: req.admin,
      action: 'release_prompt_template',
      resourceType: 'prompt_template',
      resourceId: prompt._id,
      resourceName: `${prompt.name} ${prompt.version}`,
      summary: 'Phát hành prompt template cho admin runtime.',
      severity: 'critical',
      reason: req.body.reason || '',
      before,
      after: prompt.toObject(),
      req,
    });

    res.json(serializePrompt(prompt));
  } catch (error) {
    console.error('Admin release prompt error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi phát hành prompt template.' });
  }
});

router.post('/:id/rollback', adminAuth, requireRoles('super_admin', 'ai_operator'), async (req, res) => {
  try {
    const prompt = await PromptTemplate.findById(req.params.id);
    if (!prompt) {
      return res.status(404).json({ message: 'Không tìm thấy prompt template.' });
    }

    const previous = await PromptTemplate.findOne({
      type: prompt.type,
      _id: { $ne: prompt._id },
    }).sort({ updated_at: -1, created_at: -1 });

    if (!previous) {
      return res.status(400).json({ message: 'Không có prompt trước đó để rollback.' });
    }

    const before = previous.toObject();

    await PromptTemplate.updateMany({ type: prompt.type, status: 'active' }, { status: 'archived' });
    previous.status = 'active';
    previous.rolled_back_from_id = prompt._id;
    previous.owner_id = req.admin.userId;
    previous.owner_name = req.admin.email;
    previous.released_at = new Date();
    await previous.save();

    await createAuditLog({
      actor: req.admin,
      action: 'rollback_prompt_template',
      resourceType: 'prompt_template',
      resourceId: previous._id,
      resourceName: `${previous.name} ${previous.version}`,
      summary: 'Rollback prompt template về phiên bản trước.',
      severity: 'critical',
      reason: req.body.reason || '',
      before,
      after: previous.toObject(),
      req,
    });

    res.json(serializePrompt(previous));
  } catch (error) {
    console.error('Admin rollback prompt error:', error);
    res.status(500).json({ message: 'Loi he thong khi rollback prompt template.' });
  }
});

module.exports = router;
