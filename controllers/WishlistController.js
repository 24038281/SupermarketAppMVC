const Wishlist = require('../models/Wishlist'); // currently unused; kept for interface consistency
const connection = require('../config/db');

function ensureSessionWishlist(req) {
  if (!req.session.wishlist) req.session.wishlist = [];
  return req.session.wishlist;
}

function list(req, res) {
  const wishlist = ensureSessionWishlist(req);
  res.json(wishlist);
}

function get(req, res) {
  const productId = parseInt(req.params.id, 10);
  if (Number.isNaN(productId)) return res.status(400).json({ message: 'Invalid product id' });

  const wishlist = ensureSessionWishlist(req);
  const item = wishlist.find(i => i.productId === productId);
  if (!item) return res.status(404).json({ message: 'Not found in wishlist' });
  res.json(item);
}

function create(req, res) {
  const productId = parseInt(req.params.id || req.body.productId, 10);
  if (Number.isNaN(productId)) return res.status(400).json({ message: 'Invalid product id' });

  connection.query('SELECT * FROM products WHERE id = ?', [productId], (error, results) => {
    if (error) {
      console.error('Wishlist add failed', error);
      return res.status(500).json({ message: 'Unable to add to wishlist' });
    }
    if (!results || !results.length) {
      return res.status(404).json({ message: 'Product not found' });
    }

    const product = results[0];
    const wishlist = ensureSessionWishlist(req);
    const existing = wishlist.find(item => item.productId === productId);
    if (existing) return res.status(200).json(existing);

    const entry = {
      productId: product.id,
      productName: product.productName,
      price: product.price,
      image: product.image
    };
    wishlist.push(entry);
    res.status(201).json(entry);
  });
}

function update(req, res) {
  // Wishlist items have no mutable fields beyond presence; return 400
  res.status(400).json({ message: 'Nothing to update for wishlist items' });
}

function remove(req, res) {
  const productId = parseInt(req.params.id, 10);
  if (Number.isNaN(productId)) return res.status(400).json({ message: 'Invalid product id' });

  const wishlist = ensureSessionWishlist(req);
  const next = wishlist.filter(i => i.productId !== productId);
  if (next.length === wishlist.length) return res.status(404).json({ message: 'Not found in wishlist' });
  req.session.wishlist = next;
  res.json({ productId, deleted: true });
}

module.exports = {
  model: Wishlist,
  list,
  get,
  create,
  update,
  remove
};
