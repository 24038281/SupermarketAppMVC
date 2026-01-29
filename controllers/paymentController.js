// controllers/invoiceController.js  (Note: this behaves like a NETS payment handler)
const Payment = require("../models/Payment");
const { finalizeOrderAfterPayment } = require("../services/orderFinalizer");

// --- Helpers -------------------------------------------------------------

const pick = (obj, paths = []) => {
  for (const p of paths) {
    const parts = p.split(".");
    let cur = obj;
    let ok = true;
    for (const k of parts) {
      if (!cur || typeof cur !== "object" || !(k in cur)) {
        ok = false;
        break;
      }
      cur = cur[k];
    }
    if (ok && cur !== undefined && cur !== null && cur !== "") return cur;
  }
  return null;
};

const normalizeNetsAmounts = (payload = {}) => {
  const raw =
    pick(payload, [
      "amount",
      "result.data.total_amt_incl_gst",
      "result.data.amt_in_dollars",
      "result.data.amount",
      "result.data.total_amount",
      "total_amt_incl_gst",
      "amt_in_dollars"
    ]) || 0;

  const num = Number(raw);
  return Number.isFinite(num) ? num : 0;
};

const normalizeTxnStatus = (payload = {}) => {
  const raw = pick(payload, [
    "txn_status",
    "result.data.txn_status",
    "result.data.txnStatus"
  ]);

  // NETS may return 1 / "1"
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

const isSuccessResponseCode = (payload = {}) => {
  const code = pick(payload, [
    "response_code",
    "result.data.response_code",
    "result.data.responseCode"
  ]);

  // Typical NETS success is "00" (string). Keep it flexible.
  return String(code || "").trim() === "00";
};

const extractTxnRef = (payload = {}) => {
  // Common fields NETS might send
  return pick(payload, [
    "txn_retrieval_ref",
    "txnRef",
    "txn_ref",
    "netsTxnRef",
    "result.data.txn_retrieval_ref",
    "result.data.txnRef",
    "result.data.txn_ref"
  ]);
};

// --- Exports -------------------------------------------------------------

/**
 * Create/Reset a PENDING nets_qr_transactions row.
 * Call this when you generate a NETS QR / initiate payment.
 */
exports.createPending = async ({ orderId, userId, amount, netsTxnRef, metadata }) => {
  if (!netsTxnRef) throw new Error("netsTxnRef is required");

  await Payment.createPending({
    orderId,
    userId,
    amount: Number(amount || 0),
    currency: "SGD",
    method: "NETS_QR",
    netsTxnRef,
    metadata
  });

  return { ok: true };
};

/**
 * Mark NETS success (server-side), update orders table to PAID + store txn ref/paid_at.
 */
exports.markNetsSuccess = async ({ netsTxnRef, payload }) => {
  const amount = normalizeNetsAmounts(payload);

  const result = await Payment.markStatusByTxnRef({
    netsTxnRef,
    status: "SUCCESS",
    amount,
    currency: "SGD",
    method: "NETS_QR",
    metadata: payload
  });

  // After marking NETS success, finalize order (stock + payment fields)
  if (result && result.orderId) {
    try {
      await finalizeOrderAfterPayment({
        orderId: result.orderId,
        userId: result.userId || null,
        method: 'NETS_QR',
        netsTxnRef
      });
    } catch (err) {
      console.error('[NETS] finalizeOrderAfterPayment failed', err);
    }
  }

  return result;
};

/**
 * Mark NETS failure/cancel (server-side), update orders.payment_status accordingly if you want.
 */
exports.markNetsFailure = async ({ netsTxnRef, payload, status = "FAILED" }) => {
  const amount = normalizeNetsAmounts(payload);

  return Payment.markStatusByTxnRef({
    netsTxnRef,
    status, // "FAILED" or "CANCELLED"
    amount,
    currency: "SGD",
    method: "NETS_QR",
    metadata: payload
  });
};

// Convenience wrapper for cancellations
exports.markNetsCancelled = async ({ netsTxnRef, payload }) => {
  return exports.markNetsFailure({ netsTxnRef, payload, status: "CANCELLED" });
};

/**
 * Webhook endpoint handler for NETS.
 * Expected behavior:
 * - Extract txn ref
 * - Determine success (response_code === "00" and txn_status == 1)
 * - Update payment + order atomically via Payment model
 */
exports.handleNetsWebhook = async (req, res) => {
  try {
    const netsTxnRef = extractTxnRef(req.body);

    if (!netsTxnRef) {
      return res.status(400).json({
        ok: false,
        error: "Missing txn reference (netsTxnRef/txn_retrieval_ref)"
      });
    }

    const successCode = isSuccessResponseCode(req.body);
    const txnStatus = normalizeTxnStatus(req.body);

    // NETS often treats txn_status === 1 as success/complete
    const isTxnSuccess = successCode && txnStatus === 1;

    if (isTxnSuccess) {
      console.log('[NETS] Success detected (response_code=00, txn_status=1)', {
        netsTxnRef,
        txnStatus,
        responseCode: pick(req.body, ['response_code', 'result.data.response_code', 'result.data.responseCode'])
      });
      const result = await exports.markNetsSuccess({ netsTxnRef, payload: req.body });
      return res.json({ ok: true, status: "SUCCESS", result });
    }

    // Optional: if you want to detect cancellation separately
    const result = await exports.markNetsFailure({
      netsTxnRef,
      payload: req.body,
      status: "FAILED"
    });

    return res.json({ ok: true, status: "FAILED", result });
  } catch (err) {
    console.error("NETS webhook handler error:", err);
    return res.status(500).json({
      ok: false,
      error: "Internal error",
      message: err.message
    });
  }
};
