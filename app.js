require('dotenv').config();  // ← tambahkan ini
const express = require('express');
const mongoose = require('mongoose');
// ... sisa kode sama
const path = require('path');
const methodOverride = require('method-override');

const reportRoutes = require('./routes/reports');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/daily_teaching_report';

// Connect to MongoDB
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB connected successfully'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// View Engine Setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/reports', reportRoutes);

// Dashboard redirect
app.get('/', (req, res) => res.redirect('/reports'));

// 404 Handler
app.use((req, res) => {
  res.status(404).render('error', { message: 'Halaman tidak ditemukan.' });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('error', { message: 'Terjadi kesalahan server.' });
});

app.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});
