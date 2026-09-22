const mongoose = require('mongoose');

/* ───────────────────────────────────────────────────────────────
   Helper sub-schema: dynamic label + amount line items
─────────────────────────────────────────────────────────────── */
const lineItemSchema = new mongoose.Schema(
  { label: { type: String, trim: true, default: '' }, amount: { type: Number, default: 0, min: 0 } },
  { _id: false }
);

/* ───────────────────────────────────────────────────────────────
   Salary Schema  — one document = one teacher × one pay period
─────────────────────────────────────────────────────────────── */
const salarySchema = new mongoose.Schema({
  teacher: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Teacher is required.'],
  },

  /* ── Period metadata ── */
  month:        { type: Number, required: true, min: 1, max: 12 }, // 1-12
  year:         { type: Number, required: true },                   // e.g. 2026
  periodLabel:  { type: String, default: '' },   // e.g. "26 Jul – 25 Aug 2026"
  periodStart:  { type: Date,   default: null },
  periodEnd:    { type: Date,   default: null },
  payDate:      { type: Date,   default: null },
  payDateLabel: { type: String, default: '' },   // e.g. "26-Aug"
  teacherTenureAtPeriod: { type: String, default: '' }, // e.g. "10 months" — snapshot at time of generation

  /* ── Status workflow ── */
  // draft     → admin is editing
  // published → bulk-sent to teacher (teacher can now see it, read-only)
  // paid      → marked as physically paid
  status:      { type: String, enum: ['draft', 'published', 'paid'], default: 'draft' },
  publishedAt: { type: Date, default: null },
  paidAt:      { type: Date, default: null },

  /* ══════════════════════════════════════════
     EARNINGS
  ══════════════════════════════════════════ */

  // 1. Basic Salary
  basicSalary: { type: Number, default: 0, min: 0 },

  // 2. Meal Allowance Full  →  mealFullDays × mealFullRate
  mealFullDays:  { type: Number, default: 0, min: 0 },
  mealFullRate:  { type: Number, default: 22500, min: 0 },
  mealFullTotal: { type: Number, default: 0, min: 0 },

  // 3. Meal Allowance Half  →  mealHalfDays × mealHalfRate
  mealHalfDays:  { type: Number, default: 0, min: 0 },
  mealHalfRate:  { type: Number, default: 0, min: 0 },
  mealHalfTotal: { type: Number, default: 0, min: 0 },

  // 4. Transport Allowance  →  transportDays × transportRate
  transportDays:  { type: Number, default: 0,     min: 0 },
  transportRate:  { type: Number, default: 22500, min: 0 },
  transportTotal: { type: Number, default: 0,     min: 0 },

  // 5. Monthly Incentive
  monthlyIncentive: { type: Number, default: 0, min: 0 },

  // 6. Health Allowance
  healthAllowance: { type: Number, default: 0, min: 0 },

  // 7. Position Allowance (stage-unlocked after N months)
  positionAllowance: { type: Number, default: 0, min: 0 },

  // 8. Loyalty Allowance
  loyaltyAllowance: { type: Number, default: 0, min: 0 },

  // 9. Wife / Child Allowance
  wifeChildAllowance: { type: Number, default: 0, min: 0 },

  // 10. Teaching Reward (auto-calculated from reports × commission rates; stage-gated)
  teachingReward: { type: Number, default: 0, min: 0 },

  // 11. Game Reward
  gameReward: { type: Number, default: 0, min: 0 },

  // 12. Student Commission
  studentCommission: { type: Number, default: 0, min: 0 },

  // 13. Internet / Electricity Compensation
  internetCompensation: { type: Number, default: 0, min: 0 },

  // 14. Overtime
  overtime: { type: Number, default: 0, min: 0 },

  // 15. Other Incomes (dynamic label + amount pairs)
  otherIncomes: { type: [lineItemSchema], default: [] },

  // Computed subtotal (server-side)
  subtotalIncomes: { type: Number, default: 0, min: 0 },

  /* ══════════════════════════════════════════
     DEDUCTIONS
  ══════════════════════════════════════════ */

  // 16. Installment / Loan
  instalment: { type: Number, default: 0, min: 0 },

  // 17. Miscellaneous Deductions
  miscellaneousDeduction: { type: Number, default: 0, min: 0 },

  // 18. BPJS Employment
  bpjsKetenagakerjaan: { type: Number, default: 0, min: 0 },

  // 19. Last Month's Tax (PPH)
  tax: { type: Number, default: 0, min: 0 },

  // 20. Other Deductions (dynamic label + amount pairs)
  otherDeductions: { type: [lineItemSchema], default: [] },

  // Computed subtotal (server-side)
  subtotalDeductions: { type: Number, default: 0, min: 0 },

  /* ══════════════════════════════════════════
     NET PAY
  ══════════════════════════════════════════ */
  totalSalary: { type: Number, default: 0 }, // subtotalIncomes - subtotalDeductions

  /* ── Notes / remarks ── */
  notes: { type: String, trim: true, default: '', maxlength: [500, 'Notes max 500 chars.'] },

}, { timestamps: true });

/* ───────────────────────────────────────────────────────────────
   Compound index — one salary record per teacher per month+year
─────────────────────────────────────────────────────────────── */
salarySchema.index({ teacher: 1, year: 1, month: 1 }, { unique: true });

/* ───────────────────────────────────────────────────────────────
   Instance method: recompute all totals from parts
   Call this before saving whenever any field changes.
─────────────────────────────────────────────────────────────── */
salarySchema.methods.recompute = function () {
  // Attendance totals
  this.mealFullTotal  = (this.mealFullDays  || 0) * (this.mealFullRate  || 0);
  this.mealHalfTotal  = (this.mealHalfDays  || 0) * (this.mealHalfRate  || 0);
  this.transportTotal = (this.transportDays || 0) * (this.transportRate || 0);

  // Other incomes sum
  const otherIncomesSum = (this.otherIncomes || []).reduce((s, i) => s + (i.amount || 0), 0);

  this.subtotalIncomes =
    (this.basicSalary        || 0) +
    (this.mealFullTotal      || 0) +
    (this.mealHalfTotal      || 0) +
    (this.transportTotal     || 0) +
    (this.monthlyIncentive   || 0) +
    (this.healthAllowance    || 0) +
    (this.positionAllowance  || 0) +
    (this.loyaltyAllowance   || 0) +
    (this.wifeChildAllowance || 0) +
    (this.teachingReward     || 0) +
    (this.gameReward         || 0) +
    (this.studentCommission  || 0) +
    (this.internetCompensation || 0) +
    (this.overtime           || 0) +
    otherIncomesSum;

  // Other deductions sum
  const otherDeductionsSum = (this.otherDeductions || []).reduce((s, i) => s + (i.amount || 0), 0);

  this.subtotalDeductions =
    (this.instalment             || 0) +
    (this.miscellaneousDeduction || 0) +
    (this.bpjsKetenagakerjaan    || 0) +
    (this.tax                    || 0) +
    otherDeductionsSum;

  this.totalSalary = this.subtotalIncomes - this.subtotalDeductions;
};

salarySchema.set('toJSON',   { virtuals: true });
salarySchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Salary', salarySchema);
