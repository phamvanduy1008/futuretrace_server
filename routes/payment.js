const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const User = require('../models/User');

const PREMIUM_DAILY_TOKENS = User.PREMIUM_DAILY_TOKENS || 30000;
const PLAN_DURATION_MONTHS = {
  monthly: 1,
  yearly: 12
};

const addMonths = (date, months) => {
  const next = new Date(date);
  const day = next.getDate();
  next.setMonth(next.getMonth() + months);
  if (next.getDate() !== day) {
    next.setDate(0);
  }
  return next;
};

const parsePremiumOrderId = (orderId) => {
  const parts = String(orderId || '').split('_');
  const timestamp = parts.pop();
  const planType = parts.pop();
  const userId = parts.join('_');

  if (!userId || !PLAN_DURATION_MONTHS[planType] || !timestamp) {
    return { userId: '', planType: 'monthly' };
  }

  return { userId, planType };
};

const applyPremiumPayment = async (orderId) => {
  const { userId, planType } = parsePremiumOrderId(orderId);
  if (!userId) return null;

  const user = await User.findById(userId).select('+premium_order_ids');
  if (!user) return null;

  if (user.premium_order_ids?.includes(orderId)) {
    return user;
  }

  const now = new Date();
  const isActivePremium = (user.tier === 'premium' || user.tier === 'premium_demo') &&
    user.premium_due_date &&
    new Date(user.premium_due_date) > now;
  const baseDate = isActivePremium ? new Date(user.premium_due_date) : now;

  user.tier = 'premium';
  user.premium_create_date = isActivePremium && user.premium_create_date ? user.premium_create_date : now;
  user.premium_due_date = addMonths(baseDate, PLAN_DURATION_MONTHS[planType]);
  user.token_premium = PREMIUM_DAILY_TOKENS;
  user.premium_last_token_reset_date = now;
  user.premium_order_ids = [...(user.premium_order_ids || []), orderId];

  await user.save();
  return user;
};

// Configure MoMo credentials
const config = {
  accessKey: process.env.MOMO_ACCESS_KEY || 'F8BBA842ECF85',
  secretKey: process.env.MOMO_SECRET_KEY || 'K951B6PE1waDMi640xX08PD3vg6EkVlz',
  orderInfo: 'Thanh toan FutureTrace Premium',
  partnerCode: process.env.MOMO_PARTNER_CODE || 'MOMO',
  redirectUrl: process.env.MOMO_REDIRECT_URL || 'https://futuretrace.vercel.app/payment-result', // Update this to your frontend domain
  ipnUrl: process.env.MOMO_IPN_URL || 'https://futuretrace-server.onrender.com/api/payment/callback',
  requestType: 'captureWallet',
  extraData: '',
  orderGroupId: '',
  autoCapture: true,
  lang: 'vi',
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
      extraData,
      orderGroupId,
      autoCapture,
      lang,
    } = config;

    const orderData = req.body;

    // Validate orderData
    if (!orderData.total_price || !orderData.userId) {
      return res.status(400).json({ message: 'Missing total_price or userId' });
    }

    const planType = PLAN_DURATION_MONTHS[orderData.planType] ? orderData.planType : 'monthly';
    const amount = orderData.total_price.toString();
    const orderId = `${orderData.userId}_${planType}_${new Date().getTime()}`;
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

    // signature
    const signature = crypto
      .createHmac('sha256', secretKey)
      .update(rawSignature)
      .digest('hex');

    // json object send to MoMo endpoint
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

    // If transaction is successful, update user tier
    if (result.data.resultCode === 0) {
      try {
        await applyPremiumPayment(orderId);
      } catch (err) {
        console.error("Error updating user tier:", err);
      }
    }

    return res.status(200).json(result.data);
  } catch (error) {
    console.error("MoMo Check Status Error:", error.response?.data || error.message);
    return res.status(500).json({ statusCode: 500, message: error.message });
  }
});

// Callback/IPN Handler
router.post('/callback', async (req, res) => {
  console.log("MoMo IPN Callback received:", req.body);
  if (req.body?.resultCode === 0 && req.body?.orderId) {
    try {
      await applyPremiumPayment(req.body.orderId);
    } catch (err) {
      console.error("Error applying premium from callback:", err);
    }
  }
  return res.status(204).send(); // Always return 204 to MoMo
});

module.exports = router;
