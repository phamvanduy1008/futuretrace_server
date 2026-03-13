const mongoose = require('mongoose');

const contentReportSchema = new mongoose.Schema(
  {
    target_type: { type: String, enum: ['post', 'comment'], required: true },
    target_id: { type: String, required: true },
    target_title: { type: String, default: '' },
    author_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    author_name: { type: String, default: '' },
    reporter_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reason: { type: String, required: true },
    priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
    reports_count: { type: Number, default: 1 },
    status: { type: String, enum: ['pending', 'escalated', 'resolved'], default: 'pending' },
    handled_by_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    handled_by_name: { type: String, default: '' },
    handled_at: { type: Date },
    resolution: { type: String, default: '' },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'content_reports',
  },
);

contentReportSchema.index({ status: 1, created_at: -1 });
contentReportSchema.index({ target_type: 1, target_id: 1 });

module.exports = mongoose.model('ContentReport', contentReportSchema);
