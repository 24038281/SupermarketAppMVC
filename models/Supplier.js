const mongoose = require('../config/db');

const supplierSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: String,
  phone: String,
  address: String,
}, { timestamps: true });

module.exports = mongoose.model('Supplier', supplierSchema);
