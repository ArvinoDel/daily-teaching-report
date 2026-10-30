'use strict';

const mongoose = require('mongoose');
const User = require('../models/User');
const Notification = require('../models/Notification');
const AuditLog = require('../models/AuditLog');
const ReportGapAck = require('../models/ReportGapAck');
const NoClassDate = require('../models/NoClassDate');
const reportGapService = require('../services/reportGapService');

/**
 * Format a YYYY-MM-DD date string nicely like "Wed 28 Oct"
 */
function formatShortDate(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr || '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(dt);
}

/* ══════════════════════════════════════════════════════════════
   1. GET /admin/report-gaps
══════════════════════════════════════════════════════════════ */
exports.index = async (req, res) => {
  try {
    const rawLookback = Number(req.query.lookback);
    const lookback = rawLookback === 30 ? 30 : 14;

    const data = await reportGapService.getReportGapsData({ lookbackDays: lookback });

    res.render('admin/report-gaps/index', {
      summary: data.summary,
      teacherDayGaps: data.teacherDayGaps,
      teacherSilentGaps: data.teacherSilentGaps,
      groupSilentGaps: data.groupSilentGaps,
      noClassDates: data.noClassDates,
      config: data.config,
      lookback,
      formatShortDate,
    });
  } catch (err) {
    console.error('adminReportGapController index error:', err);
    res.status(500).render('error', { message: 'Failed to load report gaps data.' });
  }
};

/* ══════════════════════════════════════════════════════════════
   2. POST /admin/report-gaps/ack
══════════════════════════════════════════════════════════════ */
exports.acknowledge = async (req, res) => {
  try {
    const { kind, teacher, group, date, reason, note } = req.body;

    const validKinds = ['teacher_day', 'teacher_silent', 'group_silent'];
    if (!validKinds.includes(kind)) {
      return res.status(400).json({ ok: false, error: 'Invalid gap kind.' });
    }

    const validReasons = ['no_class', 'holiday', 'leave', 'reported_elsewhere', 'other'];
    if (!validReasons.includes(reason)) {
      return res.status(400).json({ ok: false, error: 'Invalid acknowledgement reason.' });
    }

    let teacherId = null;
    if (teacher && mongoose.Types.ObjectId.isValid(teacher)) {
      teacherId = new mongoose.Types.ObjectId(teacher);
    }

    const groupStr = group ? String(group).trim() : null;
    const dateStr  = date  ? String(date).trim()  : null;

    if (kind === 'teacher_day') {
      if (!teacherId || !dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return res.status(400).json({ ok: false, error: 'Teacher and valid date are required for teacher_day gaps.' });
      }
    } else if (kind === 'teacher_silent') {
      if (!teacherId) {
        return res.status(400).json({ ok: false, error: 'Teacher is required for teacher_silent gaps.' });
      }
    } else if (kind === 'group_silent') {
      if (!groupStr) {
        return res.status(400).json({ ok: false, error: 'Group is required for group_silent gaps.' });
      }
    }

    const ack = await ReportGapAck.findOneAndUpdate(
      {
        kind,
        teacher: teacherId,
        group: groupStr,
        date: dateStr,
      },
      {
        $set: {
          reason,
          note: (note || '').trim().slice(0, 200),
          ackedBy: req.session.user._id,
          ackedByName: req.session.user.displayName || req.session.user.username || 'Admin',
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Audit log
    await AuditLog.create({
      admin: req.session.user._id,
      adminName: req.session.user.displayName || req.session.user.username || 'Admin',
      action: 'report_gap_ack',
      targetType: 'report_gap',
      targetId: null,
      targetLabel: `${kind}: ${teacherId || groupStr || ''} ${dateStr || ''}`.trim(),
      meta: { kind, teacher: teacherId, group: groupStr, date: dateStr, reason, note },
    });

    return res.json({ ok: true, ack });
  } catch (err) {
    console.error('adminReportGapController acknowledge error:', err);
    return res.status(500).json({ ok: false, error: 'Failed to record acknowledgement.' });
  }
};

/* ══════════════════════════════════════════════════════════════
   3. POST /admin/report-gaps/remind
══════════════════════════════════════════════════════════════ */
exports.remindTeacher = async (req, res) => {
  try {
    const { teacherId, gapKind, date, weekday, group } = req.body;

    if (!teacherId || !mongoose.Types.ObjectId.isValid(teacherId)) {
      return res.status(400).json({ ok: false, error: 'Valid teacher ID is required.' });
    }

    const teacher = await User.findById(teacherId).select('displayName username role reportGapReminders');
    if (!teacher || teacher.role !== 'teacher') {
      return res.status(404).json({ ok: false, error: 'Teacher not found.' });
    }

    const now = new Date();
    const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const claimFilter = reportGapService.buildReportGapReminderClaimFilter({
      userId: teacher._id,
      cutoff: cutoff24h,
    });

    const updated = await User.findOneAndUpdate(
      claimFilter,
      {
        $set: { 'reportGapReminders.lastSentAt': now },
      },
      { new: true }
    );

    if (!updated) {
      return res.status(429).json({
        ok: false,
        error: 'A reminder was already sent to this teacher in the last 24 hours.',
      });
    }

    // Compose notification message
    let message;
    if (gapKind === 'teacher_silent') {
      message = 'We noticed no reports have been submitted in the last 10 days. If you taught, please add your reports; if not, ignore this.';
    } else {
      const formattedDate = formatShortDate(date);
      message = `We could not find a report for ${formattedDate || date}. If you taught, please add it; if not, ignore this.`;
    }

    await Notification.create({
      recipient: teacher._id,
      type: 'report_gap_reminder',
      category: 'report',
      title: 'Possible missing report',
      message,
      link: '/reports/new',
      metadata: {
        action: 'report_gap_reminder',
        kind: gapKind || 'teacher_day',
        date: date || null,
        group: group || null,
        adminTriggered: true,
      },
    });

    await AuditLog.create({
      admin: req.session.user._id,
      adminName: req.session.user.displayName || req.session.user.username || 'Admin',
      action: 'report_gap_remind',
      targetType: 'user',
      targetId: teacher._id,
      targetLabel: teacher.displayName || teacher.username,
      meta: {
        gapKind: gapKind || 'teacher_day',
        date: date || null,
        weekday: weekday || null,
        group: group || null,
        message,
      },
    });

    return res.json({ ok: true, message: 'Reminder sent to teacher.' });
  } catch (err) {
    console.error('adminReportGapController remindTeacher error:', err);
    return res.status(500).json({ ok: false, error: 'Failed to send reminder.' });
  }
};

/* ══════════════════════════════════════════════════════════════
   4. POST /admin/report-gaps/no-class-dates
══════════════════════════════════════════════════════════════ */
exports.addNoClassDate = async (req, res) => {
  try {
    const { from, to, label } = req.body;

    if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      return res.status(400).json({ ok: false, error: 'Valid "from" date (YYYY-MM-DD) is required.' });
    }
    if (!to || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ ok: false, error: 'Valid "to" date (YYYY-MM-DD) is required.' });
    }
    if (from > to) {
      return res.status(400).json({ ok: false, error: '"from" date cannot be after "to" date.' });
    }
    const cleanLabel = (label || '').trim();
    if (!cleanLabel) {
      return res.status(400).json({ ok: false, error: 'Label is required.' });
    }
    if (cleanLabel.length > 80) {
      return res.status(400).json({ ok: false, error: 'Label max 80 characters.' });
    }

    const doc = await NoClassDate.create({
      from,
      to,
      label: cleanLabel,
      createdBy: req.session.user._id,
    });

    await AuditLog.create({
      admin: req.session.user._id,
      adminName: req.session.user.displayName || req.session.user.username || 'Admin',
      action: 'no_class_date_add',
      targetType: 'no_class_date',
      targetId: doc._id,
      targetLabel: doc.label,
      meta: { from, to, label: doc.label },
    });

    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ ok: true, doc });
    }
    return res.redirect('/admin/report-gaps');
  } catch (err) {
    console.error('adminReportGapController addNoClassDate error:', err);
    return res.status(500).json({ ok: false, error: 'Failed to add no-class date.' });
  }
};

/* ══════════════════════════════════════════════════════════════
   5. POST /admin/report-gaps/no-class-dates/:id/delete
══════════════════════════════════════════════════════════════ */
exports.deleteNoClassDate = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid ID.' });
    }

    const doc = await NoClassDate.findByIdAndDelete(id);
    if (!doc) {
      return res.status(404).json({ ok: false, error: 'No-class date not found.' });
    }

    await AuditLog.create({
      admin: req.session.user._id,
      adminName: req.session.user.displayName || req.session.user.username || 'Admin',
      action: 'no_class_date_delete',
      targetType: 'no_class_date',
      targetId: doc._id,
      targetLabel: doc.label,
      meta: { from: doc.from, to: doc.to, label: doc.label },
    });

    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ ok: true });
    }
    return res.redirect('/admin/report-gaps');
  } catch (err) {
    console.error('adminReportGapController deleteNoClassDate error:', err);
    return res.status(500).json({ ok: false, error: 'Failed to delete no-class date.' });
  }
};

