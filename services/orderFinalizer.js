const connection = require('../config/db');

const columnExists = async (conn, table, column) => {
  const [rows] = await conn.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return Array.isArray(rows) && rows.length > 0;
};

async function deductInventoryForOrder(conn, orderId, items) {
  // Prefer stock_qty column; fall back to quantity if not present
  const useStockQty = await columnExists(conn, 'products', 'stock_qty');
  const stockColumn = useStockQty ? 'stock_qty' : 'quantity';

  const orderItems = items || (await conn.query(
    'SELECT product_id, quantity FROM order_items WHERE order_id = ? FOR UPDATE',
    [orderId]
  ))[0];

  for (const it of orderItems || []) {
    const qty = Number(it.quantity) || 0;
    if (qty <= 0) continue;
    const [res] = await conn.query(
      `UPDATE products SET ${stockColumn} = ${stockColumn} - ? WHERE id = ? AND ${stockColumn} >= ?`,
      [qty, it.product_id, qty]
    );
    if (!res.affectedRows) throw new Error(`Insufficient stock for product ${it.product_id}`);
  }
}

async function restockInventoryForOrder(conn, orderId, items) {
  // Adds quantities back after a refund. Uses stock_qty when available.
  const useStockQty = await columnExists(conn, 'products', 'stock_qty');
  const stockColumn = useStockQty ? 'stock_qty' : 'quantity';

  const orderItems = items || (await conn.query(
    'SELECT product_id, quantity FROM order_items WHERE order_id = ? FOR UPDATE',
    [orderId]
  ))[0];

  for (const it of orderItems || []) {
    const qty = Number(it.quantity) || 0;
    if (qty <= 0) continue;
    await conn.query(
      `UPDATE products SET ${stockColumn} = ${stockColumn} + ? WHERE id = ?`,
      [qty, it.product_id]
    );
  }
}

/**
 * Idempotent order finalizer.
 * - Validates order belongs to user (if userId provided).
 * - Skips if already PAID (returns { alreadyPaid: true }).
 * - Decrements product stock for each order item atomically.
 * - Updates order/invoice payment fields and optional gateway refs.
 */
async function finalizeOrderAfterPayment({
  orderId,
  userId,
  method,
  paypalCaptureId,
  paypalOrderId,
  payerEmail,
  netsTxnRef
}) {
  if (!orderId) throw new Error('orderId is required for finalizeOrderAfterPayment');
  const conn = connection.promise();

  await conn.beginTransaction();
  try {
    const [orders] = await conn.query(
      `SELECT * FROM orders WHERE id = ? ${userId ? 'AND user_id = ?' : ''} FOR UPDATE`,
      userId ? [orderId, userId] : [orderId]
    );
    if (!orders || !orders.length) throw new Error('Order not found for user');
    const order = orders[0];

    if (order.payment_status === 'PAID') {
      await conn.commit();
      return { alreadyPaid: true };
    }

    const [items] = await conn.query(
      'SELECT product_id, product_name, unit_price, quantity, line_total FROM order_items WHERE order_id = ? FOR UPDATE',
      [orderId]
    );

    // Deduct stock only when payment is confirmed (atomic with payment_status update)
    await deductInventoryForOrder(conn, orderId, items);

    // Loyalty earning: $1 spent = 1 point, only when order becomes PAID
    const baseTotal = Number(
      order.final_total ??
      order.amount ??
      order.subtotal ??
      order.order_total ??
      0
    );
    const earnedPoints = Math.floor(baseTotal);
    const hasLoyaltyCol = await columnExists(conn, 'users', 'loyalty_points');
    if (hasLoyaltyCol && order.user_id && earnedPoints > 0) {
      const [lpResult] = await conn.query(
        'UPDATE users SET loyalty_points = GREATEST(COALESCE(loyalty_points,0) + ?, 0) WHERE id = ?',
        [earnedPoints, order.user_id]
      );
      console.log('[loyalty] credited', { orderId, userId: order.user_id, earnedPoints, affectedRows: lpResult.affectedRows });
    }

    const hasPayerEmail = await columnExists(conn, 'orders', 'paypal_payer_email');
    const hasPaypalOrder = await columnExists(conn, 'orders', 'paypal_order_id');
    const hasPaypalCapture = await columnExists(conn, 'orders', 'paypal_capture_id');
    const hasNetsRef = await columnExists(conn, 'orders', 'nets_txn_ref');
    const hasLoyaltyEarned = await columnExists(conn, 'orders', 'loyalty_points_earned');

    const orderSet = [
      `payment_status = 'PAID'`,
      `payment_method = ?`,
      `paid_at = COALESCE(paid_at, NOW())`
    ];
    const orderParams = [method || order.payment_method || 'PAYMENT'];
    if (hasPaypalCapture && paypalCaptureId) {
      orderSet.push('paypal_capture_id = ?');
      orderParams.push(paypalCaptureId);
    }
    if (hasPaypalOrder && paypalOrderId) {
      orderSet.push('paypal_order_id = ?');
      orderParams.push(paypalOrderId);
    }
    if (hasPayerEmail && payerEmail) {
      orderSet.push('paypal_payer_email = COALESCE(?, paypal_payer_email)');
      orderParams.push(payerEmail);
    }
    if (hasNetsRef && netsTxnRef) {
      orderSet.push('nets_txn_ref = ?');
      orderParams.push(netsTxnRef);
    }
    if (hasLoyaltyEarned) {
      orderSet.push('loyalty_points_earned = ?');
      orderParams.push(earnedPoints);
    }
    orderParams.push(orderId);
    if (userId) orderParams.push(userId);

    const orderWhere = `id = ? ${userId ? 'AND user_id = ?' : ''}`;
    await conn.query(`UPDATE orders SET ${orderSet.join(', ')} WHERE ${orderWhere}`, orderParams);

    // Invoice update (best-effort, optional columns)
    const hasInvPaypalCapture = await columnExists(conn, 'invoices', 'paypal_capture_id');
    const hasInvPaypalOrder = await columnExists(conn, 'invoices', 'paypal_order_id');
    const invSet = [
      `payment_status = 'PAID'`,
      `payment_method = ?`,
      `paid_at = COALESCE(paid_at, NOW())`
    ];
    const invParams = [method || order.payment_method || 'PAYMENT'];
    if (hasInvPaypalCapture && paypalCaptureId) {
      invSet.push('paypal_capture_id = ?');
      invParams.push(paypalCaptureId);
    }
    if (hasInvPaypalOrder && paypalOrderId) {
      invSet.push('paypal_order_id = ?');
      invParams.push(paypalOrderId);
    }
    invParams.push(orderId);
    await conn.query(
      `UPDATE invoices SET ${invSet.join(', ')} WHERE order_id = ?`,
      invParams
    );

    await conn.commit();
    return { ok: true, orderId };
  } catch (err) {
    await conn.rollback();
    throw err;
  }
}

module.exports = {
  finalizeOrderAfterPayment,
  deductInventoryForOrder,
  restockInventoryForOrder
};
