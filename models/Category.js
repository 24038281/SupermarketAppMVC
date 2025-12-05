const connection = require('../config/db');

// Ensure categories table exists (MySQL)
let tableEnsured = false;
function ensureTable() {
  if (tableEnsured) return Promise.resolve();
  const sql = `
    CREATE TABLE IF NOT EXISTS categories (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      description TEXT NULL,
      isDeleted TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;
  return new Promise((resolve, reject) => {
    connection.query(sql, (err) => {
      if (err) return reject(err);
      tableEnsured = true;
      resolve();
    });
  });
}

const Category = {
  async find(filter = {}) {
    await ensureTable();
    const where = [];
    const params = [];

    if (filter.isDeleted !== undefined) {
      where.push('isDeleted = ?');
      params.push(filter.isDeleted ? 1 : 0);
    } else {
      where.push('isDeleted = 0');
    }
    if (filter._id) {
      where.push('id = ?');
      params.push(filter._id);
    }
    if (filter.name) {
      where.push('name = ?');
      params.push(filter.name);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `SELECT * FROM categories ${whereSql} ORDER BY created_at DESC`;

    return new Promise((resolve, reject) => {
      connection.query(sql, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });
  },

  async findOne(filter = {}) {
    const rows = await Category.find(filter);
    return rows && rows[0] ? rows[0] : null;
  },

  async create(data) {
    await ensureTable();
    const name = (data.name || '').trim();
    const description = data.description || null;
    if (!name) throw new Error('Name is required');

    const sql = 'INSERT INTO categories (name, description, isDeleted) VALUES (?, ?, 0)';
    return new Promise((resolve, reject) => {
      connection.query(sql, [name, description], (err, result) => {
        if (err) return reject(err);
        resolve({ id: result.insertId, name, description, isDeleted: 0 });
      });
    });
  },

  async update(id, data) {
    await ensureTable();
    const fields = [];
    const params = [];

    if (data.name && data.name.trim()) {
      fields.push('name = ?');
      params.push(data.name.trim());
    }
    if (data.description !== undefined) {
      fields.push('description = ?');
      params.push(data.description);
    }
    if (fields.length === 0) throw new Error('No update fields provided');

    params.push(id);
    const sql = `UPDATE categories SET ${fields.join(', ')} WHERE id = ? AND isDeleted = 0`;
    return new Promise((resolve, reject) => {
      connection.query(sql, params, (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  },

  async softDelete(id) {
    await ensureTable();
    const sql = 'UPDATE categories SET isDeleted = 1 WHERE id = ?';
    return new Promise((resolve, reject) => {
      connection.query(sql, [id], (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }
};

module.exports = Category;
