const dns = require('dns');
try {
  dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
} catch (e) {
  // ignore if not supported
}
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const User = require('./models/User');
const { authLimiter, otpLimiter, aiLimiter } = require('./middleware/rateLimits');

// Không để một promise bị reject mà không ai bắt làm sập tiến trình (Node 22 mặc định tắt process)
process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled promise rejection:', reason);
});


const authRoutes = require('./routes/auth');
const simulationRoutes = require('./routes/simulations');
const communityRoutes = require('./routes/community');
const premiumRoutes = require('./routes/premium');
const paymentRoutes = require('./routes/payment');
const adminRoutes = require('./routes/admin');
const dashboardRoutes = require('./routes/dashboard');

const app = express();
const PORT = process.env.PORT || 5000;

// Render/Netlify đứng sau reverse proxy: cần để rate limit nhận đúng IP người dùng
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
// Nén JSON phản hồi (báo cáo premium ~30KB). SSE tự gọi res.flush() để không bị đệm.
app.use(compression());

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

    if (allowedOrigins.includes(origin) || origin.startsWith('http://localhost:')) {
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

/* ================= Rate limits ================= */

app.use(['/api/auth/login', '/auth/login', '/api/auth/register', '/api/auth/refresh'], authLimiter);
app.use(['/api/auth/register/send-otp', '/api/auth/register/verify-otp'], otpLimiter);
app.use([
  '/api/simulations',
  '/api/premium/analyze',
  '/api/premium/pivot',
  '/api/premium/expand-step'
], (req, res, next) => (req.method === 'GET' || req.path === '/warmup' ? next() : aiLimiter(req, res, next)));

/* ================= Routes ================= */

app.use('/api/auth', authRoutes);
app.use('/auth', authRoutes); // Also mount at /auth for Google OAuth callback compatibility
app.use('/api/simulations', simulationRoutes);
app.use('/api/community', communityRoutes);
app.use('/api/premium', premiumRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/evaluations', require('./routes/evaluations'));
app.use('/api/knowledge', require('./routes/knowledge'));

const auth = require('./middleware/auth');
const PremiumAnalysis = require('./models/PremiumAnalysis');

app.patch('/api/scenario/step-status', auth, async (req, res) => {
  try {
    const { scenarioId, stepId, completed } = req.body;
    if (!scenarioId || !stepId) {
      return res.status(400).json({ message: 'scenarioId and stepId are required.' });
    }

    const analysis = await PremiumAnalysis.findOne({ _id: scenarioId, user_id: req.user.userId });
    if (!analysis) {
      return res.status(404).json({ message: 'Scenario progress not found.' });
    }

    let stepUpdated = false;
    for (let milestone of analysis.report.milestones) {
      if (Array.isArray(milestone.details)) {
        const step = milestone.details.find(s => s.id === stepId);
        if (step) {
          step.completed = completed;
          stepUpdated = true;
          break;
        }
      }
    }

    if (!stepUpdated) {
      return res.status(404).json({ message: 'Step not found in scenario milestones.' });
    }

    analysis.markModified('report');
    await analysis.save();

    res.json({ message: 'Step status updated successfully', report: analysis.report });
  } catch (error) {
    console.error('Update step status error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

/* ================= Health Check ================= */
app.use('/api/admin', adminRoutes);

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

const connectDB = async () => {
  const primaryUri = process.env.MONGODB_URI;
  const localUri = 'mongodb://127.0.0.1:27017/futuretrace';

  try {
    console.log('🔄 Đang kết nối tới MongoDB...');
    await mongoose.connect(primaryUri, { serverSelectionTimeoutMS: 5000 });
    console.log('✅ MongoDB connected successfully (Cloud Atlas)');
  } catch (err) {
    console.warn(`⚠️ Cloud MongoDB connection failed (${err.message}). Trying Local MongoDB...`);
    try {
      await mongoose.connect(localUri);
      console.log('✅ MongoDB connected successfully (Local MongoDB 127.0.0.1:27017)');
    } catch (localErr) {
      console.error('❌ Cả Cloud và Local MongoDB đều không kết nối được:', localErr.message);
      process.exit(1);
    }
  }

  app.listen(PORT, () => {
    console.log(`🚀 FutureTrace server running on port ${PORT}`);
    console.log(`📡 API base: /api`);
  });
};

// Chỉ tự kết nối DB + lắng nghe cổng khi chạy trực tiếp (`node server.js`);
// test tích hợp import `app` và tự quản lý kết nối (MongoDB trong bộ nhớ).
if (require.main === module) {
  connectDB();
}

module.exports = app;
