const Category = require('../models/Category');

const methodNotAllowed = (req, res) => res.status(405).json({ message: 'Not allowed' });

module.exports = {
  model: Category,
  list: methodNotAllowed,
  get: methodNotAllowed,
  create: methodNotAllowed,
  update: methodNotAllowed,
  remove: methodNotAllowed
};
