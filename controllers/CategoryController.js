const Category = require('../models/Category');

// MySQL-backed CRUD for categories (kept minimal to avoid changing other logic)
async function list(req, res) {
  try {
    const categories = await Category.find({ isDeleted: false });
    res.json(categories);
  } catch (err) {
    console.error('Category list failed', err);
    res.status(500).json({ message: 'Unable to fetch categories' });
  }
}

async function get(req, res) {
  try {
    const { id } = req.params;
    const category = await Category.findOne({ _id: id, isDeleted: false });
    if (!category) return res.status(404).json({ message: 'Category not found' });
    res.json(category);
  } catch (err) {
    console.error('Category get failed', err);
    res.status(500).json({ message: 'Unable to fetch category' });
  }
}

async function create(req, res) {
  try {
    const { name, description } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ message: 'Name is required' });

    const exists = await Category.findOne({ name: name.trim(), isDeleted: false });
    if (exists) return res.status(409).json({ message: 'Category already exists' });

    const category = await Category.create({ name: name.trim(), description: description || '' });
    res.status(201).json(category);
  } catch (err) {
    console.error('Category create failed', err);
    res.status(500).json({ message: 'Unable to create category' });
  }
}

async function update(req, res) {
  try {
    const { id } = req.params;
    const { name, description } = req.body;
    const existing = await Category.findOne({ _id: id, isDeleted: false });
    if (!existing) return res.status(404).json({ message: 'Category not found' });

    await Category.update(id, { name, description });
    const updated = await Category.findOne({ _id: id, isDeleted: false });
    res.json(updated);
  } catch (err) {
    console.error('Category update failed', err);
    res.status(500).json({ message: 'Unable to update category' });
  }
}

async function remove(req, res) {
  try {
    const { id } = req.params;
    const existing = await Category.findOne({ _id: id, isDeleted: false });
    if (!existing) return res.status(404).json({ message: 'Category not found' });

    await Category.softDelete(id);
    res.json({ message: 'Category deleted' });
  } catch (err) {
    console.error('Category delete failed', err);
    res.status(500).json({ message: 'Unable to delete category' });
  }
}

module.exports = {
  model: Category,
  list,
  get,
  create,
  update,
  remove
};
