// ================================================================
//  Honourix — Database Tool  |  routes/hxdb.js
//  Fetches submission data from organizer's Google Sheet.
//  Zero personal data stored in Supabase — all reads from Drive.
// ================================================================

const express          = require('express');
const router           = express.Router();
const { createClient } = require('@supabase/supabase-js');
const jwt              = require('jsonwebtoken');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

/* ── Auth middleware ────────────────────────────────────────────── */
function verifyToken(req, res, next) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/* ── Refresh token → access token ──────────────────────────────── */
async function getAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error_description || 'Token refresh failed');
  return data.access_token;
}

/* ════════════════════════════════════════════════════════════════
   GET /api/hxdb/data/:formId
   Returns all rows from the form's Google Sheet.
   Response: { headers, rows, fields, formName, formSlug, status, submissionCount }
════════════════════════════════════════════════════════════════ */
router.get('/data/:formId', verifyToken, async (req, res) => {
  try {
    // 1. Load form from Supabase
    const { data: form, error: formErr } = await supabase
      .from('hx_forms')
      .select('id, name, slug, status, config, sheet_id, drive_folder_id, submission_count')
      .eq('id', req.params.formId)
      .eq('user_id', req.user.googleId)
      .single();

    if (formErr || !form) return res.status(404).json({ error: 'Form not found' });

    // 2. No sheet yet (draft or never published)
    if (!form.sheet_id) {
      return res.json({
        formName:        form.name,
        formSlug:        form.slug,
        status:          form.status,
        submissionCount: 0,
        headers:         [],
        rows:            [],
        fields:          form.config?.fields || [],
        noSheet:         true,
      });
    }

    // 3. Get organizer's refresh_token
    const { data: user } = await supabase
      .from('users')
      .select('refresh_token')
      .eq('google_id', req.user.googleId)
      .single();

    if (!user?.refresh_token) {
      return res.status(403).json({ error: 'Google account not fully connected. Sign out and sign in again.' });
    }

    // 4. Get fresh access token
    const accessToken = await getAccessToken(user.refresh_token);

    // 5. Fetch all rows from the "Registrations" tab in the Sheet
    const sheetRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${form.sheet_id}/values/Registrations`,
      { headers: { Authorization: 'Bearer ' + accessToken } }
    );

    if (!sheetRes.ok) {
      const errData = await sheetRes.json().catch(() => ({}));
      // If tab "Registrations" not found, try fetching first sheet
      if (sheetRes.status === 400 || sheetRes.status === 404) {
        const fallback = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${form.sheet_id}/values/A1:ZZZ`,
          { headers: { Authorization: 'Bearer ' + accessToken } }
        );
        if (!fallback.ok) throw new Error('Could not read Google Sheet. Check permissions.');
        const fallData = await fallback.json();
        return buildResponse(res, form, fallData.values || []);
      }
      throw new Error(errData.error?.message || 'Could not read Google Sheet');
    }

    const sheetData = await sheetRes.json();
    const values    = sheetData.values || [];

    return buildResponse(res, form, values);

  } catch (err) {
    console.error('[hxdb] data error:', err.message);
    if (err.message?.includes('invalid_grant')) {
      return res.status(403).json({ error: 'Google access expired. Sign out and sign in again.' });
    }
    res.status(500).json({ error: err.message });
  }
});

/* ── Helper: build response from raw sheet values ─────────────── */
function buildResponse(res, form, values) {
  if (values.length === 0) {
    return res.json({
      formName:        form.name,
      formSlug:        form.slug,
      status:          form.status,
      submissionCount: form.submission_count || 0,
      headers:         [],
      rows:            [],
      fields:          form.config?.fields || [],
    });
  }

  const headers = values[0] || [];
  const rows    = values.slice(1);  // everything after the header row

  // Normalize rows: ensure every row has same length as headers
  const normalRows = rows.map(row => {
    const r = [...row];
    while (r.length < headers.length) r.push('');
    return r;
  });

  res.json({
    formName:        form.name,
    formSlug:        form.slug,
    status:          form.status,
    submissionCount: form.submission_count || 0,
    sheetId:         form.sheet_id,
    headers,
    rows:            normalRows,
    fields:          form.config?.fields || [],  // used for chart generation
  });
}

/* ════════════════════════════════════════════════════════════════
   GET /api/hxdb/summary
   Light-weight: returns all forms with submission counts only.
   Used by hx-database.html list page. Reuses hx_forms table.
   (No Sheet API call needed — counts are already in Supabase)
════════════════════════════════════════════════════════════════ */
router.get('/summary', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('hx_forms')
      .select('id, name, slug, status, submission_count, sheet_id, created_at, updated_at, config')
      .eq('user_id', req.user.googleId)
      .order('updated_at', { ascending: false });

    if (error) throw error;

    // Include only the settings subset of config (not full field definitions)
    // to keep payload small
    const forms = (data || []).map(f => ({
      id:              f.id,
      name:            f.name,
      slug:            f.slug,
      status:          f.status,
      submissionCount: f.submission_count || 0,
      hasSheet:        !!f.sheet_id,
      sheetId:         f.sheet_id,
      fieldCount:      (f.config?.fields || []).filter(x => x.type !== 'section_break').length,
      updatedAt:       f.updated_at,
      createdAt:       f.created_at,
    }));

    res.json({ forms });
  } catch (err) {
    console.error('[hxdb] summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;