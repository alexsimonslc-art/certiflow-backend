const express = require('express');
const cors = require('cors');
const session = require('express-session');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const mailerRoutes = require('./routes/mailer');
const certRoutes = require('./routes/certificates');
const sheetsRoutes = require('./routes/sheets');
const { verifyToken } = require('./middleware/authMiddleware');
const quotaRoutes = require('./routes/quota');
const minisiteRoutes = require('./routes/minisite');
const app = express();

// ── CORS Fix ──────────────────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL?.replace(/\/$/, ''), // strip trailing slash
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3000',
].filter(Boolean);

app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    const clean = origin.replace(/\/$/, '');
    if (allowedOrigins.includes(clean)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));
app.use(session({
  secret: process.env.JWT_SECRET,
  resave: false,
  saveUninitialized: false,
}));

// Public routes
app.use('/auth', authRoutes);

// Protected routes (require JWT)
app.use('/api/mail', verifyToken, mailerRoutes);
app.use('/api/certificates', verifyToken, certRoutes);
app.use('/api/sheets', verifyToken, sheetsRoutes);
app.use('/api/quota', verifyToken, quotaRoutes);
app.use('/api/minisite', minisiteRoutes);
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Public mini site renderer — serves site.html for any /s/SLUG path
const path = require('path');
app.get('/s/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/site.html'));
});

app.use('/api/hxforms', require('./routes/hxforms'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/hxdb', require('./routes/hxdb'));
app.use('/api/ai', verifyToken, require('./routes/ai'));
app.use('/api/minisite-ai', verifyToken, require('./routes/minisite-ai'));
app.use('/api/campaigns', verifyToken, require('./routes/campaigns'));
app.use('/api/settings', verifyToken, require('./routes/settings'));
app.listen(process.env.PORT || 3000, () =>
  console.log(`Honourix backend running on port ${process.env.PORT}`)
);