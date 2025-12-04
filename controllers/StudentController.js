const Student = require('../models/Student');

const methodNotAllowed = (req, res) => res.status(405).json({ message: 'Not allowed' });

module.exports = {
  model: Student,
  list: methodNotAllowed,
  get: methodNotAllowed,
  create: methodNotAllowed,
  update: methodNotAllowed,
  remove: methodNotAllowed
};
