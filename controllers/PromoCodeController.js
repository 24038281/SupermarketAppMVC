const PromoCode = require('../models/PromoCode');

function parseNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const num = Number(value);
  return Number.isNaN(num) ? fallback : num;
}

function parseDate(value) {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

module.exports = {
  model: PromoCode,

  // GET /promocodes
  list: async (req, res) => {
    try {
      const promos = await PromoCode.find({}).lean();
      res.json(promos);
    } catch (err) {
      console.error('Failed to list promo codes', err);
      res.status(500).json({ message: 'Unable to list promo codes' });
    }
  },

  // GET /promocodes/:id
  get: async (req, res) => {
    try {
      const promo = await PromoCode.findById(req.params.id).lean();
      if (!promo) return res.status(404).json({ message: 'Promo code not found' });
      res.json(promo);
    } catch (err) {
      console.error('Failed to fetch promo code', err);
      res.status(500).json({ message: 'Unable to fetch promo code' });
    }
  },

  // POST /promocodes
  create: async (req, res) => {
    try {
      const payload = {
        code: (req.body.code || '').trim().toUpperCase(),
        description: req.body.description || '',
        discountType: req.body.discountType,
        discountValue: parseNumber(req.body.discountValue, 0),
        minOrderAmount: parseNumber(req.body.minOrderAmount, 0),
        startDate: parseDate(req.body.startDate),
        endDate: parseDate(req.body.endDate),
        maxUses: parseNumber(req.body.maxUses),
        active: req.body.active !== undefined ? Boolean(req.body.active) : true
      };

      if (!payload.code || !payload.discountType || !payload.discountValue) {
        return res.status(400).json({ message: 'code, discountType and discountValue are required' });
      }

      const created = await PromoCode.create(payload);
      res.status(201).json(created);
    } catch (err) {
      console.error('Failed to create promo code', err);
      const status = err.code === 11000 ? 409 : 500; // handle duplicate code
      res.status(status).json({ message: 'Unable to create promo code' });
    }
  },

  // PUT /promocodes/:id
  update: async (req, res) => {
    try {
      const updates = {
        ...(req.body.code !== undefined ? { code: (req.body.code || '').trim().toUpperCase() } : {}),
        ...(req.body.description !== undefined ? { description: req.body.description } : {}),
        ...(req.body.discountType !== undefined ? { discountType: req.body.discountType } : {}),
        ...(req.body.discountValue !== undefined ? { discountValue: parseNumber(req.body.discountValue, 0) } : {}),
        ...(req.body.minOrderAmount !== undefined ? { minOrderAmount: parseNumber(req.body.minOrderAmount, 0) } : {}),
        ...(req.body.startDate !== undefined ? { startDate: parseDate(req.body.startDate) } : {}),
        ...(req.body.endDate !== undefined ? { endDate: parseDate(req.body.endDate) } : {}),
        ...(req.body.maxUses !== undefined ? { maxUses: parseNumber(req.body.maxUses) } : {}),
        ...(req.body.active !== undefined ? { active: Boolean(req.body.active) } : {}),
      };

      const updated = await PromoCode.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true, lean: true });
      if (!updated) return res.status(404).json({ message: 'Promo code not found' });
      res.json(updated);
    } catch (err) {
      console.error('Failed to update promo code', err);
      const status = err.code === 11000 ? 409 : 500;
      res.status(status).json({ message: 'Unable to update promo code' });
    }
  },

  // DELETE /promocodes/:id
  remove: async (req, res) => {
    try {
      const deleted = await PromoCode.findByIdAndDelete(req.params.id).lean();
      if (!deleted) return res.status(404).json({ message: 'Promo code not found' });
      res.json({ success: true });
    } catch (err) {
      console.error('Failed to delete promo code', err);
      res.status(500).json({ message: 'Unable to delete promo code' });
    }
  }
};
