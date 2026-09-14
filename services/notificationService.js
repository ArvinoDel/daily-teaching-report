'use strict';
/**
 * notificationService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Extensible Notification Service for Daily Teaching Report
 *
 * Handles creation, querying, state updates, and event-specific dispatches.
 * Architected to support arbitrary notification categories (salary, report,
 * announcements, system) while starting with salary payment slip publications.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const mongoose = require('mongoose');
const Notification = require('../models/Notification');

/**
 * Format relative time in a human-friendly string (Indonesian / English hybrid standard)
 * @param {Date|string} date
 * @returns {string}
 */
function formatRelativeTime(date) {
  if (!date) return '';
  const now = new Date();
  const d = new Date(date);
  const diffMs = now.getTime() - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSec < 45) return 'Just now';
  if (diffMin === 1) return '1 minute ago';
  if (diffMin < 60) return `${diffMin} minutes ago`;
  if (diffHours === 1) return '1 hour ago';
  if (diffHours < 24) return `${diffHours} hours ago`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;

  return d.toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

/**
 * Universal notification dispatcher.
 * Supports duplicate prevention for unread notifications with identical metadata.
 *
 * @param {Object} params
 * @param {string|mongoose.Types.ObjectId} params.recipient
 * @param {string} [params.type='system']
 * @param {string} [params.category='system']
 * @param {string} params.title
 * @param {string} params.message
 * @param {string} [params.link='']
 * @param {Object} [params.metadata={}]
 * @returns {Promise<Notification>}
 */
async function sendNotification({
  recipient,
  type = 'system',
  category = 'system',
  title,
  message,
  link = '',
  metadata = {},
}) {
  if (!recipient) {
    throw new Error('Notification recipient is required.');
  }

  // Deduplication check: if there is an unread notification of the same type and target
  if (metadata && (metadata.salaryId || metadata.targetId)) {
    const query = {
      recipient,
      type,
      isRead: false,
    };
    if (metadata.salaryId) query['metadata.salaryId'] = metadata.salaryId;
    if (metadata.targetId) query['metadata.targetId'] = metadata.targetId;

    const existing = await Notification.findOne(query);
    if (existing) {
      existing.title = title;
      existing.message = message;
      existing.link = link;
      existing.metadata = metadata;
      existing.createdAt = new Date(); // bump freshness
      return await existing.save();
    }
  }

  return await Notification.create({
    recipient,
    type,
    category,
    title,
    message,
    link,
    metadata,
  });
}

/**
 * Specialized helper: Send notification when a salary slip is published to a teacher
 * @param {Object} salary
 * @param {Object} [teacher]
 * @returns {Promise<Notification>}
 */
async function notifySalaryPublished(salary, teacher = null) {
  const teacherId = teacher?._id || salary.teacher?._id || salary.teacher;
  if (!teacherId) return null;

  const periodLabel = salary.periodLabel || `${salary.month}/${salary.year}`;
  const title = 'Payslip Published';
  const message = `Your payslip for ${periodLabel} has been published and is ready to view.`;
  const link = `/reports/my-salary/${salary._id}/slip`;

  return await sendNotification({
    recipient: teacherId,
    type: 'salary_published',
    category: 'salary',
    title,
    message,
    link,
    metadata: {
      salaryId: salary._id,
      month: salary.month,
      year: salary.year,
      periodLabel,
    },
  });
}

/**
 * Specialized helper: Send welcome notification when a teacher registers their account
 * Prompting them to configure their teaching reward / commission rates
 * @param {Object} user
 * @returns {Promise<Notification>}
 */
async function notifyTeacherWelcome(user) {
  if (!user || !user._id) return null;

  const title = 'Welcome to Daily Teaching Report!';
  const message = `Welcome aboard, ${user.displayName}! Please set your teaching reward and session commission amounts in your profile to enable accurate income calculations.`;
  const link = '/profile/edit#commission-section';

  return await sendNotification({
    recipient: user._id,
    type: 'teacher_welcome',
    category: 'system',
    title,
    message,
    link,
    metadata: {
      action: 'set_commission',
    },
  });
}

/**
 * Cleanup helper: Remove notification when a salary is retracted back to draft
 * @param {string|mongoose.Types.ObjectId} salaryId
 * @returns {Promise<number>} count of deleted notifications
 */
async function removeSalaryNotification(salaryId) {
  if (!salaryId) return 0;
  const result = await Notification.deleteMany({
    type: 'salary_published',
    'metadata.salaryId': salaryId,
  });
  return result.deletedCount || 0;
}

/**
 * Fetch notifications for a user with optional filtering and pagination
 * @param {string|mongoose.Types.ObjectId} userId
 * @param {Object} [options]
 * @param {string} [options.filter='all'] 'all' or 'unread'
 * @param {number} [options.page=1]
 * @param {number} [options.limit=40]
 * @returns {Promise<{ notifications: Array, unreadCount: number, total: number }>}
 */
async function getTeacherNotifications(userId, { filter = 'all', page = 1, limit = 40 } = {}) {
  const query = { recipient: userId };
  if (filter === 'unread') {
    query.isRead = false;
  }

  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 40));
  const skip = (p - 1) * l;

  const [rawNotifications, total, unreadCount] = await Promise.all([
    Notification.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(l)
      .lean(),
    Notification.countDocuments(query),
    Notification.countDocuments({ recipient: userId, isRead: false }),
  ]);

  const notifications = rawNotifications.map((n) => ({
    ...n,
    relativeTime: formatRelativeTime(n.createdAt),
    formattedDate: new Date(n.createdAt).toLocaleDateString('en-US', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
  }));

  return { notifications, unreadCount, total, page: p, limit: l };
}

/**
 * Get count of unread notifications for a user (used for navbar badge)
 * @param {string|mongoose.Types.ObjectId} userId
 * @returns {Promise<number>}
 */
async function getUnreadCount(userId) {
  if (!userId) return 0;
  return await Notification.countDocuments({ recipient: userId, isRead: false });
}

/**
 * Mark a single notification as read
 * @param {string|mongoose.Types.ObjectId} notificationId
 * @param {string|mongoose.Types.ObjectId} userId
 * @returns {Promise<Notification|null>}
 */
async function markAsRead(notificationId, userId) {
  if (!mongoose.Types.ObjectId.isValid(notificationId)) return null;

  return await Notification.findOneAndUpdate(
    { _id: notificationId, recipient: userId },
    { $set: { isRead: true, readAt: new Date() } },
    { new: true }
  );
}

/**
 * Mark all unread notifications for a user as read
 * @param {string|mongoose.Types.ObjectId} userId
 * @returns {Promise<number>} modified count
 */
async function markAllAsRead(userId) {
  if (!userId) return 0;

  const result = await Notification.updateMany(
    { recipient: userId, isRead: false },
    { $set: { isRead: true, readAt: new Date() } }
  );
  return result.modifiedCount || 0;
}

/**
 * Delete an individual notification
 * @param {string|mongoose.Types.ObjectId} notificationId
 * @param {string|mongoose.Types.ObjectId} userId
 * @returns {Promise<boolean>}
 */
async function deleteNotification(notificationId, userId) {
  if (!mongoose.Types.ObjectId.isValid(notificationId)) return false;

  const result = await Notification.findOneAndDelete({
    _id: notificationId,
    recipient: userId,
  });
  return !!result;
}

module.exports = {
  formatRelativeTime,
  sendNotification,
  notifySalaryPublished,
  notifyTeacherWelcome,
  removeSalaryNotification,
  getTeacherNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
};
