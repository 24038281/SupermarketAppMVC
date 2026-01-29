// app.js
// Load environment variables (fallback if dotenv isn't installed)

console.log("✅ RUNNING FILE:", __filename);

try {
    require('dotenv').config();
} catch (err) {
    // Minimal .env loader fallback to keep app running without external dependency
    const fs = require('fs');
    const path = require('path');
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        const lines = fs.readFileSync(envPath, 'utf8').split('\n');
        lines.forEach((line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return;
            const idx = trimmed.indexOf('=');
            if (idx === -1) return;
            const key = trimmed.slice(0, idx).trim();
            const value = trimmed.slice(idx + 1).trim();
            if (!process.env[key]) process.env[key] = value;
        });
        console.warn('Loaded .env via fallback loader (install dotenv to remove this warning).');
    }
}
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const multer = require('multer');
const path = require('path');
const netsQr = require('./services/nets');
const axios = require('axios');
const { body } = require('express-validator');
const { attachLocals, checkAuthenticated, checkAdmin } = require('./middleware');
const { pointsToDollars } = require('./utils/loyalty');
const Product = require('./models/Product');
const app = express();
const NETS_PAYMENT_KEY = 'nets_qr';
const paypal = require('./services/paypal');
const { finalizeOrderAfterPayment } = require('./services/orderFinalizer');
const walletService = require('./services/walletService');
const paymentRoutes = require('./routes/paymentRoutes');
const paymentController = require('./controllers/paymentController');

const connection = require('./config/db');          // MySQL connection
const authController = require('./controllers/authController');  // register/login/logout handlers
const adminRoutes = require('./routes/adminRoutes');
const netsViewsPath = path.join(__dirname, 'NETSDemo', 'views');

// Expose PayPal client id to all views (used by checkout.ejs)
app.use((req, res, next) => {
  res.locals.paypalClientId = process.env.PAYPAL_CLIENT_ID || '';
  next();
});

app.use((req, res, next) => {
  console.log("🌐 REQUEST:", req.method, req.url);
  next();
});

// 🔎 DEBUG: show exactly who is redirecting and from which URL
app.use((req, res, next) => {
  const originalRedirect = res.redirect.bind(res);
  res.redirect = (url) => {
    console.log('🚨 REDIRECT', req.method, req.originalUrl, '->', url);
    return originalRedirect(url);
  };
  next();
});


// ==== Loyalty Helpers ====
const LOYALTY_DISCOUNT_PER_POINT = 0.02; // 1 point = $0.02 discount

function getMembershipTier(points) {
    if (points >= 600) return 'Gold';
    if (points >= 200) return 'Silver';
    return 'Basic'; // default
}
function formatInvoiceNumber(id) {
    const num = parseInt(id, 10);
    if (isNaN(num)) return '#UNKNOWN';
    const base = 108000; // keeps numbers sequential but in the 108k range
    return `#${base + num}`;
}
const ORDER_DELIVERY_COLUMNS = {
    customer_name: 'VARCHAR(255)',
    customer_contact: 'VARCHAR(50)',
    delivery_address: 'VARCHAR(255)',
    postal_code: 'VARCHAR(20)',
    payment_method: 'VARCHAR(50)',
    order_notes: 'TEXT',
    delivery_date: 'DATE',
    delivery_time: 'VARCHAR(50)'
};
const ALLOWED_DELIVERY_SLOTS = [
    '10am – 12pm',
    '12pm – 2pm',
    '2pm – 4pm',
    '6pm – 8pm'
];
let orderDeliveryColumnsEnsured = false;
function ensureOrderDeliveryColumns(callback) {
    if (orderDeliveryColumnsEnsured) return callback();
    connection.query('SHOW COLUMNS FROM orders', (err, columns) => {
        if (err) return callback(err);

        const existing = new Set((columns || []).map(col => col.Field));
        const missing = Object.keys(ORDER_DELIVERY_COLUMNS).filter(col => !existing.has(col));

        if (!missing.length) {
            orderDeliveryColumnsEnsured = true;
            return callback();
        }

        const alterParts = missing.map(col => `ADD COLUMN ${col} ${ORDER_DELIVERY_COLUMNS[col]} NULL`);
        const alterSql = `ALTER TABLE orders ${alterParts.join(', ')}`;

        connection.query(alterSql, (alterErr) => {
            if (alterErr) return callback(alterErr);
            orderDeliveryColumnsEnsured = true;
            callback();
        });
    });
}
const INVOICE_COLUMNS = {
    subtotal: 'DECIMAL(10,2)',
    final_total: 'DECIMAL(10,2)'
};
let invoiceColumnsEnsured = false;
function ensureInvoiceColumns(callback) {
    if (invoiceColumnsEnsured) return callback();
    connection.query('SHOW COLUMNS FROM invoices', (err, columns) => {
        if (err) return callback(err);
        const existing = new Set((columns || []).map(col => col.Field));
        const missing = Object.keys(INVOICE_COLUMNS).filter(col => !existing.has(col));
        if (!missing.length) {
            invoiceColumnsEnsured = true;
            return callback();
        }
        const alterParts = missing.map(col => `ADD COLUMN ${col} ${INVOICE_COLUMNS[col]} NULL`);
        const alterSql = `ALTER TABLE invoices ${alterParts.join(', ')}`;
        connection.query(alterSql, (alterErr) => {
            if (alterErr) return callback(alterErr);
            invoiceColumnsEnsured = true;
            callback();
        });
    });
}


// =====================
// Multer: File Uploads
// =====================
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'public/images'); // Directory to save uploaded files
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});
const upload = multer({ storage: storage });

// =====================
// View Engine & Static
// =====================
app.set('views', [path.join(__dirname, 'views'), netsViewsPath]);
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use('/images', express.static(path.join(__dirname, 'public', 'images')));
app.use(express.static(path.join(__dirname, 'NETSDemo', 'public')));

// =====================
// Body Parser
// =====================
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// =====================
// Session & Flash
// =====================
app.use(session({
    secret: 'secret',
    resave: false,
    saveUninitialized: true,
    // Session expires after 1 week of inactivity
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));
app.use(flash());
app.use(attachLocals);
app.use(adminRoutes);
app.use(paymentRoutes);

// =====================
// NETS QR demo routes (keeps core app logic intact)
// =====================
app.get('/nets-demo', (req, res) => {
    res.render(path.join(netsViewsPath, 'shopping'));
});
app.post('/generateNETSQR', netsQr.generateQrCode);
app.get('/nets-qr/success', (req, res) => {
    res.render('netsTxnSuccessStatus', { message: 'Transaction Successful!' });
});
app.get('/nets-qr/fail', (req, res) => {
    res.render('netsTxnFailStatus', { message: 'Transaction Failed. Please try again.' });
});
app.get('/nets-qr/cancel', async (req, res) => {
    const txnRef = req.query.txn_retrieval_ref || req.query.txnRef;
    const orderId = Number(req.query.orderId || req.query.order_id);
    if (txnRef) {
        try { await paymentController.markNetsCancelled({ netsTxnRef: txnRef, payload: { reason: 'CANCELLED_BY_USER' } }); }
        catch (err) { console.error('Failed to mark NETS cancel', err); }
    }
    // Fallback: mark order cancelled if orderId is known (and not already terminal)
    if (orderId) {
        connection.query(
            `UPDATE orders
             SET payment_status = 'CANCELLED'
             WHERE id = ? AND payment_status NOT IN ('PAID','CANCELLED','EXPIRED')`,
            [orderId],
            (err) => { if (err) console.error('[NETS] cancel fallback update failed', err); }
        );
    }
    req.flash('info', 'NETS payment cancelled. Your cart is unchanged.');
    res.redirect('/checkout');
});

// Explicit cancel from NETS QR page (support POST/GET)
const handleNetsCancelByOrder = async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  const sessionUser = req.session.user;
  const userId = sessionUser && sessionUser.id;
  const isAdmin = sessionUser && sessionUser.isPrimaryAdmin;
  if (!orderId || !sessionUser) return res.redirect('/orders');

  const whereUser = isAdmin ? '' : 'AND user_id = ?';
  const params = isAdmin ? [orderId] : [orderId, userId];
  const sql = `
    UPDATE orders
    SET payment_status = 'CANCELLED'
    WHERE id = ?
      ${whereUser}
      AND payment_status <> 'PAID'
  `;

  try {
    const [result] = await connection.promise().query(sql, params);
    console.log('[NETS] cancel updated', { orderId, affectedRows: result.affectedRows });
  } catch (err) {
    console.error('[NETS] cancel route update failed', err);
  }

  return res.redirect(`/invoice/${orderId}`);
};

app.post('/pay/nets/:orderId/cancel', checkAuthenticated, handleNetsCancelByOrder);
app.get('/pay/nets/:orderId/cancel', checkAuthenticated, handleNetsCancelByOrder);

// NETS expire (QR timeout)
app.post('/pay/nets/:orderId/expire', checkAuthenticated, async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  const sessionUser = req.session.user;
  const userId = sessionUser && sessionUser.id;
  const isAdmin = sessionUser && sessionUser.isPrimaryAdmin;
  if (!orderId || !sessionUser) return res.status(400).json({ ok: false, error: 'Invalid order' });

  const whereUser = isAdmin ? '' : 'AND user_id = ?';
  const params = isAdmin ? [orderId] : [orderId, userId];
  const sql = `
    UPDATE orders
    SET payment_status = 'EXPIRED'
    WHERE id = ?
      ${whereUser}
      AND payment_status NOT IN ('PAID','CANCELLED','EXPIRED')
  `;

  try {
    const [result] = await connection.promise().query(sql, params);
    console.log('[NETS] expire updated', { orderId, affectedRows: result.affectedRows });
    return res.json({ ok: true, affectedRows: result.affectedRows });
  } catch (err) {
    console.error('[NETS] expire route failed', err);
    return res.status(500).json({ ok: false, error: 'expire failed' });
  }
});

app.post('/pay-with-nets', checkAuthenticated, (req, res) => {
    const cart = req.session.cart || [];
    if (!cart.length) {
        req.flash('error', 'Your cart is empty.');
        return res.redirect('/cart');
    }

    // Recalculate total on the server to avoid relying on client values
    let subtotal = 0;
    cart.forEach(item => { subtotal += item.price * item.quantity; });

    const applied = req.session.appliedPromo || null;
    const promoDiscount = applied && applied.discount ? Number(applied.discount) : 0;

    const redemption = req.session.loyaltyRedemption || { points: 0, discount: 0 };
    const loyaltyDiscount = redemption.discount || 0;

    const finalTotal = Math.max(0, subtotal - promoDiscount - loyaltyDiscount);

    req.body.cartTotal = finalTotal.toFixed(2);
    return netsQr.generateQrCode(req, res);
});

// Redirect here after placing order with NETS QR
app.get('/pay/nets/:orderId', checkAuthenticated, (req, res) => {
    const orderId = parseInt(req.params.orderId, 10);
    const userId = req.session.user && req.session.user.id;

    if (!userId) {
        req.flash('error', 'Session expired. Please log in again to complete NETS payment.');
        return res.redirect('/login');
    }

    if (isNaN(orderId)) {
        req.flash('error', 'Invalid order id for NETS payment.');
        return res.redirect('/checkout');
    }

    const orderSql = 'SELECT final_total FROM orders WHERE id = ? AND user_id = ?';
    connection.query(orderSql, [orderId, userId], (err, rows) => {
        if (err) {
            console.error('❌ NETS SQL error:', err.code, err.sqlMessage);
            req.flash('error', 'Unable to load order for NETS payment.');
            return res.redirect('/orders');
        }

        if (!rows || !rows.length) {
            req.flash('error', 'Order not found.');
            return res.redirect('/orders');
        }

        const cartTotal = Number(rows[0].final_total).toFixed(2);

        // Mark payment as PENDING when QR is shown (only if not already terminal/paid)
        const pendingSql = `
            UPDATE orders
            SET payment_status = 'PENDING', payment_method = 'NETS_QR'
            WHERE id = ? AND user_id = ? AND payment_status NOT IN ('PAID','CANCELLED','EXPIRED')
        `;
        connection.query(pendingSql, [orderId, userId], (pendErr) => {
            if (pendErr) {
                console.error('[NETS] Failed to mark PENDING', pendErr);
            }
        });

        const fakeReq = {
            body: { cartTotal, orderId },
            params: { orderId },
            session: req.session,
            query: req.query,
        };


        return netsQr.generateQrCode(fakeReq, res);
    });
});

// PayPal retry / payment page for existing order
app.get('/pay/paypal/:orderId', checkAuthenticated, async (req, res) => {
    const orderId = parseInt(req.params.orderId, 10);
    const userId = req.session.user && req.session.user.id;
    if (!orderId || !userId) {
        req.flash('error', 'Invalid order for PayPal payment.');
        return res.redirect('/orders');
    }

    try {
        const [rows] = await connection.promise().query(
            `SELECT final_total FROM orders WHERE id = ? AND user_id = ?`,
            [orderId, userId]
        );
        if (!rows || !rows.length) {
            req.flash('error', 'Order not found for PayPal payment.');
            return res.redirect('/orders');
        }

        // keep pending marker so capture knows which order to finalize
        req.session.paypalPendingOrderId = orderId;

        return res.render('payPaypal', {
            user: req.session.user,
            orderId,
            amount: Number(rows[0].final_total || 0).toFixed(2),
            paypalClientId: process.env.PAYPAL_CLIENT_ID
        });
    } catch (err) {
        console.error('[PayPal] load order for retry failed', err);
        req.flash('error', 'Unable to load order for PayPal payment.');
        return res.redirect('/orders');
    }
});


// Server-Sent Events endpoint for NETS payment status
app.get('/sse/payment-status/:txnRetrievalRef', async (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });

    const txnRetrievalRef = req.params.txnRetrievalRef;
    let pollCount = 0;
    const maxPolls = 60; // 5 minutes if polling every 5s
    let frontendTimeoutStatus = 0;

    const interval = setInterval(async () => {
        pollCount++;

        try {
            const response = await axios.post(
                'https://sandbox.nets.openapipaas.com/api/v1/common/payments/nets-qr/query',
                { txn_retrieval_ref: txnRetrievalRef, frontend_timeout_status: frontendTimeoutStatus },
                {
                    headers: {
                        'api-key': process.env.API_KEY,
                        'project-id': process.env.PROJECT_ID,
                        'Content-Type': 'application/json'
                    }
                }
            );

            console.log("Polling response:", response.data);
            res.write(`data: ${JSON.stringify(response.data)}\n\n`);

            const resData = response.data.result.data;

            if (resData.response_code == "00" && resData.txn_status === 1) {
                console.log('[NETS][SSE] Success detected (response_code=00, txn_status=1)', {
                    txnRetrievalRef,
                    response_code: resData.response_code,
                    txn_status: resData.txn_status
                });
                res.write(`data: ${JSON.stringify({ success: true })}\n\n`);
                try {
                    await paymentController.markNetsSuccess({ netsTxnRef: txnRetrievalRef, payload: response.data });
                    // Clear cart/promos/checkout draft only after confirmed success
                    if (req.session) {
                        req.session.cart = [];
                        req.session.appliedPromo = null;
                        req.session.loyaltyRedemption = null;
                        req.session.checkoutDraft = null;
                    }
                } catch (e) {
                    console.error('Failed to mark NETS success', e);
                }
                clearInterval(interval);
                res.end();
            } else if (frontendTimeoutStatus == 1 && resData && (resData.response_code !== "00" || resData.txn_status === 2)) {
                res.write(`data: ${JSON.stringify({ fail: true, ...resData })}\n\n`);
                try {
                    await paymentController.markNetsFailure({ netsTxnRef: txnRetrievalRef, payload: response.data });
                } catch (e) {
                    console.error('Failed to mark NETS failure', e);
                }
                clearInterval(interval);
                res.end();
            }

        } catch (err) {
            clearInterval(interval);
            res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
            res.end();
        }

        if (pollCount >= maxPolls) {
            clearInterval(interval);
            frontendTimeoutStatus = 1;
            res.write(`data: ${JSON.stringify({ fail: true, error: "Timeout" })}\n\n`);
            try {
                await paymentController.markNetsFailure({ netsTxnRef: txnRetrievalRef, payload: { error: 'Timeout' }, status: 'EXPIRED' });
            } catch (e) {
                console.error('Failed to mark NETS timeout', e);
            }
            res.end();
        }
    }, 5000);

    req.on('close', () => {
        clearInterval(interval);
    });
});

// =====================
// Auth / Role Middleware
// =====================

// =====================
// User Dashboard (non-admin)
// =====================
app.get('/dashboard', checkAuthenticated, (req, res) => {
    if (req.session.user && req.session.user.isPrimaryAdmin) {
        return res.redirect('/admin/dashboard');
    }
    const cartCount = (req.session.cart || []).reduce((s, i) => s + i.quantity, 0);
    const wishlistCount = (req.session.wishlist || []).length;
    const membershipTier = (req.session.user && req.session.user.membership_tier) || 'Basic';
    const loyaltyPoints = (req.session.user && typeof req.session.user.loyalty_points === 'number')
        ? req.session.user.loyalty_points
        : 0;

    res.render('userDashboard', {
        user: req.session.user,
        stats: {
            cartCount,
            wishlistCount,
            membershipTier,
            loyaltyPoints
        }
    });
});

// =====================
// Membership (public/user)
// =====================
app.get('/membership', (req, res) => {
    connection.query('SELECT * FROM membership_plans WHERE active = 1 ORDER BY points_multiplier DESC', (err, plans) => {
        if (err) {
            console.error('Failed to load membership plans', err);
            req.flash('error', 'Unable to load membership plans');
            return res.render('membership', { user: req.session.user, plans: [] });
        }
        res.render('membership', { user: req.session.user, plans: plans || [] });
    });
});

// =====================
// Auth Routes (inlined for MVC structure)
// =====================
app.get('/register', authController.getRegister);
app.post(
    '/register',
    [
        body('username').notEmpty().withMessage('Username is required'),
        body('email').isEmail().withMessage('Valid email is required'),
        body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
        body('address').notEmpty().withMessage('Address is required'),
        body('contact').notEmpty().withMessage('Contact is required'),
    ],
    authController.postRegister
);
app.get('/login', authController.getLogin);
app.post('/login', authController.postLogin);
app.get('/logout', authController.logout);

// =====================
// Home Page
// =====================
app.get('/', (req, res) => {
    Product.getProductsWithBadges({ limit: 8 }, (err, results) => {
        if (err) {
            console.error('Failed to load products', err);
            return res.render('index', {
                user: req.session.user,
                cart: req.session.cart || [],
                featuredProducts: []
            });
        }
        res.render('index', {
            user: req.session.user,
            cart: req.session.cart || [],
            featuredProducts: results
        });
    });
});

// =====================
// Shopping Page
// =====================
app.get('/shopping', checkAuthenticated, (req, res) => {
    const category = (req.query.category || '').trim();
    const rawSort = (req.query.sort || '').trim();
    const sort = rawSort === 'price_asc' || rawSort === 'price_desc' ? rawSort : '';
    const promoSql = `
        SELECT * FROM promocodes
        WHERE active = 1
          AND (starts_at IS NULL OR starts_at <= NOW())
          AND (expires_at IS NULL OR expires_at >= NOW())
    `;
    Product.getProductsWithBadges({ category, sort }, (error, results) => {
        if (error) throw error;
        connection.query(promoSql, (pErr, promos) => {
            if (pErr) throw pErr;
            res.render('shopping', {
                user: req.session.user,
                products: results,
                searchQuery: null,
                promos: promos || [],
                selectedCategory: category,
                selectedSort: sort || ''
            });
        });
    });
});

// =====================
// Product Search
// =====================
app.get('/search', (req, res) => {
    const q = (req.query.q || '').trim();
    const rawSort = (req.query.sort || '').trim();
    const sort = rawSort === 'price_asc' || rawSort === 'price_desc' ? rawSort : '';

    // Basic validation
    if (!q) return res.redirect('/shopping');
    if (q.length > 100) {
        req.flash('error', 'Search term too long');
        return res.redirect('/shopping');
    }

    // escape SQL wildcard characters so user input is treated literally
    const escaped = q.replace(/[%_]/g, ch => `\\${ch}`);
    const like = `%${escaped}%`;

    const promoSql = `
        SELECT * FROM promocodes
        WHERE active = 1
          AND (starts_at IS NULL OR starts_at <= NOW())
          AND (expires_at IS NULL OR expires_at >= NOW())
    `;

    Product.getProductsWithBadges({ search: q, sort }, (err, results) => {
        if (err) {
            console.error('Search query error:', err);
            req.flash('error', 'Search failed - please try again');
            return res.redirect('/shopping');
        }

        connection.query(promoSql, (pErr, promos) => {
            if (pErr) {
                console.error('Promo query error', pErr);
                promos = [];
            }
            res.render('shopping', {
                user: req.session.user || null,
                products: results,
                searchQuery: q,
                promos: promos || [],
                selectedCategory: '',
                selectedSort: sort || ''
            });
        });
    });
});

// =====================
// Cart
// =====================


// Add to cart
app.post('/add-to-cart/:id', checkAuthenticated, (req, res) => {
    const productId = parseInt(req.params.id);
    const quantityToAdd = parseInt(req.body.quantity) || 1;

    connection.query('SELECT * FROM products WHERE id = ?', [productId], (error, results) => {
        if (error) throw error;

        if (results.length > 0) {
            const product = results[0];

            // If no stock at all
            if (!product.quantity || product.quantity <= 0) {
                req.flash('error', `Sorry, "${product.productName}" is out of stock.`);
                return res.redirect('/shopping');
            }

            // Initialize cart in session if not exists
            if (!req.session.cart) {
                req.session.cart = [];
            }

            const cart = req.session.cart;

            // Check if product already in cart
            const existingItem = cart.find(item => item.productId === productId);

            const currentQtyInCart = existingItem ? existingItem.quantity : 0;
            let desiredTotalQty = currentQtyInCart + quantityToAdd;

            // Enforce stock limit
            if (desiredTotalQty > product.quantity) {
                desiredTotalQty = product.quantity;
                req.flash(
                    'error',
                    `Only ${product.quantity} units of "${product.productName}" are available. Cart quantity has been adjusted.`
                );
            }

            // If after adjustment there's still some quantity to keep
            if (desiredTotalQty > 0) {
                if (existingItem) {
                    existingItem.quantity = desiredTotalQty;
                } else {
                    cart.push({
                        productId: product.id,
                        productName: product.productName,
                        price: product.price,
                        quantity: desiredTotalQty,
                        image: product.image
                    });
                }
            } else {
                // If no quantity can be added at all
                req.flash('error', `Unable to add "${product.productName}" – no stock available.`);
            }

            res.redirect('/cart');
        } else {
            res.status(404).send('Product not found');
        }
    });
});


// View cart
app.get('/cart', checkAuthenticated, (req, res) => {
    const cart = req.session.cart || [];
    res.render('cart', {
        cart,
        user: req.session.user
    });
});

// Update cart item quantity
app.post('/cart/update/:id', checkAuthenticated, (req, res) => {
    const productId = parseInt(req.params.id);
    const quantity = parseInt(req.body.quantity);

    if (!req.session.cart) return res.redirect('/cart');
    if (isNaN(quantity) || quantity <= 0) {
        req.session.cart = req.session.cart.filter(i => i.productId !== productId);
        return res.redirect('/cart');
    }

    const cart = req.session.cart;
    const item = cart.find(i => i.productId === productId);
    if (!item) return res.redirect('/cart');

    // ✅ Check stock from DB
    connection.query('SELECT quantity, productName FROM products WHERE id = ?', [productId], (err, results) => {
        if (err) throw err;
        if (!results.length) {
            req.flash('error', 'Product no longer exists.');
            return res.redirect('/cart');
        }

        const product = results[0];
        if (quantity > product.quantity) {
            req.flash(
                'error',
                `Cannot set quantity above stock. Only ${product.quantity} units of "${product.productName}" are available.`
            );
            return res.redirect('/cart');
        }

        item.quantity = quantity;
        res.redirect('/cart');
    });
});

// Remove cart item
app.post('/cart/remove/:id', checkAuthenticated, (req, res) => {
    const productId = parseInt(req.params.id);
    if (!req.session.cart) return res.redirect('/cart');
    req.session.cart = req.session.cart.filter(i => i.productId !== productId);
    res.redirect('/cart');
});

// =====================
// Wishlist
// =====================
app.get('/wishlist', checkAuthenticated, (req, res) => {
    const wishlist = req.session.wishlist || [];
    res.render('wishlist', {
        user: req.session.user,
        wishlist
    });
});

// Add to wishlist
app.post('/wishlist/add/:id', checkAuthenticated, (req, res) => {
    const productId = parseInt(req.params.id);

    connection.query('SELECT * FROM products WHERE id = ?', [productId], (error, results) => {
        if (error) throw error;

        if (results.length > 0) {
            const product = results[0];

            if (!req.session.wishlist) req.session.wishlist = [];
            const wishlist = req.session.wishlist;

            const existing = wishlist.find(item => item.productId === productId);
            if (!existing) {
                wishlist.push({
                    productId: product.id,
                    productName: product.productName,
                    price: product.price,
                    image: product.image
                });
            }
        }
        res.redirect('/wishlist');
    });
});

// Remove from wishlist
app.post('/wishlist/remove/:id', checkAuthenticated, (req, res) => {
    const productId = parseInt(req.params.id);
    if (!req.session.wishlist) return res.redirect('/wishlist');
    req.session.wishlist = req.session.wishlist.filter(i => i.productId !== productId);
    res.redirect('/wishlist');
});

// =====================
// Orders / Purchase History
// =====================
app.get('/orders', checkAuthenticated, (req, res) => {
    // Prevent stale "Invoice not found" flash from showing on purchase history
    if (req.session && req.session.flash && req.session.flash.error) {
        delete req.session.flash.error;
    }
    const userId = req.session.user && req.session.user.id;
    if (!userId) {
        req.flash('error', 'You must be logged in to view orders.');
        return res.redirect('/login');
    }

    const orderSql = `
        SELECT
            o.*,
            u.username,
            u.email,
            i.id AS invoice_id,
            i.invoice_number
        FROM orders o
        JOIN users u ON o.user_id = u.id
        LEFT JOIN invoices i ON i.order_id = o.id
        WHERE o.user_id = ?
        ORDER BY o.created_at DESC
    `;
    connection.query(orderSql, [userId], (err, orders) => {
        if (err) {
            console.error('Failed to load orders', err);
            req.flash('error', 'Unable to load your orders right now.');
            return res.render('purchasehistory', { user: req.session.user, orders: [] });
        }
        const orderList = orders || [];
        if (!orderList.length) {
            return res.render('purchasehistory', { user: req.session.user, orders: [] });
        }

        const orderIds = orderList.map(o => o.id);
        const itemsSql = `
            SELECT oi.*, p.image
            FROM order_items oi
            LEFT JOIN products p ON oi.product_id = p.id
            WHERE oi.order_id IN (?)
            ORDER BY oi.order_id ASC, oi.id ASC
        `;
        connection.query(itemsSql, [orderIds], (iErr, items) => {
            if (iErr) {
                console.error('Failed to load order items', iErr);
                req.flash('error', 'Unable to load your orders right now.');
                return res.render('purchasehistory', { user: req.session.user, orders: [] });
            }
            const grouped = {};
            (items || []).forEach(it => {
                if (!grouped[it.order_id]) grouped[it.order_id] = [];
                grouped[it.order_id].push(it);
            });
            const hydrated = orderList.map(o => {
                const invId = o.invoice_id; // use invoice primary key only
                const rawInvoice = o.invoice_number || (invId ? formatInvoiceNumber(invId) : '');
                const invoiceDisplay = (rawInvoice || '').replace(/^#/, '');
                return {
                    ...o,
                    items: grouped[o.id] || [],
                    invoiceId: invId,
                    invoiceNumber: rawInvoice,
                    invoiceDisplay
                };
            });
            res.render('purchasehistory', {
                user: req.session.user,
                orders: hydrated
            });
        });
    });
});

// Reorder: copy past order items back into cart
app.get('/orders/:id/reorder', checkAuthenticated, (req, res) => {
    const userId = req.session.user && req.session.user.id;
    const orderId = parseInt(req.params.id, 10);
    if (!userId || isNaN(orderId)) {
        req.flash('error', 'Invalid order.');
        return res.redirect('/orders');
    }

    // Ensure order belongs to user
    connection.query('SELECT id FROM orders WHERE id = ? AND user_id = ?', [orderId, userId], (err, rows) => {
        if (err || !rows || !rows.length) {
            req.flash('error', 'Order not found.');
            return res.redirect('/orders');
        }

        const itemsSql = `
            SELECT oi.*, p.productName, p.price AS current_price, p.image, p.quantity AS stock
            FROM order_items oi
            LEFT JOIN products p ON oi.product_id = p.id
            WHERE oi.order_id = ?
        `;
        connection.query(itemsSql, [orderId], (iErr, items) => {
            if (iErr) {
                console.error('Failed to load order items for reorder', iErr);
                req.flash('error', 'Unable to reorder right now.');
                return res.redirect('/orders');
            }

            if (!req.session.cart) req.session.cart = [];
            const cart = req.session.cart;
            const skipped = [];
            let addedCount = 0;

            (items || []).forEach(it => {
                if (!it.product_id || !it.productName || it.stock === null || it.stock === undefined || it.stock <= 0) {
                    skipped.push(it.product_name || `Item #${it.id}`);
                    return;
                }
                const desiredQty = Math.min(it.quantity, it.stock);
                if (desiredQty <= 0) {
                    skipped.push(it.productName);
                    return;
                }

                const existing = cart.find(c => c.productId === it.product_id);
                if (existing) {
                    const newQty = Math.min(existing.quantity + desiredQty, it.stock);
                    addedCount += Math.max(0, newQty - existing.quantity);
                    existing.quantity = newQty;
                } else {
                    cart.push({
                        productId: it.product_id,
                        productName: it.productName,
                        price: it.current_price || it.unit_price || 0,
                        image: it.image,
                        quantity: desiredQty
                    });
                    addedCount += desiredQty;
                }
            });

            if (addedCount > 0) {
                req.flash('success', `Added ${addedCount} item(s) from order #${orderId} to your cart.`);
            } else {
                req.flash('info', 'No items could be added from that order.');
            }
            if (skipped.length) {
                req.flash('error', `Skipped items due to stock/unavailability: ${skipped.join(', ')}`);
            }
            res.redirect('/cart');
        });
    });
});

// =====================
// Checkout
// =====================
app.get('/checkout', checkAuthenticated, (req, res) => {
    const userId = req.session?.user?.id || null;
    const cart = req.session.cart || [];
    if (cart.length === 0) {
        req.flash('error', 'Your cart is empty.');
        return res.redirect('/cart');
    }

    let total = 0;
    cart.forEach(item => {
        total += item.price * item.quantity;
    });

    // Fetch active promos to show on checkout page
    const promoSql = `
        SELECT * FROM promocodes
        WHERE active = 1
          AND (starts_at IS NULL OR starts_at <= NOW())
          AND (expires_at IS NULL OR expires_at >= NOW())
    `;
    const walletBalancePromise = userId
        ? (async () => {
            try {
                await walletService.ensureWallet(userId);
                return await walletService.getBalance(userId);
            } catch (err) {
                console.error('Failed to load wallet balance', err);
                return 0;
            }
          })()
        : Promise.resolve(0);

    const renderCheckout = (payload) => {
        walletBalancePromise.then((balance) => {
            res.render('checkout', { walletBalance: balance, ...payload });
        });
    };

    connection.query(promoSql, (pErr, promos) => {
        if (pErr) throw pErr;
        const applied = req.session.appliedPromo || null;
        const userId = req.session.user && req.session.user.id;
        const loyaltyRedemption = req.session.loyaltyRedemption || { points: 0, discount: 0 };
        const draft = req.session.checkoutDraft || {};
        const deliveryDate = draft.deliveryDate || '';
        const deliveryTime = draft.deliveryTime || '';

        // re-validate applied promo against current cart and per-user limits
        if (applied && applied.promoId) {
            connection.query('SELECT * FROM promocodes WHERE id = ?', [applied.promoId], (err, pRows) => {
                if (err) {
                    console.error('Error validating applied promo', err);
                    // proceed without applied promo
                    req.session.appliedPromo = null;
                    return renderCheckout({
                        user: req.session.user,
                        cart,
                        total,
                        originalTotal: total,
                        promoError: null,
                        appliedPromo: null,
                        appliedDiscount: 0,
                        previewPromo: req.session.previewPromo || null,
                        promos: promos || [],
                        loyaltyRedemption,
                        deliveryDate,
                        deliveryTime
                    });
                }
                const promo = pRows && pRows[0];
                if (!promo) {
                    req.session.appliedPromo = null;
                    req.flash('error', 'Previously applied promo is no longer valid');
                    return res.redirect('/checkout');
                }

                // check min_total
                if (promo.min_total && total < promo.min_total) {
                    // remove applied promo if subtotal fell below required minimum
                    req.session.appliedPromo = null;
                    req.flash('error', `Promo ${promo.code} removed: requires minimum spend of $${parseFloat(promo.min_total).toFixed(2)}`);
                    return res.redirect('/checkout');
                }

                // check per-user usage
                if (promo.per_user_limit && userId) {
                    connection.query('SELECT uses FROM promocode_redemptions WHERE promo_id = ? AND user_id = ?', [promo.id, userId], (rErr, rRows) => {
                        if (rErr) {
                            console.error('Error checking promo redemptions', rErr);
                            req.session.appliedPromo = null;
                            req.flash('error', 'Unable to validate promo usage');
                            return res.redirect('/checkout');
                        }
                        const redeemed = rRows && rRows[0] ? rRows[0].uses : 0;
                        if (redeemed >= promo.per_user_limit) {
                            req.session.appliedPromo = null;
                            req.flash('error', `Promo ${promo.code} already used by this account`);
                            return res.redirect('/checkout');
                        }

                        // promo OK
                        const appliedDiscount = Number(applied.discount) || 0;
                        const renderTotal = Math.max(0, total - appliedDiscount);
                        return renderCheckout({
                            user: req.session.user,
                            cart,
                            total: renderTotal,
                            originalTotal: total,
                            promoError: null,
                            appliedPromo: applied ? applied.code : null,
                            appliedDiscount,
                            previewPromo: req.session.previewPromo || null,
                            promos: promos || [],
                            loyaltyRedemption,
                            deliveryDate,
                            deliveryTime
                        });
                    });
                } else {
                    const appliedDiscount = Number(applied.discount) || 0;
                    const renderTotal = Math.max(0, total - appliedDiscount);
                    return renderCheckout({
                        user: req.session.user,
                        cart,
                        total: renderTotal,
                        originalTotal: total,
                        promoError: null,
                        appliedPromo: applied ? applied.code : null,
                        appliedDiscount,
                        previewPromo: req.session.previewPromo || null,
                        promos: promos || [],
                        loyaltyRedemption,
                        deliveryDate,
                        deliveryTime
                    });
                }
            });
        } else {
            // no applied promo
            return renderCheckout({
                user: req.session.user,
                cart,
                total,
                originalTotal: total,
                promoError: null,
                appliedPromo: null,
                appliedDiscount: 0,
                previewPromo: req.session.previewPromo || null,
                promos: promos || [],
                loyaltyRedemption,
                deliveryDate,
                deliveryTime
            });
        }
    });
});
// =====================
// Loyalty: apply points
// =====================
app.post('/apply-loyalty', checkAuthenticated, (req, res) => {
    const user = req.session.user;
    if (!user) {
        req.flash('error', 'You must be logged in to redeem points.');
        return res.redirect('/login');
    }

    const availablePoints = typeof user.loyalty_points === 'number' ? user.loyalty_points : 0;
    const rawRequested = parseInt(req.body.pointsToRedeem, 10);
    if (isNaN(rawRequested) || rawRequested <= 0) {
        req.flash('error', 'Please enter a valid number of points.');
        return res.redirect('/checkout');
    }

    // Optional: enforce multiples of 100
    if (rawRequested % 100 !== 0) {
        req.flash('error', 'Please redeem points in multiples of 100.');
        return res.redirect('/checkout');
    }

    if (rawRequested > availablePoints) {
        req.flash('error', 'You do not have enough points to redeem that amount.');
        return res.redirect('/checkout');
    }

    const discount = pointsToDollars(rawRequested);

    // Deduct from DB and update session user balance
    connection.query(
        'UPDATE users SET loyalty_points = GREATEST(loyalty_points - ?, 0) WHERE id = ?',
        [rawRequested, user.id],
        (err) => {
            if (err) {
                console.error('Failed to deduct loyalty points', err);
                req.flash('error', 'Unable to redeem points right now.');
                return res.redirect('/checkout');
            }

            const newBalance = Math.max(0, availablePoints - rawRequested);
            req.session.user.loyalty_points = newBalance;

            // Save in session so checkout.ejs and POST /checkout can use it
            req.session.loyaltyRedemption = {
                points: rawRequested,
                discount: discount
            };

            req.flash('success', `Redeeming ${rawRequested} points for $${discount.toFixed(2)} off.`);
            res.redirect('/checkout');
        }
    );
});

// Cancel loyalty redemption (restore points)
app.post('/cancel-loyalty', checkAuthenticated, (req, res) => {
    const user = req.session.user;
    const redemption = req.session.loyaltyRedemption;
    if (!user || !redemption || !redemption.points) {
        return res.redirect('/checkout');
    }

    const pointsToRestore = redemption.points;

    connection.query(
        'UPDATE users SET loyalty_points = loyalty_points + ? WHERE id = ?',
        [pointsToRestore, user.id],
        (err) => {
            if (err) {
                console.error('Failed to restore loyalty points', err);
                req.flash('error', 'Unable to cancel redemption right now.');
                return res.redirect('/checkout');
            }

            req.session.user.loyalty_points = (req.session.user.loyalty_points || 0) + pointsToRestore;
            req.session.loyaltyRedemption = null;
            req.flash('info', 'Loyalty redemption cancelled and points restored.');
            res.redirect('/checkout');
        }
    );
});

// =====================
// Checkout: place order #post
// =====================

app.post('/checkout', checkAuthenticated, (req, res) => {
    
    console.log("CHECKOUT BODY:",req.body);

    const cart = req.session.cart || [];
    const userId = req.session.user && req.session.user.id;

    console.log('🔵 POST /checkout', {
        userId,
        paymentMethodInput: req.body.paymentMethod
    });
    console.log('ℹ️ req.body keys:', Object.keys(req.body));
    console.log('ℹ️ full req.body:', req.body);

    if (!userId) {
        req.flash('error', 'Please log in to place an order.');
        return res.redirect('/login');
    }
    if (req.session.user && req.session.user.isPrimaryAdmin) {
        req.flash('error', 'Admin accounts cannot place orders. Please use a customer account.');
        return res.redirect('/admin/dashboard');
    }

    // Delivery + payment details from checkout form (explicit camelCase -> snake_case mapping)
    const orderPayload = {
        customer_name: (req.body.customerName || '').trim(),
        customer_contact: (req.body.customerContact || '').trim(),
        delivery_address: (req.body.customerAddress || '').trim(),
        postal_code: (req.body.customerPostal || '').trim(),
        payment_method_raw: (req.body.paymentMethod || '').trim().toLowerCase(),
        order_notes: (req.body.orderNotes || '').trim(),
        delivery_date: (req.body.deliveryDate || '').trim(),
        delivery_time: (req.body.deliveryTime || '').trim()
    };
    const paymentMethodInput = orderPayload.payment_method_raw;
    const deliveryName = orderPayload.customer_name;
    const deliveryContact = orderPayload.customer_contact;
    const deliveryAddress = orderPayload.delivery_address;
    const deliveryPostal = orderPayload.postal_code;
    const orderNotes = orderPayload.order_notes;
    const deliveryDateStr = orderPayload.delivery_date;
    const deliveryTimeSlot = orderPayload.delivery_time;

    const paymentMethodLabels = {
        cash_on_delivery: 'Cash on Delivery',
        paynow_mock: 'PayNow',
        card_mock: 'Credit/Debit',
        [NETS_PAYMENT_KEY]: 'NETS QR',
        wallet: 'WALLET'
    };
    const paymentMethod = paymentMethodLabels[paymentMethodInput] || paymentMethodInput;
    const isNetsPayment = paymentMethodInput === NETS_PAYMENT_KEY;
    const isWalletPayment = paymentMethodInput === 'wallet';
    console.log('ℹ️ payment method normalized', { paymentMethodInput, paymentMethod, isNetsPayment });

    const checkoutErrors = [];
    if (!deliveryName) checkoutErrors.push('Delivery name is required.');
    if (!deliveryContact) checkoutErrors.push('Contact number is required.');
    if (!deliveryAddress) checkoutErrors.push('Delivery address is required.');
    if (!deliveryPostal) checkoutErrors.push('Postal code is required.');
    if (!paymentMethod) checkoutErrors.push('Payment method is required.');

    // Delivery scheduling validation
    let deliveryDateVal = null;
    if (!deliveryDateStr) {
        checkoutErrors.push('Delivery date is required.');
    } else {
        const candidate = new Date(deliveryDateStr);
        if (isNaN(candidate.getTime())) {
            checkoutErrors.push('Invalid delivery date.');
        } else {
            const today = new Date();
            today.setHours(0,0,0,0);
            candidate.setHours(0,0,0,0);
            if (candidate < today) {
                checkoutErrors.push('Delivery date cannot be in the past.');
            } else {
                deliveryDateVal = deliveryDateStr;
            }
        }
    }

    if (!deliveryTimeSlot) {
        checkoutErrors.push('Delivery time slot is required.');
    } else if (!ALLOWED_DELIVERY_SLOTS.includes(deliveryTimeSlot)) {
        checkoutErrors.push('Invalid delivery time slot.');
    }

    // Persist draft values for re-render
    req.session.checkoutDraft = {
        deliveryDate: deliveryDateStr,
        deliveryTime: deliveryTimeSlot
    };

    if (checkoutErrors.length) {
        checkoutErrors.forEach(msg => req.flash('error', msg));
        return res.redirect('/checkout');
    }

    // 1. Calculate order totals (before DB)
    let orderTotal = 0;
    cart.forEach(item => {
        orderTotal += item.price * item.quantity;
    });

    // Promo discount
    const applied = req.session.appliedPromo || null;
    let promoDiscount = 0;
    if (applied && applied.promoId) {
        promoDiscount = Number(applied.discount) || 0;
    }

    // Loyalty discount
    const redemption = req.session.loyaltyRedemption || { points: 0, discount: 0 };
    const redeemedPoints = redemption.points || 0;
    const loyaltyDiscount = redemption.discount || 0;

    // Final amount paid (cannot be negative)
    let finalTotal = Math.max(0, orderTotal - promoDiscount - loyaltyDiscount);
    console.log('ℹ️ Checkout totals', { orderTotal, promoDiscount, loyaltyDiscount, finalTotal, paymentMethod: paymentMethodInput });

    // Loyalty earning will be applied only after payment is PAID (see finalizeOrderAfterPayment)

    async function postCommit(orderId) {
        // Wallet immediate payment
        if (isWalletPayment) {
            try {
                await walletService.ensureWallet(userId);
                await walletService.debitWallet({
                    userId,
                    amount: finalTotal,
                    orderId,
                    reason: 'Order payment',
                    reference: 'WALLET_PAY'
                });
                await finalizeOrderAfterPayment({ orderId, userId, method: 'WALLET' });

                req.session.cart = [];
                req.session.appliedPromo = null;
                req.session.loyaltyRedemption = null;
                req.session.checkoutDraft = null;

                req.flash('success', 'Payment completed with Wallet.');
                return res.redirect(`/invoice/${orderId}`);
            } catch (err) {
                console.error('Wallet payment failed', err);
                try {
                    await connection.promise().query(
                        `UPDATE orders
                           SET payment_status = 'PENDING',
                               payment_method = 'WALLET',
                               payment_failure_reason = 'INSUFFICIENT_WALLET_BALANCE'
                         WHERE id = ?`,
                        [orderId]
                    );
                } catch (updErr) {
                    console.error('Failed to mark wallet failure on order', updErr);
                }
                req.flash('error', 'Wallet payment failed: ' + err.message);
                return res.redirect('/checkout');
            }
        }

        // Default flow (non-wallet)
        if (!isNetsPayment) {
            req.session.cart = [];
            req.session.appliedPromo = null;
            req.session.loyaltyRedemption = null;
            req.session.checkoutDraft = null;
        }

        req.flash('success', 'Order placed successfully! Complete payment to confirm.');
        const redirectTarget = isNetsPayment ? `/pay/nets/${orderId}` : `/invoice/${orderId}`;
        return res.redirect(redirectTarget);
    }

    // Start a transaction so stock + order are consistent
    ensureOrderDeliveryColumns((schemaErr) => {
        if (schemaErr) {
            console.error('Failed to ensure delivery columns', schemaErr);
            req.flash('error', 'Unable to prepare order storage. Please try again.');
            return res.redirect('/checkout');
        }

        ensureInvoiceColumns((invoiceErr) => {
            if (invoiceErr) {
                console.error('Failed to ensure invoice columns', invoiceErr);
                req.flash('error', 'Unable to prepare invoice storage. Please try again.');
                return res.redirect('/checkout');
            }

            connection.beginTransaction(err => {
                if (err) {
                    console.error('Failed to start transaction', err);
                    req.flash('error', 'Unable to complete checkout. Please try again.');
                    return res.redirect('/checkout');
                }

            // 2. Insert into orders (invoice header)
            const orderSql = `
                INSERT INTO orders (
                    user_id,
                    customer_name,
                    customer_contact,
                    delivery_address,
                    postal_code,
                    payment_method,
                    payment_status,
                    order_notes,
                    delivery_date,
                    delivery_time,
                    subtotal,
                    promo_discount,
                    loyalty_discount,
                    final_total
                )
                VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?)
            `;
            const orderParams = [
                userId,
                orderPayload.customer_name,
                orderPayload.customer_contact,
                orderPayload.delivery_address,
                orderPayload.postal_code,
                paymentMethod,
                orderPayload.order_notes || null,
                deliveryDateVal,
                deliveryTimeSlot,
                orderTotal,
                promoDiscount,
                loyaltyDiscount,
                finalTotal
            ];
            connection.query(orderSql, orderParams, (orderErr, orderResult) => {
                if (orderErr) {
                    return connection.rollback(() => {
                        console.error('Failed to insert order', orderErr);
                        req.flash('error', 'Unable to create order record.');
                        res.redirect('/checkout');
                    });
                }

                const orderId = orderResult.insertId; // invoice number

                // 3. Insert order_items (stock will be deducted only after payment is PAID)
                const itemSql = `
                    INSERT INTO order_items
                    (order_id, product_id, product_name, unit_price, quantity, line_total)
                    VALUES (?, ?, ?, ?, ?, ?)
                `;

                let pending = cart.length;
                for (const item of cart) {
                    const lineTotal = item.price * item.quantity;

                    // Insert line item
                    connection.query(
                        itemSql,
                        [orderId, item.productId, item.productName, item.price, item.quantity, lineTotal],
                        (itemErr) => {
                            if (itemErr) {
                                return connection.rollback(() => {
                                    console.error('Failed to insert order item', itemErr);
                                    req.flash('error', 'Unable to create order items.');
                                res.redirect('/checkout');
                            });
                        }

                        // One item done
                        pending--;
                        if (pending === 0) {
                            // All items processed — now update loyalty + promo and COMMIT
                            createInvoiceThenFinish();
                        }
                        }
                    );
                }

                // Called when all items & stock updates finished
                function insertInvoice(orderId, next) {
                    const invoiceNumber = formatInvoiceNumber(orderId);
                    const invoiceSql = `
                        INSERT INTO invoices (order_id, user_id, invoice_number, subtotal, final_total, amount)
                        VALUES (?, ?, ?, ?, ?, ?)
                    `;
                    connection.query(
                        invoiceSql,
                        [orderId, userId, invoiceNumber, orderTotal, finalTotal, finalTotal],
                        (invErr) => {
                            if (invErr) {
                                return connection.rollback(() => {
                                    console.error('Failed to create invoice', invErr);
                                    req.flash('error', 'Unable to create invoice record.');
                                    res.redirect('/checkout');
                                });
                            }
                            next();
                        }
                    );
                }

                function createInvoiceThenFinish() {
                    insertInvoice(orderId, finishOrder);
                }

                function finishOrder() {
                    // Loyalty points are only awarded after payment is marked PAID (see finalizeOrderAfterPayment)
                    updatePromoAndCommit(orderId);
                }

                function updatePromoAndCommit(orderId) {
                    if (applied && applied.promoId) {
                        connection.query('SELECT * FROM promocodes WHERE id = ?', [applied.promoId], (err, rows) => {
                            if (!err && rows && rows.length > 0) {
                                const promo = rows[0];
                                const now = new Date();
                                const startsAt = promo.starts_at ? new Date(promo.starts_at) : null;
                                const expiresAt = promo.expires_at ? new Date(promo.expires_at) : null;
                                const maxUses = promo.max_uses;

                                if (!((startsAt && startsAt > now) || (expiresAt && expiresAt < now) || (maxUses !== null && promo.uses >= maxUses))) {
                                    // increment uses
                                    connection.query(
                                        'UPDATE promocodes SET uses = uses + 1 WHERE id = ?',
                                        [applied.promoId],
                                        () => {}
                                    );
                                    // record per-user redemption
                                    if (userId) {
                                        const upsert = `
                                            INSERT INTO promocode_redemptions (promo_id, user_id, uses, last_used)
                                            VALUES (?, ?, 1, NOW())
                                            ON DUPLICATE KEY UPDATE uses = uses + 1, last_used = NOW()
                                        `;
                                        connection.query(upsert, [applied.promoId, userId], () => {});
                                    }
                                }
                            }

                            // Commit transaction
                            connection.commit(commitErr => {
                                if (commitErr) {
                                    return connection.rollback(() => {
                                        console.error('Commit error', commitErr);
                                        req.flash('error', 'Failed to finalise order.');
                                        res.redirect('/checkout');
                                    });
                                }

                                return postCommit(orderId);
                            });
                        });
                    } else {
                        // No promo, just commit
                        connection.commit(commitErr => {
                            if (commitErr) {
                                return connection.rollback(() => {
                                    console.error('Commit error', commitErr);
                                    req.flash('error', 'Failed to finalise order.');
                                    res.redirect('/checkout');
                                });
                            }

                            return postCommit(orderId);
                        });
                    }
                }
            }); // end order insert query

        }); // end connection.beginTransaction
    }); // end ensureInvoiceColumns
}); // end ensureOrderDeliveryColumns
}); // end app.post('/checkout')


// PayPal helpers scoped to these routes
const runQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    connection.query(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });

const columnExists = (table, column) =>
  new Promise((resolve) => {
    connection.query('SHOW COLUMNS FROM ?? LIKE ?', [table, column], (err, rows) => {
      if (err) {
        console.warn('[PayPal] Column check failed', { table, column, message: err.message });
        return resolve(false);
      }
      resolve(Array.isArray(rows) && rows.length > 0);
    });
  });

// Create a pending PayPal order row before hitting PayPal (Option A)
app.post('/checkout/pending', checkAuthenticated, async (req, res) => {
  const cart = req.session.cart || [];
  const user = req.session.user;

  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  if (!cart.length) return res.status(400).json({ error: 'Your cart is empty.' });

  const {
    customerName,
    customerContact,
    customerAddress,
    customerPostal,
    deliveryDate,
    deliveryTime,
    orderNotes
  } = req.body || {};

  if (!customerName || !customerContact || !customerAddress || !customerPostal || !deliveryDate || !deliveryTime) {
    return res.status(400).json({ error: 'Missing required checkout details.' });
  }

  // Recompute totals on server
  let subtotal = 0;
  cart.forEach(item => { subtotal += item.price * item.quantity; });
  const applied = req.session.appliedPromo || null;
  const promoDiscount = applied && applied.discount ? Number(applied.discount) : 0;
  const redemption = req.session.loyaltyRedemption || { discount: 0 };
  const loyaltyDiscount = redemption.discount || 0;
  const finalTotal = Math.max(0, subtotal - promoDiscount - loyaltyDiscount);

  try {
    // Ensure optional delivery columns exist
    await new Promise((resolve, reject) => {
      ensureOrderDeliveryColumns((err) => err ? reject(err) : resolve());
    });

    const insertSql = `
      INSERT INTO orders (
        user_id,
        customer_name,
        customer_contact,
        delivery_address,
        postal_code,
        payment_method,
        payment_status,
        order_notes,
        delivery_date,
        delivery_time,
        subtotal,
        promo_discount,
        loyalty_discount,
        final_total
      )
      VALUES (?, ?, ?, ?, ?, 'PAYPAL', 'PENDING', ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
      user.id,
      customerName,
      customerContact,
      customerAddress,
      customerPostal,
      orderNotes || null,
      deliveryDate || null,
      deliveryTime || null,
      subtotal,
      promoDiscount,
      loyaltyDiscount,
      finalTotal
    ];

    const result = await runQuery(insertSql, params);
    const orderId = result.insertId;
    req.session.paypalPendingOrderId = orderId; // keep in session to avoid client tampering

    // Insert order items so invoices show line items for PayPal flow
    if (cart.length) {
      const itemValues = cart.map(it => [
        orderId,
        it.productId,
        it.productName,
        it.price,
        it.quantity,
        (it.price || 0) * (it.quantity || 0)
      ]);
      try {
        await runQuery(
          `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, line_total) VALUES ?`,
          [itemValues]
        );
      } catch (itemErr) {
        console.error('[PayPal] Failed to insert order items for pending order', itemErr);
      }
    }

    // Best-effort invoice stub so /invoice/:id works
    try {
        const invoiceNumber = formatInvoiceNumber(orderId);
        await runQuery(
          `
            INSERT INTO invoices (order_id, user_id, invoice_number, subtotal, final_total, amount)
          VALUES (?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            subtotal = VALUES(subtotal),
            final_total = VALUES(final_total),
            amount = VALUES(amount)
        `,
        [orderId, user.id, invoiceNumber, subtotal, finalTotal, finalTotal]
      );
    } catch (invErr) {
      console.warn('[PayPal] Invoice stub creation skipped', invErr.message);
    }

    return res.json({ orderId });
  } catch (err) {
    console.error('[PayPal] Failed to create pending order', err);
    return res.status(500).json({ error: 'Failed to create pending order', message: err.message });
  }
});

// PayPal: Create Order
app.post('/api/paypal/create-order', async (req, res) => {
  try {
    const { amount } = req.body;
    const orderId = Number(req.body.orderId || req.session.paypalPendingOrderId);
    if (!amount) return res.status(400).json({ error: 'amount is required' });
    if (!orderId || Number.isNaN(orderId)) return res.status(400).json({ error: 'orderId is required' });

    // Mark PENDING when creating PayPal order (only if not already terminal/paid)
    try {
      await runQuery(
        `UPDATE orders SET payment_status = 'PENDING', payment_method = 'PAYPAL'
         WHERE id = ? AND payment_status NOT IN ('PAID','CANCELLED','EXPIRED')`,
        [orderId]
      );
    } catch (pendErr) {
      console.error('[PayPal] Failed to mark PENDING', pendErr);
    }

    // PayPal requires invoice_id uniqueness; include orderId + timestamp to avoid duplicates on retries
    const uniqueInvoiceId = `${orderId}-${Date.now()}`;
    const order = await paypal.createOrder({
      amount,
      currency: 'SGD',
      referenceId: orderId || undefined,
      invoiceId: uniqueInvoiceId
    });

    if (order && order.id) {
      console.log('[PayPal] order created', { paypalOrderId: order.id, amount, orderId, invoiceId: uniqueInvoiceId });
      res.json({ id: order.id });
    } else {
      console.error('[PayPal] Unexpected create-order response', order);
      res.status(500).json({ error: 'Failed to create PayPal order', details: order });
    }
  } catch (err) {
    console.error('[PayPal] Create order failed', err.response?.data || err.message);
    try {
      if (orderId) {
        await runQuery(
          `UPDATE orders
             SET payment_status = 'FAILED'
           WHERE id = ? AND payment_status NOT IN ('PAID','CANCELLED','EXPIRED')`,
          [orderId]
        );
      }
    } catch (updErr) {
      console.error('[PayPal] mark FAILED after create error', updErr);
    }
    res.status(500).json({ error: 'Failed to create PayPal order', message: err.message });
  }
});

// PayPal: Cancel (from PayPal Buttons onCancel)
app.post('/api/paypal/cancel', async (req, res) => {
  const orderId = Number(req.body.orderId || req.session.paypalPendingOrderId);
  if (!orderId || Number.isNaN(orderId)) return res.status(400).json({ error: 'orderId is required' });

  try {
    await runQuery(
      `UPDATE orders
         SET payment_status = 'CANCELLED'
       WHERE id = ? AND payment_status NOT IN ('PAID','CANCELLED','EXPIRED')`,
      [orderId]
    );
  } catch (err) {
    console.error('[PayPal] cancel update failed', err);
  }

  return res.json({ ok: true, redirectUrl: `/invoice/${orderId}` });
});

// PayPal: Capture Order
app.post('/api/paypal/capture-order', async (req, res) => {
  try {
    const paypalOrderId = req.body.orderID;
    const orderId = Number(req.body.orderId || req.session.paypalPendingOrderId);
    if (!paypalOrderId) return res.status(400).json({ error: 'orderID (PayPal order) is required' });
    if (!orderId || Number.isNaN(orderId)) return res.status(400).json({ error: 'orderId (local order) is required' });

    const capture = await paypal.captureOrder(paypalOrderId);
    console.log('[PayPal] captureOrder response:', JSON.stringify(capture, null, 2));

    const captureStatus = capture && capture.status;
    const captureId = capture?.purchase_units?.[0]?.payments?.captures?.[0]?.id;
    const payerEmail = capture?.payer?.email_address || null;

    if (captureStatus !== 'COMPLETED' || !captureId) {
      try {
        await runQuery(
          `UPDATE orders
             SET payment_status = 'FAILED'
           WHERE id = ? AND payment_status NOT IN ('PAID','CANCELLED','EXPIRED')`,
          [orderId]
        );
      } catch (updErr) {
        console.error('[PayPal] mark FAILED update error', updErr);
      }
      return res.status(400).json({ error: 'Payment not completed', details: capture });
    }

    try {
      await finalizeOrderAfterPayment({
        orderId,
        userId: req.session?.user?.id || null,
        method: 'PAYPAL',
        paypalCaptureId: captureId,
        paypalOrderId: paypalOrderId,
        payerEmail
      });

      // Record in payments table for refund linkage
      try {
        const [orderRows] = await connection.promise().query(
          'SELECT user_id, final_total, subtotal FROM orders WHERE id = ? LIMIT 1',
          [orderId]
        );
        const amt = Number(orderRows?.[0]?.final_total ?? orderRows?.[0]?.subtotal ?? 0);
        const amountCents = Math.round((amt || 0) * 100);
        await connection.promise().query(
          `INSERT INTO payments (order_id, user_id, method, amount_cents, status, provider_order_id, provider_capture_id)
             VALUES (?, ?, 'paypal', ?, 'PAID', ?, ?)
           ON DUPLICATE KEY UPDATE
             user_id = VALUES(user_id),
             amount_cents = VALUES(amount_cents),
             status = 'PAID',
             provider_order_id = VALUES(provider_order_id),
             provider_capture_id = VALUES(provider_capture_id),
             updated_at = CURRENT_TIMESTAMP`,
          [orderId, orderRows?.[0]?.user_id || null, amountCents, paypalOrderId, captureId]
        );
      } catch (payErr) {
        console.error('[PayPal] Failed to record payment row', payErr);
      }
    } catch (dbErr) {
      console.error('[PayPal] Failed to finalize order after capture', dbErr);
      return res.status(500).json({ error: 'Captured but failed to finalize order', message: dbErr.message });
    }

    const redirectUrl = `/invoice/${orderId}`;
    req.session.paypalPendingOrderId = null; // clear pending marker after success
    return res.json({
      ok: true,
      orderId,
      paypalCaptureId: captureId,
      paypalOrderId: paypalOrderId,
      payerEmail,
      redirectUrl
    });
  } catch (err) {
    req.session.paypalPendingOrderId = null; // clear to force a fresh pending on next attempt
    console.error('[PayPal] Capture order failed', err.response?.data || err.message);
    try {
      if (orderId) {
        await runQuery(
          `UPDATE orders
             SET payment_status = 'FAILED'
           WHERE id = ? AND payment_status NOT IN ('PAID','CANCELLED','EXPIRED')`,
          [orderId]
        );
      }
    } catch (updErr) {
      console.error('[PayPal] mark FAILED after error', updErr);
    }
    res.status(500).json({ error: 'Failed to capture PayPal order', message: err.message });
  }
});

// =====================
// Invoice view
//  ====================
// Invoice viewer: accepts invoice.id or invoice.invoice_number (with/without leading "#")
// Does NOT accept order_id directly; we resolve to order_id after finding the invoice row.
app.get('/invoice/:id', checkAuthenticated, async (req, res) => {
    const rawId = String(req.params.id || '').replace(/^#/, '');
    const numericId = parseInt(rawId, 10);
    const sessionUser = req.session.user;
    const userId = sessionUser && sessionUser.id;
    const isAdmin = sessionUser && sessionUser.isPrimaryAdmin;

    if (!rawId || (isNaN(numericId) && !rawId)) {
        req.flash('error', 'Invalid invoice identifier.');
        return res.redirect('/orders');
    }

    // First: find invoice by id or invoice_number (normalized, with/without #)
    const lookupWhere = isAdmin
        ? 'WHERE (i.id = ? OR i.invoice_number = ? OR i.invoice_number = ? OR i.order_id = ?)'
        : 'WHERE (i.id = ? OR i.invoice_number = ? OR i.invoice_number = ? OR i.order_id = ?) AND i.user_id = ?';
    const lookupSql = `
        SELECT order_id
        FROM invoices i
        ${lookupWhere}
        LIMIT 1
    `;
    const lookupArgs = isAdmin
        ? [numericId, rawId, `#${rawId}`, numericId]
        : [numericId, rawId, `#${rawId}`, numericId, userId];

    const invoiceSql = `
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
            o.refund_status,
            o.refund_amount,
            o.refund_reason,
            o.refunded_at,
            o.refund_txn_ref,
            o.payment_failure_reason,
            o.paypal_capture_id,
            o.paid_at,
            o.subtotal AS order_subtotal,
            o.promo_discount,
            o.loyalty_discount,
            o.final_total AS order_final_total,
            o.created_at AS order_created_at,
            u.username,
            u.email
        FROM invoices i
        JOIN orders o ON i.order_id = o.id
        LEFT JOIN users u ON u.id = o.user_id
        WHERE i.order_id = ?
          ${isAdmin ? '' : 'AND o.user_id = ?'}
        LIMIT 1
    `;
    const itemsSql = `
        SELECT *
        FROM order_items
        WHERE order_id = ?
    `;

    try {
        const [invLookup] = await connection.promise().query(lookupSql, lookupArgs);
        if (!invLookup || !invLookup.length) {
            req.flash('error', 'Invoice not found.');
            return res.redirect('/orders');
        }

        const orderId = invLookup[0].order_id;
        const params = isAdmin ? [orderId] : [orderId, userId];
        const [invoiceRows] = await connection.promise().query(invoiceSql, params);
        if (!invoiceRows || !invoiceRows.length) {
            req.flash('error', 'Invoice not found.');
            return res.redirect('/orders');
        }

        const invoice = invoiceRows[0];
        const paymentStatus = (invoice.payment_status || '').toUpperCase();
        const paymentMethod = invoice.payment_method;
        const isPaid = paymentStatus === 'PAID' || paymentStatus === 'SUCCESS';
        const isFailed = paymentStatus === 'FAILED' || paymentStatus === 'CANCELLED' || paymentStatus === 'EXPIRED';
        const isPending = !isPaid && !isFailed;
        const [itemRows] = await connection.promise().query(itemsSql, [invoice.order_id]);
        const [refundRows] = await connection.promise().query(
            'SELECT * FROM refunds WHERE order_id = ? ORDER BY id DESC LIMIT 1',
            [invoice.order_id]
        );
        const refundRow = refundRows && refundRows[0] ? refundRows[0] : null;

        // Clear any stale "Invoice not found" flash if this lookup succeeded
        if (req.session && req.session.flash && req.session.flash.error) {
            delete req.session.flash.error;
        }

        res.render('invoice', {
            user: sessionUser,
            order: {
                ...invoice,
                id: invoice.order_id, // keep existing view expectations
                subtotal: invoice.order_subtotal ?? invoice.invoice_subtotal ?? invoice.subtotal,
                final_total: invoice.order_final_total ?? invoice.invoice_final_total ?? invoice.final_total,
                amount: invoice.invoice_amount ?? invoice.amount,
                created_at: invoice.order_created_at || invoice.invoice_created_at || invoice.created_at
            },
            items: itemRows,
            refundRow,
            invoiceNumber: invoice.invoice_number || formatInvoiceNumber(invoice.invoice_id || invoice.order_id),
            paymentStatus,
            paymentMethod,
            isPaid,
            isFailed,
            isPending
        });
    } catch (err) {
        console.error('Invoice lookup error', err);
        req.flash('error', 'Unable to load invoice.');
        return res.redirect('/orders');
    }
});


// =====================
// Logout (also may exist in authRoutes)
// =====================
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

// PayPal: Wallet Top-up Create Order
app.post('/api/paypal/topup/create-order', async (req, res) => {
  try {
    const topupId = Number(req.body.topupId || req.session.paypalPendingTopupId);
    if (!topupId) return res.status(400).json({ error: 'topupId is required' });
    const userId = req.session.user && req.session.user.id;
    const conn = connection.promise();
    const [rows] = await conn.query(
      'SELECT * FROM wallet_topups WHERE id = ? AND user_id = ? LIMIT 1',
      [topupId, userId]
    );
    if (!rows || !rows.length) return res.status(404).json({ error: 'Top-up not found' });
    const topup = rows[0];
    if (String(topup.status || '').toUpperCase() === 'PAID') {
      return res.status(400).json({ error: 'Top-up already paid' });
    }

    const order = await paypal.createOrder({
      amount: topup.amount,
      currency: 'SGD',
      referenceId: `TOPUP-${topupId}`,
      invoiceId: `TOPUP-${topupId}-${Date.now()}`
    });

    if (order && order.id) {
      req.session.paypalPendingTopupId = topupId;
      // store PayPal order id into reference (optional)
      await conn.query('UPDATE wallet_topups SET reference = ? WHERE id = ?', [order.id, topupId]);
      return res.json({ id: order.id });
    }
    return res.status(500).json({ error: 'Failed to create PayPal top-up order' });
  } catch (err) {
    console.error('[PayPal Topup] create-order failed', err.response?.data || err.message);
    return res.status(500).json({ error: 'Failed to create PayPal top-up order', message: err.message });
  }
});

// PayPal: Wallet Top-up Capture
app.post('/api/paypal/topup/capture-order', async (req, res) => {
  const paypalOrderId = req.body.orderID;
  const topupId = Number(req.body.topupId || req.session.paypalPendingTopupId);
  if (!paypalOrderId) return res.status(400).json({ error: 'orderID is required' });
  if (!topupId) return res.status(400).json({ error: 'topupId is required' });

  try {
    const capture = await paypal.captureOrder(paypalOrderId);
    const captureStatus = capture && capture.status;
    const captureId = capture?.purchase_units?.[0]?.payments?.captures?.[0]?.id;
    if (captureStatus !== 'COMPLETED' || !captureId) {
      await connection.promise().query(
        `UPDATE wallet_topups SET status = 'FAILED' WHERE id = ?`,
        [topupId]
      );
      return res.status(400).json({ error: 'Payment not completed', details: capture });
    }

    const conn = connection.promise();
    const [rows] = await conn.query('SELECT * FROM wallet_topups WHERE id = ? LIMIT 1', [topupId]);
    if (!rows || !rows.length) return res.status(404).json({ error: 'Top-up not found' });
    const topup = rows[0];
    if (String(topup.status || '').toUpperCase() === 'PAID') {
      req.session.paypalPendingTopupId = null;
      return res.json({ ok: true, redirectUrl: '/wallet' });
    }

    await conn.query(
      `UPDATE wallet_topups
          SET status = 'PAID',
              reference = ?,
              paid_at = NOW()
        WHERE id = ?`,
      [captureId, topupId]
    );
    await walletService.ensureWallet(topup.user_id);
    await walletService.creditWallet({
      userId: topup.user_id,
      amount: topup.amount,
      orderId: null,
      reason: 'Wallet Top-Up',
      reference: `PAYPAL_TOPUP_${topupId}`
    });

    req.session.paypalPendingTopupId = null;
    return res.json({ ok: true, redirectUrl: '/wallet', paypalCaptureId: captureId });
  } catch (err) {
    console.error('[PayPal Topup] capture-order failed', err.response?.data || err.message);
    try {
      await connection.promise().query(
        `UPDATE wallet_topups SET status = 'FAILED' WHERE id = ?`,
        [topupId]
      );
    } catch (_) {}
    return res.status(500).json({ error: 'Failed to capture PayPal top-up', message: err.message });
  }
});

// PayPal: Wallet Top-up Cancel
app.post('/api/paypal/topup/cancel', async (req, res) => {
  const topupId = Number(req.body.topupId || req.session.paypalPendingTopupId);
  if (!topupId) return res.status(400).json({ error: 'topupId is required' });
  try {
    await connection.promise().query(
      `UPDATE wallet_topups
         SET status = 'CANCELLED'
       WHERE id = ? AND status <> 'PAID'`,
      [topupId]
    );
    req.session.paypalPendingTopupId = null;
    return res.json({ ok: true });
  } catch (err) {
    console.error('[PayPal Topup] cancel failed', err.response?.data || err.message);
    return res.status(500).json({ error: 'Failed to cancel PayPal top-up', message: err.message });
  }
});

// Payment options chooser (UI only; no state change)
app.get('/pay/options/:orderId', checkAuthenticated, async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  const sessionUser = req.session.user;
  const isAdmin = sessionUser && sessionUser.isPrimaryAdmin;
  if (!orderId || Number.isNaN(orderId)) {
    req.flash('error', 'Invalid order.');
    return res.redirect('/orders');
  }

  try {
    const conn = connection.promise();
    const where = isAdmin ? 'id = ?' : 'id = ? AND user_id = ?';
    const params = isAdmin ? [orderId] : [orderId, sessionUser.id];
    const [rows] = await conn.query(`SELECT * FROM orders WHERE ${where} LIMIT 1`, params);
    if (!rows || !rows.length) {
      req.flash('error', 'Order not found or not accessible.');
      return res.redirect('/orders');
    }
    const order = rows[0];
    const methodNorm = String(order.payment_method || '').toLowerCase().replace(/\s+/g, '_');
    let retryUrl = null;
    let retryLabel = 'Retry Payment';
    if (methodNorm === 'nets_qr') {
      retryUrl = `/pay/nets/${orderId}`;
      retryLabel = 'Retry NETS_QR';
    } else if (methodNorm === 'paypal') {
      retryUrl = `/pay/paypal/${orderId}`;
      retryLabel = 'Retry PayPal';
    } else if (methodNorm === 'wallet') {
      retryUrl = `/invoice/${orderId}`; // fallback if no dedicated wallet retry route
      retryLabel = 'Retry Wallet';
    }

    res.render('pay-options', {
      user: sessionUser,
      order,
      orderId,
      retryUrl,
      retryLabel,
      switchUrl: `/pay/retry/${orderId}`
    });
  } catch (err) {
    console.error('pay/options error', err);
    req.flash('error', 'Unable to load payment options.');
    return res.redirect('/orders');
  }
});

// Retry payment (for pending/unpaid orders)
app.get('/pay/retry/:orderId', checkAuthenticated, async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  const user = req.session.user;
  const isAdmin = user && user.isPrimaryAdmin;
  if (!orderId || Number.isNaN(orderId)) {
    req.flash('error', 'Invalid order.');
    return res.redirect('/orders');
  }

  try {
    const conn = connection.promise();
    const where = isAdmin ? 'id = ?' : 'id = ? AND user_id = ?';
    const params = isAdmin ? [orderId] : [orderId, user.id];
    const [rows] = await conn.query(`SELECT * FROM orders WHERE ${where} LIMIT 1`, params);
    if (!rows || !rows.length) {
      req.flash('error', 'Order not found.');
      return res.redirect('/orders');
    }
    const order = rows[0];
    if (String(order.payment_status || '').toUpperCase() === 'PAID') {
      return res.redirect(`/invoice/${orderId}`);
    }
    const failureReason = order.payment_failure_reason || '';
    res.render('retry-payment', {
      user,
      order,
      disallowWallet: failureReason === 'INSUFFICIENT_WALLET_BALANCE'
    });
  } catch (err) {
    console.error('Retry GET failed', err);
    req.flash('error', 'Unable to load retry payment.');
    return res.redirect('/orders');
  }
});

app.post('/pay/retry/:orderId', checkAuthenticated, async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  const method = (req.body.method || '').toLowerCase();
  const user = req.session.user;
  const isAdmin = user && user.isPrimaryAdmin;
  if (!orderId || Number.isNaN(orderId)) {
    req.flash('error', 'Invalid order.');
    return res.redirect('/orders');
  }
  if (!['paypal', 'nets_qr', 'wallet'].includes(method)) {
    req.flash('error', 'Please choose PayPal, NETS QR, or Wallet.');
    return res.redirect(`/pay/retry/${orderId}`);
  }

  try {
    const conn = connection.promise();
    const where = isAdmin ? 'id = ?' : 'id = ? AND user_id = ?';
    const [rows] = await conn.query(
      `SELECT id, user_id, payment_status, payment_method, final_total FROM orders WHERE ${where} LIMIT 1`,
      isAdmin ? [orderId] : [orderId, user.id]
    );
    if (!rows || !rows.length) {
      req.flash('error', 'Order not found or not permitted.');
      return res.redirect('/orders');
    }
    const order = rows[0];
    if (String(order.payment_status || '').toUpperCase() === 'PAID') {
      return res.redirect(`/invoice/${orderId}`);
    }

    if (method === 'wallet') {
      try {
        await walletService.ensureWallet(order.user_id || user.id);
        await walletService.debitWallet({
          userId: order.user_id || user.id,
          amount: order.final_total,
          orderId,
          reason: 'Order Payment (Retry)',
          reference: `RETRY_WALLET_${orderId}`
        });
        await finalizeOrderAfterPayment({ orderId, userId: order.user_id || user.id, method: 'WALLET' });
        req.flash('success', 'Payment completed with Wallet.');
        return res.redirect(`/invoice/${orderId}`);
      } catch (err) {
        console.error('Wallet retry failed', err);
        req.flash('error', err.message || 'Wallet payment failed.');
        return res.redirect(`/pay/retry/${orderId}`);
      }
    }

    // PayPal or NETS path: mark pending and redirect as before
    const newMethodLabel = method === 'nets_qr' ? 'NETS QR' : 'PayPal';
    const params = isAdmin ? [newMethodLabel, orderId] : [newMethodLabel, orderId, user.id];
    const updateSql = `
      UPDATE orders
         SET payment_method = ?,
             payment_status = 'PENDING',
             payment_failure_reason = NULL
       WHERE ${where}
    `;
    const [result] = await conn.query(updateSql, params);
    if (!result.affectedRows) {
      req.flash('error', 'Order not found or not permitted.');
      return res.redirect('/orders');
    }
  } catch (err) {
    console.error('Retry POST update failed', err);
    req.flash('error', 'Unable to start retry payment.');
    return res.redirect(`/pay/retry/${orderId}`);
  }

  if (method === 'nets_qr') {
    return res.redirect(`/pay/nets/${orderId}`);
  }
  // PayPal
  req.session.paypalPendingOrderId = orderId;
  return res.redirect(`/pay/paypal/${orderId}`);
});

// Wallet: view balance & history
app.get('/wallet', checkAuthenticated, async (req, res) => {
  const userId = req.session.user && req.session.user.id;
  if (!userId) return res.redirect('/login');

  try {
    await walletService.ensureWallet(userId);
    const balance = await walletService.getBalance(userId);
    const [txns] = await connection.promise().query(
      `SELECT id, type, amount, reason, reference, order_id, created_at
         FROM wallet_transactions
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 10`,
      [userId]
    );
    res.render('wallet', { user: req.session.user, balance, transactions: txns || [] });
  } catch (err) {
    console.error('Failed to load wallet', err);
    req.flash('error', 'Unable to load wallet right now.');
    res.redirect('/shopping');
  }
});

// Wallet Top-up: form
app.get('/wallet/topup', checkAuthenticated, async (req, res) => {
  const userId = req.session.user && req.session.user.id;
  if (!userId) return res.redirect('/login');
  try {
    await walletService.ensureWallet(userId);
    const balance = await walletService.getBalance(userId);
    res.render('wallet-topup', { user: req.session.user, balance });
  } catch (err) {
    console.error('Topup load error', err);
    req.flash('error', 'Unable to load top-up page.');
    return res.redirect('/wallet');
  }
});

// Wallet Top-up: submit
app.post('/wallet/topup', checkAuthenticated, async (req, res) => {
  const userId = req.session.user && req.session.user.id;
  if (!userId) return res.redirect('/login');
  const amount = Number(req.body.amount || 0);
  const methodRaw = (req.body.payment_method || '').toUpperCase();
  if (!amount || amount <= 0) {
    req.flash('error', 'Please enter an amount greater than 0.');
    return res.redirect('/wallet/topup');
  }
  if (!['PAYPAL', 'NETS_QR'].includes(methodRaw)) {
    req.flash('error', 'Please choose PayPal or NETS QR.');
    return res.redirect('/wallet/topup');
  }

  try {
    const conn = connection.promise();
    const [result] = await conn.query(
      `INSERT INTO wallet_topups (user_id, amount, payment_method, status, created_at)
       VALUES (?, ?, ?, 'PENDING', NOW())`,
      [userId, amount, methodRaw]
    );
    const topupId = result.insertId;
    if (methodRaw === 'PAYPAL') {
      req.session.paypalPendingTopupId = topupId;
      return res.redirect(`/wallet/topup/paypal/${topupId}`);
    }
    return res.redirect(`/wallet/topup/nets/${topupId}`);
  } catch (err) {
    console.error('Topup insert error', err);
    req.flash('error', 'Unable to start top-up.');
    return res.redirect('/wallet/topup');
  }
});

// Wallet top-up PayPal page (Option A)
app.get('/wallet/topup/paypal/:topupId', checkAuthenticated, async (req, res) => {
  const userId = req.session.user && req.session.user.id;
  const isAdmin = req.session.user && req.session.user.isPrimaryAdmin;
  const topupId = parseInt(req.params.topupId, 10);
  if (!userId || !topupId) {
    req.flash('error', 'No PayPal top-up in progress.');
    return res.redirect('/wallet/topup');
  }
  try {
    const conn = connection.promise();
    const where = isAdmin ? 'id = ?' : 'id = ? AND user_id = ?';
    const params = isAdmin ? [topupId] : [topupId, userId];
    const [rows] = await conn.query(
      `SELECT * FROM wallet_topups WHERE ${where} LIMIT 1`,
      params
    );
    if (!rows || !rows.length) {
      req.flash('error', 'Top-up not found.');
      return res.redirect('/wallet/topup');
    }
    const topup = rows[0];
    const terminal = ['PAID', 'CANCELLED', 'EXPIRED', 'FAILED'];
    if (terminal.includes(String(topup.status || '').toUpperCase())) {
      req.flash('info', `Top-up is ${topup.status}.`);
      return res.redirect('/wallet');
    }
    req.session.paypalPendingTopupId = topupId;
    const balance = await walletService.getBalance(topup.user_id);
    res.render('wallet-topup-paypal', {
      user: req.session.user,
      balance,
      topup
    });
  } catch (err) {
    console.error('PayPal topup load error', err);
    req.flash('error', 'Unable to load PayPal top-up.');
    return res.redirect('/wallet/topup');
  }
});

// Wallet top-up NETS page
app.get('/wallet/topup/nets/:topupId', checkAuthenticated, async (req, res) => {
  const topupId = parseInt(req.params.topupId, 10);
  const userId = req.session.user && req.session.user.id;
  const isAdmin = req.session.user && req.session.user.isPrimaryAdmin;
  if (!topupId) {
    req.flash('error', 'Invalid top-up.');
    return res.redirect('/wallet/topup');
  }
  try {
    const conn = connection.promise();
    const where = isAdmin ? 'id = ?' : 'id = ? AND user_id = ?';
    const params = isAdmin ? [topupId] : [topupId, userId];
    const [rows] = await conn.query(`SELECT * FROM wallet_topups WHERE ${where} LIMIT 1`, params);
    if (!rows || !rows.length) {
      req.flash('error', 'Top-up not found.');
      return res.redirect('/wallet');
    }
    const topup = rows[0];
    const terminal = ['PAID', 'CANCELLED', 'EXPIRED', 'FAILED'];
    if (terminal.includes(String(topup.status || '').toUpperCase())) {
      req.flash('info', `Top-up is ${topup.status}.`);
      return res.redirect('/wallet');
    }
    // ensure pending
    await conn.query(
      `UPDATE wallet_topups SET status = 'PENDING' WHERE id = ? AND status NOT IN ('PAID','CANCELLED','EXPIRED','FAILED')`,
      [topupId]
    );

    // Reuse NETS QR generator with top-up context
    req.body = req.body || {};
    req.body.cartTotal = Number(topup.amount || 0).toFixed(2);
    req.body.topupId = topupId;
    req.body.flowType = 'WALLET_TOPUP';
    return netsQr.generateQrCode(req, res);
  } catch (err) {
    console.error('NETS topup page error', err);
    req.flash('error', 'Unable to load NETS top-up.');
    return res.redirect('/wallet');
  }
});

// Wallet top-up NETS cancel
app.post('/wallet/topup/nets/:topupId/cancel', checkAuthenticated, async (req, res) => {
  const topupId = parseInt(req.params.topupId, 10);
  const userId = req.session.user && req.session.user.id;
  const isAdmin = req.session.user && req.session.user.isPrimaryAdmin;
  if (!topupId) return res.redirect('/wallet');
  try {
    const conn = connection.promise();
    const where = isAdmin ? 'id = ?' : 'id = ? AND user_id = ?';
    const params = isAdmin ? [topupId] : [topupId, userId];
    await conn.query(
      `UPDATE wallet_topups SET status = 'CANCELLED' WHERE ${where} AND status NOT IN ('PAID')`,
      params
    );
  } catch (err) {
    console.error('Cancel NETS topup error', err);
  }
  req.flash('info', 'Top-up cancelled.');
  return res.redirect('/wallet');
});

// NETS top-up success hook (could be called by SSE/webhook)
app.post('/wallet/topup/nets/:topupId/success', async (req, res) => {
  const topupId = parseInt(req.params.topupId, 10);
  const netsRef = req.body.nets_txn_ref || req.body.txn_ref || null;
  const userId = req.body.user_id || null;
  try {
    const conn = connection.promise();
    const [rows] = await conn.query('SELECT * FROM wallet_topups WHERE id = ? LIMIT 1', [topupId]);
    if (!rows || !rows.length) return res.status(404).json({ error: 'Top-up not found' });
    const topup = rows[0];
    if (String(topup.status || '').toUpperCase() === 'PAID') return res.json({ ok: true });
    await conn.query(
      `UPDATE wallet_topups SET status = 'PAID', reference = ?, paid_at = NOW() WHERE id = ?`,
      [netsRef || `NETS_TOPUP_${topupId}`, topupId]
    );
    await walletService.ensureWallet(topup.user_id);
    await walletService.creditWallet({
      userId: topup.user_id,
      amount: topup.amount,
      orderId: null,
      reason: 'Wallet Top-Up',
      reference: `NETS_TOPUP_${topupId}`
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error('NETS topup success error', err);
    return res.status(500).json({ error: err.message });
  }
});

// NETS top-up fail
app.post('/wallet/topup/nets/:topupId/fail', async (req, res) => {
  const topupId = parseInt(req.params.topupId, 10);
  try {
    await connection.promise().query(
      `UPDATE wallet_topups SET status = 'FAILED' WHERE id = ? AND status NOT IN ('PAID')`,
      [topupId]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('NETS topup fail error', err);
    return res.status(500).json({ error: err.message });
  }
});

// NETS top-up expire
app.post('/wallet/topup/nets/:topupId/expire', async (req, res) => {
  const topupId = parseInt(req.params.topupId, 10);
  try {
    await connection.promise().query(
      `UPDATE wallet_topups SET status = 'EXPIRED' WHERE id = ? AND status NOT IN ('PAID')`,
      [topupId]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('NETS topup expire error', err);
    return res.status(500).json({ error: err.message });
  }
});


// =====================
// Single Product View
// =====================
app.get('/product/:id', checkAuthenticated, (req, res) => {
    const productId = req.params.id;

    connection.query('SELECT * FROM products WHERE id = ?', [productId], (error, results) => {
        if (error) throw error;

        if (results.length === 0) {
            return res.status(404).send('Product not found');
        }

        const product = results[0];

        res.render('product', {
            product,
            user: req.session.user
        });
    });
});


// =====================
// Promo: apply route
// =====================
app.post('/apply-promo', checkAuthenticated, (req, res) => {
    const code = (req.body.code || '').trim().toUpperCase();
    if (!code) {
        req.flash('error', 'Please provide a promo code');
        return res.redirect('/checkout');
    }

    // Note: do not clear existing applied promo here — allow preview/confirm flow.

    connection.query('SELECT * FROM promocodes WHERE code = ? AND active = 1', [code], (err, rows) => {
        if (err) {
            console.error('Promo lookup error', err);
            req.flash('error', 'Unable to validate promo code');
            return res.redirect('/checkout');
        }
        const promo = rows && rows[0];
        if (!promo) {
            req.flash('error', 'Promo code not found or inactive');
            return res.redirect('/checkout');
        }

        const now = new Date();
        if (promo.starts_at && new Date(promo.starts_at) > now) {
            req.flash('error', 'Promo not yet active');
            return res.redirect('/checkout');
        }
        if (promo.expires_at && new Date(promo.expires_at) < now) {
            req.flash('error', 'Promo has expired');
            return res.redirect('/checkout');
        }

        // compute cart total
        const cart = req.session.cart || [];
        const total = cart.reduce((s, i) => s + i.price * i.quantity, 0);
        if (promo.min_total && total < promo.min_total) {
            req.flash('error', `Promo requires minimum spend of $${parseFloat(promo.min_total).toFixed(2)}`);
            return res.redirect('/checkout');
        }

        if (promo.max_uses !== null && promo.uses >= promo.max_uses) {
            req.flash('error', 'Promo has reached its maximum uses');
            return res.redirect('/checkout');
        }

        // enforce per-user limit using promocode_redemptions table (if configured)
        const userId = req.session.user && req.session.user.id;
        if (promo.per_user_limit && userId) {
            connection.query('SELECT uses FROM promocode_redemptions WHERE promo_id = ? AND user_id = ?', [promo.id, userId], (rErr, rRows) => {
                if (rErr) {
                    console.error('Promo redemption lookup error', rErr);
                    req.flash('error', 'Unable to validate promo usage');
                    return res.redirect('/checkout');
                }
                const redeemed = rRows && rRows[0] ? rRows[0].uses : 0;
                if (redeemed >= promo.per_user_limit) {
                    req.flash('error', 'Promo already used by this account');
                    return res.redirect('/checkout');
                }

                // calculate discount
                let discount = 0;
                if (promo.type === 'percent') {
                    discount = total * (promo.amount / 100);
                } else {
                    discount = parseFloat(promo.amount);
                }
                if (discount > total) discount = total;

                // Save applied promo in session (will be finalized on checkout)
                req.session.appliedPromo = { promoId: promo.id, code: promo.code, discount };
                req.flash('success', `Promo applied: ${promo.code} (-$${discount.toFixed(2)})`);
                return res.redirect('/checkout');
            });
        } else {
            // no per-user limit or no user id (shouldn't happen since route requires auth)
            let discount = 0;
            if (promo.type === 'percent') {
                discount = total * (promo.amount / 100);
            } else {
                discount = parseFloat(promo.amount);
            }
            if (discount > total) discount = total;
            req.session.appliedPromo = { promoId: promo.id, code: promo.code, discount };
            req.flash('success', `Promo applied: ${promo.code} (-$${discount.toFixed(2)})`);
            return res.redirect('/checkout');
        }
    });
});

// =====================
// Promo: preview / confirm / cancel routes
// =====================
app.post('/preview-promo', checkAuthenticated, (req, res) => {
    const code = (req.body.code || '').trim().toUpperCase();
    if (!code) {
        req.flash('error', 'Please provide a promo code');
        return res.redirect('/checkout');
    }

    connection.query('SELECT * FROM promocodes WHERE code = ? AND active = 1', [code], (err, rows) => {
        if (err) {
            console.error('Promo lookup error', err);
            req.flash('error', 'Unable to validate promo code');
            return res.redirect('/checkout');
        }
        const promo = rows && rows[0];
        if (!promo) {
            req.flash('error', 'Promo code not found or inactive');
            return res.redirect('/checkout');
        }

        const now = new Date();
        if (promo.starts_at && new Date(promo.starts_at) > now) {
            req.flash('error', 'Promo not yet active');
            return res.redirect('/checkout');
        }
        if (promo.expires_at && new Date(promo.expires_at) < now) {
            req.flash('error', 'Promo has expired');
            return res.redirect('/checkout');
        }

        const cart = req.session.cart || [];
        const total = cart.reduce((s, i) => s + i.price * i.quantity, 0);
        if (promo.min_total && total < promo.min_total) {
            req.flash('error', `Promo requires minimum spend of $${parseFloat(promo.min_total).toFixed(2)}`);
            return res.redirect('/checkout');
        }

        if (promo.max_uses !== null && promo.uses >= promo.max_uses) {
            req.flash('error', 'Promo has reached its maximum uses');
            return res.redirect('/checkout');
        }

        const userId = req.session.user && req.session.user.id;
        if (promo.per_user_limit && userId) {
            connection.query('SELECT uses FROM promocode_redemptions WHERE promo_id = ? AND user_id = ?', [promo.id, userId], (rErr, rRows) => {
                if (rErr) {
                    console.error('Promo redemption lookup error', rErr);
                    req.flash('error', 'Unable to validate promo usage');
                    return res.redirect('/checkout');
                }
                const redeemed = rRows && rRows[0] ? rRows[0].uses : 0;
                if (redeemed >= promo.per_user_limit) {
                    req.flash('error', 'Promo already used by this account');
                    return res.redirect('/checkout');
                }

                // OK for preview
                let discount = 0;
                if (promo.type === 'percent') discount = total * (promo.amount / 100);
                else discount = parseFloat(promo.amount);
                if (discount > total) discount = total;
                req.session.previewPromo = { promoId: promo.id, code: promo.code, discount };
                req.flash('success', `Promo preview: ${promo.code} (-$${discount.toFixed(2)})`);
                return res.redirect('/checkout');
            });
        } else {
            let discount = 0;
            if (promo.type === 'percent') discount = total * (promo.amount / 100);
            else discount = parseFloat(promo.amount);
            if (discount > total) discount = total;
            req.session.previewPromo = { promoId: promo.id, code: promo.code, discount };
            req.flash('success', `Promo preview: ${promo.code} (-$${discount.toFixed(2)})`);
            return res.redirect('/checkout');
        }
    });
});

app.post('/confirm-promo', checkAuthenticated, (req, res) => {
    const preview = req.session.previewPromo;
    if (!preview) {
        req.flash('error', 'No promo to confirm');
        return res.redirect('/checkout');
    }

    // Re-validate promo before applying
    connection.query('SELECT * FROM promocodes WHERE id = ?', [preview.promoId], (err, rows) => {
        if (err || !rows || rows.length === 0) {
            req.flash('error', 'Promo no longer valid');
            req.session.previewPromo = null;
            return res.redirect('/checkout');
        }
        const promo = rows[0];
        const cart = req.session.cart || [];
        const total = cart.reduce((s, i) => s + i.price * i.quantity, 0);
        const userId = req.session.user && req.session.user.id;

        if (promo.min_total && total < promo.min_total) {
            req.flash('error', `Promo requires minimum spend of $${parseFloat(promo.min_total).toFixed(2)}`);
            req.session.previewPromo = null;
            return res.redirect('/checkout');
        }
        if (promo.max_uses !== null && promo.uses >= promo.max_uses) {
            req.flash('error', 'Promo has reached its maximum uses');
            req.session.previewPromo = null;
            return res.redirect('/checkout');
        }
        if (promo.per_user_limit && userId) {
            connection.query('SELECT uses FROM promocode_redemptions WHERE promo_id = ? AND user_id = ?', [promo.id, userId], (rErr, rRows) => {
                if (rErr) {
                    console.error('Promo redemption lookup error', rErr);
                    req.flash('error', 'Unable to validate promo usage');
                    req.session.previewPromo = null;
                    return res.redirect('/checkout');
                }
                const redeemed = rRows && rRows[0] ? rRows[0].uses : 0;
                if (redeemed >= promo.per_user_limit) {
                    req.flash('error', 'Promo already used by this account');
                    req.session.previewPromo = null;
                    return res.redirect('/checkout');
                }

                // apply
                req.session.appliedPromo = preview;
                req.session.previewPromo = null;
                req.flash('success', `Promo applied: ${preview.code} (-$${preview.discount.toFixed(2)})`);
                return res.redirect('/checkout');
            });
        } else {
            req.session.appliedPromo = preview;
            req.session.previewPromo = null;
            req.flash('success', `Promo applied: ${preview.code} (-$${preview.discount.toFixed(2)})`);
            return res.redirect('/checkout');
        }
    });
});

app.post('/cancel-promo', checkAuthenticated, (req, res) => {
    req.session.previewPromo = null;
    req.flash('info', 'Promo preview cancelled');
    res.redirect('/checkout');
});

// Remove an already applied promo
app.post('/remove-applied-promo', checkAuthenticated, (req, res) => {
    if (req.session.appliedPromo) {
        const code = req.session.appliedPromo.code;
        req.session.appliedPromo = null;
        req.flash('info', `Removed applied promo ${code}`);
    }
    res.redirect('/checkout');
});

// =====================
// Product CRUD (Admin)
// =====================

// Add product (admin)
app.get('/addProduct', checkAuthenticated, checkAdmin, (req, res) => {
    res.render('addProduct', { user: req.session.user });
});

app.post('/addProduct', checkAuthenticated, checkAdmin, upload.single('image'), (req, res) => {
    const { name, quantity, price, category } = req.body;
    let image = null;
    if (req.file) {
        image = req.file.filename;
    }

    const sql = 'INSERT INTO products (productName, quantity, price, category, image, created_at) VALUES (?, ?, ?, ?, ?, NOW())';
    connection.query(sql, [name, quantity, price, category || 'Others', image], (error) => {
        if (error) {
            console.error('Error adding product:', error);
            return res.status(500).send('Error adding product');
        }
        res.redirect('/inventory');
    });
});

// Update product (admin)
app.get('/updateProduct/:id', checkAuthenticated, checkAdmin, (req, res) => {
    const productId = req.params.id;
    const sql = 'SELECT * FROM products WHERE id = ?';

    connection.query(sql, [productId], (error, results) => {
        if (error) throw error;

        if (results.length > 0) {
            res.render('updateProduct', { product: results[0], user: req.session.user });
        } else {
            res.status(404).send('Product not found');
        }
    });
});

app.post('/updateProduct/:id', checkAuthenticated, checkAdmin, upload.single('image'), (req, res) => {
    const productId = req.params.id;
    const { name, quantity, price, category } = req.body;
    let image = req.body.currentImage;
    if (req.file) {
        image = req.file.filename;
    }

    const sql = 'UPDATE products SET productName = ?, quantity = ?, price = ?, category = ?, image = ? WHERE id = ?';
    connection.query(sql, [name, quantity, price, category || 'Others', image, productId], (error) => {
        if (error) {
            console.error('Error updating product:', error);
            return res.status(500).send('Error updating product');
        }
        res.redirect('/inventory');
    });
});

// Delete product (admin)
app.get('/deleteProduct/:id', checkAuthenticated, checkAdmin, (req, res) => {
    const productId = req.params.id;

    // First, ensure product exists so we can show a clearer message
    connection.query('SELECT id FROM products WHERE id = ?', [productId], (selErr, rows) => {
        if (selErr) {
            console.error('Error checking product before delete:', selErr);
            req.flash('error', 'Unable to delete product right now.');
            return res.redirect('/inventory');
        }
        if (!rows || !rows.length) {
            req.flash('error', 'Product not found or already deleted.');
            return res.redirect('/inventory');
        }

        connection.query('DELETE FROM products WHERE id = ?', [productId], (error) => {
            if (error) {
                // FK constraint means product is referenced in order_items
                if (error.code === 'ER_ROW_IS_REFERENCED_2' || error.code === 'ER_ROW_IS_REFERENCED' || error.errno === 1451 || error.sqlState === '23000') {
                    req.flash('error', 'Product cannot be deleted due to existing orders.');
                    return res.redirect('/inventory');
                }
                console.error('Error deleting product:', error);
                req.flash('error', 'Error deleting product.');
                return res.redirect('/inventory');
            }
            req.flash('success', 'Product deleted.');
            res.redirect('/inventory');
        });
    });
});

// =====================
// Start Server
// =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
