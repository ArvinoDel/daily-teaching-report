const mongoose = require('mongoose');

// Canonical level order (used for sorting in UI)
const LEVELS = [
  'EMS', 'EML',
  'B1', 'B2',
  'E1', 'E2', 'E3', 'E4', 'E5', 'E6',
  'PI',
  'I1', 'I2', 'I3',
  'PA',
  'A1', 'A2', 'A3',
];

// Human-readable category per level code
const LEVEL_LABELS = {
  EMS: 'Sunshine',  EML: 'Moonlight',
  B1:  'Beginner',  B2:  'Beginner',
  E1:  'Elementary', E2: 'Elementary', E3: 'Elementary',
  E4:  'Elementary', E5: 'Elementary', E6: 'Elementary',
  PI:  'Pre-Intermediate',
  I1:  'Intermediate', I2: 'Intermediate', I3: 'Intermediate',
  PA:  'Pre-Advanced',
  A1:  'Advanced',  A2:  'Advanced',  A3:  'Advanced',
};

const groupSchema = new mongoose.Schema({
  group_name: {
    type:      String,
    required:  [true, 'Group name is required.'],
    trim:      true,
    maxlength: [100, 'Group name max 100 characters.'],
  },
  type: {
    type:     String,
    enum:     ['GROUP', 'PRIVATE'],
    required: [true, 'Type is required.'],
    default:  'GROUP',
  },
  level: {
    type:      String,
    trim:      true,
    maxlength: [50, 'Level max 50 characters.'],
    default:   '',
  },
  students: {
    type:    [String],
    default: [],
  },
}, { timestamps: true });

const Group = mongoose.model('Group', groupSchema);
module.exports        = Group;
module.exports.LEVELS       = LEVELS;
module.exports.LEVEL_LABELS = LEVEL_LABELS;