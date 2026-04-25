// @ts-nocheck
// ================================================================
//  Honourix — Attendance Scanner  |  routes/attendance.js
//  Entry pass verification + admit + stats + organizer view
// ================================================================

const express          = require('express');
const router           = express.Router();
const { createClient } = require('@supabase/supabase-js');

const { verifyToken } = require('../middleware/authMiddleware');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const passSupabase = (process.env.PASS_SUPABASE_URL && process.env.PASS_SUPABASE_KEY)
  ? createClient(process.env.PASS_SUPABASE_URL, process.env.PASS_SUPABASE_KEY)
  : null;

async function getAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error_description || data.error || 'Token refresh failed');
  return data.access_token;
}

function colLetter(n) {
  let s = '';
  n += 1;
  while (n > 0) {
    n -= 1;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

function sanitizePass(p) {
  return {
    passToken:     p.pass_token,
    submissionId:  p.submission_id,
    attendeeName:  p.attendee_name,
    attendeeEmail: p.attendee_email,
    status:        p.status,
    scanCount:     p.scan_count,
    checkedInAt:   p.checked_in_at,
    checkedInBy:   p.checked_in_by,
    config:        p.pass_config,
    formId:        p.form_id,
    formSlug:      p.form_slug,
  };
}

/* ════════════════════════════════════════════════════════════════
   GET /api/attendance/verify-token?token=TOKEN  (public)
════════════════════════════════════════════════════════════════ */
router.get('/verify-token', async (req, res) => {
  if (!passSupabase) return res.status(503).json({ error: 'Attendance system not configured' });
  try {
    const { data, error } = await passSupabase
      .from('hx_passes')
      .select('*')
      .eq('pass_token', req.query.token)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Invalid pass' });
    res.json({ ok: true, pass: sanitizePass(data) });
  } catch (err) {
    console.error('[attendance] verify-token error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════════════════════
   POST /api/attendance/admit  (public — staff code auth)
   Body: { token, staffCode, staffName }
════════════════════════════════════════════════════════════════ */
router.post('/admit', async (req, res) => {
  if (!passSupabase) return res.status(503).json({ error: 'Attendance system not configured' });
  const { token, staffCode, staffName } = req.body;
  if (!token || !staffCode) return res.status(400).json({ error: 'token and staffCode are required' });

  try {
    // Look up pass
    const { data: passRecord, error: passErr } = await passSupabase
      .from('hx_passes')
      .select('*')
      .eq('pass_token', token)
      .single();
    if (passErr || !passRecord) return res.status(404).json({ error: 'Invalid pass' });

    // Look up form for staff code verification
    const { data: form, error: formErr } = await supabase
      .from('hx_forms')
      .select('id, config, sheet_id, user_id')
      .eq('id', passRecord.form_id)
      .single();
    if (formErr || !form) return res.status(404).json({ error: 'Form not found' });

    // Verify staff code
    const expectedCode = form.config?.settings?.passStaffCode || '';
    if (!expectedCode || staffCode.toUpperCase() !== expectedCode.toUpperCase()) {
      return res.status(403).json({ error: 'Invalid staff code' });
    }

    // Already admitted?
    if (passRecord.status === 'admitted') {
      return res.status(409).json({ error: 'Already admitted', pass: sanitizePass(passRecord) });
    }

    // Update pass status
    const checkedInAt = new Date().toISOString();
    const checkedInBy = staffName || 'Staff';
    const { error: updateErr } = await passSupabase
      .from('hx_passes')
      .update({
        status:        'admitted',
        scan_count:    passRecord.scan_count + 1,
        checked_in_at: checkedInAt,
        checked_in_by: checkedInBy,
      })
      .eq('pass_token', token);
    if (updateErr) throw updateErr;

    // Fire-and-forget Google Sheet sync
    if (form.sheet_id && passRecord.sheet_row) {
      (async () => {
        try {
          const { data: user } = await supabase
            .from('users')
            .select('refresh_token')
            .eq('google_id', form.user_id)
            .single();
          if (!user?.refresh_token) return;
          const accessToken  = await getAccessToken(user.refresh_token);
          const dataFields   = (form.config?.fields || []).filter(f => f.type !== 'section_break');
          const baseIdx      = 2 + dataFields.length; // 0-based index of Pass Token col
          const passCol      = colLetter(baseIdx);
          const statusCol    = colLetter(baseIdx + 1);
          const checkinAtCol = colLetter(baseIdx + 2);
          const checkinByCol = colLetter(baseIdx + 3);
          const r            = passRecord.sheet_row;
          await fetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${form.sheet_id}/values:batchUpdate`,
            {
              method:  'POST',
              headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                valueInputOption: 'RAW',
                data: [
                  { range: `Sheet1!${passCol}${r}`,      values: [[passRecord.pass_token]] },
                  { range: `Sheet1!${statusCol}${r}`,    values: [['Checked In']] },
                  { range: `Sheet1!${checkinAtCol}${r}`, values: [[checkedInAt]] },
                  { range: `Sheet1!${checkinByCol}${r}`, values: [[checkedInBy]] },
                ],
              }),
            }
          );
          console.log(`[attendance] Sheet row ${r} updated for pass ${token.slice(0, 8)}`);
        } catch (sheetErr) {
          console.error('[attendance] Sheet sync failed (non-fatal):', sheetErr.message);
        }
      })();
    }

    res.json({ ok: true, message: 'Admitted successfully' });
  } catch (err) {
    console.error('[attendance] admit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════════════════════
   GET /api/attendance/stats/:formSlug?staffCode=CODE  (public)
════════════════════════════════════════════════════════════════ */
router.get('/stats/:formSlug', async (req, res) => {
  if (!passSupabase) return res.status(503).json({ error: 'Attendance system not configured' });
  const { formSlug } = req.params;
  const { staffCode } = req.query;
  if (!staffCode) return res.status(400).json({ error: 'staffCode is required' });

  try {
    const { data: form, error: formErr } = await supabase
      .from('hx_forms')
      .select('id, config')
      .eq('slug', formSlug)
      .single();
    if (formErr || !form) return res.status(404).json({ error: 'Form not found' });

    const expectedCode = form.config?.settings?.passStaffCode || '';
    if (!expectedCode || staffCode.toUpperCase() !== expectedCode.toUpperCase()) {
      return res.status(403).json({ error: 'Invalid staff code' });
    }

    const { data: passes, error: countErr } = await passSupabase
      .from('hx_passes')
      .select('status, pass_config')
      .eq('form_slug', formSlug);
    if (countErr) throw countErr;

    const total     = passes.length;
    const admitted  = passes.filter(p => p.status === 'admitted').length;
    const eventName = passes[0]?.pass_config?.eventName || form.config?.settings?.passEventName || '';

    res.json({ ok: true, total, admitted, pending: total - admitted, eventName });
  } catch (err) {
    console.error('[attendance] stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════════════════════
   GET /api/attendance/organizer/passes/:formId  (protected)
════════════════════════════════════════════════════════════════ */
router.get('/organizer/passes/:formId', verifyToken, async (req, res) => {
  if (!passSupabase) return res.status(503).json({ error: 'Attendance system not configured' });
  try {
    const { data: form, error: formErr } = await supabase
      .from('hx_forms')
      .select('id')
      .eq('id', req.params.formId)
      .eq('user_id', req.user.googleId)
      .single();
    if (formErr || !form) return res.status(403).json({ error: 'Not authorized' });

    const { data: passes, error: passErr } = await passSupabase
      .from('hx_passes')
      .select('*')
      .eq('form_id', req.params.formId)
      .order('created_at', { ascending: false });
    if (passErr) throw passErr;

    res.json({ ok: true, passes: passes || [] });
  } catch (err) {
    console.error('[attendance] organizer/passes error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
