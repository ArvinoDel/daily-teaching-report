const mongoose = require('mongoose');

const noClassDateSchema = new mongoose.Schema({
  from: {
    type: String, // YYYY-MM-DD
    required: [true, 'From date is required.'],
    validate: {
      validator: function(v) {
        return /^\d{4}-\d{2}-\d{2}$/.test(v);
      },
      message: 'From date must be in YYYY-MM-DD format.',
    },
  },
  to: {
    type: String, // YYYY-MM-DD
    required: [true, 'To date is required.'],
    validate: {
      validator: function(v) {
        return /^\d{4}-\d{2}-\d{2}$/.test(v);
      },
      message: 'To date must be in YYYY-MM-DD format.',
    },
  },
  label: {
    type: String,
    required: [true, 'Label is required.'],
    trim: true,
    maxlength: [80, 'Label max 80 characters.'],
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
}, { timestamps: true });

noClassDateSchema.index({ from: 1, to: 1 });

module.exports = mongoose.model('NoClassDate', noClassDateSchema);

