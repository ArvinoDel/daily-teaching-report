'use strict';
const mongoose = require('mongoose');

/* ─────────────────────────────────────────────────────────────────────
 *  MaterialContent
 *
 *  Holds the written rich-text content, attached files, and links
 *  for a Material. Kept in a separate collection so Material stays lean.
 * ───────────────────────────────────────────────────────────────────── */

const resourceSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ['file', 'link'],
      required: true,
    },
    label: {
      type: String,
      maxlength: 100,
      default: '',
      trim: true,
    },
    // URL for external links only
    url: {
      type: String,
      maxlength: 500,
      default: null,
      trim: true,
    },
    // Cloudinary details for files only
    file: {
      publicId:         { type: String, default: null },
      resourceType:     { type: String, default: 'auto' },
      deliveryType:     { type: String, default: 'authenticated' },
      format:           { type: String, default: '' },
      bytes:            { type: Number, default: 0 },
      originalFilename: { type: String, default: '' },
    },
    addedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    addedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

const materialContentSchema = new mongoose.Schema(
  {
    material: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Material',
      required: true,
      unique: true,
      index: true,
    },
    // Sanitized HTML (max 200 KB)
    body: {
      type: String,
      default: '',
      maxlength: [200 * 1024, 'Content body exceeds 200 KB limit.'],
    },
    resources: {
      type: [resourceSchema],
      default: [],
      validate: [
        function(val) {
          return !val || val.length <= 20;
        },
        'Maximum 20 resources allowed per material.',
      ],
    },
    locked: {
      type: Boolean,
      default: false,
    },
    version: {
      type: Number,
      default: 1,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    updatedByName: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

materialContentSchema.index({ material: 1 }, { unique: true });

const MaterialContent = mongoose.model('MaterialContent', materialContentSchema);
module.exports = MaterialContent;
