'use strict';
/**
 * notificationController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Notification controller handling the notification center for teachers and staff.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const notificationService = require('../services/notificationService');

/**
 * GET /notifications
 * Render notification center page
 */
exports.index = async (req, res) => {
  try {
    const userId = req.session.user._id;
    const page   = parseInt(req.query.page, 10) || 1;

    // Fetch all notifications for the user
    const { notifications, unreadCount, total } = await notificationService.getTeacherNotifications(
      userId,
      { filter: 'all', page, limit: 50 }
    );

    // Automatically mark all unread notifications as read when visiting notifications
    if (unreadCount > 0) {
      await notificationService.markAllAsRead(userId);
    }

    // Immediately clear navbar unread badge on this render
    res.locals.unreadNotificationCount = 0;

    const flash = req.session.flash || null;
    delete req.session.flash;

    res.render('notifications/index', {
      title: 'Notifications',
      notifications,
      total,
      flash,
      csrfToken: req.session.csrfToken || '',
    });
  } catch (err) {
    console.error('[notifications] index error:', err);
    res.status(500).render('error', { message: 'Failed to load notifications.' });
  }
};

/**
 * POST /notifications/:id/read
 * Mark a single notification as read
 */
exports.markAsRead = async (req, res) => {
  try {
    const userId = req.session.user._id;
    const notifId = req.params.id;

    await notificationService.markAsRead(notifId, userId);

    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.json({ success: true });
    }

    res.redirect(req.get('Referrer') || '/notifications');
  } catch (err) {
    console.error('[notifications] markAsRead error:', err);
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.status(500).json({ error: 'Failed to mark notification.' });
    }
    req.session.flash = { type: 'error', msg: 'Failed to mark notification.' };
    res.redirect('/notifications');
  }
};

/**
 * POST /notifications/mark-all-read
 * Mark all notifications for the user as read
 */
exports.markAllAsRead = async (req, res) => {
  try {
    const userId = req.session.user._id;
    const count = await notificationService.markAllAsRead(userId);

    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.json({ success: true, count });
    }

    req.session.flash = {
      type: 'success',
      msg: count > 0 ? `${count} notification${count > 1 ? 's' : ''} marked as read.` : 'All notifications are already read.',
    };
    res.redirect('/notifications');
  } catch (err) {
    console.error('[notifications] markAllAsRead error:', err);
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.status(500).json({ error: 'Failed to mark all notifications.' });
    }
    req.session.flash = { type: 'error', msg: 'Failed to mark all notifications.' };
    res.redirect('/notifications');
  }
};

/**
 * POST /notifications/:id/delete
 * Delete a notification
 */
exports.deleteNotification = async (req, res) => {
  try {
    const userId = req.session.user._id;
    const notifId = req.params.id;

    const success = await notificationService.deleteNotification(notifId, userId);

    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.json({ success });
    }

    req.session.flash = { type: 'success', msg: 'Notification deleted successfully.' };
    res.redirect('/notifications');
  } catch (err) {
    console.error('[notifications] delete error:', err);
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.status(500).json({ error: 'Failed to delete notification.' });
    }
    req.session.flash = { type: 'error', msg: 'Failed to delete notification.' };
    res.redirect('/notifications');
  }
};
