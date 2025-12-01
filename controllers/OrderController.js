const Order = require('../models/Order');

const notImplemented = (req, res) => res.status(501).json({ message: 'Not implemented' });

module.exports = {
  model: Order,
  list: notImplemented,
  get: notImplemented,
  create: notImplemented,
  update: notImplemented,
  remove: notImplemented
};
