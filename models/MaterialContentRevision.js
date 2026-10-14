'use strict';
const mongoose = require('mongoose');

/* ─────────────────────────────────────────────────────────────────────
 *  MaterialContentRevision
 *
 *  Snapshots of material content created on every save/restore.
 *  Allows admins to view history and restore previous versions.
 * ───────────────────────────────────────────────────────────────────── */

const materialContentRevisionSchema = new mongoose.Schema(
  {
    material: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Material',
      required: true,
      index:    true,
    },
    version: {
      type:     Number,
      required: true,
    },
    body: {
      type:    String,
      default: '',
    },
    resources: {
      type:    Array,
      default: [],
    },
    note: {
      type:      String,
      maxlength: [200, 'Revision note max 200 characters.'],
      default:   '',
      trim:      true,
    },
    editedBy: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'User',
      default: null,
    },
    editedByName: {
      type:    String,
      default: '',
      trim:    true,
    },
    editedAt: {
      type:    Date,
      default: Date.now,
    },
  },
  {
    timestamps: false,
  }
);

materialContentRevisionSchema.index({ material: 1, version: -1 });

const MaterialContentRevision = mongoose.model('MaterialContentRevision', materialContentRevisionSchema);
module.exports = MaterialContentRevision;
