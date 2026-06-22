const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const User = require('../models/User');
const auth = require('../middleware/auth');
// Configure MoMo credentials
const config = {
  accessKey: process.env.MOMO_ACCESS_KEY || 'F8BBA842ECF85',
  secretKey: process.env.MOMO_SECRET_KEY || 'K951B6PE1waDMi640xX08PD3vg6EkVlz',
  orderInfo: 'Mua token FutureTrace',
  partnerCode: process.env.MOMO_PARTNER_CODE || 'MOMO',
  redirectUrl: process.env.MOMO_REDIRECT_URL || 'https://futuretrace.vercel.app/payment-result',
  ipnUrl: process.env.MOMO_IPN_URL || 'https://futuretrace-server.onrender.com/api/payment/callback',
  requestType: 'captureWallet',
  extraData: '',
  orderGroupId: '',
  autoCapture: true,
  lang: 'vi',
};

// Valid token pack amounts
const VALID_TOKEN_AMOUNTS = [100, 250, 550, 1200, 2500, 5000];

const parseOrderId = (orderId) => {
  // Format: userId_tokenAmount_timestamp
  const parts = String(orderId || '').split('_');
  const timestamp = parts.pop();
  const tokenAmount = parseInt(parts.pop()) || 0;
  const userId = parts.join('_');
  return { userId, tokenAmount, timestamp };
};

// Create payment
router.post('/', async (req, res) => {
  try {
    const {
      accessKey,
      secretKey,
      orderInfo,
      partnerCode,
      redirectUrl,
      ipnUrl,
      requestType,
      orderGroupId,
      autoCapture,
      lang,
    } = config;

    const orderData = req.body;

    // Validate orderData
    if (!orderData.total_price || !orderData.userId) {
      return res.status(400).json({ message: 'Missing total_price or userId' });
    }

    const tokenAmount = VALID_TOKEN_AMOUNTS.includes(orderData.tokenAmount) ? orderData.tokenAmount : 0;
    const extraData = Buffer.from(JSON.stringify({ tokenAmount })).toString('base64');
    const amount = orderData.total_price.toString();
    const orderId = `${orderData.userId}_${tokenAmount}_${new Date().getTime()}`;
    const requestId = orderId;

    const rawSignature =
      'accessKey=' + accessKey +
      '&amount=' + amount +
      '&extraData=' + extraData +
      '&ipnUrl=' + ipnUrl +
      '&orderId=' + orderId +
      '&orderInfo=' + orderInfo +
      '&partnerCode=' + partnerCode +
      '&redirectUrl=' + redirectUrl +
      '&requestId=' + requestId +
      '&requestType=' + requestType;

    const signature = crypto
      .createHmac('sha256', secretKey)
      .update(rawSignature)
      .digest('hex');

    const requestBody = JSON.stringify({
      partnerCode: partnerCode,
      partnerName: 'FutureTrace',
      storeId: 'FutureTraceStore',
      requestId: requestId,
      amount: amount,
      orderId: orderId,
      orderInfo: orderInfo,
      redirectUrl: redirectUrl,
      ipnUrl: ipnUrl,
      lang: lang,
      requestType: requestType,
      autoCapture: autoCapture,
      extraData: extraData,
      orderGroupId: orderGroupId,
      signature: signature,
    });

    const options = {
      method: 'POST',
      url: 'https://test-payment.momo.vn/v2/gateway/api/create',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody),
      },
      data: requestBody,
    };

    const result = await axios(options);

    return res.status(200).json({
      momo_payment: {
        payUrl: result.data.payUrl,
        qrCodeUrl: result.data.qrCodeUrl,
        deeplink: result.data.deeplink,
        orderId: result.data.orderId
      }
    });
  } catch (error) {
    console.error("MoMo Create Payment Error:", error.response?.data || error.message);
    return res.status(500).json({ statusCode: 500, message: error.message, details: error.response?.data });
  }
});

// Check transaction status
router.post('/check-status', async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ message: 'Missing orderId' });
    }

    const { accessKey, secretKey, partnerCode } = config;
    const requestId = orderId;

    const rawSignature = `accessKey=${accessKey}&orderId=${orderId}&partnerCode=${partnerCode}&requestId=${requestId}`;

    const signature = crypto
      .createHmac('sha256', secretKey)
      .update(rawSignature)
      .digest('hex');

    const requestBody = JSON.stringify({
      partnerCode: partnerCode,
      requestId: requestId,
      orderId: orderId,
      signature: signature,
      lang: 'vi',
    });

    const options = {
      method: 'POST',
      url: 'https://test-payment.momo.vn/v2/gateway/api/query',
      headers: {
        'Content-Type': 'application/json',
      },
      data: requestBody,
    };
    const result = await axios(options);

    // If transaction is successful, add tokens to user
    if (result.data.resultCode === 0) {
      const { userId, tokenAmount } = parseOrderId(orderId);

      try {
        const user = await User.findById(userId);
        if (user && tokenAmount > 0) {
          // Use atomic update to prevent double-crediting
          const updateResult = await User.updateOne(
            { _id: userId, processed_orders: { $ne: orderId } },
            {
              $inc: { token: tokenAmount },
              $addToSet: { processed_orders: orderId }
            }
          );

          if (updateResult.modifiedCount === 1) {
            const Transaction = require('../models/Transaction');
            await Transaction.create({
              userId,
              amount: result.data.amount || 0,
              tokenAmount,
              paymentMethod: 'momo',
              status: 'success',
              orderId: orderId,
              description: `Mua gói ${tokenAmount} token qua MoMo`,
              metadata: result.data
            });
          }
        }
      } catch (err) {
        console.error("Error updating user tokens:", err);
      }
    }

    return res.status(200).json(result.data);
  } catch (error) {
    console.error("MoMo Check Status Error:", error.response?.data || error.message);
    return res.status(500).json({ statusCode: 500, message: error.message });
  }
});

// Callback/IPN Handler
router.post('/callback', (req, res) => {
  console.log("MoMo IPN Callback received:", req.body);
  return res.status(204).send();
});
// POST /api/payment/claim-free-pack
router.post('/claim-free-pack', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ message: 'Không tìm thấy người dùng' });
    }
    if (user.has_claimed_free_pack) {
      return res.status(400).json({ message: 'Bạn đã nhận gói trải nghiệm này rồi' });
    }

    user.has_claimed_free_pack = true;
    user.token = (user.token || 0) + 100;
    await user.save();

    const Transaction = require('../models/Transaction');
    await Transaction.create({
      userId: user._id,
      amount: 0,
      tokenAmount: 100,
      paymentMethod: 'free_claim',
      status: 'success',
      orderId: `FREE_${user._id}_${Date.now()}`,
      description: 'Nhận gói trải nghiệm 0đ',
      metadata: {}
    });

    res.json({ message: 'Nhận token thành công', token: user.token });
  } catch (error) {
    console.error('Claim free pack error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống' });
  }
});

// Get user transaction history
router.get('/history', auth, async (req, res) => {
  try {
    const Transaction = require('../models/Transaction');
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 4;
    const skip = (page - 1) * limit;

    const query = { userId: req.user.userId };

    const transactions = await Transaction.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Transaction.countDocuments(query);

    res.json({
      transactions,
      currentPage: page,
      totalPages: Math.ceil(total / limit),
      totalTransactions: total
    });
  } catch (error) {
    console.error('Get history error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống' });
  }
});

module.exports = router;
