require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const simulationRoutes = require('./routes/simulations');
const communityRoutes = require('./routes/community');
const premiumRoutes = require('./routes/premium');
const paymentRoutes = require('./routes/payment');

const app = express();
const PORT = process.env.PORT || 5000;

/* ================= CORS ================= */

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:3000',
  'https://futuretrace.cloud',
  'https://www.futuretrace.cloud'
];

app.use(cors({
  origin: function (origin, callback) {

    // allow requests with no origin (mobile apps, postman)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log("Blocked CORS:", origin);
      callback(new Error('Not allowed by CORS'));
    }

  },
  credentials: true
}));

/* ================= Middleware ================= */

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

/* ================= Routes ================= */

app.use('/api/auth', authRoutes);
app.use('/api/simulations', simulationRoutes);
app.use('/api/community', communityRoutes);
app.use('/api/premium', premiumRoutes);
app.use('/api/payment', paymentRoutes);

/* ================= Health Check ================= */

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString()
  });
});

/* ================= Error Handler ================= */

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ message: 'Internal server error' });
});

/* ================= MongoDB ================= */

mongoose.connect(process.env.MONGODB_URI)
  .then(() => {

    console.log('✅ MongoDB connected');

    app.listen(PORT, () => {

      console.log(`🚀 FutureTrace server running on port ${PORT}`);
      console.log(`📡 API base: /api`);

    });

  })
  .catch((err) => {

    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);

  });

module.exports = app;