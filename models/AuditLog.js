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
    enum: [
      'update', 'delete', 'salary_generate', 'salary_publish',
      'salary_update', 'merge', 'salary_bulk_update', 'import_groups',
      'group_student_add', 'group_student_remove', 'group_student_move',
      'group_student_rename',
      'group_roster_repair',
      'onboarding_remind',
      'report_gap_remind',
      'report_gap_ack',
      'no_class_date_add',
      'no_class_date_delete',
    ],
    required: true,
  },
  targetType: {
    type: String,
    enum: ['report', 'user', 'group', 'salary', 'material', 'no_class_date', 'report_gap'],
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
