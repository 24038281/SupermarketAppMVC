const Order = require('../models/Order'); // kept for interface consistency (legacy mongoose)
const connection = require('../config/db');

// List all orders (basic JSON), ordered newest first
function list(req, res) {
  connection.query('SELECT * FROM orders ORDER BY created_at DESC', (err, rows) => {
    if (err) {
      console.error('Order list failed', err);
      return res.status(500).json({ message: 'Unable to fetch orders' });
    }
    res.json(rows || []);
  });
}

// Get single order with its items
function get(req, res) {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ message: 'Invalid order id' });

  connection.query('SELECT * FROM orders WHERE id = ?', [id], (err, orderRows) => {
    if (err) {
      console.error('Order fetch failed', err);
      return res.status(500).json({ message: 'Unable to fetch order' });
    }
    if (!orderRows || !orderRows.length) return res.status(404).json({ message: 'Order not found' });
    const order = orderRows[0];

    connection.query('SELECT * FROM order_items WHERE order_id = ?', [id], (iErr, itemRows) => {
      if (iErr) {
        console.error('Order items fetch failed', iErr);
        return res.status(500).json({ message: 'Unable to fetch order items' });
      }
      order.items = itemRows || [];
      res.json(order);
    });
  });
}

// Creation/updation/deletion not exposed via this controller in current app; return 405 to avoid changing business logic
const methodNotAllowed = (req, res) => res.status(405).json({ message: 'Not allowed' });

module.exports = {
  model: Order,
  list,
  get,
  create: methodNotAllowed,
  update: methodNotAllowed,
  remove: methodNotAllowed
};
