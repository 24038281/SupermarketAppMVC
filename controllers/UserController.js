// controllers/UserController.js
const User = require('../models/User');

const list = async (req, res) => {
  try {
    const users = await User.find().lean();
    res.json(users); // or render a view if you prefer
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch users' });
  }
};

const get = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).lean();
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user); // or render('user/show', { user })
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch user' });
  }
};

const create = async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    // prevent self-registering as admin (can tweak if needed)
    const finalRole = role === 'admin' ? 'customer' : (role || 'customer');

    const user = new User({
      name,
      email,
      role: finalRole
    });

    await user.setPassword(password);
    await user.save();

    // if you're using EJS + flash + redirect:
    // req.flash('success', 'Account created');
    // return res.redirect('/login');

    res.status(201).json({ message: 'User created', userId: user._id });
  } catch (err) {
    console.error(err);

    if (err.code === 11000 && err.keyPattern && err.keyPattern.email) {
      return res.status(400).json({ message: 'Email already registered' });
    }

    res.status(500).json({ message: 'Failed to create user' });
  }
};

const update = async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (name) user.name = name;
    if (email) user.email = email;

    // Optional: protect admin assignment here too
    if (role && role !== 'admin') {
      user.role = role;
    }

    if (password) {
      await user.setPassword(password);
    }

    await user.save();
    res.json({ message: 'User updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update user' });
  }
};

const remove = async (req, res) => {
  try {
    const result = await User.findByIdAndDelete(req.params.id);
    if (!result) return res.status(404).json({ message: 'User not found' });
    res.json({ message: 'User deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to delete user' });
  }
};

module.exports = {
  model: User,
  list,
  get,
  create,
  update,
  remove
};
