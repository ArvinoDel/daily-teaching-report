require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const methodOverride = require('method-override');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const compression = require('compression'); // ⚡ gzip compression

const csrfProtection = require('./middleware/csrf');
const reportRoutes   = require('./routes/reports');
const authRoutes     = require('./routes/auth');
const profileRoutes  = require('./routes/profile');
const adminRoutes    = require('./routes/admin');
const feedbackRoutes = require('./routes/feedback');
const notificationRoutes = require('./routes/notifications');
const publicCardRoutes   = require('./routes/publicCard');
const Notification   = require('./models/Notification');
const Feedback = require('./models/Feedback');
const { requireAuth } = require('./middleware/auth');

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/daily_teaching_report';
// Public base URL for QR codes — set APP_BASE_URL in .env for a tunnel/production URL.
// Falls back to the current request origin dynamically (see app.locals middleware below).
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/$/, '');

// Enforce SESSION_SECRET — refuse to start with the insecure default
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.error('❌ SESSION_SECRET environment variable is required. Add it to your .env file.');
  process.exit(1);
}

mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 8000,
  maxPoolSize: 20, // ⚡ allow more concurrent DB operations (default is 5)
  minPoolSize: 5,
})
  .then(() => {
    console.log('✅ MongoDB connected');
    // Initialize weekly backup scheduler
    const backupService = require('./services/backupService');
    backupService.initScheduler();
  })
  .catch(err => console.error('❌ MongoDB error:', err));

// ⚡ Enable EJS view caching in production (templates compiled once, reused)
if (process.env.NODE_ENV === 'production') {
  app.set('view cache', true);
}

// Security headers via Helmet
app.use(helmet({
  contentSecurityPolicy: process.env.NODE_ENV === 'production'
    ? {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "'unsafe-eval'",
          "blob:",
          "data:",
          "https://cdn.tailwindcss.com",
          "https://*.tailwindcss.com",
          "https://cdn.jsdelivr.net",
          "https://cdnjs.cloudflare.com",
          "https://unpkg.com"
        ],
        workerSrc: ["'self'", "blob:", "data:", "https://cdn.jsdelivr.net"],
        childSrc: ["'self'", "blob:", "data:", "https://cdn.jsdelivr.net"],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://cdn.tailwindcss.com",
          "https://*.tailwindcss.com",
          "https://fonts.googleapis.com",
          "https://cdn.jsdelivr.net"
        ],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "blob:", "https://res.cloudinary.com"],
        connectSrc: [
          "'self'",
          "blob:",
          "data:",
          "https://*.tailwindcss.com",
          "https://cdn.jsdelivr.net",
          "https://tessdata.projectnaptha.com",
          "https://raw.githubusercontent.com"
        ],
      },
    }
    : false,
}));

// Rate limiting - login brute force protection
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many login attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// General API rate limit
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(generalLimiter);
app.use(compression()); // ⚡ gzip all responses — reduces page size by 70–85%

// Body size limits — 10MB to accommodate image uploads & large JSON payloads
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
// Only allow method override via POST body hidden field (not query string)
app.use(methodOverride(function (req) {
  if (req.body && typeof req.body === 'object' && '_method' in req.body) {
    const method = req.body._method;
    delete req.body._method;
    return method;
  }
}));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '7d',    // ⚡ browsers cache static files for 7 days — zero re-fetches on repeat visits
  etag:   true,
}));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: MONGO_URI }),
  name: 'sid',
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  }
}));

// CSRF protection — must come after session middleware
app.use(csrfProtection);

// Apply login rate limiter specifically to login route
app.use('/auth/login', loginLimiter);

// Make user available in all views + track last active
app.use(async (req, res, next) => {
  if (!req.session.user) {
    res.locals.currentUser = null;
    return next();
  }
  const now = Date.now();
  const lastTracked    = req.session._lastTracked    || 0;
  const lastNotifCheck = req.session._lastNotifCheck || 0;
  const needsTrackUpdate  = now - lastTracked    > 60000;  // 1-min debounce (unchanged)
  const needsNotifRefresh = now - lastNotifCheck > 15000;  // Bug #10 fix: 15-sec cache

  try {
    const User = require('./models/User');
    // Always fetch fresh user data for nav dropdown; only hit notification count every 15 s
    const parallelOps = [
      User.findById(req.session.user._id).select('username displayName role joinDate commission profilePicture lastActiveAt'),
      needsNotifRefresh
        ? Notification.countDocuments({ recipient: req.session.user._id, isRead: false })
        : Promise.resolve(null),
    ];
    if (needsTrackUpdate) {
      req.session._lastTracked = now;
      parallelOps.push(User.findByIdAndUpdate(req.session.user._id, { lastActiveAt: new Date() }));
    }

    const [user, notifResult] = await Promise.all(parallelOps);
    res.locals.currentUser = user || null;

    if (needsNotifRefresh && notifResult !== null) {
      req.session._cachedUnreadCount = notifResult || 0;
      req.session._lastNotifCheck    = now;
    }
    res.locals.unreadNotificationCount = req.session._cachedUnreadCount || 0;
  } catch (e) {
    res.locals.currentUser = req.session.user || null;
    res.locals.unreadNotificationCount = 0;
  }
  next();
});

// Inject baseUrl into every response — used by QR code generator in views
app.use((req, res, next) => {
  res.locals.baseUrl = APP_BASE_URL || (req.protocol + '://' + req.get('host'));
  next();
});

app.use('/auth',    authRoutes);
app.use('/reports', requireAuth, reportRoutes);
app.use('/profile', requireAuth, profileRoutes);
app.use('/notifications', requireAuth, notificationRoutes);
app.use('/admin',   adminRoutes);
app.use('/feedback', feedbackRoutes);
// Public (unauthenticated) routes — student card view via QR/camera scan
app.use('/', publicCardRoutes);
app.get('/score-calculator', requireAuth, (req, res) => res.render('score-calculator'));
app.get('/', (req, res) => res.redirect('/reports'));


app.use((req, res) => {
  res.locals.currentUser = res.locals.currentUser || null;
  res.locals.csrfToken = res.locals.csrfToken || (req.session && req.session.csrfToken) || '';
  if (req.path.includes('/api/') || (req.headers.accept && req.headers.accept.includes('application/json'))) {
    return res.status(404).json({ error: 'Endpoint not found.' });
  }
  res.status(404).render('error', { message: 'Page not found.' });
});


// Multer & General error handler
app.use(async (err, req, res, next) => {
  res.locals.currentUser = res.locals.currentUser || null;
  res.locals.csrfToken = res.locals.csrfToken || (req.session && req.session.csrfToken) || '';

  if (err instanceof multer.MulterError) {
    let message = 'File upload error.';
    if (err.code === 'LIMIT_FILE_SIZE') message = 'File too large. Maximum size is 2MB.';
    if (err.code === 'LIMIT_UNEXPECTED_FILE') message = 'Unexpected file field.';
    if (req.path.includes('/api/') || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(400).json({ error: message });
    }
    return res.status(400).render('error', { message });
  }

  console.error(err.stack);

  // Auto-log server errors (non-4xx) into the Feedback collection
  // so they appear in /admin/feedbacks without any manual reporting.
  const statusCode = err.status || err.statusCode || 500;
  if (statusCode >= 500) {
    try {
      const userId = req.session && req.session.user ? req.session.user._id : null;
      const userName = req.session && req.session.user ? req.session.user.username : null;

      await Feedback.create({
        description: [
          `[AUTO] ${err.message || 'Unknown error'}`,
          ``,
          `Route: ${req.method} ${req.originalUrl}`,
          userName ? `User: ${userName}` : `User: (not logged in)`,
          ``,
          `Stack:`,
          err.stack || '(no stack trace)',
        ].join('\n'),
        pageUrl: req.originalUrl,
        submitterName: 'System (auto)',
        ...(userId && { user: userId }),
        source: 'system',
        status: 'pending',
      });
    } catch (feedbackErr) {
      // Never let feedback saving crash the error handler itself
      console.error('[AutoFeedback] Failed to save error to Feedback:', feedbackErr.message);
    }
  }

  if (req.path.includes('/api/') || (req.headers.accept && req.headers.accept.includes('application/json'))) {
    return res.status(statusCode).json({ error: err.message || 'Internal server error.' });
  }
  res.status(500).render('error', { message: 'Internal server error.' });
});

if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
}

module.exports = app;