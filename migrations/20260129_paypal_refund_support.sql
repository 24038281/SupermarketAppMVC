-- PayPal + provider refund support
-- Adds capture/order refs on orders + normalized payments/refunds tables.

-- Orders: store PayPal identifiers and refund markers used by routes
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS paypal_order_id VARCHAR(64) NULL AFTER payment_method,
  ADD COLUMN IF NOT EXISTS paypal_capture_id VARCHAR(64) NULL AFTER paypal_order_id,
  ADD COLUMN IF NOT EXISTS refund_status ENUM('NONE','PENDING','REFUNDED','FAILED') DEFAULT 'NONE' AFTER payment_status,
  ADD COLUMN IF NOT EXISTS refund_amount DECIMAL(10,2) NULL AFTER refund_status,
  ADD COLUMN IF NOT EXISTS refund_reason VARCHAR(255) NULL AFTER refund_amount,
  ADD COLUMN IF NOT EXISTS refund_txn_ref VARCHAR(64) NULL AFTER refund_reason,
  ADD COLUMN IF NOT EXISTS refunded_at DATETIME NULL AFTER refund_txn_ref;

-- Payments: records original payment source + provider identifiers
CREATE TABLE IF NOT EXISTS payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  user_id INT NULL,
  method ENUM('paypal','nets_qr','wallet') NOT NULL,
  amount_cents INT NOT NULL,
  status ENUM('PENDING','PAID','REFUND_PENDING','REFUNDED','REFUND_FAILED') NOT NULL DEFAULT 'PENDING',
  provider_order_id VARCHAR(64) NULL,
  provider_capture_id VARCHAR(64) NULL,
  nets_txn_ref VARCHAR(64) NULL,
  metadata JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_paypal_capture (provider_capture_id),
  UNIQUE KEY uk_nets_txn (nets_txn_ref),
  KEY idx_payment_order (order_id),
  CONSTRAINT fk_payment_order FOREIGN KEY (order_id) REFERENCES orders(id)
);

-- Refunds: records each refund attempt
CREATE TABLE IF NOT EXISTS refunds (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  payment_id INT NULL,
  method ENUM('paypal','nets_qr','wallet') NOT NULL,
  amount_cents INT NOT NULL,
  status ENUM('REQUESTED','PROCESSING','COMPLETED','FAILED') NOT NULL DEFAULT 'REQUESTED',
  provider_refund_id VARCHAR(64) NULL,
  nets_refund_ref VARCHAR(64) NULL,
  reason VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_provider_refund (provider_refund_id),
  UNIQUE KEY uk_nets_refund (nets_refund_ref),
  KEY idx_refund_payment (payment_id),
  CONSTRAINT fk_refund_payment FOREIGN KEY (payment_id) REFERENCES payments(id),
  CONSTRAINT fk_refund_order FOREIGN KEY (order_id) REFERENCES orders(id)
);
