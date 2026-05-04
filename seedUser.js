require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');


async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected');

  // Ganti sesuai kebutuhan
  const user = await User.create({
    username: 'admin',
    password: 'password123',
    displayName: 'Admin',
    role: 'admin',
  });

  console.log('✅ User created:', user.username);
  await mongoose.disconnect();
  process.exit(0);
}

seed().catch(err => {
  console.error(err);
  process.exit(1);
});