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
      required: [true, 'Teaching date must be filled diisi.'],
    },
    subject: {
      type: String,
      required: [true, 'Mata pelajaran wajib diisi.'],
      trim: true,
      maxlength: [100, 'Mata pelajaran maksimal 100 karakter.'],
    },
    class_name: {
      type: String,
      required: [true, 'Nama kelas wajib diisi.'],
      trim: true,
      maxlength: [50, 'Nama kelas maksimal 50 karakter.'],
    },
    duration: {
      type: Number,
      required: [true, 'Durasi mengajar wajib diisi.'],
      min: [1, 'Durasi minimal 1 menit.'],
      comment: 'Durasi dalam menit',
    },
    teaching_type: {
      type: String,
      required: [true, 'Tipe pengajar wajib dipilih.'],
      enum: {
        values: ['Prime Teacher (Full)', 'Assistant Teacher', '1/2 Prime Teacher', 'Prime Teacher (Assisted)'],
        message: '{VALUE} bukan tipe pengajar yang valid.',
      },
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [1000, 'Catatan maksimal 1000 karakter.'],
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
  },
  {
    timestamps: true,
  }
);

// Virtual: durasi dalam format jam & menit
reportSchema.virtual('durationFormatted').get(function () {
  const hours = Math.floor(this.duration / 60);
  const minutes = this.duration % 60;
  if (hours === 0) return `${minutes} minute(s)`;
  if (minutes === 0) return `${hours} hour(s)`;
  return `${hours} hour ${minutes} minute(s)`;
});

// Virtual: tanggal dalam format lokal Indonesia
reportSchema.virtual('dateFormatted').get(function () {
  return this.date.toLocaleDateString('id-ID', {
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