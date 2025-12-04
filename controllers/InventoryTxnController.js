const InventoryTxn = require('../models/InventoryTxn');

const methodNotAllowed = (req, res) => res.status(405).json({ message: 'Not allowed' });

module.exports = {
  model: InventoryTxn,
  list: methodNotAllowed,
  get: methodNotAllowed,
  create: methodNotAllowed,
  update: methodNotAllowed,
  remove: methodNotAllowed
};
