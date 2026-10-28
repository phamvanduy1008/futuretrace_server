const mongoose = require('mongoose');
require('dotenv').config();
const SystemSetting = require('../models/SystemSetting');
const { systemSettings } = require('../services/adminDefaults');

async function migrate() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/futuretrace');
    const aiDefault = systemSettings.find((g) => g.group_key === 'ai');
    if (aiDefault) {
      await SystemSetting.findOneAndUpdate(
        { group_key: 'ai' },
        {
          title: aiDefault.title,
          description: aiDefault.description,
          fields: aiDefault.fields,
        },
        { upsert: true, new: true }
      );
      console.log('✅ Successfully updated AI settings group in MongoDB!');
      const updated = await SystemSetting.findOne({ group_key: 'ai' });
      console.log('Updated AI fields:');
      updated.fields.forEach((f) => console.log(` - [${f.key}] ${f.label}: ${f.value}`));
    }
  } catch (err) {
    console.error('Migration error:', err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

migrate();
