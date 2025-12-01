const Supplier = require('../models/Supplier');

const notImplemented = (req, res) => res.status(501).json({ message: 'Not implemented' });

module.exports = {
  model: Supplier,
  list: notImplemented,
  get: notImplemented,
  create: notImplemented,
  update: notImplemented,
  remove: notImplemented
};
