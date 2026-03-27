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

app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
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