const AuditLog = require('../models/AuditLog');

const createAuditLog = async ({
  actor,
  action,
  resourceType,
  resourceId,
  resourceName = '',
  severity = 'info',
  summary = '',
  reason = '',
  before = null,
  after = null,
  req = null,
}) => {
  if (!actor?.userId) {
    return null;
  }

  return AuditLog.create({
    actor_id: actor.userId,
    actor_email: actor.email || '',
    actor_roles: actor.roles || [],
    action,
    resource_type: resourceType,
    resource_id: String(resourceId),
    resource_name: resourceName,
    severity,
    summary,
    reason,
    before,
    after,
    ip: req?.ip || '',
    user_agent: req?.headers?.['user-agent'] || '',
  });
};

module.exports = {
  createAuditLog,
};
