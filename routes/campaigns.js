// @ts-nocheck
const express = require('express');
const router  = require('express').Router();
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

/* ══════════════════════════════════════════════════════════════
   POST /api/campaigns
   Saves campaign to Supabase and creates a Drive backup sheet
   (cert & combined only — mail tool skips the sheet)
══════════════════════════════════════════════════════════════ */
router.post('/', async (req, res) => {
  try {
    const { name, type, total_count, sent_count, status, backup_data, folder_id } = req.body;
    const userId = req.user.googleId;

    let backupSheetLink = null;

    // Only create a backup sheet for cert / combined types
    if (type !== 'mail' && backup_data && backup_data.length > 0) {
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
      );
      oauth2Client.setCredentials({ access_token: req.user.accessToken });

      const drive  = google.drive({ version: 'v3', auth: oauth2Client });
      const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

      // ── Find target folder ──────────────────────────────────
      let targetFolderId = folder_id || null;
      if (!targetFolderId) {
        // Fall back: look up the folder by campaign name (combined-tool path)
        const folderName = `Honourix — ${name}`;
        const found = await drive.files.list({
          q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
          fields: 'files(id)',
        });
        targetFolderId = found.data.files?.[0]?.id || null;
      }

      // ── Sheet name = campaign name + date & time ────────────
      const now   = new Date();
      const dtStr = now.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' })
                  + ' ' + now.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', hour12:true });
      const sheetTitle = `${name} — ${dtStr}`;

      // ── Create the spreadsheet ──────────────────────────────
      const sheet = await sheets.spreadsheets.create({
        requestBody: { properties: { title: sheetTitle } },
      });
      const spreadsheetId = sheet.data.spreadsheetId;
      backupSheetLink     = sheet.data.spreadsheetUrl;

      // ── Move sheet into the cert folder ────────────────────
      if (targetFolderId) {
        const file      = await drive.files.get({ fileId: spreadsheetId, fields: 'parents' });
        const oldParents = (file.data.parents || []).join(',');
        await drive.files.update({
          fileId:        spreadsheetId,
          addParents:    targetFolderId,
          removeParents: oldParents,
          fields:        'id, parents',
        });
      }

      // ── Write data (header + rows) ──────────────────────────
      const headers = Object.keys(backup_data[0]);
      const values  = [
        headers,
        ...backup_data.map(row => headers.map(h => String(row[h] ?? ''))),
      ];
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range:           'Sheet1!A1',
        valueInputOption:'USER_ENTERED',
        requestBody:     { values },
      });

      // ── Make sheet readable by anyone with link ─────────────
      await drive.permissions.create({
        fileId:      spreadsheetId,
        requestBody: { role: 'reader', type: 'anyone' },
      });
    }

    // ── Save campaign record to Supabase ────────────────────
    const { data, error } = await supabase
      .from('campaigns')
      .insert([{
        user_id:           userId,
        name:              name              || 'Campaign',
        type:              type              || 'cert',
        total_count:       total_count       || 0,
        sent_count:        sent_count        || 0,
        status:            status            || 'completed',
        backup_sheet_link: backupSheetLink,
      }])
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, campaign: data });

  } catch (err) {
    console.error('Campaign save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════════════════════
   GET /api/campaigns
   Returns all campaigns for the logged-in user
══════════════════════════════════════════════════════════════ */
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('campaigns')
      .select('id, name, type, total_count, sent_count, status, backup_sheet_link, created_at')
      .eq('user_id', req.user.googleId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ campaigns: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
