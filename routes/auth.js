const express = require('express');
const { google } = require('googleapis');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const router = express.Router();

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/gmail.readonly', 
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/presentations.readonly',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email',
];

router.get('/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state: req.query.type || 'personal',
  });
  res.redirect(url);
});

router.get('/google/callback', async (req, res) => {
  const { code, state: accountType } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user profile from Google
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: profile } = await oauth2.userinfo.get();

    // Save/update user in Supabase
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_KEY
    );

    const { data: user, error } = await supabase
      .from('users')
      .upsert({
        google_id: profile.id,
        email: profile.email,
        name: profile.name,
        picture: profile.picture,
        account_type: accountType,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || null,
      }, { onConflict: 'google_id' })
      .select()
      .single();

    if (error) {
      console.error('Supabase error:', error.message);
    } else {
      console.log('User saved:', user.email);
    }

    // Issue JWT with user data
    const jwtToken = jwt.sign(
      {
        googleId: profile.id,
        email: profile.email,
        name: profile.name,
        picture: profile.picture,
        accountType,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?token=${jwtToken}`);
  } catch (err) {
    console.error('OAuth error:', err.message);
    res.redirect(`${process.env.FRONTEND_URL}/login.html?error=auth_failed`);
  }
});

router.get('/config', (req, res) => {
  res.json({ clientId: process.env.GOOGLE_CLIENT_ID });
});

module.exports = router;
