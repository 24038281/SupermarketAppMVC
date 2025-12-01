const Product = require('../models/Product');

const notImplemented = (req, res) => res.status(501).json({ message: 'Not implemented' });

module.exports = {
  model: Product,
  list: notImplemented,
  get: notImplemented,
  create: notImplemented,
  update: notImplemented,
  remove: notImplemented
};
