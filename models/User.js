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
    enum: ['teacher', 'admin', 'superadmin'],
    default: 'teacher',
  },
  // When the teacher started working (month + year stored as Date day=1)
  joinDate: {
    type: Date,
    default: null,
  },
  // Commission price per session type (in IDR)
  commission: {
    primeFull:     { type: Number, default: 0, min: 0 },
    primeAssisted: { type: Number, default: 0, min: 0 },
    halfPrime:     { type: Number, default: 0, min: 0 },
    assistant:     { type: Number, default: 0, min: 0 },
  },
  profilePicture: {
    type: String,
    default: null,
  },
  cloudinaryId: {
    type: String,
    default: null,
  },
  lastActiveAt: {
    type: Date,
    default: null,
  },
}, { timestamps: true });

// Virtual: compute experience string from joinDate to now
userSchema.virtual('experienceFormatted').get(function () {
  if (!this.joinDate) return null;
  const now = new Date();
  const totalMonths = Math.max(0,
    (now.getFullYear() - this.joinDate.getFullYear()) * 12 +
    (now.getMonth() - this.joinDate.getMonth())
  );
  const yrs = Math.floor(totalMonths / 12);
  const mos = totalMonths % 12;
  if (yrs === 0 && mos === 0) return '< 1 mo';
  if (yrs === 0) return `${mos}mo`;
  if (mos === 0) return `${yrs}yr`;
  return `${yrs}yr ${mos}mo`;
});

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

userSchema.set('toJSON', { virtuals: true });
userSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('User', userSchema);