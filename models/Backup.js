const mongoose = require('mongoose');

const backupSchema = new mongoose.Schema({
  initiatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
  },
  initiatedByName: { type: String, required: true },
  status: {
    type: String,
    enum: ['success', 'failed'],
    default: 'success',
  },
  format: {
    type: String,
    enum: ['json_gz', 'json', 'bson_gz'],
    default: 'json_gz',
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