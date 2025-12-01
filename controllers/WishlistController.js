const Wishlist = require('../models/Wishlist');

const notImplemented = (req, res) => res.status(501).json({ message: 'Not implemented' });

module.exports = {
  model: Wishlist,
  list: notImplemented,
  get: notImplemented,
  create: notImplemented,
  update: notImplemented,
  remove: notImplemented
};
