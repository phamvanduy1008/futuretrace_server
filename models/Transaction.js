const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true }, // VND amount
  tokenAmount: { type: Number, required: true },
  paymentMethod: { type: String, enum: ['momo', 'vnpay', 'manual', 'free_claim'], required: true },
  status: { type: String, enum: ['success', 'failed', 'pending'], default: 'pending' },
  orderId: { type: String, unique: true, sparse: true },
  description: { type: String, default: '' },
  metadata: { type: mongoose.Schema.Types.Mixed } // For any extra IPN data
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'transactions'
});

transactionSchema.index({ userId: 1 });
transactionSchema.index({ status: 1 });
transactionSchema.index({ created_at: -1 });

module.exports = mongoose.model('Transaction', transactionSchema);
