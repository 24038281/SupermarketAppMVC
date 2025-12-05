// MySQL-backed Product helper (not using mongoose in this project)
const connection = require('../config/db');

let bestsellerFlagEnsured = false;
function ensureEverBestsellerColumn(callback) {
  if (bestsellerFlagEnsured) return callback();
  connection.query('SHOW COLUMNS FROM products LIKE "ever_bestseller"', (err, rows) => {
    if (err) return callback(err);
    if (rows && rows.length) {
      bestsellerFlagEnsured = true;
      return callback();
    }
    connection.query('ALTER TABLE products ADD COLUMN ever_bestseller TINYINT(1) NOT NULL DEFAULT 0', (alterErr) => {
      if (alterErr) return callback(alterErr);
      bestsellerFlagEnsured = true;
      callback();
    });
  });
}

function getBestsellerIds(callback) {
  const sql = `
    SELECT product_id, SUM(quantity) AS total_sold
    FROM order_items
    GROUP BY product_id
    ORDER BY total_sold DESC
    LIMIT 4
  `;
  connection.query(sql, (err, rows) => {
    if (err) return callback(err);
    const ids = (rows || []).map(r => r.product_id);
    if (!ids.length) return callback(null, new Set());

    // Persist that these products have ever been bestsellers so they never show "New" again.
    connection.query('UPDATE products SET ever_bestseller = 1 WHERE id IN (?)', [ids], () => {
      // ignore update errors to avoid blocking rendering
      callback(null, new Set(ids));
    });
  });
}

function getProductsWithBadges(options, callback) {
  const opts = options || {};
  const where = [];
  const params = [];
  const orderClause = 'ORDER BY products.id ASC';
  const NEW_PRODUCT_WINDOW_DAYS = 7; // only show "New" badge for products added within 7 days

  if (opts.category) {
    where.push('category = ?');
    params.push(opts.category);
  }
  if (opts.search) {
    where.push('productName LIKE ?');
    params.push(`%${opts.search}%`);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limitClause = opts.limit ? 'LIMIT ?' : '';
  if (opts.limit) params.push(Number(opts.limit));

  const productSql = `
    SELECT products.*
    FROM products
    ${whereClause}
    ${orderClause}
    ${limitClause}
  `;

  ensureEverBestsellerColumn((colErr) => {
    if (colErr) return callback(colErr);

    getBestsellerIds((bestErr, bestsellerSet) => {
      if (bestErr) return callback(bestErr);

      connection.query(productSql, params, (prodErr, products) => {
        if (prodErr) return callback(prodErr);

        const now = new Date();
        const newWindowAgo = new Date(now.getTime() - NEW_PRODUCT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

        const withBadges = (products || []).map(p => {
          const createdAt = p.created_at ? new Date(p.created_at) : null;
          const isNew = (!p.ever_bestseller) && createdAt ? createdAt >= newWindowAgo : false;
          return {
            ...p,
            isBestseller: bestsellerSet.has(p.id),
            isNew
          };
        });

        callback(null, withBadges);
      });
    });
  });
}

const Product = {
  getProductsByCategory(category, callback) {
    return getProductsWithBadges({ category }, callback);
  },
  getProductsWithBadges
};

module.exports = Product;
