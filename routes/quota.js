// @ts-nocheck
const express = require('express');
const router  = express.Router();
const { google } = require('googleapis');

function getAuth(token) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: token });
  return auth;
}

router.get('/', async (req, res) => {
  try {
    const auth  = getAuth(req.user.accessToken);
    const gmail = google.gmail({ version: 'v1', auth });
    const drive = google.drive({ version: 'v3', auth });

    // Emails sent today
    const today    = new Date();
    const afterStr = today.getFullYear() + '/' +
                     String(today.getMonth() + 1).padStart(2, '0') + '/' +
                     String(today.getDate()).padStart(2, '0');

    const msgRes    = await gmail.users.messages.list({
      userId: 'me',
      q: 'in:sent after:' + afterStr,
      maxResults: 1,
      fields: 'resultSizeEstimate',
    });
    const sentToday = msgRes.data.resultSizeEstimate || 0;

    // Detect workspace vs free gmail
    const profileRes  = await gmail.users.getProfile({ userId: 'me' });
    const emailAddr   = profileRes.data.emailAddress || '';
    const isWorkspace = !emailAddr.endsWith('@gmail.com');
    const dailyLimit  = isWorkspace ? 2000 : 500;

    // Drive storage
    const aboutRes   = await drive.about.get({ fields: 'storageQuota' });
    const sq         = aboutRes.data.storageQuota || {};
    const driveUsed  = parseInt(sq.usage  || '0');
    const driveTotal = parseInt(sq.limit  || '16106127360');

    res.json({
      sentToday,
      dailyLimit,
      isWorkspace,
      driveUsed,
      driveTotal,
      certsToday: 0,
    });
  } catch (e) {
    console.error('Quota error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;