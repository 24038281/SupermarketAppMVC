const axios = require('axios');
const { URLSearchParams } = require('url');
require('dotenv').config();

const PAYPAL_CLIENT = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_BASE_URL = process.env.PAYPAL_BASE_URL || process.env.PAYPAL_API || 'https://api-m.sandbox.paypal.com';

async function getAccessToken() {
  if (!PAYPAL_CLIENT || !PAYPAL_SECRET) {
    throw new Error('Missing PayPal credentials (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)');
  }

  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');

  try {
    const { data } = await axios.post(`${PAYPAL_BASE_URL}/v1/oauth2/token`, params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      auth: {
        username: PAYPAL_CLIENT,
        password: PAYPAL_SECRET
      }
    });

    if (!data || !data.access_token) {
      throw new Error('No access token returned from PayPal');
    }
    return data.access_token;
  } catch (err) {
    console.error('[PayPal] Failed to obtain access token', err.response?.data || err.message);
    throw err;
  }
}

async function createOrder({ amount, currency = 'SGD', referenceId, invoiceId } = {}) {
  if (!amount) throw new Error('amount is required to create PayPal order');
  const accessToken = await getAccessToken();

  const payload = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        amount: {
          currency_code: currency,
          value: String(amount)
        },
        ...(referenceId ? { reference_id: String(referenceId) } : {}),
        ...(invoiceId ? { invoice_id: String(invoiceId) } : {})
      }
    ]
  };

  try {
    const { data } = await axios.post(`${PAYPAL_BASE_URL}/v2/checkout/orders`, payload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      }
    });
    return data;
  } catch (err) {
    console.error('[PayPal] createOrder failed', err.response?.data || err.message);
    throw err;
  }
}

async function captureOrder(paypalOrderId) {
  if (!paypalOrderId) throw new Error('paypalOrderId is required to capture PayPal order');
  const accessToken = await getAccessToken();

  try {
    const { data } = await axios.post(`${PAYPAL_BASE_URL}/v2/checkout/orders/${paypalOrderId}/capture`, {}, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      }
    });
    return data;
  } catch (err) {
    console.error('[PayPal] captureOrder failed', err.response?.data || err.message);
    throw err;
  }
}

async function refundCapture(paypalCaptureId, amount, currency = 'SGD') {
  if (!paypalCaptureId) throw new Error('paypalCaptureId is required to refund PayPal capture');
  const accessToken = await getAccessToken();
  const payload = amount
    ? { amount: { value: String(amount), currency_code: currency } }
    : {}; // full refund when amount is omitted

  try {
    const { data } = await axios.post(`${PAYPAL_BASE_URL}/v2/payments/captures/${paypalCaptureId}/refund`, payload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      }
    });
    return data;
  } catch (err) {
    const status = err.response?.status;
    if (status === 429) {
      err.rateLimited = true; // allow caller to short-circuit retries
    }
    console.error('[PayPal] refundCapture failed', err.response?.data || err.message);
    throw err;
  }
}

module.exports = { getAccessToken, createOrder, captureOrder, refundCapture };
