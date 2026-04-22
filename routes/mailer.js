// @ts-nocheck
const express          = require('express');
const { google }       = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const router           = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

/* ── Helper: increment quota in Supabase for this user ────────── */
async function incrementQuota(googleId, count = 1) {
  try {
    const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
      .toISOString().split('T')[0];

    const { data: user } = await supabase
      .from('users')
      .select('sent_today, last_sent_date, total_sent')
      .eq('google_id', googleId)
      .single();

    if (!user) return;

    const base = (user.last_sent_date !== today) ? 0 : (user.sent_today || 0);

    await supabase
      .from('users')
      .update({
        sent_today:     base + count,
        total_sent:     (user.total_sent || 0) + count,
        last_sent_date: today,
      })
      .eq('google_id', googleId);
  } catch (e) {
    console.error('[quota increment error]', e.message);
    // Non-critical — don't fail the send job
  }
}

/* ══════════════════════════════════════════════════════════════
   POST /api/mailer/send  — bulk send to all recipients
══════════════════════════════════════════════════════════════ */
router.post('/send', async (req, res) => {
  const { recipients, subject, htmlTemplate } = req.body;
  const gmail    = google.gmail({ version: 'v1', auth: req.oauth2Client });
  const googleId = req.user?.googleId;
  const results  = [];
  let successCount = 0;

  for (const recipient of recipients) {
    // Replace all {{tag}} placeholders
    let personalizedHtml = htmlTemplate;
    for (const [key, val] of Object.entries(recipient)) {
      personalizedHtml = personalizedHtml.replace(new RegExp(`{{${key}}}`, 'g'), val || '');
    }

    const raw = Buffer.from(
      `To: ${recipient.email}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${personalizedHtml}`
    ).toString('base64url');

    try {
      await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
      results.push({ email: recipient.email, status: 'sent' });
      successCount++;
    } catch (err) {
      results.push({ email: recipient.email, status: 'failed', error: err.message });
    }
  }

  // ✅ Increment quota once after all sends complete
  if (googleId && successCount > 0) {
    await incrementQuota(googleId, successCount);
  }

  res.json({ results });
});

/* ══════════════════════════════════════════════════════════════
   POST /api/mailer/send-one  — single test send
══════════════════════════════════════════════════════════════ */
router.post('/send-one', async (req, res) => {
  const { to, subject, html } = req.body;
  const gmail    = google.gmail({ version: 'v1', auth: req.oauth2Client });
  const googleId = req.user?.googleId;

  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}`
  ).toString('base64url');

  try {
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });

    // ✅ Increment quota for single send too
    if (googleId) await incrementQuota(googleId, 1);

    res.json({ status: 'sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;