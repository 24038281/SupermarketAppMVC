const Product = require('../models/Product');
const connection = require('../config/db');

function list(req, res) {
  const { category, search, limit } = req.query;
  Product.getProductsWithBadges({ category, search, limit }, (err, products) => {
    if (err) {
      console.error('Product list failed', err);
      return res.status(500).json({ message: 'Unable to fetch products' });
    }
    res.json(products || []);
  });
}

function get(req, res) {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ message: 'Invalid product id' });

  connection.query('SELECT * FROM products WHERE id = ?', [id], (err, rows) => {
    if (err) {
      console.error('Product fetch failed', err);
      return res.status(500).json({ message: 'Unable to fetch product' });
    }
    if (!rows || rows.length === 0) return res.status(404).json({ message: 'Product not found' });
    res.json(rows[0]);
  });
}

function create(req, res) {
  const { name, quantity, price, category, image } = req.body;
  if (!name || quantity === undefined || price === undefined) {
    return res.status(400).json({ message: 'name, quantity and price are required' });
  }

  const sql = `
    INSERT INTO products (productName, quantity, price, category, image, created_at)
    VALUES (?, ?, ?, ?, ?, NOW())
  `;
  const params = [
    name,
    parseInt(quantity, 10),
    parseFloat(price),
    category || 'Others',
    image || null
  ];

  connection.query(sql, params, (err, result) => {
    if (err) {
      console.error('Product create failed', err);
      return res.status(500).json({ message: 'Unable to create product' });
    }
    res.status(201).json({
      id: result.insertId,
      productName: name,
      quantity: parseInt(quantity, 10),
      price: parseFloat(price),
      category: category || 'Others',
      image: image || null
    });
  });
}

function update(req, res) {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ message: 'Invalid product id' });

  const { name, quantity, price, category, image } = req.body;
  const fields = [];
  const params = [];

  if (name !== undefined) {
    fields.push('productName = ?');
    params.push(name);
  }
  if (quantity !== undefined) {
    fields.push('quantity = ?');
    params.push(parseInt(quantity, 10));
  }
  if (price !== undefined) {
    fields.push('price = ?');
    params.push(parseFloat(price));
  }
  if (category !== undefined) {
    fields.push('category = ?');
    params.push(category || 'Others');
  }
  if (image !== undefined) {
    fields.push('image = ?');
    params.push(image || null);
  }

  if (!fields.length) return res.status(400).json({ message: 'No fields to update' });

  params.push(id);
  const sql = `UPDATE products SET ${fields.join(', ')} WHERE id = ?`;
  connection.query(sql, params, (err, result) => {
    if (err) {
      console.error('Product update failed', err);
      return res.status(500).json({ message: 'Unable to update product' });
    }
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Product not found' });
    res.json({ id, updated: true });
  });
}

function remove(req, res) {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ message: 'Invalid product id' });

  connection.query('DELETE FROM products WHERE id = ?', [id], (err, result) => {
    if (err) {
      console.error('Product delete failed', err);
      return res.status(500).json({ message: 'Unable to delete product' });
    }
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Product not found' });
    res.json({ id, deleted: true });
  });
}

module.exports = {
  model: Product,
  list,
  get,
  create,
  update,
  remove
};
