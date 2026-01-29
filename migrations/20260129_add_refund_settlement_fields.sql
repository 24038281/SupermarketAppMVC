-- Adds settlement fields for manual refund workflows
ALTER TABLE refunds
  ADD COLUMN IF NOT EXISTS settlement_method VARCHAR(50) NULL AFTER status,
  ADD COLUMN IF NOT EXISTS settled_at DATETIME NULL AFTER settlement_method;
