const crypto = require('crypto');
const connection = require('../config/db');

const PRIMARY_ADMIN_EMAIL = (process.env.PRIMARY_ADMIN_EMAIL || 'sam@gmail.com').trim().toLowerCase();

function hashPassword(password) {
  return crypto.createHash('sha1').update(password || '').digest('hex');
}

function getRegister(req, res) {
  const formData = (req.flash('formData')[0]) || {};
  const messages = req.flash('error') || [];
  res.render('register', { user: req.session.user || null, messages, formData });
}

function postRegister(req, res) {
  const { username, email, password, address, contact } = req.body;
  const hashed = hashPassword(password);
  const formData = { username, email, address, contact };

  // ensure uniqueness
  connection.query('SELECT id FROM users WHERE email = ?', [email], (err, rows) => {
    if (err) {
      console.error('Register lookup failed', err);
      req.flash('error', 'Registration failed. Please try again.');
      req.flash('formData', formData);
      return res.redirect('/register');
    }
    if (rows && rows.length) {
      req.flash('error', 'Email already registered.');
      req.flash('formData', formData);
      return res.redirect('/register');
    }

    connection.query(
      'INSERT INTO users (username, email, password, address, contact, role) VALUES (?, ?, ?, ?, ?, ?)',
      [username, email, hashed, address, contact, 'user'],
      (insErr, result) => {
        if (insErr) {
          console.error('Registration insert failed', insErr);
          req.flash('error', 'Registration failed. Please try again.');
          req.flash('formData', formData);
          return res.redirect('/register');
        }
        // log in the new user
        req.session.user = {
          id: result.insertId,
          username,
          email,
          role: 'user',
          membership_tier: 'Basic',
          loyalty_points: 0
        };
        req.flash('success', 'Registration successful!');
        res.redirect('/shopping');
      }
    );
  });
}

function getLogin(req, res) {
  const messages = req.flash('error') || [];
  const success = req.flash('success') || [];
  res.render('login', { user: req.session.user || null, messages: messages.concat(success) });
}

function postLogin(req, res) {
  const { email, password } = req.body;
  const hashed = hashPassword(password);
  connection.query('SELECT * FROM users WHERE email = ? AND password = ?', [email, hashed], (err, rows) => {
    if (err) {
      console.error('Login query failed', err);
      req.flash('error', 'Login failed. Please try again.');
      return res.redirect('/login');
    }
    if (!rows || !rows.length) {
      req.flash('error', 'Invalid email or password.');
      return res.redirect('/login');
    }
    const user = rows[0];
    const isPrimaryAdmin = (user.email || '').trim().toLowerCase() === PRIMARY_ADMIN_EMAIL;
    req.session.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      role: isPrimaryAdmin ? 'admin' : (user.role || 'user'),
      isPrimaryAdmin,
      membership_tier: user.membership_tier || 'Basic',
      loyalty_points: user.loyalty_points || 0
    };
    req.flash('success', 'Logged in successfully');
    res.redirect('/shopping');
  });
}

function logout(req, res) {
  req.session.destroy(() => {
    res.redirect('/login');
  });
}

module.exports = { getRegister, postRegister, getLogin, postLogin, logout };
