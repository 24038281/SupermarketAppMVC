const connection = require('../config/db');

const runQuery = (sql, params) =>
  new Promise((resolve, reject) => {
    connection.query(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });

const Payment = {
  async createPending({ orderId, userId, amount, currency = 'SGD', method = 'NETS_QR', netsTxnRef, metadata = null }) {
    if (!netsTxnRef) throw new Error('netsTxnRef is required for payment');
    const sql = `
      INSERT INTO nets_qr_transactions (order_id, user_id, txn_ref, amount, status, payload)
      VALUES (?, ?, ?, ?, 'PENDING', ?)
      ON DUPLICATE KEY UPDATE
        order_id = VALUES(order_id),
        user_id = VALUES(user_id),
        amount = VALUES(amount),
        status = 'PENDING',
        payload = VALUES(payload)
    `;
    const payload = metadata ? JSON.stringify(metadata) : null;
    await runQuery(sql, [orderId || null, userId || null, netsTxnRef, amount || 0, payload]);
  },

  async markStatusByTxnRef({ netsTxnRef, status, amount, currency = 'SGD', metadata }) {
    if (!netsTxnRef) throw new Error('netsTxnRef is required to update payment');

    const conn = connection.promise();
    await conn.beginTransaction();
    try {
      const [rows] = await conn.query('SELECT * FROM nets_qr_transactions WHERE txn_ref = ? FOR UPDATE', [netsTxnRef]);
      let payment = rows && rows[0];

      if (!payment) {
        const insertSql = `
          INSERT INTO nets_qr_transactions (order_id, user_id, txn_ref, amount, status, payload)
          VALUES (NULL, NULL, ?, ?, ?, ?)
        `;
        const payload = metadata ? JSON.stringify(metadata) : null;
        await conn.query(insertSql, [netsTxnRef, amount || 0, status, payload]);
        const [fresh] = await conn.query('SELECT * FROM nets_qr_transactions WHERE txn_ref = ? FOR UPDATE', [netsTxnRef]);
        payment = fresh && fresh[0];
      }

      const orderId = payment ? payment.order_id : null;
      const userId = payment ? payment.user_id : null;

      if (payment && payment.status === status) {
        await conn.commit();
        return { skipped: true, status, orderId, userId };
      }

      const payload = metadata ? JSON.stringify(metadata) : null;
      await conn.query(
        `
          UPDATE nets_qr_transactions
          SET status = ?,
              amount = COALESCE(?, amount),
              payload = COALESCE(?, payload),
              updated_at = NOW()
          WHERE txn_ref = ?
        `,
        [status, amount || null, payload, netsTxnRef]
      );

      if (orderId) {
        if (status === 'SUCCESS') {
          await conn.query(
            `
              UPDATE orders
              SET payment_status = 'SUCCESS',
                  payment_method = 'NETS_QR',
                  nets_txn_ref = ?,
                  paid_at = NOW()
              WHERE id = ? AND payment_status NOT IN ('PAID','CANCELLED','EXPIRED')
            `,
            [netsTxnRef, orderId]
          );
          // Record normalized payment row for refund linkage
          try {
            const amountCents = Math.round((Number(amount) || 0) * 100);
            await conn.query(
              `INSERT INTO payments (order_id, user_id, method, amount_cents, status, nets_txn_ref)
                 VALUES (?, ?, 'nets_qr', ?, 'PAID', ?)
               ON DUPLICATE KEY UPDATE
                 user_id = VALUES(user_id),
                 amount_cents = VALUES(amount_cents),
                 status = 'PAID',
                 nets_txn_ref = VALUES(nets_txn_ref),
                 updated_at = CURRENT_TIMESTAMP`,
              [orderId, userId || null, amountCents, netsTxnRef]
            );
          } catch (payErr) {
            console.error('[NETS] failed to upsert payments row', payErr.message);
          }
        } else {
          await conn.query(
            `
              UPDATE orders
              SET payment_status = ?
              WHERE id = ? AND payment_status NOT IN ('PAID','CANCELLED','EXPIRED')
            `,
            [status, orderId]
          );
        }
      }

      await conn.commit();
      return { status, orderId, userId };
    } catch (err) {
      await connection.promise().rollback();
      throw err;
    }
  }
};

module.exports = Payment;
