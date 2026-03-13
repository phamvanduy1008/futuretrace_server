const express = require('express');

const adminAuthRoutes = require('./adminAuth');
const adminDashboardRoutes = require('./adminDashboard');
const adminUsersRoutes = require('./adminUsers');
const adminSimulationsRoutes = require('./adminSimulations');
const adminPremiumRoutes = require('./adminPremium');
const adminCommunityRoutes = require('./adminCommunity');
const adminModerationRoutes = require('./adminModeration');
const adminAIRoutes = require('./adminAI');
const adminPromptRoutes = require('./adminPrompts');
const adminSettingsRoutes = require('./adminSettings');
const adminAuditRoutes = require('./adminAudit');

const router = express.Router();

router.use('/auth', adminAuthRoutes);
router.use('/dashboard', adminDashboardRoutes);
router.use('/users', adminUsersRoutes);
router.use('/simulations', adminSimulationsRoutes);
router.use('/premium-analyses', adminPremiumRoutes);
router.use('/community', adminCommunityRoutes);
router.use('/moderation', adminModerationRoutes);
router.use('/ai/logs', adminAIRoutes);
router.use('/prompts', adminPromptRoutes);
router.use('/settings', adminSettingsRoutes);
router.use('/audit-logs', adminAuditRoutes);

module.exports = router;
