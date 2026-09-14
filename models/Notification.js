const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Recipient is required.'],
    index: true,
  },
  type: {
    type: String,
    required: true,
    default: 'system',
    trim: true,
  },
  category: {
    type: String,
    enum: ['salary', 'report', 'announcement', 'system'],
    default: 'salary',
    index: true,
  },
  title: {
    type: String,
    required: [true, 'Title is required.'],
    trim: true,
    maxlength: [200, 'Title max 200 characters.'],
  },
  message: {
    type: String,
    required: [true, 'Message is required.'],
    trim: true,
    maxlength: [1000, 'Message max 1000 characters.'],
  },
  link: {
    type: String,
    default: '',
    trim: true,
  },
  isRead: {
    type: Boolean,
    default: false,
    index: true,
  },
  readAt: {
    type: Date,
    default: null,
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
}, { timestamps: true });

// Compound index for fast queries: fetching user's unread or recent notifications
notificationSchema.index({ recipient: 1, isRead: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
