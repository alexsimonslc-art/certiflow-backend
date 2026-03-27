const express = require('express');
const { google } = require('googleapis');
const router = express.Router();

router.get('/read', async (req, res) => {
  const { sheetId, range } = req.query;
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: req.user.accessToken });
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: range || 'Sheet1!A:Z' });
    res.json({ data: response.data.values });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
