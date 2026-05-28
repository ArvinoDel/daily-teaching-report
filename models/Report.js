const mongoose = require('mongoose');


const reportSchema = new mongoose.Schema(
  {
    teacher: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    date: {
      type: Date,
      required: [true, 'Teaching date is required.'],
    },
    subject: {
      type: String,
      trim: true,
      maxlength: [100, 'Subject max 100 characters.'],
      default: '',
    },
    class_name: {
      type: String,
      required: [true, 'Class name is required.'],
      trim: true,
      maxlength: [50, 'Class name max 50 characters.'],
    },
    duration: {
      type: Number,
      required: [true, 'Teaching duration is required.'],
      min: [1, 'Minimum duration is 1 minute.'],
      comment: 'Duration in minutes',
    },
    teaching_type: {
      type: String,
      required: [true, 'Teaching type is required.'],
      enum: {
        values: ['Prime Teacher (Full)', 'Assistant Teacher', '1/2 Prime Teacher', 'Prime Teacher (Assisted)'],
        message: '{VALUE} is not a valid teaching type.',
      },
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [1000, 'Notes max 1000 characters.'],
      default: '',
    },
    ac_students: {
      type: [String],
      default: [],
    },
    absent_students: {
      type: [String],
      default: [],
    },
    session_mode: {
      type: String,
      enum: ['online', 'offline'],
      default: 'offline',
    },
    uses_personal_internet: {
      type: Boolean,
      default: false,
    },
    session_type: {
      type: String,
      enum: ['group', 'private', 'competition'],
      default: 'group',
    },
    competition_groups: {
      type: [String],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

// Virtual: duration in hours & minutes format
reportSchema.virtual('durationFormatted').get(function () {
  const hours = Math.floor(this.duration / 60);
  const minutes = this.duration % 60;
  if (hours === 0) return `${minutes} minute(s)`;
  if (minutes === 0) return `${hours} hour(s)`;
  return `${hours} hour ${minutes} minute(s)`;
});

// Virtual: date in formatted local string
reportSchema.virtual('dateFormatted').get(function () {
  return this.date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
});

// Virtual: tanggal untuk input[type=date] (YYYY-MM-DD)
reportSchema.virtual('dateInputFormat').get(function () {
  return this.date.toISOString().substring(0, 10);
});

reportSchema.set('toJSON', { virtuals: true });
reportSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Report', reportSchema);