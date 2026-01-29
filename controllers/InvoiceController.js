const connection = require("../config/db");
const Invoice = require("../models/Invoice"); // kept for interface consistency

// List invoices (now includes order + payment fields)
function list(req, res) {
  const sql = `
    SELECT
      i.*,
      o.customer_name,
      o.customer_contact,
      o.delivery_address,
      o.postal_code,
      o.delivery_date,
      o.delivery_time,
      o.order_notes,
      o.payment_method,
      o.payment_status,
      o.nets_txn_ref,
      o.paid_at,
      o.final_total AS order_final_total
    FROM invoices i
    JOIN orders o ON o.id = i.order_id
    ORDER BY i.created_at DESC
  `;

  connection.query(sql, (err, rows) => {
    if (err) {
      console.error("Invoice list failed", err);
      return res.status(500).json({ message: "Unable to fetch invoices" });
    }
    res.json(rows || []);
  });
}

// Get single invoice by invoice.id (now includes order + payment fields)
function get(req, res) {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid invoice id" });

  const sql = `
    SELECT
      i.*,
      o.user_id AS order_user_id,
      o.customer_name,
      o.customer_contact,
      o.delivery_address,
      o.postal_code,
      o.delivery_date,
      o.delivery_time,
      o.order_notes,
      o.payment_method,
      o.payment_status,
      o.nets_txn_ref,
      o.paid_at,
      o.subtotal AS order_subtotal,
      o.promo_discount,
      o.loyalty_discount,
      o.final_total AS order_final_total
    FROM invoices i
    JOIN orders o ON o.id = i.order_id
    WHERE i.id = ?
    LIMIT 1
  `;

  connection.query(sql, [id], (err, rows) => {
    if (err) {
      console.error("Invoice fetch failed", err);
      return res.status(500).json({ message: "Unable to fetch invoice" });
    }
    if (!rows || !rows.length) return res.status(404).json({ message: "Invoice not found" });

    res.json(rows[0]);
  });
}

// Render a single invoice page (EJS)
async function renderInvoice(req, res) {
  const orderId = parseInt(req.params.id, 10);
  const sessionUser = req.session.user;
  const userId = sessionUser && sessionUser.id;
  const isAdmin = sessionUser && sessionUser.isPrimaryAdmin;

  if (Number.isNaN(orderId)) {
    req.flash("error", "Invalid invoice ID.");
    return res.redirect("/orders");
  }

  const invoiceSelect = `
    SELECT
      i.id AS invoice_id,
      i.invoice_number,
      i.subtotal AS invoice_subtotal,
      i.final_total AS invoice_final_total,
      i.amount AS invoice_amount,
      i.created_at AS invoice_created_at,
      o.id AS order_id,
      o.user_id,
      o.customer_name,
      o.customer_contact,
      o.delivery_address,
      o.postal_code,
      o.delivery_date,
      o.delivery_time,
      o.order_notes,
      o.payment_method,
      o.payment_status,
      o.nets_txn_ref,
      o.paid_at,
      o.subtotal AS order_subtotal,
      o.promo_discount,
      o.loyalty_discount,
      o.final_total AS order_final_total,
      o.created_at AS order_created_at,
      u.username,
      u.email
    FROM invoices i
    JOIN orders o ON o.id = i.order_id
    LEFT JOIN users u ON u.id = o.user_id
    WHERE i.order_id = ?
      ${isAdmin ? "" : "AND o.user_id = ?"}
    LIMIT 1
  `;

  const itemsSql = `
    SELECT *
    FROM order_items
    WHERE order_id = ?
  `;

  try {
    const params = isAdmin ? [orderId] : [orderId, userId];
    const [invoiceRows] = await connection.promise().query(invoiceSelect, params);

    if (!invoiceRows || !invoiceRows.length) {
      req.flash("error", "Invoice not found.");
      return res.redirect("/orders");
    }

    const invoiceRow = invoiceRows[0];
    const [itemRows] = await connection.promise().query(itemsSql, [invoiceRow.order_id]);

    return res.render("invoice", {
      user: req.user || req.session.user,
      order: {
        ...invoiceRow,
        id: invoiceRow.order_id,
        subtotal: invoiceRow.order_subtotal ?? invoiceRow.invoice_subtotal ?? invoiceRow.subtotal,
        final_total: invoiceRow.order_final_total ?? invoiceRow.invoice_final_total ?? invoiceRow.final_total,
        amount: invoiceRow.invoice_amount ?? invoiceRow.amount,
        created_at: invoiceRow.order_created_at || invoiceRow.invoice_created_at || invoiceRow.created_at
      },
      items: itemRows,
      invoiceNumber:
        invoiceRow.invoice_number ||
        `#${108000 + (invoiceRow.invoice_id || invoiceRow.order_id || 0)}`
    });
  } catch (err) {
    console.error("Invoice render failed", err);
    req.flash("error", "Unable to load invoice.");
    return res.redirect("/orders");
  }
}

// Creation/updation/deletion are not exposed here to avoid altering existing flows
const methodNotAllowed = (req, res) => res.status(405).json({ message: "Not allowed" });

module.exports = {
  model: Invoice,
  list,
  get,
  renderInvoice,
  create: methodNotAllowed,
  update: methodNotAllowed,
  remove: methodNotAllowed
};
