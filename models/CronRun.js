'use strict';

const mongoose = require('mongoose');

const cronRunSchema = new mongoose.Schema({
  job: {
    type: String,
    enum: ['backup', 'backup-cleanup', 'manual-prune'],
    required: true,
  },
  trigger: {
    type: String,
    enum: ['vercel-cron', 'scheduler', 'manual'],
    required: true,
  },
  startedAt: {
    type: Date,
    required: true,
    default: Date.now,
  },
  finishedAt: {
    type: Date,
    default: null,
  },
  ok: {
    type: Boolean,
    required: true,
    default: true,
  },
  durationMs: {
    type: Number,
    default: 0,
  },
  summary: {
    type: mongoose.Schema.Types.Mixed,
    default: () => ({}),
  },
  error: {
    type: String,
    maxlength: 300,
    default: null,
  },
}, { timestamps: true });

// TTL index of 120 days on startedAt
cronRunSchema.index({ startedAt: 1 }, { expireAfterSeconds: 120 * 24 * 60 * 60 });

// Compound index on (job, startedAt desc)
cronRunSchema.index({ job: 1, startedAt: -1 });

module.exports = mongoose.model('CronRun', cronRunSchema);

