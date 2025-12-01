const express = require('express');
const connection = require('../config/db');
const { checkAuthenticated, checkAdmin } = require('../middleware');

const router = express.Router();
function formatInvoiceNumber(id) {
  const num = parseInt(id, 10);
  if (isNaN(num)) return '#UNKNOWN';
  const base = 108000; // keeps numbers sequential but in the 108k range
  return `#${base + num}`;
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

// Admin: Suppliers (stub for now)
router.get('/admin/suppliers', checkAuthenticated, checkAdmin, (req, res) => {
  const suppliers = [];
  res.render('adminSuppliers', {
    user: req.session.user,
    suppliers
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

router.post('/admin/membership-plans', checkAuthenticated, checkAdmin, (req, res) => {
  const { name, description, points_multiplier, annual_fee, min_annual_spend, benefits, active } = req.body;
  const errors = [];

  const cleanedName = (name || '').trim();
  if (!cleanedName) errors.push('Name is required');

  const cleanedMultiplier = parseFloat(points_multiplier);
  if (isNaN(cleanedMultiplier) || cleanedMultiplier <= 0) errors.push('Points multiplier must be a positive number');

  let cleanedFee = 0;
  if (annual_fee) {
    const v = parseFloat(annual_fee);
    if (isNaN(v) || v < 0) errors.push('Annual fee must be non-negative');
    else cleanedFee = v;
  }

  if (errors.length) {
    errors.forEach(e => req.flash('error', e));
    return res.redirect('/admin/membership-plans');
  }

  const sql = `INSERT INTO membership_plans (name, description, points_multiplier, annual_fee, min_annual_spend, benefits, active) VALUES (?, ?, ?, ?, ?, ?, ?)`;
  connection.query(
    sql,
    [cleanedName, description || null, cleanedMultiplier, cleanedFee, min_annual_spend || null, benefits || null, active ? 1 : 0],
    (err, result) => {
      if (err) {
        console.error('Failed to create membership plan', err);
        req.flash('error', 'Failed to create plan: ' + (err.code || err.message));
        return res.redirect('/admin/membership-plans');
      }
      console.log('Created membership plan id=', result.insertId);
      req.flash('success', 'Membership plan created');
      res.redirect('/admin/membership-plans');
    }
  );
});

router.get('/admin/membership-plans/:id/edit', checkAuthenticated, checkAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  connection.query('SELECT * FROM membership_plans WHERE id = ?', [id], (err, rows) => {
    if (err || !rows || rows.length === 0) {
      req.flash('error', 'Plan not found');
      return res.redirect('/admin/membership-plans');
    }
    res.render('adminMembershipPlanEdit', { user: req.session.user, plan: rows[0] });
  });
});

router.post('/admin/membership-plans/:id', checkAuthenticated, checkAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, description, points_multiplier, annual_fee, min_annual_spend, benefits, active } = req.body;
  const errors = [];

  const cleanedName = (name || '').trim();
  if (!cleanedName) errors.push('Name is required');

  const cleanedMultiplier = parseFloat(points_multiplier);
  if (isNaN(cleanedMultiplier) || cleanedMultiplier <= 0) errors.push('Points multiplier must be a positive number');

  let cleanedFee = 0;
  if (annual_fee) {
    const v = parseFloat(annual_fee);
    if (isNaN(v) || v < 0) errors.push('Annual fee must be non-negative');
    else cleanedFee = v;
  }

  if (errors.length) {
    errors.forEach(e => req.flash('error', e));
    return res.redirect('/admin/membership-plans');
  }

  const sql = `UPDATE membership_plans SET name = ?, description = ?, points_multiplier = ?, annual_fee = ?, min_annual_spend = ?, benefits = ?, active = ? WHERE id = ?`;
  connection.query(
    sql,
    [cleanedName, description || null, cleanedMultiplier, cleanedFee, min_annual_spend || null, benefits || null, active ? 1 : 0, id],
    (err) => {
      if (err) {
        console.error('Failed to update membership plan', err);
        req.flash('error', 'Failed to update plan');
        return res.redirect('/admin/membership-plans');
      }
      req.flash('success', 'Plan updated');
      res.redirect('/admin/membership-plans');
    }
  );
});

router.post('/admin/membership-plans/:id/delete', checkAuthenticated, checkAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  connection.query('DELETE FROM membership_plans WHERE id = ?', [id], (err) => {
    if (err) {
      console.error('Failed to delete membership plan', err);
      req.flash('error', 'Failed to delete plan');
      return res.redirect('/admin/membership-plans');
    }
    req.flash('success', 'Plan deleted');
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
            o.*,
            u.username,
            u.email
        FROM orders o
        JOIN users u ON o.user_id = u.id
        ORDER BY o.created_at DESC
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
  const orderId = parseInt(req.params.id, 10);

  const sqlOrder = `
        SELECT o.*, u.username, u.email
        FROM orders o
        JOIN users u ON o.user_id = u.id
        WHERE o.id = ?
    `;
  const sqlItems = `
        SELECT *
        FROM order_items
        WHERE order_id = ?
    `;

  connection.query(sqlOrder, [orderId], (err, orderRows) => {
    if (err || !orderRows || orderRows.length === 0) {
      req.flash('error', 'Order not found');
      return res.redirect('/admin/invoices');
    }
    const order = orderRows[0];

    connection.query(sqlItems, [orderId], (iErr, itemRows) => {
      if (iErr) {
        req.flash('error', 'Unable to load invoice items');
        return res.redirect('/admin/invoices');
      }

      res.render('invoice', {
        user: req.session.user,
        order,
        items: itemRows,
        invoiceNumber: formatInvoiceNumber(orderId)
      });
    });
  });
});

module.exports = router;
