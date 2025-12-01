const Student = require('../models/Student');

const notImplemented = (req, res) => res.status(501).json({ message: 'Not implemented' });

module.exports = {
  model: Student,
  list: notImplemented,
  get: notImplemented,
  create: notImplemented,
  update: notImplemented,
  remove: notImplemented
};
