const mongoose = require('mongoose');

const backupSchema = new mongoose.Schema({
  initiatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  initiatedByName: { type: String, required: true },
  status: {
    type: String,
    enum: ['success', 'failed'],
    default: 'success',
  },
  fileUrl:       { type: String, default: null },   // Cloudinary secure_url
  cloudinaryId:  { type: String, default: null },   // for deletion
  fileSizeBytes: { type: Number, default: 0 },
  recordCounts: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  errorMessage: { type: String, default: null },
}, { timestamps: true });

module.exports = mongoose.model('Backup', backupSchema);