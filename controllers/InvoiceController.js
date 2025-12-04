const connection = require('../config/db');
const Invoice = require('../models/Invoice'); // kept for interface consistency

// List invoices (basic JSON)
function list(req, res) {
  connection.query('SELECT * FROM invoices ORDER BY created_at DESC', (err, rows) => {
    if (err) {
      console.error('Invoice list failed', err);
      return res.status(500).json({ message: 'Unable to fetch invoices' });
    }
    res.json(rows || []);
  });
}

// Get single invoice by id
function get(req, res) {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ message: 'Invalid invoice id' });

  connection.query('SELECT * FROM invoices WHERE id = ?', [id], (err, rows) => {
    if (err) {
      console.error('Invoice fetch failed', err);
      return res.status(500).json({ message: 'Unable to fetch invoice' });
    }
    if (!rows || !rows.length) return res.status(404).json({ message: 'Invoice not found' });
    res.json(rows[0]);
  });
}

// Creation/updation/deletion are not exposed here to avoid altering existing flows
const methodNotAllowed = (req, res) => res.status(405).json({ message: 'Not allowed' });

module.exports = {
  model: Invoice,
  list,
  get,
  create: methodNotAllowed,
  update: methodNotAllowed,
  remove: methodNotAllowed
};
