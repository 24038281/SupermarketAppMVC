const express = require('express');
const connection = require('../config/db');
const { checkAuthenticated, checkAdmin } = require('../middleware');
const { restockInventoryForOrder } = require('../services/orderFinalizer');
const walletService = require('../services/walletService');
const paypal = require('../services/paypal');

const router = express.Router();
function formatInvoiceNumber(id) {
  const num = parseInt(id, 10);
  if (isNaN(num)) return '#UNKNOWN';
  const base = 108000; // keeps numbers sequential but in the 108k range
  return `#${base + num}`;
}
async function columnExists(conn, table, column) {
  const [rows] = await conn.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column]);
  return Array.isArray(rows) && rows.length > 0;
}

// Admin Dashboard (primary admin only)
router.get('/admin/dashboard', checkAuthenticated, checkAdmin, async (req, res) => {
  const getCount = (sql) =>
    new Promise((resolve, reject) => {
      connection.query(sql, (err, rows) => {
        if (err) return reject(err);
        resolve((rows && rows[0] && rows[0].count) || 0);
      });
    });

  try {
    const [userCount, productCount, orderCount, activePromoCount] = await Promise.all([
      getCount('SELECT COUNT(*) AS count FROM users'),
      getCount('SELECT COUNT(*) AS count FROM products'),
      getCount('SELECT COUNT(*) AS count FROM orders'),
      getCount('SELECT COUNT(*) AS count FROM promocodes WHERE active = 1')
    ]);

    res.render('adminDashboard', {
      user: req.session.user,
      stats: {
        users: userCount,
        products: productCount,
        orders: orderCount,
        activePromos: activePromoCount
      }
    });
  } catch (err) {
    console.error('Failed to load admin dashboard', err);
    req.flash('error', 'Unable to load admin dashboard');
    res.redirect('/');
  }
});

// Inventory (Admin Only)
router.get('/inventory', checkAuthenticated, checkAdmin, (req, res) => {
  connection.query('SELECT * FROM products', (error, results) => {
    if (error) throw error;
    res.render('inventory', {
      products: results,
      user: req.session.user
    });
  });
});

// Admin: Products list (redirect to inventory to avoid duplicate paths)
router.get('/admin/products', checkAuthenticated, checkAdmin, (req, res) => {
  res.redirect('/inventory');
});

// Admin: Categories (stub for now)
router.get('/admin/categories', checkAuthenticated, checkAdmin, (req, res) => {
  const categories = [];
  res.render('adminCategories', {
    user: req.session.user,
    categories
  });
});


// Admin: Membership Plans
router.get('/admin/membership-plans', checkAuthenticated, checkAdmin, (req, res) => {
  const plansSql = 'SELECT * FROM membership_plans ORDER BY points_multiplier DESC, id ASC';
  const usersSql = `
    SELECT id, username, email,
           COALESCE(membership_tier, 'Basic') AS membership_tier,
           COALESCE(loyalty_points, 0) AS loyalty_points
    FROM users
    ORDER BY loyalty_points DESC, username ASC
  `;

  connection.query(plansSql, (planErr, plans) => {
    if (planErr) {
      console.error('Failed to fetch membership plans', planErr);
      req.flash('error', 'Unable to load membership plans');
      return res.render('adminMembershipPlans', { user: req.session.user, plans: [], members: [] });
    }
    connection.query(usersSql, (userErr, members) => {
      if (userErr) {
        console.error('Failed to fetch membership users', userErr);
        req.flash('error', 'Unable to load membership users');
        return res.render('adminMembershipPlans', { user: req.session.user, plans: plans || [], members: [] });
      }
      res.render('adminMembershipPlans', { user: req.session.user, plans: plans || [], members: members || [] });
    });
  });
});

// Disable create/edit/delete plan actions on this page – keep read-only display
router.post('/admin/membership-plans', checkAuthenticated, checkAdmin, (req, res) => {
  req.flash('error', 'Plan editing is disabled on this page (read-only).');
  return res.redirect('/admin/membership-plans');
});
router.get('/admin/membership-plans/:id/edit', checkAuthenticated, checkAdmin, (req, res) => {
  req.flash('error', 'Plan editing is disabled on this page (read-only).');
  return res.redirect('/admin/membership-plans');
});
router.post('/admin/membership-plans/:id', checkAuthenticated, checkAdmin, (req, res) => {
  req.flash('error', 'Plan editing is disabled on this page (read-only).');
  return res.redirect('/admin/membership-plans');
});
router.post('/admin/membership-plans/:id/delete', checkAuthenticated, checkAdmin, (req, res) => {
  req.flash('error', 'Plan editing is disabled on this page (read-only).');
  return res.redirect('/admin/membership-plans');
});

// Admin: Refund PayPal-paid order back to PayPal (provider refund)
router.post('/admin/refund/:orderId', checkAuthenticated, checkAdmin, async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  const reason = (req.body.reason || '').slice(0, 255) || null;
  const amountRaw = req.body.amount;
  const redirectTo = `/invoice/${orderId}`;
  if (!orderId || Number.isNaN(orderId)) {
    req.flash('error', 'Invalid order id for refund.');
    return res.redirect('/orders');
  }

  const conn = connection.promise();
  let refundRowId = null;
  let amountCents = null;
  let captureId = null;
  let paymentId = null;
  let providerRefundId = null;

  // ---- Phase 1: validate + mark refund pending ----
  try {
    await conn.beginTransaction();
    const [orders] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
    if (!orders.length) {
      await conn.rollback();
      req.flash('error', 'Order not found.');
      return res.redirect(redirectTo);
    }
    const order = orders[0];
    const method = (order.payment_method || '').toLowerCase();
    if (method !== 'paypal') {
      await conn.rollback();
      req.flash('error', 'This refund route handles PayPal-paid orders only.');
      return res.redirect(redirectTo);
    }
    if (String(order.payment_status || '').toUpperCase() !== 'PAID') {
      await conn.rollback();
      req.flash('error', 'Only paid orders can be refunded.');
      return res.redirect(redirectTo);
    }
    const currentRefundStatus = String(order.refund_status || '').toUpperCase();
    if (['PENDING', 'REFUNDED'].includes(currentRefundStatus)) {
      await conn.rollback();
      req.flash('error', 'Refund already in progress or completed.');
      return res.redirect(redirectTo);
    }
    captureId = order.paypal_capture_id;
    if (!captureId) {
      await conn.rollback();
      req.flash('error', 'Missing PayPal capture id; cannot process refund.');
      return res.redirect(redirectTo);
    }

    const amountDecimal = amountRaw
      ? Number(parseFloat(amountRaw).toFixed(2))
      : Number(order.final_total ?? order.amount ?? order.subtotal ?? 0);
    if (!Number.isFinite(amountDecimal) || amountDecimal <= 0) {
      await conn.rollback();
      req.flash('error', 'Refund amount must be greater than 0.');
      return res.redirect(redirectTo);
    }
    const maxAmount = Number(order.final_total ?? order.amount ?? order.subtotal ?? amountDecimal);
    const normalizedAmount = Math.min(amountDecimal, maxAmount);
    amountCents = Math.round(normalizedAmount * 100);

    // Ensure a payment row exists for linkage
    const [payments] = await conn.query(
      'SELECT * FROM payments WHERE order_id = ? AND method = ? LIMIT 1 FOR UPDATE',
      [orderId, 'paypal']
    );
    if (payments && payments.length) {
      paymentId = payments[0].id;
      await conn.query('UPDATE payments SET status = ? WHERE id = ?', ['REFUND_PENDING', paymentId]);
    } else {
      const [paymentInsert] = await conn.query(
        `INSERT INTO payments (order_id, user_id, method, amount_cents, status, provider_order_id, provider_capture_id)
         VALUES (?, ?, 'paypal', ?, 'REFUND_PENDING', ?, ?)`,
        [orderId, order.user_id || null, amountCents, order.paypal_order_id || null, captureId]
      );
      paymentId = paymentInsert.insertId;
    }

    // Create refund row marked PROCESSING
    const [refundInsert] = await conn.query(
      `INSERT INTO refunds (order_id, payment_id, method, amount_cents, status, reason)
       VALUES (?, ?, 'paypal', ?, 'PROCESSING', ?)`,
      [orderId, paymentId, amountCents, reason]
    );
    refundRowId = refundInsert.insertId;

    await conn.query(
      `UPDATE orders
         SET refund_status = 'PENDING',
             refund_amount = ?,
             refund_reason = ?,
             refund_txn_ref = NULL,
             refunded_at = NULL
       WHERE id = ?`,
      [normalizedAmount, reason, orderId]
    );

    await conn.commit();
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    console.error('[Admin Refund][PayPal] validation/pending failed', err);
    req.flash('error', 'Failed to start PayPal refund: ' + err.message);
    return res.redirect(redirectTo);
  }

  // ---- Phase 2: call PayPal refund API ----
  let refundPayload = null;
  try {
    refundPayload = await paypal.refundCapture(captureId, (amountCents / 100).toFixed(2), 'SGD');
    providerRefundId = refundPayload?.id || refundPayload?.result?.id || null;
  } catch (err) {
    const isRateLimit = err.rateLimited || err.response?.status === 429;
    const msg = isRateLimit ? 'PayPal rate limited; try again shortly.' : (err.response?.data?.message || err.message);
    // ---- Phase 3a: persist failure ----
    try {
      await conn.beginTransaction();
      if (refundRowId) {
        await conn.query(
          `UPDATE refunds
              SET status = 'FAILED',
                  provider_refund_id = COALESCE(?, provider_refund_id),
                  updated_at = NOW()
            WHERE id = ?`,
          [providerRefundId, refundRowId]
        );
      }
      if (paymentId) {
        await conn.query('UPDATE payments SET status = ? WHERE id = ?', ['REFUND_FAILED', paymentId]);
      }
      await conn.query(
        `UPDATE orders
           SET refund_status = 'FAILED',
               refund_txn_ref = COALESCE(?, refund_txn_ref),
               refund_reason = COALESCE(?, refund_reason)
         WHERE id = ?`,
        [providerRefundId, msg, orderId]
      );
      await conn.commit();
    } catch (dbErr) {
      try { await conn.rollback(); } catch (_) {}
      console.error('[Admin Refund][PayPal] failed-state persist error', dbErr);
    }

    req.flash('error', msg);
    return res.redirect(redirectTo);
  }

  // ---- Phase 3b: persist success ----
  try {
    await conn.beginTransaction();
    const [orderRows] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
    const order = orderRows && orderRows[0] ? orderRows[0] : null;
    if (refundRowId) {
      await conn.query(
        `UPDATE refunds
            SET status = 'COMPLETED',
                provider_refund_id = ?,
                updated_at = NOW()
          WHERE id = ?`,
        [providerRefundId, refundRowId]
      );
    }
    if (paymentId) {
      await conn.query('UPDATE payments SET status = ? WHERE id = ?', ['REFUNDED', paymentId]);
    }
    const fullRefundTotal = Number(order?.final_total ?? order?.amount ?? order?.subtotal ?? 0);
    if (order && amountCents === Math.round(fullRefundTotal * 100)) {
      const [items] = await conn.query(
        'SELECT product_id, quantity FROM order_items WHERE order_id = ? FOR UPDATE',
        [orderId]
      );
      await restockInventoryForOrder(conn, orderId, items);
      const earnedPoints = Number(order.loyalty_points_earned || 0);
      if (earnedPoints > 0 && order.user_id) {
        await conn.query(
          'UPDATE users SET loyalty_points = GREATEST(COALESCE(loyalty_points,0) - ?, 0) WHERE id = ?',
          [earnedPoints, order.user_id]
        );
      }
    }
    await conn.query(
      `UPDATE orders
         SET refund_status = 'REFUNDED',
             refund_txn_ref = ?,
             refunded_at = NOW()
       WHERE id = ?`,
      [providerRefundId, orderId]
    );
    await conn.commit();
    req.flash('success', 'PayPal refund completed.');
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    console.error('[Admin Refund][PayPal] success persist failed', err);
    req.flash('error', 'Refund completed at PayPal but failed to record locally: ' + err.message);
  }

  return res.redirect(redirectTo);
});

// NETS QR: create refund request (no automatic provider refund)
router.post('/admin/refund/nets/:orderId', checkAuthenticated, checkAdmin, async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  const reason = (req.body.reason || '').slice(0, 255) || null;
  const amountRaw = req.body.amount;
  const redirectTo = `/invoice/${orderId}`;
  if (!orderId || Number.isNaN(orderId)) {
    req.flash('error', 'Invalid order id for NETS refund.');
    return res.redirect('/orders');
  }

  const conn = connection.promise();
  try {
    await conn.beginTransaction();
    const [orders] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
    if (!orders.length) {
      await conn.rollback();
      req.flash('error', 'Order not found.');
      return res.redirect(redirectTo);
    }
    const order = orders[0];
    const method = String(order.payment_method || '').toLowerCase();
    const payStatus = String(order.payment_status || '').toUpperCase();
    if (method !== 'nets_qr') {
      await conn.rollback();
      req.flash('error', 'This NETS refund endpoint is only for NETS QR payments.');
      return res.redirect(redirectTo);
    }
    if (payStatus !== 'PAID') {
      await conn.rollback();
      req.flash('error', 'Only paid orders can be refunded.');
      return res.redirect(redirectTo);
    }
    const currentRefundStatus = String(order.refund_status || '').toUpperCase();
    if (['PENDING', 'REFUNDED'].includes(currentRefundStatus)) {
      await conn.rollback();
      req.flash('error', 'Refund already in progress or completed.');
      return res.redirect(redirectTo);
    }

    const amountDecimal = amountRaw
      ? Number(parseFloat(amountRaw).toFixed(2))
      : Number(order.final_total ?? order.amount ?? order.subtotal ?? 0);
    if (!Number.isFinite(amountDecimal) || amountDecimal <= 0) {
      await conn.rollback();
      req.flash('error', 'Refund amount must be greater than 0.');
      return res.redirect(redirectTo);
    }
    const maxAmount = Number(order.final_total ?? order.amount ?? order.subtotal ?? amountDecimal);
    const normalizedAmount = Math.min(amountDecimal, maxAmount);
    const amountCents = Math.round(normalizedAmount * 100);

    // Ensure payment row exists
    let paymentId = null;
    const [payments] = await conn.query(
      'SELECT * FROM payments WHERE order_id = ? AND method = ? LIMIT 1 FOR UPDATE',
      [orderId, 'nets_qr']
    );
    if (payments && payments.length) {
      paymentId = payments[0].id;
      await conn.query('UPDATE payments SET status = ? WHERE id = ?', ['REFUND_PENDING', paymentId]);
    } else {
      const [payInsert] = await conn.query(
        `INSERT INTO payments (order_id, user_id, method, amount_cents, status, nets_txn_ref)
         VALUES (?, ?, 'nets_qr', ?, 'REFUND_PENDING', ?)`,
        [orderId, order.user_id || null, amountCents, order.nets_txn_ref || null]
      );
      paymentId = payInsert.insertId;
    }

    const rand = Math.floor(1000 + Math.random() * 9000);
    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const netsRefundRef = `NETS-RF-${datePart}-${orderId}-${rand}`;

    const [refundInsert] = await conn.query(
      `INSERT INTO refunds (order_id, payment_id, method, amount_cents, status, nets_refund_ref, reason)
       VALUES (?, ?, 'nets_qr', ?, 'REQUESTED', ?, ?)`,
      [orderId, paymentId, amountCents, netsRefundRef, reason]
    );

    await conn.query(
      `UPDATE orders
         SET refund_status = 'PENDING',
             refund_amount = ?,
             refund_reason = ?,
             refund_txn_ref = ?,
             refunded_at = NULL
       WHERE id = ?`,
      [normalizedAmount, reason, netsRefundRef, orderId]
    );

    await conn.commit();
    req.flash('success', 'NETS refund request recorded. Awaiting manual completion.');
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    console.error('[Admin Refund][NETS] failed', err);
    req.flash('error', 'Failed to create NETS refund request: ' + err.message);
  }

  return res.redirect(redirectTo);
});

// NETS QR: mark refund completed (manual)
router.post('/admin/refunds/nets/:refundId/complete', checkAuthenticated, checkAdmin, async (req, res) => {
  const refundId = parseInt(req.params.refundId, 10);
  if (!refundId) {
    req.flash('error', 'Missing refund id.');
    return res.redirect('/orders');
  }
  const conn = connection.promise();
  try {
    await conn.beginTransaction();
    const hasLoyaltyPointsEarned = await columnExists(conn, 'orders', 'loyalty_points_earned');
    const loyaltySelect = hasLoyaltyPointsEarned ? 'o.loyalty_points_earned' : '0 AS loyalty_points_earned';
    const [rows] = await conn.query(
      `SELECT r.*, o.user_id, o.final_total, o.subtotal, o.id AS order_id, ${loyaltySelect}
         FROM refunds r
         JOIN orders o ON o.id = r.order_id
        WHERE r.id = ? FOR UPDATE`,
      [refundId]
    );
    if (!rows.length) {
      await conn.rollback();
      req.flash('error', 'Refund not found.');
      return res.redirect('/orders');
    }
    const refund = rows[0];
    if (refund.method !== 'nets_qr') {
      await conn.rollback();
      req.flash('error', 'This endpoint is only for NETS refunds.');
      return res.redirect(`/invoice/${refund.order_id}`);
    }
    if (!['REQUESTED', 'PROCESSING'].includes(String(refund.status).toUpperCase())) {
      await conn.rollback();
      req.flash('error', 'Refund is not in a completable state.');
      return res.redirect(`/invoice/${refund.order_id}`);
    }

    const fullRefundTotal = Number(refund.final_total ?? refund.subtotal ?? 0);
    if (refund.amount_cents === Math.round(fullRefundTotal * 100)) {
      const [items] = await conn.query(
        'SELECT product_id, quantity FROM order_items WHERE order_id = ? FOR UPDATE',
        [refund.order_id]
      );
      await restockInventoryForOrder(conn, refund.order_id, items);
      const earnedPoints = Number(refund.loyalty_points_earned || 0);
      if (earnedPoints > 0 && refund.user_id) {
        await conn.query(
          'UPDATE users SET loyalty_points = GREATEST(COALESCE(loyalty_points,0) - ?, 0) WHERE id = ?',
          [earnedPoints, refund.user_id]
        );
      }
    }

    await conn.query(
      `UPDATE refunds
          SET status = 'COMPLETED',
              settlement_method = 'NETS_MANUAL',
              settled_at = NOW(),
              updated_at = NOW()
        WHERE id = ?`,
      [refundId]
    );
    if (refund.payment_id) {
      await conn.query('UPDATE payments SET status = \'REFUNDED\' WHERE id = ?', [refund.payment_id]);
    }
    await conn.query(
      `UPDATE orders
         SET refund_status = 'REFUNDED',
             refund_txn_ref = COALESCE(refund_txn_ref, ?),
             refunded_at = NOW()
       WHERE id = ?`,
      [refund.nets_refund_ref || null, refund.order_id]
    );

    await conn.commit();
    req.flash('success', 'NETS refund marked as completed.');
    return res.redirect(`/invoice/${refund.order_id}`);
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    console.error('[Admin Refund][NETS complete] failed', err);
    req.flash('error', 'Failed to mark refund completed: ' + err.message);
    return res.redirect('/orders');
  }
});

// Wallet fallback for failed provider refunds (PayPal/NETS)
router.post('/admin/refunds/:refundId/refund-to-wallet', checkAuthenticated, checkAdmin, async (req, res) => {
  const refundId = parseInt(req.params.refundId, 10);
  if (!refundId) {
    req.flash('error', 'Missing refund id.');
    return res.redirect('/orders');
  }
  try {
    const [rows] = await connection.promise().query(
      `SELECT r.*, o.user_id, o.id AS order_id, p.status AS payment_status, p.id AS payment_id
         FROM refunds r
         JOIN orders o ON o.id = r.order_id
         LEFT JOIN payments p ON p.id = r.payment_id
        WHERE r.id = ?`,
      [refundId]
    );
    if (!rows.length) {
      await conn.rollback();
      req.flash('error', 'Refund not found.');
      return res.redirect('/orders');
    }
    const refund = rows[0];
    const method = String(refund.method || '').toLowerCase();
    const status = String(refund.status || '').toUpperCase();
    if (!['nets_qr', 'paypal'].includes(method) || status !== 'FAILED') {
      await conn.rollback();
      req.flash('error', 'Wallet fallback allowed only for failed NETS or PayPal refunds.');
      return res.redirect(`/invoice/${refund.order_id}`);
    }
    if (!refund.user_id) {
      await conn.rollback();
      req.flash('error', 'Refund has no associated user for wallet credit.');
      return res.redirect(`/invoice/${refund.order_id}`);
    }

    const amount = Number(refund.amount_cents || 0) / 100;
    await walletService.ensureWallet(refund.user_id);
    await walletService.creditWallet({
      userId: refund.user_id,
      amount: amount,
      orderId: refund.order_id,
      reason: 'Refund wallet fallback',
      reference: 'WALLET-FALLBACK'
    });

    await connection.promise().query(
      `UPDATE refunds
          SET status = 'COMPLETED',
              updated_at = NOW(),
              nets_refund_ref = COALESCE(nets_refund_ref, 'WALLET-FALLBACK')
        WHERE id = ? AND status = 'FAILED'`,
      [refundId]
    );
    if (refund.payment_id) {
      await connection.promise().query('UPDATE payments SET status = \'REFUNDED\' WHERE id = ?', [refund.payment_id]);
    }
    await connection.promise().query(
      `UPDATE orders
         SET refund_status = 'REFUNDED',
             refund_txn_ref = COALESCE(refund_txn_ref, 'WALLET-FALLBACK'),
             refunded_at = NOW()
       WHERE id = ? AND refund_status = 'FAILED'`,
      [refund.order_id]
    );
    req.flash('success', 'Refund credited to wallet as fallback.');
    return res.redirect(`/invoice/${refund.order_id}`);
  } catch (err) {
    console.error('[Admin Refund][Wallet fallback] failed', err);
    req.flash('error', 'Failed to credit wallet: ' + err.message);
    return res.redirect('/orders');
  }
});

// Admin: update loyalty points for a specific user
router.post('/admin/membership-plans/users/:id/points', checkAuthenticated, checkAdmin, (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const pointsRaw = (req.body.loyalty_points || '').trim();

  if (Number.isNaN(userId) || userId <= 0) {
    req.flash('error', 'Invalid user selected.');
    return res.redirect('/admin/membership-plans');
  }

  const pointsVal = Number(pointsRaw);
  if (!Number.isInteger(pointsVal) || pointsVal < 0) {
    req.flash('error', 'Loyalty points must be a non-negative integer.');
    return res.redirect('/admin/membership-plans');
  }

  // Update the user's loyalty_points
  connection.query('UPDATE users SET loyalty_points = ? WHERE id = ?', [pointsVal, userId], (err, result) => {
    if (err) {
      console.error('Failed to update loyalty points', err);
      req.flash('error', 'Unable to update loyalty points.');
      return res.redirect('/admin/membership-plans');
    }
    if (result.affectedRows === 0) {
      req.flash('error', 'User not found.');
      return res.redirect('/admin/membership-plans');
    }
    req.flash('success', 'Loyalty points updated successfully.');
    res.redirect('/admin/membership-plans');
  });
});

// Admin: Promo codes - list and create
router.get('/admin/promocodes', checkAuthenticated, checkAdmin, (req, res) => {
  connection.query('SELECT * FROM promocodes ORDER BY id DESC', (err, results) => {
    if (err) {
      console.error('Failed to fetch promocodes', err);
      req.flash('error', 'Unable to load promo codes');
      return res.render('adminPromocodes', { user: req.session.user, promocodes: [] });
    }
    res.render('adminPromocodes', { user: req.session.user, promocodes: results });
  });
});

// Admin: create a new promo
router.post('/admin/promocodes', checkAuthenticated, checkAdmin, (req, res) => {
  const { code, description, type, amount, min_total, starts_at, expires_at, max_uses, per_user_limit, active } = req.body;
  const errors = [];
  const cleanedCode = (code || '').trim().toUpperCase();
  if (!cleanedCode) errors.push('Code is required');
  const cleanedType = type === 'percent' ? 'percent' : 'fixed';
  const cleanedAmount = parseFloat(amount);
  if (isNaN(cleanedAmount) || cleanedAmount <= 0) errors.push('Amount must be a positive number');
  let cleanedMin = null;
  if (min_total) {
    const v = parseFloat(min_total);
    if (isNaN(v) || v < 0) errors.push('Min total must be a non-negative number');
    else cleanedMin = v;
  }
  let cleanedPerUser = null;
  if (per_user_limit) {
    const v = parseInt(per_user_limit, 10);
    if (isNaN(v) || v <= 0) errors.push('Per-user limit must be a positive integer');
    else cleanedPerUser = v;
  }
  let cleanedMaxUses = null;
  if (max_uses) {
    const v = parseInt(max_uses, 10);
    if (isNaN(v) || v <= 0) errors.push('Max uses must be a positive integer');
    else cleanedMaxUses = v;
  }

  const cleanedStarts = starts_at ? new Date(starts_at) : null;
  const cleanedExpires = expires_at ? new Date(expires_at) : null;
  if (cleanedStarts && isNaN(cleanedStarts.getTime())) errors.push('Invalid starts_at datetime');
  if (cleanedExpires && isNaN(cleanedExpires.getTime())) errors.push('Invalid expires_at datetime');
  if (cleanedStarts && cleanedExpires && cleanedStarts >= cleanedExpires) errors.push('starts_at must be before expires_at');

  if (errors.length) {
    errors.forEach(e => req.flash('error', e));
    return res.redirect('/admin/promocodes');
  }

  connection.query('SELECT id FROM promocodes WHERE code = ?', [cleanedCode], (selErr, selRows) => {
    if (selErr) {
      console.error('Promo lookup error', selErr);
      req.flash('error', 'Unable to validate promo code');
      return res.redirect('/admin/promocodes');
    }
    if (selRows && selRows.length > 0) {
      req.flash('error', 'Promo code already exists');
      return res.redirect('/admin/promocodes');
    }

    const promo = {
      code: cleanedCode,
      description: description || null,
      type: cleanedType,
      amount: cleanedAmount,
      min_total: cleanedMin,
      starts_at: cleanedStarts ? cleanedStarts.toISOString().slice(0, 19).replace('T', ' ') : null,
      expires_at: cleanedExpires ? cleanedExpires.toISOString().slice(0, 19).replace('T', ' ') : null,
      max_uses: cleanedMaxUses,
      per_user_limit: cleanedPerUser,
      active: active ? 1 : 0
    };

    const sql = `INSERT INTO promocodes (code, description, type, amount, min_total, starts_at, expires_at, max_uses, per_user_limit, active, uses) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`;
    connection.query(
      sql,
      [promo.code, promo.description, promo.type, promo.amount, promo.min_total, promo.starts_at, promo.expires_at, promo.max_uses, promo.per_user_limit, promo.active],
      (insErr, result) => {
        if (insErr) {
          console.error('Failed to create promo', insErr);
          req.flash('error', 'Failed to create promo code: ' + (insErr.code || insErr.message));
          return res.redirect('/admin/promocodes');
        }
        console.log('Created promo id=', result && result.insertId);
        req.flash('success', 'Promo code created');
        res.redirect('/admin/promocodes');
      }
    );
  });
});

// Admin: edit promo form
router.get('/admin/promocodes/:id/edit', checkAuthenticated, checkAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  connection.query('SELECT * FROM promocodes WHERE id = ?', [id], (err, rows) => {
    if (err || !rows || rows.length === 0) {
      req.flash('error', 'Promo not found');
      return res.redirect('/admin/promocodes');
    }
    res.render('adminPromoEdit', { user: req.session.user, promo: rows[0] });
  });
});

// Admin: update promo
router.post('/admin/promocodes/:id', checkAuthenticated, checkAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { code, description, type, amount, min_total, starts_at, expires_at, max_uses, per_user_limit, active } = req.body;
  const errors = [];
  const cleanedCode = (code || '').trim().toUpperCase();
  if (!cleanedCode) errors.push('Code is required');
  const cleanedType = type === 'percent' ? 'percent' : 'fixed';
  const cleanedAmount = parseFloat(amount);
  if (isNaN(cleanedAmount) || cleanedAmount <= 0) errors.push('Amount must be a positive number');
  let cleanedMin = null;
  if (min_total) {
    const v = parseFloat(min_total);
    if (isNaN(v) || v < 0) errors.push('Min total must be a non-negative number');
    else cleanedMin = v;
  }
  let cleanedPerUser = null;
  if (per_user_limit) {
    const v = parseInt(per_user_limit, 10);
    if (isNaN(v) || v <= 0) errors.push('Per-user limit must be a positive integer');
    else cleanedPerUser = v;
  }
  let cleanedMaxUses = null;
  if (max_uses) {
    const v = parseInt(max_uses, 10);
    if (isNaN(v) || v <= 0) errors.push('Max uses must be a positive integer');
    else cleanedMaxUses = v;
  }
  const cleanedStarts = starts_at ? new Date(starts_at) : null;
  const cleanedExpires = expires_at ? new Date(expires_at) : null;
  if (cleanedStarts && isNaN(cleanedStarts.getTime())) errors.push('Invalid starts_at datetime');
  if (cleanedExpires && isNaN(cleanedExpires.getTime())) errors.push('Invalid expires_at datetime');
  if (cleanedStarts && cleanedExpires && cleanedStarts >= cleanedExpires) errors.push('starts_at must be before expires_at');
  if (errors.length) {
    errors.forEach(e => req.flash('error', e));
    return res.redirect('/admin/promocodes');
  }

  connection.query('SELECT id FROM promocodes WHERE code = ? AND id != ?', [cleanedCode, id], (selErr, selRows) => {
    if (selErr) {
      console.error('Promo lookup error', selErr);
      req.flash('error', 'Unable to validate promo code');
      return res.redirect('/admin/promocodes');
    }
    if (selRows && selRows.length > 0) {
      req.flash('error', 'Promo code already used by another promo');
      return res.redirect('/admin/promocodes');
    }

    const data = {
      code: cleanedCode,
      description: description || null,
      type: cleanedType,
      amount: cleanedAmount,
      min_total: cleanedMin,
      starts_at: cleanedStarts ? cleanedStarts.toISOString().slice(0, 19).replace('T', ' ') : null,
      expires_at: cleanedExpires ? cleanedExpires.toISOString().slice(0, 19).replace('T', ' ') : null,
      max_uses: cleanedMaxUses,
      per_user_limit: cleanedPerUser,
      active: active ? 1 : 0
    };

    const sql = `UPDATE promocodes SET code = ?, description = ?, type = ?, amount = ?, min_total = ?, starts_at = ?, expires_at = ?, max_uses = ?, per_user_limit = ?, active = ? WHERE id = ?`;
    connection.query(
      sql,
      [data.code, data.description, data.type, data.amount, data.min_total, data.starts_at, data.expires_at, data.max_uses, data.per_user_limit, data.active, id],
      (uErr) => {
        if (uErr) {
          console.error('Failed to update promo', uErr);
          req.flash('error', 'Failed to update promo');
          return res.redirect('/admin/promocodes');
        }
        req.flash('success', 'Promo updated');
        res.redirect('/admin/promocodes');
      }
    );
  });
});

// Admin: delete promo
router.post('/admin/promocodes/:id/delete', checkAuthenticated, checkAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  connection.query('DELETE FROM promocodes WHERE id = ?', [id], (err) => {
    if (err) {
      console.error('Failed to delete promo', err);
      req.flash('error', 'Failed to delete promo');
      return res.redirect('/admin/promocodes');
    }
    req.flash('success', 'Promo deleted');
    res.redirect('/admin/promocodes');
  });
});

// Admin: View All Invoices / Orders
router.get('/admin/invoices', checkAuthenticated, checkAdmin, (req, res) => {
  const sql = `
        SELECT 
            i.id,
            i.order_id,
            i.user_id,
            COALESCE(i.invoice_number, CONCAT('#', 108000 + i.id)) AS invoiceNumber,
            i.created_at,
            o.subtotal,
            o.final_total,
            o.created_at AS order_created_at,
            u.username,
            u.email
        FROM invoices i
        JOIN orders o ON i.order_id = o.id
        JOIN users u ON i.user_id = u.id
        ORDER BY i.created_at DESC
    `;
  connection.query(sql, (err, results) => {
    if (err) {
      console.error('Failed to fetch invoices', err);
      req.flash('error', 'Unable to load invoices');
      return res.render('adminInvoices', { user: req.session.user, orders: [] });
    }

    res.render('adminInvoices', {
      user: req.session.user,
      orders: results || []
    });
  });
});

// Admin: view single invoice
router.get('/admin/invoices/:id', checkAuthenticated, checkAdmin, (req, res) => {
  const invoiceId = parseInt(req.params.id, 10);

  const sqlInvoice = `
        SELECT o.*, u.username, u.email, i.invoice_number AS invoiceNumber, i.id AS invoice_id
        FROM invoices i
        JOIN orders o ON i.order_id = o.id
        JOIN users u ON i.user_id = u.id
        WHERE i.id = ?
    `;
  const sqlItems = `
        SELECT *
        FROM order_items
        WHERE order_id = ?
    `;

  connection.query(sqlInvoice, [invoiceId], (err, orderRows) => {
    if (err || !orderRows || orderRows.length === 0) {
      req.flash('error', 'Invoice not found');
      return res.redirect('/admin/invoices');
    }
    const order = orderRows[0];
    const orderId = order.id;
    const invoiceNumber = order.invoiceNumber || formatInvoiceNumber(orderId);

    connection.query(sqlItems, [orderId], (iErr, itemRows) => {
      if (iErr) {
        req.flash('error', 'Unable to load invoice items');
        return res.redirect('/admin/invoices');
      }

      connection.query(
        'SELECT * FROM refunds WHERE order_id = ? ORDER BY id DESC LIMIT 1',
        [orderId],
        (rErr, refundRows) => {
          if (rErr) {
            console.error('Failed to load refund info', rErr);
          }
          const refundRow = refundRows && refundRows[0] ? refundRows[0] : null;
          const messages = req.flash('error') || [];
          const successMessages = req.flash('success') || [];
          res.render('invoice', {
            user: req.session.user,
            messages,
            successMessages,
            order,
            items: itemRows,
            invoiceNumber,
            refundRow
          });
        }
      );
    });
  });
});

// Admin: Refund an order (credits in-app wallet) — only for wallet-paid orders
router.post('/admin/orders/:orderId/refund', checkAuthenticated, checkAdmin, async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  const redirectTo = (req.get('referer') && req.get('referer').includes('/invoice/'))
    ? req.get('referer')
    : `/invoice/${orderId}`;
  if (!orderId || Number.isNaN(orderId)) {
    req.flash('error', 'Invalid order id');
    return res.redirect('/admin/invoices');
  }

  const amountRaw = (req.body.amount || '').toString().trim();
  const reason = (req.body.reason || '').trim() || null;
  const conn = connection.promise();
  let order;
  let refundAmount;
  const REF_REF = 'WALLET';

  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
    if (!rows || !rows.length) {
      await conn.rollback();
      req.flash('error', 'Order not found');
      return res.redirect('/admin/invoices');
    }
    order = rows[0];
    const payMethod = String(order.payment_method || '').toLowerCase();
    if (payMethod !== 'wallet') {
      await conn.rollback();
      req.flash('error', 'Use the PayPal or NETS refund actions for non-wallet payments.');
      return res.redirect(redirectTo);
    }
    if (!order.user_id) {
      await conn.rollback();
      req.flash('error', 'Refund failed: order has no user linked.');
      return res.redirect(redirectTo);
    }
    const payStatus = String(order.payment_status || '').toUpperCase();
    if (payStatus !== 'PAID') {
      await conn.rollback();
      req.flash('error', 'Only paid orders can be refunded.');
      return res.redirect(redirectTo);
    }
    const currentRefundStatus = String(order.refund_status || '').toUpperCase();
    if (currentRefundStatus === 'REFUNDED') {
      await conn.rollback();
      req.flash('error', 'Order has already been refunded.');
      return res.redirect(redirectTo);
    }

    const fallbackTotal = Number(order.final_total ?? order.amount ?? order.subtotal ?? 0);
    refundAmount = amountRaw ? Number(parseFloat(amountRaw).toFixed(2)) : fallbackTotal;
    if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
      await conn.rollback();
      req.flash('error', 'Refund amount must be greater than 0.');
      return res.redirect(redirectTo);
    }
    if (refundAmount > fallbackTotal) refundAmount = fallbackTotal;

    await conn.query(
      `UPDATE orders
         SET refund_status = 'PENDING',
             refund_amount = ?,
             refund_reason = ?,
             refund_txn_ref = NULL,
             refunded_at = NULL
       WHERE id = ?`,
      [refundAmount, reason, orderId]
    );
    await conn.commit();
  } catch (err) {
    console.error('Failed to mark refund pending', err);
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    req.flash('error', 'Unable to start refund: ' + err.message);
    return res.redirect(redirectTo);
  }

  // Credit to wallet
  try {
    await walletService.ensureWallet(order.user_id);
    await walletService.creditWallet({
      userId: order.user_id,
      amount: refundAmount,
      orderId,
      reason: reason || 'Order refund',
      reference: REF_REF
    });
  } catch (err) {
    console.error('Wallet credit failed', err);
    await conn.query(`UPDATE orders SET refund_status = 'FAILED' WHERE id = ?`, [orderId]);
    req.flash('error', 'Refund failed to credit wallet: ' + err.message);
    return res.redirect(redirectTo);
  }

  // Finalize refund + optional restock on full refund
  try {
    await conn.beginTransaction();
    const fullRefundTotal = Number(order.final_total ?? order.amount ?? order.subtotal ?? 0);
    if (refundAmount === fullRefundTotal) {
      const [items] = await conn.query(
        'SELECT product_id, quantity FROM order_items WHERE order_id = ? FOR UPDATE',
        [orderId]
      );
      await restockInventoryForOrder(conn, orderId, items);
      const earnedPoints = Number(order.loyalty_points_earned || 0);
      if (earnedPoints > 0 && order.user_id) {
        await conn.query(
          'UPDATE users SET loyalty_points = GREATEST(COALESCE(loyalty_points,0) - ?, 0) WHERE id = ?',
          [earnedPoints, order.user_id]
        );
      }
    }
    await conn.query(
      `UPDATE orders
         SET refund_status = 'REFUNDED',
             refund_txn_ref = ?,
             refunded_at = NOW(),
             refund_amount = ?,
             refund_reason = COALESCE(?, refund_reason)
       WHERE id = ?`,
      [REF_REF, refundAmount, reason, orderId]
    );
    await conn.commit();
    req.flash('success', `Refund of $${refundAmount.toFixed(2)} credited to wallet.`);
  } catch (err) {
    console.error('Failed to finalize refund', err);
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    await conn.query(`UPDATE orders SET refund_status = 'FAILED' WHERE id = ?`, [orderId]);
    req.flash('error', 'Refund credited but failed to record locally: ' + err.message);
  }

  return res.redirect(redirectTo);
});

module.exports = router;
