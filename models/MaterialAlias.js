'use strict';
const mongoose = require('mongoose');

const materialAliasSchema = new mongoose.Schema(
  {
    nameNormalized: {
      type:     String,
      required: true,
      trim:     true,
    },
    level: {
      type:    String,
      default: '',
      trim:    true,
      set: function(v) {
        return (v || '').trim().toUpperCase();
      },
    },
    material: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Material',
      required: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

materialAliasSchema.index(
  { nameNormalized: 1, level: 1 },
  { unique: true }
);
materialAliasSchema.index({ material: 1 });

module.exports = mongoose.model('MaterialAlias', materialAliasSchema);
