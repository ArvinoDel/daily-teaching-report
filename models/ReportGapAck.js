const mongoose = require('mongoose');

const reportGapAckSchema = new mongoose.Schema({
  kind: {
    type: String,
    enum: ['teacher_day', 'teacher_silent', 'group_silent'],
    required: true,
  },
  teacher: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  group: {
    type: String,
    trim: true,
    default: null,
  },
  date: {
    type: String, // YYYY-MM-DD (teacher_day only)
    default: null,
    validate: {
      validator: function(v) {
        if (!v) return true;
        return /^\d{4}-\d{2}-\d{2}$/.test(v);
      },
      message: 'Date must be in YYYY-MM-DD format.',
    },
  },
  reason: {
    type: String,
    enum: ['no_class', 'holiday', 'leave', 'reported_elsewhere', 'other'],
    required: true,
  },
  note: {
    type: String,
    trim: true,
    maxlength: 200,
    default: '',
  },
  ackedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  ackedByName: {
    type: String,
    required: true,
    trim: true,
  },
}, { timestamps: true });

// Unique on (kind, teacher, group, date)
reportGapAckSchema.index(
  { kind: 1, teacher: 1, group: 1, date: 1 },
  { unique: true }
);

module.exports = mongoose.model('ReportGapAck', reportGapAckSchema);

