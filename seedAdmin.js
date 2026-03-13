require('dotenv').config();

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const User = require('./models/User');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_FULL_NAME = process.env.ADMIN_FULL_NAME || 'FutureTrace Admin';

async function run() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required.');
  }

  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD are required.');
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const existing = await User.findOne({ email: ADMIN_EMAIL.toLowerCase().trim() });

  if (existing) {
    const roles = new Set(existing.roles || []);
    roles.add('super_admin');
    existing.roles = Array.from(roles);
    existing.password_hash = passwordHash;
    existing.full_name = existing.full_name || ADMIN_FULL_NAME;
    existing.status = 'active';
    await existing.save();
    console.log(`Updated admin user: ${existing.email}`);
  } else {
    await User.create({
      email: ADMIN_EMAIL.toLowerCase().trim(),
      password_hash: passwordHash,
      full_name: ADMIN_FULL_NAME,
      roles: ['user', 'super_admin'],
      tier: 'premium_demo',
      status: 'active',
      avatar_url: `https://i.pravatar.cc/150?u=${ADMIN_EMAIL}`,
    });
    console.log(`Created admin user: ${ADMIN_EMAIL}`);
  }

  await mongoose.disconnect();
}

run()
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error('Seed admin error:', error.message);
    try {
      await mongoose.disconnect();
    } catch (disconnectError) {
      console.error('Disconnect error:', disconnectError.message);
    }
    process.exit(1);
  });
