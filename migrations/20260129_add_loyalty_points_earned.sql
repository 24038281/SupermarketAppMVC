-- Track loyalty points earned per order for refund reversal
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS loyalty_points_earned INT NOT NULL DEFAULT 0 AFTER loyalty_discount;
