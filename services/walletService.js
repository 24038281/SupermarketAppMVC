const connection = require('../config/db');

/**
 * Ensures a wallet row exists for the user.
 */
async function ensureWallet(userId) {
  if (!userId) throw new Error('userId is required');
  const conn = connection.promise();
  await conn.query(
    `INSERT INTO wallets (user_id, balance, currency, status)
     VALUES (?, 0, 'SGD', 'ACTIVE')
     ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP`,
    [userId]
  );
  return true;
}

async function getBalance(userId) {
  if (!userId) throw new Error('userId is required');
  const conn = connection.promise();
  const [rows] = await conn.query('SELECT balance FROM wallets WHERE user_id = ?', [userId]);
  return rows && rows[0] ? Number(rows[0].balance) : 0;
}

async function creditWallet({ userId, amount, orderId = null, reason = null, reference = null }) {
  if (!userId) throw new Error('userId is required');
  const creditAmount = Number(amount);
  if (!Number.isFinite(creditAmount) || creditAmount <= 0) throw new Error('amount must be > 0');

  const conn = connection.promise();
  await conn.beginTransaction();
  try {
    await ensureWallet(userId);
    await conn.query('UPDATE wallets SET balance = balance + ? WHERE user_id = ?', [creditAmount, userId]);
    await conn.query(
      `INSERT INTO wallet_transactions (user_id, order_id, type, amount, reason, reference)
       VALUES (?, ?, 'CREDIT', ?, ?, ?)`,
      [userId, orderId, creditAmount, reason, reference]
    );
    await conn.commit();
    return { ok: true };
  } catch (err) {
    await conn.rollback();
    throw err;
  }
}

async function debitWallet({ userId, amount, orderId = null, reason = null, reference = null }) {
  if (!userId) throw new Error('userId is required');
  const debitAmount = Number(amount);
  if (!Number.isFinite(debitAmount) || debitAmount <= 0) throw new Error('amount must be > 0');

  const conn = connection.promise();
  await conn.beginTransaction();
  try {
    await ensureWallet(userId);
    const [rows] = await conn.query('SELECT balance FROM wallets WHERE user_id = ? FOR UPDATE', [userId]);
    const balance = rows && rows[0] ? Number(rows[0].balance) : 0;
    if (balance < debitAmount) {
      await conn.rollback();
      throw new Error('Insufficient wallet balance');
    }
    await conn.query('UPDATE wallets SET balance = balance - ? WHERE user_id = ?', [debitAmount, userId]);
    await conn.query(
      `INSERT INTO wallet_transactions (user_id, order_id, type, amount, reason, reference)
       VALUES (?, ?, 'DEBIT', ?, ?, ?)`,
      [userId, orderId, debitAmount, reason, reference]
    );
    await conn.commit();
    return { ok: true };
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    throw err;
  }
}

module.exports = {
  ensureWallet,
  getBalance,
  creditWallet,
  debitWallet
};
