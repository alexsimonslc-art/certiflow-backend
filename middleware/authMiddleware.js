// middleware/authMiddleware.js
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    // ── your existing checks — untouched ──────────────────────
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];

    if (!token || token === 'null' || token === 'undefined') {
      return res.status(401).json({ error: 'Invalid token format' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // ──────────────────────────────────────────────────────────

    // ── NEW: auto-refresh Google access token ─────────────────
    oauth2Client.setCredentials({
      access_token:  decoded.accessToken,
      refresh_token: decoded.refreshToken,
    });

    const { token: freshToken } = await oauth2Client.getAccessToken();

    // If Google issued a new token, save it to Supabase silently
    if (freshToken && freshToken !== decoded.accessToken) {
      await supabase
        .from('users')
        .update({ access_token: freshToken })
        .eq('google_id', decoded.googleId);
    }

    // Attach to request — routes use req.user and req.oauth2Client
    req.user = { ...decoded, accessToken: freshToken || decoded.accessToken };
    req.oauth2Client = oauth2Client;
    // ──────────────────────────────────────────────────────────

    next();

  } catch (err) {
    // ── your existing error handling — untouched ───────────────
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    return res.status(401).json({ error: 'Auth failed' });
    // ──────────────────────────────────────────────────────────
  }
};

module.exports = { verifyToken };