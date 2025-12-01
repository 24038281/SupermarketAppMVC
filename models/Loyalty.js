const connection = require('../config/db');

// Tier thresholds and multipliers
const TIERS = [
  { name: 'Platinum', min: 800, multiplier: 2.0 },
  { name: 'Gold', min: 300, multiplier: 1.5 },
  { name: 'Silver', min: 100, multiplier: 1.2 },
  { name: 'Bronze', min: 0, multiplier: 1.0 }
];

function getTierFromBalance(currentBalance) {
  for (const t of TIERS) {
    if (currentBalance >= t.min) return t.name;
  }
  return 'Bronze';
}

function getMultiplierForTier(tierName) {
  const t = TIERS.find(x => x.name === tierName);
  return t ? t.multiplier : 1.0;
}

module.exports = {
  getSummary(userId, cb) {
    connection.query('SELECT * FROM user_loyalty_balance WHERE user_id = ?', [userId], (err, rows) => {
      if (err) return cb(err);
      if (!rows || rows.length === 0) return cb(null, { total_balance: 0, total_earned: 0, total_redeemed: 0, tier: 'Bronze' });
      const summary = rows[0];
      // Recalculate tier based on current balance
      summary.tier = getTierFromBalance(summary.total_balance);
      return cb(null, summary);
    });
  },

  awardPoints(userId, points, description, cb) {
    if (!userId) return cb(new Error('Missing userId'));
    if (!points || points <= 0) return cb(null); // nothing to do

    // Insert transaction
    const insertSql = `INSERT INTO loyalty_points (user_id, points, transaction_type, description, created_at) VALUES (?, ?, 'earn', ?, NOW())`;
    connection.query(insertSql, [userId, points, description], (err) => {
      if (err) return cb(err);

      // Update summary: balance, earned (remove lifetime_points from upsert)
      const upsert = `INSERT INTO user_loyalty_balance (user_id, total_balance, total_earned) VALUES (?, ?, ?)
                      ON DUPLICATE KEY UPDATE total_balance = total_balance + ?, total_earned = total_earned + ?`;
      connection.query(upsert, [userId, points, points, points, points], (uErr) => {
        if (uErr) return cb(uErr);

        // Fetch balance to compute tier
        connection.query('SELECT total_balance FROM user_loyalty_balance WHERE user_id = ?', [userId], (sErr, sRows) => {
          if (sErr) return cb(sErr);
          const balance = (sRows && sRows[0]) ? (sRows[0].total_balance || 0) : 0;
          const newTier = getTierFromBalance(balance);
          // Update tier based on balance
          connection.query('UPDATE user_loyalty_balance SET tier = ? WHERE user_id = ?', [newTier, userId], (tErr) => {
            if (tErr) return cb(tErr);
            return cb(null, { pointsAwarded: points, balance, tier: newTier });
          });
        });
      });
    });
  },

  redeemPoints(userId, points, description, cb) {
    if (!userId) return cb(new Error('Missing userId'));
    if (!points || points <= 0) return cb(new Error('Nothing to redeem'));

    // Insert negative transaction
    const insertSql = `INSERT INTO loyalty_points (user_id, points, transaction_type, description, created_at) VALUES (?, ?, 'redeem', ?, NOW())`;
    connection.query(insertSql, [userId, -points, description], (err) => {
      if (err) return cb(err);

      // Deduct from balance and add to total_redeemed
      const update = `UPDATE user_loyalty_balance SET total_balance = total_balance - ?, total_redeemed = total_redeemed + ? WHERE user_id = ?`;
      connection.query(update, [points, points, userId], (uErr) => {
        if (uErr) return cb(uErr);
        return cb(null);
      });
    });
  },

  getTierFromBalance,
  getMultiplierForTier
};
