'use strict';
const mongoose = require('mongoose');

/* ─────────────────────────────────────────────────────────────────────
 *  Normalization helpers
 *  Exported so the controller, admin controller, and migration script
 *  all share the EXACT same logic — no duplication.
 * ───────────────────────────────────────────────────────────────────── */

/**
 * Normalize a material name to a canonical key.
 *
 * Rules (match the client-side copy in report-form.ejs):
 *   1. Trim surrounding whitespace.
 *   2. Lowercase the whole string.
 *   3. Replace every run of non-letter / non-digit characters
 *      (Unicode-aware: /[^\p{L}\p{N}]+/gu) with a single space.
 *   4. Trim again.
 *
 * Returns "" for names that reduce to nothing (e.g. "---", "  ").
 *
 * @param  {string} raw
 * @returns {string}
 */
function normalizeMaterialName(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Format a material name for display.
 * Keeps the original casing of the first entry but collapses
 * multiple whitespace runs into a single space and trims edges.
 *
 * @param  {string} raw
 * @returns {string}
 */
function formatMaterialDisplayName(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw.trim().replace(/\s+/g, ' ');
}

/* ─────────────────────────────────────────────────────────────────────
 *  Schema
 * ───────────────────────────────────────────────────────────────────── */
const materialSchema = new mongoose.Schema(
  {
    // Display name - the first-entered original text, trimmed and
    // whitespace-collapsed. Max 100 chars to match Report.subject.
    name: {
      type:      String,
      required:  true,
      trim:      true,
      maxlength: [100, 'Material name max 100 characters.'],
    },

    // Lowercase normalized key used for deduplication lookups.
    nameNormalized: {
      type:     String,
      required: true,
    },

    // Level code resolved SERVER-SIDE from the class group (e.g. "E4").
    // Empty string means "no level" (private, competition, or unknown group).
    level: {
      type:    String,
      default: '',
      trim:    true,
      set: function(v) {
        return (v || '').trim().toUpperCase();
      },
    },

    // The teacher who first created this material entry.
    createdBy: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'User',
      default: null,
    },

    // How many non-auto-generated reports have used this material.
    usageCount: {
      type:    Number,
      default: 0,
    },

    // When this material was most recently referenced by a report.
    lastUsedAt: {
      type:    Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

/* -- Indexes ----------------------------------------------------------
 *  Primary: unique per (normalizedName, level) pair for deduplication.
 *  Secondary: efficient fetch for the autocomplete list (level + rank).
 */
materialSchema.index(
  { nameNormalized: 1, level: 1 },
  { unique: true }
);
materialSchema.index({ level: 1, usageCount: -1 });

const Material = mongoose.model('Material', materialSchema);

// Attach helpers as static methods so they can be accessed from the model
Material.normalizeMaterialName    = normalizeMaterialName;
Material.formatMaterialDisplayName = formatMaterialDisplayName;

module.exports = Material;

// Also export named so consumers can use:
//   const { normalizeMaterialName } = require('../models/Material');
module.exports.normalizeMaterialName    = normalizeMaterialName;
module.exports.formatMaterialDisplayName = formatMaterialDisplayName;
