const connection = require('../config/db');

const Invoice = {
  create(invoice, callback) {
    const sql = `
      INSERT INTO invoices (order_id, user_id, invoice_number, subtotal, final_total, amount)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    const params = [
      invoice.order_id,
      invoice.user_id,
      invoice.invoice_number,
      invoice.subtotal,
      invoice.final_total,
      invoice.amount
    ];
    connection.query(sql, params, callback);
  },

  findAll(callback) {
    const sql = `
      SELECT 
        i.id,
        i.order_id,
        i.user_id,
        i.invoice_number AS invoiceNumber,
        i.subtotal,
        i.final_total,
        i.amount,
        i.created_at,
        o.created_at AS order_created_at
      FROM invoices i
      JOIN orders o ON i.order_id = o.id
      ORDER BY i.created_at DESC
    `;
    connection.query(sql, callback);
  },

  findById(id, callback) {
    const sql = `
      SELECT 
        i.*,
        o.subtotal,
        o.final_total,
        o.created_at AS order_created_at
      FROM invoices i
      JOIN orders o ON i.order_id = o.id
      WHERE i.id = ?
    `;
    connection.query(sql, [id], callback);
  }
};

module.exports = Invoice;
