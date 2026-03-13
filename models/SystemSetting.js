const mongoose = require('mongoose');

const systemSettingFieldSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    description: { type: String, default: '' },
    type: { type: String, enum: ['toggle', 'number', 'text', 'select'], required: true },
    value: { type: mongoose.Schema.Types.Mixed, default: null },
    options: { type: [String], default: [] },
  },
  { _id: false },
);

const systemSettingSchema = new mongoose.Schema(
  {
    group_key: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    description: { type: String, default: '' },
    fields: { type: [systemSettingFieldSchema], default: [] },
    updated_by_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updated_by_name: { type: String, default: '' },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'system_settings',
  },
);

systemSettingSchema.index({ group_key: 1 }, { unique: true });

module.exports = mongoose.model('SystemSetting', systemSettingSchema);
