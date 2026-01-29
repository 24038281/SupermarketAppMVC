const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');

// NETS webhook callback (server-to-server)
router.post('/nets/webhook', paymentController.handleNetsWebhook);

module.exports = router;
