const mongoose = require('mongoose');

const feedbackSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  submitterName: {
    type: String,
    default: '',
  },
  submitterEmail: {
    type: String,
    default: '',
  },
  description: {
    type: String,
    required: [true, 'Description is required.'],
    trim: true,
  },
  screenshotUrl: {
    type: String,
    default: null,
  },
  cloudinaryId: {
    type: String,
    default: null,
  },
  pageUrl: {
    type: String,
    default: '',
  },
  status: {
    type: String,
    enum: ['pending', 'resolved', 'ignored'],
    default: 'pending',
  },
}, { timestamps: true });

module.exports = mongoose.model('Feedback', feedbackSchema);
