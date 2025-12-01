const mongoose = require('../config/db');

const studentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String },
    cohort: { type: String }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Student', studentSchema);
