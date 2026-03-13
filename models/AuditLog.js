const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    actor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    actor_email: { type: String, required: true },
    actor_roles: { type: [String], default: [] },
    action: { type: String, required: true },
    resource_type: { type: String, required: true },
    resource_id: { type: String, required: true },
    resource_name: { type: String, default: '' },
    severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'info' },
    summary: { type: String, default: '' },
    reason: { type: String, default: '' },
    before: { type: mongoose.Schema.Types.Mixed },
    after: { type: mongoose.Schema.Types.Mixed },
    ip: { type: String, default: '' },
    user_agent: { type: String, default: '' },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: false },
    collection: 'audit_logs',
  },
);

auditLogSchema.index({ created_at: -1 });
auditLogSchema.index({ actor_id: 1, created_at: -1 });
auditLogSchema.index({ resource_type: 1, resource_id: 1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
