const mongoose = require('mongoose');

/* ─────────────────────────────────────────────────────────────────
 * Normalize a raw student name for deduplication.
 * Strips trailing grade/school annotations like "11 SPB", "12 CS",
 * "10 N2", "9 CS+", etc., then lowercases and trims.
 * Examples:
 *   "Lionel 11 SPB"    → "lionel"
 *   "Michelle Evelyn 12 CS" → "michelle evelyn"
 *   "Haikal & Airra"   → "haikal & airra"  (shared slot, kept as-is)
 * ───────────────────────────────────────────────────────────────── */
function normalizeName(raw) {
  if (!raw) return '';
  // Remove trailing annotations: number + optional letters/digits/+/- cluster
  // e.g. "11 SPB", "12 CS", "10 N2", "9 CS+", "12 N1 CW"
  const cleaned = raw
    .trim()
    // Remove trailing " (something)" notes like "(Aug)", "(Off Aug 1/2)"
    .replace(/\s*\([^)]*\)\s*$/, '')
    // Remove trailing asterisk notes
    .replace(/\*.*$/, '')
    // Remove trailing grade+school annotation: digits followed by letters/digits
    .replace(/\s+\d{1,2}\s+[A-Z][A-Z0-9+\-]*(\s+[A-Z][A-Z0-9+\-]*)*\s*$/i, '')
    .trim();
  return cleaned.toLowerCase();
}

/* ─────────────────────────────────────────────────────────────────
 * Extract grade + school from a raw name annotation.
 * "Lionel 11 SPB" → "11 SPB"
 * "Lionel"        → ""
 * ───────────────────────────────────────────────────────────────── */
function extractGradeSchool(raw) {
  if (!raw) return '';
  const cleaned = raw
    .trim()
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\*.*$/, '');
  const match = cleaned.match(/\s+(\d{1,2}\s+[A-Z][A-Z0-9+\-]*(?:\s+[A-Z][A-Z0-9+\-]*)*)\s*$/i);
  return match ? match[1].trim() : '';
}

/* ─────────────────────────────────────────────────────────────────
 * Extract the display (full) name: raw minus grade/school annotation
 * "Lionel 11 SPB" → "Lionel"
 * ───────────────────────────────────────────────────────────────── */
function extractFullName(raw) {
  if (!raw) return '';
  const cleaned = raw
    .trim()
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\*.*$/, '');
  const withoutAnnotation = cleaned
    .replace(/\s+\d{1,2}\s+[A-Z][A-Z0-9+\-]*(\s+[A-Z][A-Z0-9+\-]*)*\s*$/i, '')
    .trim();
  return withoutAnnotation || cleaned.trim();
}

/* ─────────────────────────────────────────────────────────────────
 *  Schema
 * ───────────────────────────────────────────────────────────────── */
const studentSchema = new mongoose.Schema(
  {
    // Human-readable unique code, e.g. "STD-2026-0001"
    student_code: {
      type:     String,
      required: true,
      unique:   true,
      trim:     true,
    },

    // Machine-scannable barcode string (Code 128 / alphanumeric)
    // This is the raw string encoded into the barcode graphic.
    barcode: {
      type:     String,
      required: true,
      unique:   true,
      trim:     true,
    },

    // Clean display name derived from raw_name (no grade/school suffix)
    full_name: {
      type:    String,
      required: true,
      trim:    true,
    },

    // The original string as it appeared in the CSV roster
    raw_name: {
      type:  String,
      trim:  true,
      default: '',
    },

    // Normalized name used for deduplication across imports
    normalized_name: {
      type:  String,
      trim:  true,
      index: true,
    },

    // Grade & school annotation extracted from raw_name
    grade_school: {
      type:    String,
      trim:    true,
      default: '',
    },

    // Groups this student belongs to (relational reference)
    groups: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref:  'Group',
      },
    ],

    // Lifecycle status
    status: {
      type:    String,
      enum:    ['active', 'inactive', 'graduated'],
      default: 'active',
    },

    notes: {
      type:    String,
      trim:    true,
      default: '',
    },
  },
  { timestamps: true }
);

/* ── No extra index() calls needed — unique:true on the schema fields
   already creates the indexes for barcode, student_code, and
   normalized_name. ── */

/* ─────────────────────────────────────────────────────────────────
 *  Static helpers
 * ───────────────────────────────────────────────────────────────── */

/**
 * Look up a student by barcode string.
 * @param {string} barcode
 * @returns {Promise<Student|null>}
 */
studentSchema.statics.findByBarcode = function (barcode) {
  return this.findOne({ barcode: barcode.trim() });
};

/**
 * Find a student by normalized name, or return null if not found.
 * @param {string} rawName
 * @returns {Promise<Student|null>}
 */
studentSchema.statics.findByRawName = function (rawName) {
  return this.findOne({ normalized_name: normalizeName(rawName) });
};

const Student = mongoose.model('Student', studentSchema);

module.exports = Student;
module.exports.normalizeName      = normalizeName;
module.exports.extractGradeSchool = extractGradeSchool;
module.exports.extractFullName    = extractFullName;
