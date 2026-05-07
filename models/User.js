const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: [true, 'Username is required.'],
    unique: true,
    trim: true,
    lowercase: true,
    minlength: [3, 'Username must be at least 3 characters.'],
    maxlength: [30, 'Username max 30 characters.'],
  },
  password: {
    type: String,
    required: [true, 'Password is required.'],
    minlength: [6, 'Password must be at least 6 characters.'],
  },
  displayName: {
    type: String,
    required: [true, 'Display name is required.'],
    trim: true,
    maxlength: [50, 'Display name max 50 characters.'],
  },
  role: {
    type: String,
    enum: ['teacher', 'admin'],
    default: 'teacher',
  },
  workingExperience: {
    type: Number,
    min: [0, 'Working experience cannot be negative.'],
    max: [60, 'Working experience seems too high.'],
    default: 0,
  },
 profilePicture: {
    type: String,
    default: null,
  },
  cloudinaryId: {        // ← tambah ini
    type: String,
    default: null,
  },
  lastActiveAt: {
    type: Date,
    default: null,
  },
}, { timestamps: true });

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Compare password method
userSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.model('User', userSchema);