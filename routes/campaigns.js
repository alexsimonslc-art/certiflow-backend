const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
require('dotenv').config(); // <-- Added to match auth.js

// Initialize Supabase EXACTLY like auth.js and hxdb.js
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Import your auth middleware
const { verifyToken } = require('../middleware/authMiddleware');

// POST: Create Campaign & Backup Sheet
router.post('/', verifyToken, async (req, res) => {
  try {
    const { name, type, total_count, sent_count, status, backup_data } = req.body;
    
    // We get googleId from your verifyToken middleware
    const userId = req.user.googleId; 

    let backupSheetLink = null;

    // 1. Generate Google Sheet if backup_data exists
    if (backup_data && backup_data.length > 0 && req.user.accessToken) {
      const oauth2Client = new google.auth.OAuth2();
      oauth2Client.setCredentials({ access_token: req.user.accessToken });
      const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

      // Create the new Backup Spreadsheet
      const sheet = await sheets.spreadsheets.create({
        resource: { properties: { title: `Backup: ${name}` } },
      });

      const spreadsheetId = sheet.data.spreadsheetId;
      backupSheetLink = sheet.data.spreadsheetUrl;

      // Extract Headers and Rows cleanly
      const headers = Object.keys(backup_data[0]);
      const values = [headers, ...backup_data.map(row => headers.map(h => row[h] || ''))];

      // Write Data to the new Sheet
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: 'Sheet1!A1',
        valueInputOption: 'USER_ENTERED',
        resource: { values },
      });
    }

    // 2. Insert into Supabase Table
    const { data, error } = await supabase
      .from('campaigns')
      .insert([{
        user_id: userId,
        name,
        type,
        total_count,
        sent_count,
        status,
        backup_sheet_link: backupSheetLink
      }])
      .select();

    if (error) throw error;
    res.json({ success: true, campaign: data[0] });

  } catch (error) {
    console.error('Campaign Backup Error:', error);
    res.status(500).json({ error: 'Failed to save campaign and generate backup.' });
  }
});

// GET: Fetch all campaigns for the UI
router.get('/', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('campaigns')
      .select('*')
      .eq('user_id', req.user.googleId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ campaigns: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;