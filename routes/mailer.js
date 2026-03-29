const express = require('express');
const { google } = require('googleapis');
const router = express.Router();

router.post('/send', async (req, res) => {
  const { recipients, subject, htmlTemplate } = req.body;
  const gmail = google.gmail({ version: 'v1', auth: req.oauth2Client }); // ← changed
  const results = [];
  for (const recipient of recipients) {
    const personalizedHtml = htmlTemplate
      .replace(/{{name}}/g, recipient.name)
      .replace(/{{cert_link}}/g, recipient.cert_link || '');
    const raw = Buffer.from(
      `To: ${recipient.email}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${personalizedHtml}`
    ).toString('base64url');
    try {
      await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
      results.push({ email: recipient.email, status: 'sent' });
    } catch (err) {
      results.push({ email: recipient.email, status: 'failed', error: err.message });
    }
  }
  res.json({ results });
});

router.post('/send-one', async (req, res) => {
  const { to, subject, html } = req.body;
  const gmail = google.gmail({ version: 'v1', auth: req.oauth2Client }); // ← changed
  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}`
  ).toString('base64url');
  try {
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    res.json({ status: 'sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;