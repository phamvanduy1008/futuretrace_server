const express = require('express');
const Transaction = require('../models/Transaction');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const query = {};
    if (req.query.status && req.query.status !== 'all') {
      query.status = req.query.status;
    }
    if (req.query.paymentMethod && req.query.paymentMethod !== 'all') {
      query.paymentMethod = req.query.paymentMethod;
    }

    const transactions = await Transaction.find(query)
      .populate('userId', 'email full_name')
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Transaction.countDocuments(query);

    const items = transactions.map(tx => ({
      id: tx._id,
      userName: tx.userId?.full_name || 'Unknown',
      userEmail: tx.userId?.email || 'N/A',
      amount: tx.amount,
      tokenAmount: tx.tokenAmount,
      method: tx.paymentMethod,
      status: tx.status,
      date: tx.created_at,
      description: tx.description
    }));

    // Stats
    const successTotal = await Transaction.aggregate([
      { $match: { status: 'success' } },
      { $group: { _id: null, totalRevenue: { $sum: '$amount' }, totalTokens: { $sum: '$tokenAmount' } } }
    ]);

    const stats = {
      totalTransactions: total,
      totalRevenue: successTotal[0]?.totalRevenue || 0,
      totalTokens: successTotal[0]?.totalTokens || 0
    };

    res.json({
      items,
      stats,
      page,
      totalPages: Math.ceil(total / limit),
      total
    });
  } catch (error) {
    console.error('Error fetching admin payments:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;
