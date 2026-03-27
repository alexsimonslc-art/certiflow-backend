const express = require('express');
const cors = require('cors');
const session = require('express-session');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const mailerRoutes = require('./routes/mailer');
const certRoutes = require('./routes/certificates');
const sheetsRoutes = require('./routes/sheets');
const { verifyToken } = require('./middleware/authMiddleware');

const app = express();

// ── CORS Fix ──────────────────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL?.replace(/\/$/, ''), // strip trailing slash
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3000',
].filter(Boolean);

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

app.use(express.json());
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

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(process.env.PORT || 3000, () =>
  console.log(`CertiFlow backend running on port ${process.env.PORT}`)
);