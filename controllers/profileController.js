const User = require('../models/User');
const cloudinary = require('cloudinary').v2;

// GET /profile/edit
exports.editForm = async (req, res) => {
  try {
    const user = await User.findById(req.session.user._id);
    if (!user) return res.render('error', { message: 'User not found.' });
    const currentYear = new Date().getFullYear();
    res.render('profile/edit', { user, errors: [], success: null, currentYear });
  } catch (err) {
    res.render('error', { message: 'Something went wrong.' });
  }
};

// POST /profile/edit
exports.update = async (req, res) => {
  const currentYear = new Date().getFullYear();

  try {
    const { username, password, password_confirm, joinMonth, joinYear } = req.body;
    const user = await User.findById(req.session.user._id);
    if (!user) return res.render('error', { message: 'User not found.' });

    const errors = [];

    // Validate username
    if (!username || username.trim().length < 3) {
      errors.push('Username must be at least 3 characters.');
    } else if (username.trim().length > 30) {
      errors.push('Username max 30 characters.');
    } else {
      const existing = await User.findOne({
        username: username.toLowerCase().trim(),
        _id: { $ne: user._id },
      });
      if (existing) errors.push('Username already taken.');
    }

    // Validate join date
    let parsedJoinDate = user.joinDate || null;
    if (joinMonth && joinYear) {
      const m = parseInt(joinMonth);
      const y = parseInt(joinYear);
      if (isNaN(m) || isNaN(y) || m < 1 || m > 12 || y < 1970 || y > currentYear) {
        errors.push('Join date is not valid.');
      } else {
        parsedJoinDate = new Date(y, m - 1, 1);
        if (parsedJoinDate > new Date()) {
          parsedJoinDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
        }
      }
    }

    // Validate commission prices
    const commFields = ['primeFull', 'primeAssisted', 'halfPrime', 'assistant'];
    const commValues = {};
    for (const field of commFields) {
      const raw = req.body[`commission_${field}`];
      const val = raw !== undefined && raw !== '' ? Number(raw) : 0;
      if (isNaN(val) || val < 0) {
        errors.push(`Commission price for ${field} must be 0 or more.`);
      } else {
        commValues[field] = Math.round(val);
      }
    }

    // Validate password if provided
    if (password && password.length > 0) {
      if (password.length < 6) errors.push('Password must be at least 6 characters.');
      if (password !== password_confirm) errors.push('Passwords do not match.');
    }

    if (errors.length > 0) {
      if (req.file && req.file.filename) {
        await cloudinary.uploader.destroy(req.file.filename);
      }
      return res.render('profile/edit', { user, errors, success: null, currentYear });
    }

    // Apply updates
    user.username  = username.toLowerCase().trim();
    user.joinDate  = parsedJoinDate;
    user.commission = {
      primeFull:     commValues.primeFull     ?? user.commission?.primeFull     ?? 0,
      primeAssisted: commValues.primeAssisted ?? user.commission?.primeAssisted ?? 0,
      halfPrime:     commValues.halfPrime     ?? user.commission?.halfPrime     ?? 0,
      assistant:     commValues.assistant     ?? user.commission?.assistant     ?? 0,
    };

    if (password && password.length > 0) {
      user.password = password;
    }

    if (req.file) {
      if (user.cloudinaryId) {
        await cloudinary.uploader.destroy(user.cloudinaryId);
      }
      user.profilePicture = req.file.path;
      user.cloudinaryId   = req.file.filename;
    }

    await user.save();

    // Update session
    req.session.user.username       = user.username;
    req.session.user.profilePicture = user.profilePicture;

    return res.render('profile/edit', { user, errors: [], success: 'Profile updated successfully!', currentYear });

  } catch (err) {
    console.error(err);
    const user = await User.findById(req.session.user._id);
    res.render('profile/edit', {
      user,
      errors: ['Something went wrong. Please try again.'],
      success: null,
      currentYear,
    });
  }
};