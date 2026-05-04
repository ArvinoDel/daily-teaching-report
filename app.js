require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const methodOverride = require('method-override');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');

const reportRoutes = require('./routes/reports');
const authRoutes = require('./routes/auth');
const { requireAuth } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/daily_teaching_report';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'teaching-report-secret-key',
  resave: false,
  saveUninitialized: false,
  store: new MongoStore({ mongoUrl: MONGO_URI }),
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

// Make user available in all views
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  next();
});

app.use('/auth', authRoutes);
app.use('/reports', requireAuth, reportRoutes);
app.get('/score-calculator', requireAuth, (req, res) => res.render('score-calculator'));
app.get('/', (req, res) => res.redirect('/reports'));

app.use((req, res) => res.status(404).render('error', { message: 'Page not found.' }));
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('error', { message: 'Internal server error.' });
});

app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));