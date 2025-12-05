// app.js
// Load environment variables (fallback if dotenv isn't installed)
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
const { body } = require('express-validator');
const { attachLocals, checkAuthenticated, checkAdmin } = require('./middleware');
const { pointsToDollars } = require('./utils/loyalty');
const Product = require('./models/Product');

const connection = require('./config/db');          // MySQL connection
const authController = require('./controllers/authController');  // register/login/logout handlers
const adminRoutes = require('./routes/adminRoutes');

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

const app = express();

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
app.set('view engine', 'ejs');
app.use(express.static('public'));

// =====================
// Body Parser
// =====================
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
    const userId = req.session.user && req.session.user.id;
    if (!userId) {
        req.flash('error', 'You must be logged in to view orders.');
        return res.redirect('/login');
    }

    const orderSql = `
        SELECT
            o.*,
            u.username,
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
                const invId = o.invoice_id || o.id;
                const rawInvoice = o.invoice_number || formatInvoiceNumber(invId);
                const invoiceDisplay = (rawInvoice || '').replace(/^#/, ''); // show numeric part (e.g. 108007)
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
                    return res.render('checkout', {
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
                        return res.render('checkout', {
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
                    return res.render('checkout', {
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
            return res.render('checkout', {
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
    const cart = req.session.cart || [];
    const userId = req.session.user && req.session.user.id;

    if (!cart.length) {
        req.flash('error', 'Cart is empty.');
        return res.redirect('/cart');
    }

    // Delivery + payment details from checkout form
    const deliveryName = (req.body.customerName || '').trim();
    const deliveryContact = (req.body.customerContact || '').trim();
    const deliveryAddress = (req.body.customerAddress || '').trim();
    const deliveryPostal = (req.body.customerPostal || '').trim();
    const paymentMethodInput = (req.body.paymentMethod || '').trim();
    const orderNotes = (req.body.orderNotes || '').trim();
    const deliveryDateStr = (req.body.deliveryDate || '').trim();
    const deliveryTimeSlot = (req.body.deliveryTime || '').trim();

    const paymentMethodLabels = {
        cash_on_delivery: 'Cash on Delivery',
        paynow_mock: 'PayNow',
        card_mock: 'Credit/Debit'
    };
    const paymentMethod = paymentMethodLabels[paymentMethodInput] || paymentMethodInput;

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

    // Loyalty earning: $1 spent = 1 point
    const earnedPoints = Math.floor(finalTotal);

    // Net change in points:
    // - We already deducted redeemedPoints at /apply-loyalty, so do NOT subtract again here.
    // - Just add the points earned from this order.
    const netPoints = earnedPoints;

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
                INSERT INTO orders (user_id, customer_name, customer_contact, delivery_address, postal_code, payment_method, order_notes, delivery_date, delivery_time, subtotal, promo_discount, loyalty_discount, final_total)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;
            connection.query(
                orderSql,
                [userId, deliveryName, deliveryContact, deliveryAddress, deliveryPostal, paymentMethod, orderNotes || null, deliveryDateVal, deliveryTimeSlot, orderTotal, promoDiscount, loyaltyDiscount, finalTotal],
            (orderErr, orderResult) => {
                if (orderErr) {
                    return connection.rollback(() => {
                        console.error('Failed to insert order', orderErr);
                        req.flash('error', 'Unable to create order record.');
                        res.redirect('/checkout');
                    });
                }

                const orderId = orderResult.insertId; // invoice number

                // 3. Insert order_items + update stock for each cart item
                const itemSql = `
                    INSERT INTO order_items
                    (order_id, product_id, product_name, unit_price, quantity, line_total)
                    VALUES (?, ?, ?, ?, ?, ?)
                `;
                const stockSql = `
                    UPDATE products
                    SET quantity = quantity - ?
                    WHERE id = ? AND quantity >= ?
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

                            // Update stock
                            connection.query(
                                stockSql,
                                [item.quantity, item.productId, item.quantity],
                                (stockErr, stockResult) => {
                                    if (stockErr) {
                                        return connection.rollback(() => {
                                            console.error('Failed to update stock', stockErr);
                                            req.flash('error', 'Unable to update stock.');
                                            res.redirect('/checkout');
                                        });
                                    }

                                    // If affectedRows is 0, stock not enough (should not happen if you checked earlier)
                                    if (stockResult.affectedRows === 0) {
                                        return connection.rollback(() => {
                                            console.error('Insufficient stock for product', item.productId);
                                            req.flash('error', `Insufficient stock for ${item.productName}.`);
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
                    // 4. Update user loyalty in DB (best-effort: if columns missing, skip but do not block checkout)
                    if (userId && netPoints !== 0) {
                        connection.query(
                            'UPDATE users SET loyalty_points = GREATEST(COALESCE(loyalty_points,0) + ?, 0) WHERE id = ?',
                            [netPoints, userId],
                            (lpErr) => {
                                if (lpErr) {
                                    // Log but do not block checkout; ensures orders still complete
                                    console.error('Failed to update loyalty points', lpErr);
                                }

                                // Update session so UI reflects earned points this session
                                const current = typeof req.session.user.loyalty_points === 'number'
                                    ? req.session.user.loyalty_points
                                    : 0;
                                const newPoints = Math.max(0, current + netPoints);
                                req.session.user.loyalty_points = newPoints;
                                req.session.user.membership_tier = getMembershipTier(newPoints);

                                // 5. Update promo usage (if any), then commit
                                updatePromoAndCommit(orderId);
                            }
                        );
                    } else {
                        // no loyalty change – just promo + commit
                        updatePromoAndCommit(orderId);
                    }
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

                                // 6. Clear cart + session promos/loyalty
                                req.session.cart = [];
                                req.session.appliedPromo = null;
                                req.session.loyaltyRedemption = null;
                                req.session.checkoutDraft = null;

                                req.flash('success', `Order placed successfully! You earned ${earnedPoints} points.`);
                                // redirect to invoice page
                                res.redirect(`/invoice/${orderId}`);
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

                            req.session.cart = [];
                            req.session.appliedPromo = null;
                            req.session.loyaltyRedemption = null;
                            req.session.checkoutDraft = null;

                            req.flash('success', `Order placed successfully! You earned ${earnedPoints} points.`);
                            res.redirect(`/invoice/${orderId}`);
                        });
                    }
                }
            }); // end order insert query

        }); // end connection.beginTransaction
    }); // end ensureInvoiceColumns
}); // end ensureOrderDeliveryColumns
}); // end app.post('/checkout')

// =====================
// Invoice view
//  ====================
app.get('/invoice/:id', checkAuthenticated, (req, res) => {
    const orderId = parseInt(req.params.id, 10);
    const userId = req.session.user && req.session.user.id;

    if (isNaN(orderId)) {
        req.flash('error', 'Invalid invoice ID.');
        return res.redirect('/orders');
    }

    // Fetch order header (ensure it belongs to current user)
    const orderSql = `
        SELECT o.*, u.username, u.email
        FROM orders o
        JOIN users u ON o.user_id = u.id
        WHERE o.id = ? AND o.user_id = ?
    `;
    const itemsSql = `
        SELECT *
        FROM order_items
        WHERE order_id = ?
    `;

    connection.query(orderSql, [orderId, userId], (err, orderRows) => {
        if (err || !orderRows || orderRows.length === 0) {
            console.error('Invoice lookup error', err);
            req.flash('error', 'Invoice not found.');
            return res.redirect('/orders');
        }

        const order = orderRows[0];

        connection.query(itemsSql, [orderId], (itemErr, itemRows) => {
            if (itemErr) {
                console.error('Invoice items lookup error', itemErr);
                req.flash('error', 'Unable to load invoice items.');
                return res.redirect('/orders');
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


// =====================
// Logout (also may exist in authRoutes)
// =====================
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
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
