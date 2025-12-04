const Loyalty = require('../models/Loyalty');

const methodNotAllowed = (req, res) => res.status(405).json({ message: 'Not allowed' });

module.exports = {
  model: Loyalty,
  list: methodNotAllowed,
  get: methodNotAllowed,
  create: methodNotAllowed,
  update: methodNotAllowed,
  remove: methodNotAllowed
};
