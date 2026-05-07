require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const methodOverride = require('method-override');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const reportRoutes = require('./routes/reports');
const authRoutes = require('./routes/auth');
const profileRoutes = require('./routes/profile');
const { requireAuth } = require('./middleware/auth');

const app = express();
app.set('trust proxy', 1); // fix #2

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/daily_teaching_report';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// [FIX 1] Security headers via Helmet
app.use(helmet({
  contentSecurityPolicy: process.env.NODE_ENV === 'production'
    ? {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "'unsafe-eval'",
          "https://cdn.tailwindcss.com",
          "https://*.tailwindcss.com"
        ],
        scriptSrcAttr: ["'unsafe-inline'"],  // ← ini fix-nya
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://cdn.tailwindcss.com",
          "https://*.tailwindcss.com",
          "https://fonts.googleapis.com"
        ],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https://res.cloudinary.com"],  // ← tambah cloudinary
        connectSrc: ["'self'", "https://*.tailwindcss.com"],
      },
    }
    : false,
}));

// [FIX 2] Rate limiting - login brute force protection
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: 'Too many login attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// [FIX 3] General API rate limit
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(generalLimiter);

// [FIX 4] Body size limit to prevent DoS via large payloads
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(express.json({ limit: '10kb' }));
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'teaching-report-secret-key',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: MONGO_URI }),
  name: 'sid', // [FIX 5] Hide default 'connect.sid' session name
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7,
    httpOnly: true,          // [FIX 6] Prevent JS access to cookie
    secure: process.env.NODE_ENV === 'production', // [FIX 7] HTTPS-only in prod
    sameSite: 'lax',         // [FIX 8] CSRF protection via SameSite
  }
}));

// Apply login rate limiter specifically to login route
app.use('/auth/login', loginLimiter);

// Make user available in all views + track last active
app.use(async (req, res, next) => {
  if (!req.session.user) {
    res.locals.currentUser = null;
    return next();
  }
  const now = Date.now();
  const lastTracked = req.session._lastTracked || 0;
  const needsUpdate = now - lastTracked > 60000;

  try {
    const User = require('./models/User');
    if (needsUpdate) {
      req.session._lastTracked = now;
      await User.findByIdAndUpdate(req.session.user._id, { lastActiveAt: new Date() });
    }
    // Always fetch fresh user data for dropdown (workingExperience, profilePicture, lastActiveAt)
    const user = await User.findById(req.session.user._id).select('username displayName role workingExperience profilePicture lastActiveAt');
    res.locals.currentUser = user || null;
  } catch (e) {
    res.locals.currentUser = req.session.user || null;
  }
  next();
});

app.use('/auth', authRoutes);
app.use('/reports', requireAuth, reportRoutes);
app.use('/profile', requireAuth, profileRoutes);
app.get('/score-calculator', requireAuth, (req, res) => res.render('score-calculator'));
app.get('/', (req, res) => res.redirect('/reports'));

app.use((req, res) => res.status(404).render('error', { message: 'Page not found.' }));
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('error', { message: 'Internal server error.' });
});

app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));