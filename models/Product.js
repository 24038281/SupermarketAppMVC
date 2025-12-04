// MySQL-backed Product helper (not using mongoose in this project)
const connection = require('../config/db');

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
    callback(null, new Set(ids));
  });
}

function getProductsWithBadges(options, callback) {
  const opts = options || {};
  const where = [];
  const params = [];
  const orderClause = 'ORDER BY products.id ASC';

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

  getBestsellerIds((bestErr, bestsellerSet) => {
    if (bestErr) return callback(bestErr);

    connection.query(productSql, params, (prodErr, products) => {
      if (prodErr) return callback(prodErr);

      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const withBadges = (products || []).map(p => {
        const createdAt = p.created_at ? new Date(p.created_at) : null;
        const isNew = createdAt ? createdAt >= thirtyDaysAgo : false;
        return {
          ...p,
          isBestseller: bestsellerSet.has(p.id),
          isNew
        };
      });

      callback(null, withBadges);
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
