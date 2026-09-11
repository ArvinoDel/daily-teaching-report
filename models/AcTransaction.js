/**
 * models/AcTransaction.js
 *
 * Records every individual AC give/take event triggered by a barcode scan.
 * Independent of the Report model — allows ad-hoc AC management without
 * needing a full teaching report.
 *
 * AC totals are computed by aggregating BOTH:
 *   • Report.ac_students (historical, pre-migration data)
 *   • AcTransaction (new scan-based events)
 */

const mongoose = require('mongoose');

const acTransactionSchema = new mongoose.Schema({
  /* ── Student identity ── */
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
    required: true,
    index: true,
  },
  // Denormalized for fast display without populate
  student_name: { type: String, required: true, trim: true },
  student_code: { type: String, trim: true, default: '' },
  barcode:      { type: String, trim: true, default: '' },

  /* ── Transaction ── */
  type: {
    type: String,
    enum: ['add', 'reduce'],
    required: true,
  },
  amount: {
    type: Number,
    default: 1,
    min: 1,
    max: 10,
  },

  /* ── Context (what the teacher typed before scanning) ── */
  subject:    { type: String, trim: true, default: '' },
  class_name: { type: String, trim: true, default: '' },
  note:       { type: String, trim: true, default: '' },

  /* ── Who & when ── */
  date:       { type: Date, default: Date.now, index: true },
  scanned_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  scanned_by_name: { type: String, default: '' },
}, { timestamps: true });

/* ── Compound indexes for fast AC total aggregation ── */
acTransactionSchema.index({ student: 1, date: -1 });
acTransactionSchema.index({ student: 1, type: 1 });

const AcTransaction = mongoose.model('AcTransaction', acTransactionSchema);

module.exports = AcTransaction;
