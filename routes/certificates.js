const express = require('express');
const { google } = require('googleapis');
const router = express.Router();

router.post('/generate', async (req, res) => {
  const { sheetId, templateId, folderId, nameColumn, emailColumn } = req.body;
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: req.user.accessToken });
  const drive = google.drive({ version: 'v3', auth });
  const slides = google.slides({ version: 'v1', auth });
  const sheets = google.sheets({ version: 'v4', auth });

  const sheetData = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Sheet1!A:Z' });
  const rows = sheetData.data.values;
  const headers = rows[0];
  const nameIdx = headers.indexOf(nameColumn);
  const results = [];

  for (let i = 1; i < rows.length; i++) {
    const participantName = rows[i][nameIdx];
    try {
      const copy = await drive.files.copy({ fileId: templateId, requestBody: { name: `Certificate_${participantName}`, parents: [folderId] } });
      await slides.presentations.batchUpdate({ presentationId: copy.data.id, requestBody: { requests: [{ replaceAllText: { containsText: { text: '{{name}}' }, replaceText: participantName } }] } });
      const pdfStream = await drive.files.export({ fileId: copy.data.id, mimeType: 'application/pdf' }, { responseType: 'stream' });
      const uploaded = await drive.files.create({ requestBody: { name: `${participantName}_Certificate.pdf`, parents: [folderId] }, media: { mimeType: 'application/pdf', body: pdfStream.data } });
      await drive.permissions.create({ fileId: uploaded.data.id, requestBody: { role: 'reader', type: 'anyone' } });
      const fileInfo = await drive.files.get({ fileId: uploaded.data.id, fields: 'webViewLink' });
      await drive.files.delete({ fileId: copy.data.id });
      results.push({ name: participantName, link: fileInfo.data.webViewLink, status: 'done' });
    } catch (err) {
      results.push({ name: participantName, status: 'failed', error: err.message });
    }
  }
  res.json({ results });
});

// Single certificate generation (used by combined pipeline)
router.post('/generate-one', async (req, res) => {
  const { participantName, templateId, folderId, replacements, sheetId, rowIndex } = req.body;
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: req.user.accessToken });
  const drive  = google.drive({ version: 'v3', auth });
  const slides = google.slides({ version: 'v1', auth });
  const sheets = google.sheets({ version: 'v4', auth });

  try {
    // 1. Copy template
    const copy = await drive.files.copy({
      fileId: templateId,
      requestBody: { name: `Certificate_${participantName}`, parents: [folderId] },
    });

    // 2. Replace all placeholders
    const requests = Object.entries(replacements).map(([ph, val]) => ({
      replaceAllText: { containsText: { text: `{{${ph}}}` }, replaceText: val }
    }));
    await slides.presentations.batchUpdate({
      presentationId: copy.data.id,
      requestBody: { requests },
    });

    // 3. Export PDF + re-upload
    const pdfStream = await drive.files.export(
      { fileId: copy.data.id, mimeType: 'application/pdf' },
      { responseType: 'stream' }
    );
    const uploaded = await drive.files.create({
      requestBody: { name: `${participantName}_Certificate.pdf`, parents: [folderId] },
      media: { mimeType: 'application/pdf', body: pdfStream.data },
    });

    // 4. Make shareable
    await drive.permissions.create({
      fileId: uploaded.data.id,
      requestBody: { role: 'reader', type: 'anyone' },
    });
    const fileInfo = await drive.files.get({ fileId: uploaded.data.id, fields: 'webViewLink' });
    await drive.files.delete({ fileId: copy.data.id });

    // 5. Write back to Sheet if requested
    if (sheetId && rowIndex !== undefined) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `Sheet1!Z${rowIndex + 2}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[fileInfo.data.webViewLink]] },
      });
    }

    res.json({ link: fileInfo.data.webViewLink });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
