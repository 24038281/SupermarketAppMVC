/**
 * Drop and recreate the supermarket DB schema with working seed data
 * (users, products, orders, promos, loyalty, etc.).
 *
 * WARNING: This will erase existing data in the listed tables.
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2');

// Load .env with fallback loader (mirrors app.js)
try {
  require('dotenv').config();
} catch (err) {
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
  }
}

const connection = mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'c372_supermarketdb',
  multipleStatements: true
});

const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

const sql = `
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS invoices;
DROP TABLE IF EXISTS loyalty_points;
DROP TABLE IF EXISTS membership_plans;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS promocode_redemptions;
DROP TABLE IF EXISTS promocodes;
DROP TABLE IF EXISTS user_loyalty_balance;
DROP TABLE IF EXISTS user_memberships;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS vouchers;

CREATE TABLE users (
  id INT NOT NULL AUTO_INCREMENT,
  username VARCHAR(20) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password VARCHAR(255) NOT NULL,
  address VARCHAR(255) NOT NULL,
  contact VARCHAR(10) NOT NULL,
  role VARCHAR(10) NOT NULL,
  loyalty_points INT NOT NULL DEFAULT 0,
  membership_tier VARCHAR(20) DEFAULT 'Basic',
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

CREATE TABLE products (
  id INT NOT NULL AUTO_INCREMENT,
  productName VARCHAR(200) NOT NULL,
  quantity INT NOT NULL,
  price DOUBLE(10,2) NOT NULL,
  category VARCHAR(100) DEFAULT NULL,
  image VARCHAR(50) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE orders (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  customer_name VARCHAR(255) DEFAULT NULL,
  customer_contact VARCHAR(50) DEFAULT NULL,
  delivery_address VARCHAR(255) DEFAULT NULL,
  postal_code VARCHAR(20) DEFAULT NULL,
  payment_method VARCHAR(50) DEFAULT NULL,
  order_notes TEXT,
  subtotal DECIMAL(10,2) NOT NULL,
  promo_discount DECIMAL(10,2) DEFAULT 0.00,
  loyalty_discount DECIMAL(10,2) DEFAULT 0.00,
  final_total DECIMAL(10,2) NOT NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY user_id (user_id),
  CONSTRAINT orders_ibfk_1 FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

CREATE TABLE order_items (
  id INT NOT NULL AUTO_INCREMENT,
  order_id INT NOT NULL,
  product_id INT NOT NULL,
  product_name VARCHAR(255) DEFAULT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  price DECIMAL(10,2) DEFAULT NULL,
  quantity INT NOT NULL,
  line_total DECIMAL(10,2) NOT NULL,
  subtotal DECIMAL(10,2) DEFAULT NULL,
  PRIMARY KEY (id),
  KEY order_id (order_id),
  KEY product_id (product_id),
  CONSTRAINT order_items_ibfk_1 FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT order_items_ibfk_2 FOREIGN KEY (product_id) REFERENCES products (id)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

CREATE TABLE invoices (
  id INT NOT NULL AUTO_INCREMENT,
  order_id INT NOT NULL,
  user_id INT NOT NULL,
  invoice_number VARCHAR(50) DEFAULT NULL,
  subtotal DECIMAL(10,2) DEFAULT NULL,
  final_total DECIMAL(10,2) DEFAULT NULL,
  amount DECIMAL(10,2) DEFAULT NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY invoice_number (invoice_number),
  KEY order_id (order_id),
  KEY user_id (user_id),
  CONSTRAINT invoices_ibfk_1 FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT invoices_ibfk_2 FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

CREATE TABLE loyalty_points (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  points INT NOT NULL DEFAULT 0,
  balance INT DEFAULT 0,
  earned_from_order_id INT DEFAULT NULL,
  redeemed_from_order_id INT DEFAULT NULL,
  transaction_type ENUM('earn','redeem','expiration','adjustment') DEFAULT 'earn',
  description VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME DEFAULT NULL,
  PRIMARY KEY (id),
  KEY user_id (user_id),
  CONSTRAINT loyalty_points_ibfk_1 FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

CREATE TABLE membership_plans (
  id INT NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(255) DEFAULT NULL,
  points_multiplier DECIMAL(3,2) NOT NULL DEFAULT 1.00,
  annual_fee DECIMAL(10,2) DEFAULT 0.00,
  min_annual_spend DECIMAL(10,2) DEFAULT NULL,
  benefits VARCHAR(500) DEFAULT NULL,
  active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY name (name)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

CREATE TABLE promocodes (
  id INT NOT NULL AUTO_INCREMENT,
  code VARCHAR(50) NOT NULL,
  description VARCHAR(255) DEFAULT NULL,
  type ENUM('percent','fixed') NOT NULL DEFAULT 'fixed',
  amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  min_total DECIMAL(10,2) DEFAULT NULL,
  starts_at DATETIME DEFAULT NULL,
  expires_at DATETIME DEFAULT NULL,
  max_uses INT DEFAULT NULL,
  uses INT DEFAULT 0,
  per_user_limit INT DEFAULT 1,
  active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY code (code)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

CREATE TABLE promocode_redemptions (
  id INT NOT NULL AUTO_INCREMENT,
  promo_id INT NOT NULL,
  user_id INT NOT NULL,
  uses INT DEFAULT 0,
  last_used TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY promo_id (promo_id, user_id),
  CONSTRAINT promocode_redemptions_ibfk_1 FOREIGN KEY (promo_id) REFERENCES promocodes (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

CREATE TABLE user_loyalty_balance (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  total_balance INT DEFAULT 0,
  total_earned INT DEFAULT 0,
  total_redeemed INT DEFAULT 0,
  last_updated TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  lifetime_points INT DEFAULT 0,
  tier ENUM('Bronze','Silver','Gold','Platinum') DEFAULT 'Bronze',
  PRIMARY KEY (id),
  UNIQUE KEY user_id (user_id),
  CONSTRAINT user_loyalty_balance_ibfk_1 FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

CREATE TABLE user_memberships (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  membership_plan_id INT NOT NULL,
  joined_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  renewal_date DATE DEFAULT NULL,
  is_active TINYINT(1) DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY unique_user_membership (user_id, membership_plan_id),
  KEY membership_plan_id (membership_plan_id),
  CONSTRAINT user_memberships_ibfk_1 FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT user_memberships_ibfk_2 FOREIGN KEY (membership_plan_id) REFERENCES membership_plans (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

CREATE TABLE vouchers (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  code VARCHAR(50) NOT NULL,
  points_redeemed INT NOT NULL,
  discount_amount DECIMAL(10,2) NOT NULL,
  is_used TINYINT(1) DEFAULT 0,
  used_at DATETIME DEFAULT NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY code (code),
  KEY idx_user_code (user_id, code),
  KEY idx_used (is_used),
  CONSTRAINT vouchers_ibfk_1 FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

SET FOREIGN_KEY_CHECKS = 1;

INSERT INTO users (id, username, email, password, address, contact, role, loyalty_points, membership_tier) VALUES
  (1, 'Peter Lim', 'peter@peter.com', '7c4a8d09ca3762af61e59520943dc26494f8941b', 'Woodlands Ave 2', '98765432', 'admin', 0, 'Basic'),
  (2, 'Mary Tan', 'mary@mary.com', '7c4a8d09ca3762af61e59520943dc26494f8941b', 'Tampines Ave 1', '12345678', 'user', 0, 'Basic'),
  (3, 'bobochan', 'bobochan@gmail.com', '7c4a8d09ca3762af61e59520943dc26494f8941b', 'Woodlands', '98765432', 'user', 0, 'Basic'),
  (4, 'sarahlee', 'sarahlee@gmail.com', '7c4a8d09ca3762af61e59520943dc26494f8941b', 'Woodlands', '98765432', 'user', 0, 'Basic'),
  (5, 'sam@gmail.com', 'sam@gmail.com', '01b307acba4f54f55aafc33bb06bbbf6ca803e9a', 'Bedok Ave 4', '23456789', 'user', 44, 'Bronze'),
  (6, 'tom@gmail.com', 'tom@gmail.com', '93ec71b22793a81569c94ca17e4d9c293d8e201f', 'Bedok Ave 4', '98765432', 'user', 0, 'Basic');

INSERT INTO membership_plans (id, name, description, points_multiplier, annual_fee, min_annual_spend, benefits, active, created_at, updated_at) VALUES
  (1, 'Basic', 'Standard membership with 1x points', 1.00, 0.00, NULL, 'Earn 1 point per $1 spent', 1, '${now}', '${now}'),
  (2, 'Silver', 'Premium membership with 1.5x points', 1.50, 9.99, NULL, 'Earn 1.5 points per $1 spent, birthday discount', 1, '${now}', '${now}'),
  (3, 'Gold', 'Elite membership with 2x points', 2.00, 19.99, NULL, 'Earn 2 points per $1 spent, priority support, free shipping', 1, '${now}', '${now}');

INSERT INTO products (id, productName, quantity, price, category, image, created_at) VALUES
  (1, 'Apples', 50, 1.50, 'Fruits', 'apples.png', '${now}'),
  (2, 'Bananas', 75, 0.80, 'Fruits', 'bananas.png', '${now}'),
  (3, 'Milk', 50, 3.50, 'Dairy', 'milk.png', '${now}'),
  (4, 'Bread', 80, 1.80, 'Bakery', 'bread.png', '${now}'),
  (14, 'Tomatoes', 80, 1.50, 'Vegetables', 'tomatoes.png', '${now}'),
  (19, 'Broccoli', 100, 5.00, 'Vegetables', 'Broccoli.png', '${now}'),
  (20, 'Cheddar Cheese', 60, 4.50, 'Dairy', 'cheese.png', '${now}'),
  (21, 'Bell Pepper', 90, 1.20, 'Vegetables', 'bellpepper.png', '${now}');

INSERT INTO orders (id, user_id, customer_name, customer_contact, delivery_address, postal_code, payment_method, order_notes, subtotal, promo_discount, loyalty_discount, final_total, created_at) VALUES
  (3, 5, NULL, NULL, NULL, NULL, NULL, NULL, 30.80, 0.00, 0.00, 30.80, '${now}'),
  (4, 5, NULL, NULL, NULL, NULL, NULL, NULL, 54.80, 0.00, 0.00, 54.80, '${now}'),
  (5, 5, NULL, NULL, NULL, NULL, NULL, NULL, 36.00, 3.60, 0.00, 32.40, '${now}');

INSERT INTO order_items (id, order_id, product_id, product_name, unit_price, price, quantity, line_total, subtotal) VALUES
  (1, 3, 2, 'Bananas', 0.80, NULL, 1, 0.80, NULL),
  (2, 3, 14, 'Tomatoes', 1.50, NULL, 20, 30.00, NULL),
  (3, 4, 2, 'Bananas', 0.80, NULL, 6, 4.80, NULL),
  (4, 4, 19, 'Broccoli', 5.00, NULL, 10, 50.00, NULL),
  (5, 5, 4, 'Bread', 1.80, NULL, 20, 36.00, NULL);

INSERT INTO invoices (id, order_id, user_id, invoice_number, subtotal, final_total, amount, created_at) VALUES
  (1, 3, 5, '#108003', 30.80, 30.80, 30.80, '${now}'),
  (2, 4, 5, '#108004', 54.80, 54.80, 54.80, '${now}'),
  (3, 5, 5, '#108005', 36.00, 32.40, 32.40, '${now}');

INSERT INTO loyalty_points (id, user_id, points, balance, earned_from_order_id, redeemed_from_order_id, transaction_type, description, created_at, expires_at) VALUES
  (1, 5, 19, 0, NULL, NULL, 'earn', 'Order total: $18.64', '${now}', NULL),
  (7, 5, 25, 0, NULL, NULL, 'earn', 'Order total: $25.00', '${now}', NULL);

INSERT INTO user_loyalty_balance (id, user_id, total_balance, total_earned, total_redeemed, last_updated, lifetime_points, tier) VALUES
  (1, 5, 44, 44, 0, '${now}', 44, 'Bronze');

INSERT INTO user_memberships (id, user_id, membership_plan_id, joined_at, renewal_date, is_active) VALUES
  (1, 5, 1, '${now}', NULL, 1);

INSERT INTO promocodes (id, code, description, type, amount, min_total, starts_at, expires_at, max_uses, uses, per_user_limit, active, created_at) VALUES
  (1, 'WELCOME10', '10% off for all customers', 'percent', 10.00, NULL, NULL, NULL, NULL, 2, 1, 1, '${now}'),
  (2, 'TAKE5', '$5 off orders over $20', 'fixed', 5.00, 20.00, NULL, NULL, 100, 0, 1, 1, '${now}'),
  (3, 'MERRY20', 'Christmas 20% off promotions', 'percent', 20.00, NULL, NULL, NULL, NULL, 2, 1, 1, '${now}');

INSERT INTO promocode_redemptions (id, promo_id, user_id, uses, last_used) VALUES
  (1, 1, 5, 1, '${now}'),
  (2, 3, 5, 1, '${now}');

INSERT INTO vouchers (id, user_id, code, points_redeemed, discount_amount, is_used, used_at, created_at, expires_at) VALUES
  (1, 5, 'WELCOME-VOUCHER', 10, 5.00, 0, NULL, '${now}', NULL);
`;

console.log('Re-seeding database... this will drop and recreate tables with sample data.');
connection.query(sql, (err) => {
  if (err) {
    console.error('Reseed failed:', err);
    process.exit(1);
  }
  console.log('Reseed complete. Sample users/products/orders restored.');
  connection.end();
});
