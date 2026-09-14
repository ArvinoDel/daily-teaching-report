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
    const filter = req.query.filter === 'unread' ? 'unread' : 'all';
    const page   = parseInt(req.query.page, 10) || 1;

    const { notifications, unreadCount, total } = await notificationService.getTeacherNotifications(
      userId,
      { filter, page, limit: 50 }
    );

    const flash = req.session.flash || null;
    delete req.session.flash;

    res.render('notifications/index', {
      title: 'Notifikasi',
      notifications,
      unreadCount,
      total,
      currentFilter: filter,
      flash,
      csrfToken: req.session.csrfToken || '',
    });
  } catch (err) {
    console.error('[notifications] index error:', err);
    res.status(500).render('error', { message: 'Gagal memuat notifikasi.' });
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
      return res.status(500).json({ error: 'Gagal menandai notifikasi.' });
    }
    req.session.flash = { type: 'error', msg: 'Gagal menandai notifikasi.' };
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
      msg: count > 0 ? `${count} notifikasi ditandai sudah dibaca.` : 'Semua notifikasi sudah dibaca.',
    };
    res.redirect('/notifications');
  } catch (err) {
    console.error('[notifications] markAllAsRead error:', err);
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.status(500).json({ error: 'Gagal menandai semua notifikasi.' });
    }
    req.session.flash = { type: 'error', msg: 'Gagal menandai notifikasi.' };
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

    req.session.flash = { type: 'success', msg: 'Notifikasi berhasil dihapus.' };
    res.redirect('/notifications');
  } catch (err) {
    console.error('[notifications] delete error:', err);
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.status(500).json({ error: 'Gagal menghapus notifikasi.' });
    }
    req.session.flash = { type: 'error', msg: 'Gagal menghapus notifikasi.' };
    res.redirect('/notifications');
  }
};
