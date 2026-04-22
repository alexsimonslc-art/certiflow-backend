// @ts-nocheck
const express          = require('express');
const router           = express.Router();
const { google }       = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

/* ── Today's date in IST ─────────────────────────────────────── */
function getTodayIST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
    .toISOString().split('T')[0]; // "2026-04-23"
}

/* ══════════════════════════════════════════════════════════════
   GET /api/quota
══════════════════════════════════════════════════════════════ */
router.get('/', async (req, res) => {
  try {
    const gmail = google.gmail({ version: 'v1', auth: req.oauth2Client });
    const drive = google.drive({ version: 'v3', auth: req.oauth2Client });

    // Get user identity
    const profileRes  = await gmail.users.getProfile({ userId: 'me' });
    const emailAddr   = profileRes.data.emailAddress || '';
    const isWorkspace = !emailAddr.endsWith('@gmail.com') && !emailAddr.endsWith('@googlemail.com');
    const dailyLimit  = isWorkspace ? 1500 : 100;
    const acctType    = isWorkspace ? 'workspace' : 'standard';
    const today       = getTodayIST();

    // Get Drive storage
    const aboutRes   = await drive.about.get({ fields: 'storageQuota' });
    const sq         = aboutRes.data.storageQuota || {};
    const driveUsed  = parseInt(sq.usage || '0');
    const driveTotal = parseInt(sq.limit || '16106127360');

    // Fetch user row from Supabase
    const { data: user, error } = await supabase
      .from('users')
      .select('sent_today, last_sent_date, total_sent, daily_limit, account_type')
      .eq('google_id', req.user.googleId)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User record not found in database.' });
    }

    // Lazy midnight reset — if date has changed, reset sent_today
    let sentToday = user.sent_today || 0;
    if (user.last_sent_date !== today) {
      await supabase
        .from('users')
        .update({
          sent_today:     0,
          last_sent_date: today,
          daily_limit:    dailyLimit,
          account_type:   acctType,
        })
        .eq('google_id', req.user.googleId);
      sentToday = 0;
    }

    res.json({
      sentToday,
      totalSent:   user.total_sent   || 0,
      limit:       dailyLimit,
      dailyLimit,
      isWorkspace,
      accountType: acctType,
      driveUsed,
      driveTotal,
      email:       emailAddr,
      certsToday:  0,
    });

  } catch (e) {
    console.error('Quota error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ══════════════════════════════════════════════════════════════
   POST /api/quota/increment
   Body: { count: number }  — called after successful Certiflow sends
══════════════════════════════════════════════════════════════ */
router.post('/increment', async (req, res) => {
  try {
    const count = parseInt(req.body?.count || '1');
    const today = getTodayIST();

    // Fetch current record
    const { data: user, error } = await supabase
      .from('users')
      .select('sent_today, last_sent_date, total_sent')
      .eq('google_id', req.user.googleId)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User record not found.' });
    }

    // If date changed, treat base as 0 (lazy reset)
    const base = (user.last_sent_date !== today) ? 0 : (user.sent_today || 0);

    const { data: updated } = await supabase
      .from('users')
      .update({
        sent_today:     base + count,
        total_sent:     (user.total_sent || 0) + count,
        last_sent_date: today,
      })
      .eq('google_id', req.user.googleId)
      .select('sent_today, total_sent')
      .single();

    res.json({
      ok:        true,
      sentToday: updated.sent_today,
      totalSent: updated.total_sent,
    });

  } catch (e) {
    console.error('Increment error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;