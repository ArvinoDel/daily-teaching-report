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
      default: 60,
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
    // Students who had their AC cards reduced (stored as array of names,
    // duplicates allowed to represent multiple deductions, same as ac_students)
    ac_reduced_students: {
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
    // ── Assistant Teacher tagging ──────────────────────────────
    // Registered user tagged as the prime teacher (if any)
    partner_teacher: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    // Display name of the partner (registered or manually typed)
    partner_teacher_name: {
      type: String,
      trim: true,
      default: '',
    },
    // The paired report created automatically for the partner
    linked_report: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Report',
      default: null,
    },
    // True when this report was auto-generated for the tagged partner
    is_auto_generated: {
      type: Boolean,
      default: false,
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

// Virtual: date for input[type=date] (YYYY-MM-DD)
reportSchema.virtual('dateInputFormat').get(function () {
  return this.date.toISOString().substring(0, 10);
});

reportSchema.set('toJSON', { virtuals: true });
reportSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Report', reportSchema);

// ── Compound indexes for common query patterns ──────────────────────────────
// Without these every query is a full collection scan.

// Primary: teacher's reports, date-ranged (most-used access pattern)
reportSchema.index({ teacher: 1, date: -1 });

// Admin listing / salary generation: all reports by date
reportSchema.index({ date: -1 });

// AC achievement aggregations (Bug #3 fix: is_auto_generated filter)
reportSchema.index({ ac_students:         1, is_auto_generated: 1 });
reportSchema.index({ ac_reduced_students: 1, is_auto_generated: 1 });

// Linked-report and partner cleanup queries
reportSchema.index({ linked_report:   1 });
reportSchema.index({ partner_teacher: 1 });