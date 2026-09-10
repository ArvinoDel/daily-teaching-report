const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  admin: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  adminName: {
    type: String,
    required: true,
  },
  action: {
    type: String,
    enum: ['update', 'delete', 'salary_generate', 'salary_publish', 'salary_update'],
    required: true,
  },
  targetType: {
    type: String,
    enum: ['report', 'user', 'group', 'salary'], // 🟢 added 'salary'
    required: true,
  },
  targetId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
  },
  targetLabel: {
    type: String,
    default: '',
  },
  meta: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
}, { timestamps: true });

module.exports = mongoose.model('AuditLog', auditLogSchema);