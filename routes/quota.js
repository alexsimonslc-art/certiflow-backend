// @ts-nocheck
const express = require('express');
const router = express.Router();
const { google } = require('googleapis');

router.get('/', async (req, res) => {
  try {
    const gmail = google.gmail({ version: 'v1', auth: req.oauth2Client }); // ← changed
    const drive = google.drive({ version: 'v3', auth: req.oauth2Client }); // ← changed

    const today    = new Date();
    const afterStr = today.getFullYear() + '/' +
                     String(today.getMonth() + 1).padStart(2, '0') + '/' +
                     String(today.getDate()).padStart(2, '0');

    // Count actual sent messages today by paginating through results
    let sentToday = 0;
    let pageToken = undefined;
    do {
      const msgRes = await gmail.users.messages.list({
        userId: 'me',
        q: 'in:sent after:' + afterStr,
        maxResults: 500,
        ...(pageToken ? { pageToken } : {}),
      });
      sentToday += (msgRes.data.messages || []).length;
      pageToken  = msgRes.data.nextPageToken;
    } while (pageToken);

    const profileRes  = await gmail.users.getProfile({ userId: 'me' });
    const emailAddr   = profileRes.data.emailAddress || '';
    const isWorkspace = !emailAddr.endsWith('@gmail.com');
    const dailyLimit  = isWorkspace ? 2000 : 500;

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
      email: emailAddr,
      limit: isWorkspace ? 1500 : 100,   // Platform limits (stricter than Google's raw limits)
      totalSent: sentToday,              // We use today's count; no lifetime store yet
    });
  } catch (e) {
    console.error('Quota error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/quota/increment — called after each successful email send
router.post('/increment', async (req, res) => {
  try {
    // We rely on Gmail's live count, so this is just an acknowledgement.
    // The GET /api/quota endpoint re-queries Gmail on every call.
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;