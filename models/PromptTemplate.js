const mongoose = require('mongoose');

const promptTemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ['simulation', 'premium', 'pivot'], required: true },
    version: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ['draft', 'active', 'archived', 'rollback_ready'],
      default: 'draft',
    },
    owner_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    owner_name: { type: String, default: '' },
    summary: { type: String, default: '' },
    content: { type: String, required: true },
    release_notes: { type: String, default: '' },
    released_at: { type: Date },
    rolled_back_from_id: { type: mongoose.Schema.Types.ObjectId, ref: 'PromptTemplate' },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'prompt_templates',
  },
);

promptTemplateSchema.index({ type: 1, updated_at: -1 });
promptTemplateSchema.index({ status: 1, updated_at: -1 });

module.exports = mongoose.model('PromptTemplate', promptTemplateSchema);
