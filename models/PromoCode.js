const mongoose = require('../config/db');

const promoCodeSchema = new mongoose.Schema({
  code: { type: String, unique: true, required: true },
  description: String,
  discountType: { type: String, enum: ['percentage', 'fixed'], required: true },
  discountValue: { type: Number, required: true },
  minOrderAmount: { type: Number, default: 0 },
  startDate: Date,
  endDate: Date,
  maxUses: Number,
  usedCount: { type: Number, default: 0 },
  active: { type: Boolean, default: true }
});

module.exports = mongoose.model('PromoCode', promoCodeSchema);
