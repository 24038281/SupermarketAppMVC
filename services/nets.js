const axios = require('axios');
const paymentController = require('../controllers/paymentController');

exports.generateQrCode = async (req, res) => {
    const { cartTotal } = req.body;
    const orderId = req?.params?.orderId || req?.body?.orderId || null;

    try {
        const requestBody = {
            txn_id: 'sandbox_nets|m|8ff8e5b6-d43e-4786-8ac5-7accf8c5bd9b', // demo ID
            amt_in_dollars: cartTotal,
            notify_mobile: 0
        };

        const response = await axios.post(
            'https://sandbox.nets.openapipaas.com/api/v1/common/payments/nets-qr/request',
            requestBody,
            {
                headers: {
                    'api-key': process.env.API_KEY,
                    'project-id': process.env.PROJECT_ID
                }
            }
        );

        const getCourseInitIdParam = () => {
            try {
                require.resolve('../course_init_id');
                const { courseInitId } = require('../course_init_id');
                return courseInitId ? `${courseInitId}` : '';
            } catch (error) {
                return '';
            }
        };

        const qrData = response.data.result.data;

        if (qrData.response_code === '00' && qrData.txn_status === 1 && qrData.qr_code) {
            const txnRetrievalRef = qrData.txn_retrieval_ref;
            const courseInitId = getCourseInitIdParam();
            const webhookUrl = `https://sandbox.nets.openapipaas.com/api/v1/common/payments/nets/webhook?txn_retrieval_ref=${txnRetrievalRef}&course_init_id=${courseInitId}`;

            // Record pending payment for idempotency
            try {
                await paymentController.createPending({
                    orderId: req.params && req.params.orderId ? parseInt(req.params.orderId, 10) : null,
                    userId: req.session && req.session.user ? req.session.user.id : null,
                    amount: Number(cartTotal || 0),
                    netsTxnRef: txnRetrievalRef,
                    metadata: response.data
                });
            } catch (err) {
                console.error('Failed to create pending payment', err);
            }

            return res.render('netsQr', {
                total: cartTotal,
                title: 'Scan to Pay',
                qrCodeUrl: `data:image/png;base64,${qrData.qr_code}`,
                txnRetrievalRef,
                courseInitId,
                networkCode: qrData.network_status,
                timer: 300,
                webhookUrl,
                fullNetsResponse: response.data,
                apiKey: process.env.API_KEY,
                projectId: process.env.PROJECT_ID,
                orderId,
                topupId: req.body.topupId || req.params?.topupId || null,
                flowType: req.body.flowType || null
            });
        }

        let errorMsg = 'An error occurred while generating the QR code.';
        if (qrData.network_status !== 0) {
            errorMsg = qrData.error_message || 'Transaction failed. Please try again.';
        }
        return res.render('netsQrFail', {
            title: 'Error',
            responseCode: qrData.response_code || 'N.A.',
            instructions: qrData.instruction || '',
            errorMsg
        });
    } catch (error) {
        console.error('Error in generateQrCode:', error.message);
        return res.redirect('/nets-qr/fail');
    }
};
