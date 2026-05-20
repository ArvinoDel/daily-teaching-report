const Feedback = require('../models/Feedback');
const cloudinary = require('cloudinary').v2;

// Cloudinary configuration for deleting screenshots
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Handle feedback submission from error/feedback form (Public/GUEST & Auth users)
 */
exports.submitFeedback = async (req, res) => {
  try {
    const { description, submitterName, submitterEmail, pageUrl } = req.body;
    const errors = [];

    if (!description || !description.trim()) {
      errors.push('Deskripsi error wajib diisi.');
    }

    const isLoggedIn = !!req.session.user;
    
    // If not logged in, submitterName is required
    if (!isLoggedIn && (!submitterName || !submitterName.trim())) {
      errors.push('Nama wajib diisi jika kamu tidak masuk.');
    }

    if (errors.length > 0) {
      // If there are errors and a file was uploaded to Cloudinary, clean it up
      if (req.file && req.file.filename) {
        await cloudinary.uploader.destroy(req.file.filename);
      }
      return res.status(400).json({ ok: false, errors });
    }

    const feedbackData = {
      description: description.trim(),
      pageUrl: pageUrl || '',
      status: 'pending',
    };

    if (isLoggedIn) {
      feedbackData.user = req.session.user._id;
    } else {
      feedbackData.submitterName = submitterName.trim();
      feedbackData.submitterEmail = submitterEmail ? submitterEmail.trim() : '';
    }

    if (req.file) {
      feedbackData.screenshotUrl = req.file.path; // Cloudinary URL
      feedbackData.cloudinaryId = req.file.filename; // Cloudinary public ID
    }

    await Feedback.create(feedbackData);
    return res.json({ ok: true });
  } catch (err) {
    console.error('Error submitting feedback:', err);
    // Cleanup upload if error occurs
    if (req.file && req.file.filename) {
      try {
        await cloudinary.uploader.destroy(req.file.filename);
      } catch (e) {
        console.error('Failed to cleanup file:', e);
      }
    }
    return res.status(500).json({ ok: false, errors: ['Terjadi kesalahan pada server. Coba lagi nanti.'] });
  }
};

/**
 * Render admin feedbacks view directory
 */
exports.adminList = async (req, res) => {
  try {
    const feedbacks = await Feedback.find()
      .populate('user', 'username displayName role profilePicture')
      .sort({ createdAt: -1 });

    res.render('admin/feedbacks/index', {
      title: 'Admin Feedbacks',
      feedbacks,
    });
  } catch (err) {
    console.error('Error listing feedbacks:', err);
    res.status(500).render('error', { message: 'Gagal memuat daftar laporan error.' });
  }
};

/**
 * Update feedback status (pending, resolved, ignored)
 */
exports.adminUpdateStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['pending', 'resolved', 'ignored'].includes(status)) {
      return res.status(400).render('error', { message: 'Status tidak valid.' });
    }

    await Feedback.findByIdAndUpdate(id, { status });
    res.redirect('/admin/feedbacks');
  } catch (err) {
    console.error('Error updating feedback status:', err);
    res.status(500).render('error', { message: 'Gagal memperbarui status laporan.' });
  }
};

/**
 * Delete feedback (includes Cloudinary asset cleanup)
 */
exports.adminDelete = async (req, res) => {
  try {
    const { id } = req.params;
    const feedback = await Feedback.findById(id);

    if (!feedback) {
      return res.status(404).render('error', { message: 'Laporan tidak ditemukan.' });
    }

    // If there is an associated Cloudinary asset, delete it
    if (feedback.cloudinaryId) {
      try {
        await cloudinary.uploader.destroy(feedback.cloudinaryId);
      } catch (cloudinaryErr) {
        console.error('Failed to delete asset from Cloudinary:', cloudinaryErr);
      }
    }

    await Feedback.findByIdAndDelete(id);
    res.redirect('/admin/feedbacks');
  } catch (err) {
    console.error('Error deleting feedback:', err);
    res.status(500).render('error', { message: 'Gagal menghapus laporan.' });
  }
};
