const User = require('../models/User');
const cloudinary = require('cloudinary').v2;

// GET /profile/edit
exports.editForm = async (req, res) => {
  try {
    const user = await User.findById(req.session.user._id);
    if (!user) return res.render('error', { message: 'User not found.' });
    res.render('profile/edit', { user, errors: [], success: null });
  } catch (err) {
    res.render('error', { message: 'Something went wrong.' });
  }
};

// POST /profile/edit
exports.update = async (req, res) => {
  try {
    const { username, password, password_confirm, workingExperience } = req.body;
    const user = await User.findById(req.session.user._id);
    if (!user) return res.render('error', { message: 'User not found.' });

    const errors = [];

    // Validate username
    if (!username || username.trim().length < 3) {
      errors.push('Username must be at least 3 characters.');
    } else if (username.trim().length > 30) {
      errors.push('Username max 30 characters.');
    } else {
      const existing = await User.findOne({ username: username.toLowerCase().trim(), _id: { $ne: user._id } });
      if (existing) errors.push('Username already taken.');
    }

    // Validate working experience
    const exp = Number(workingExperience);
    if (isNaN(exp) || exp < 0 || exp > 60) {
      errors.push('Working experience must be between 0 and 60 years.');
    }

    // Validate password if provided
    if (password && password.length > 0) {
      if (password.length < 6) errors.push('Password must be at least 6 characters.');
      if (password !== password_confirm) errors.push('Passwords do not match.');
    }

    if (errors.length > 0) {
      // Kalau ada error, hapus file yang sudah terupload ke Cloudinary
      if (req.file && req.file.filename) {
        await cloudinary.uploader.destroy(req.file.filename);
      }
      return res.render('profile/edit', { user, errors, success: null });
    }

    // Apply updates
    user.username = username.toLowerCase().trim();
    user.workingExperience = exp;

    if (password && password.length > 0) {
      user.password = password;
    }

    if (req.file) {
      // Hapus foto lama dari Cloudinary kalau ada
      if (user.cloudinaryId) {
        await cloudinary.uploader.destroy(user.cloudinaryId);
      }
      // Simpan URL dan public_id baru
      user.profilePicture = req.file.path;
      user.cloudinaryId   = req.file.filename;
    }

    await user.save();

    // Update session
    req.session.user.username       = user.username;
    req.session.user.profilePicture = user.profilePicture;

    return res.render('profile/edit', { user, errors: [], success: 'Profile updated successfully!' });

  } catch (err) {
    console.error(err);
    const user = await User.findById(req.session.user._id);
    res.render('profile/edit', { user, errors: ['Something went wrong. Please try again.'], success: null });
  }
};