/* ================================================================
   Honourix — Backend  |  routes/minisite.js
   Batch 5 — Mini Site API routes

   Endpoints:
   POST /api/minisite/submit          — Append form row to Google Sheet
   POST /api/minisite/sheet/create    — Create a new Sheet for a site
   GET  /api/minisite/sheet/:sheetId  — Get sheet metadata + row count
   GET  /api/minisite/config/:slug    — Fetch public site config (no auth)
   POST /api/minisite/save            — Save/update site config (auth)
   GET  /api/minisite/list            — List organizer's sites (auth)
   DELETE /api/minisite/:id           — Delete a site (auth)
================================================================ */

const express   = require('express');
const { google } = require('googleapis');
const jwt        = require('jsonwebtoken');
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const router = express.Router();

/* ─────────────────────────────────────────────────────────────
   AUTH HELPERS
───────────────────────────────────────────────────────────── */

/** Extract user from JWT — throws if invalid. */
function getUserFromToken(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) throw new Error('No token provided');
  return jwt.verify(token, process.env.JWT_SECRET);
}

/** Build an OAuth2 client from a user's stored tokens. */
async function getOAuthClient(user) {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  // Fetch fresh tokens from Supabase (access token may be rotated)
  const { data: dbUser, error } = await supabase
    .from('users')
    .select('access_token, refresh_token')
    .eq('google_id', user.googleId)
    .single();

  if (error || !dbUser) throw new Error('User not found in database');

  oauth2.setCredentials({
    access_token:  dbUser.access_token,
    refresh_token: dbUser.refresh_token,
  });

  // Auto-refresh: persist new access token if refreshed
  oauth2.on('tokens', async (tokens) => {
    if (tokens.access_token) {
      await supabase
        .from('users')
        .update({ access_token: tokens.access_token })
        .eq('google_id', user.googleId);
    }
  });

  return oauth2;
}

/* ─────────────────────────────────────────────────────────────
   RATE LIMITER — simple in-memory per IP
   (Replace with Redis in production)
───────────────────────────────────────────────────────────── */
const _submitCounts = new Map();
const SUBMIT_LIMIT  = 5;   // max submissions per IP per window
const SUBMIT_WINDOW = 60 * 60 * 1000; // 1 hour

function checkRateLimit(ip) {
  const now   = Date.now();
  const entry = _submitCounts.get(ip) || { count: 0, resetAt: now + SUBMIT_WINDOW };
  if (now > entry.resetAt) {
    _submitCounts.set(ip, { count: 1, resetAt: now + SUBMIT_WINDOW });
    return false;
  }
  if (entry.count >= SUBMIT_LIMIT) return true;
  entry.count++;
  _submitCounts.set(ip, entry);
  return false;
}

/* ─────────────────────────────────────────────────────────────
   SHEET HELPERS
───────────────────────────────────────────────────────────── */

/**
 * Append a single data row to a Google Sheet.
 * If the sheet is empty, writes a header row first.
 * auth:    OAuth2 client
 * sheetId: Google Sheet file ID
 * data:    { fieldName: value, ... }
 */
async function appendRowToSheet(auth, sheetId, data) {
  const sheets = google.sheets({ version: 'v4', auth });

  // 1. Check if sheet has a header row
  const meta = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Sheet1!1:1',
  });

  const existingHeaders = (meta.data.values?.[0] || []).map(h => h.toString().trim());
  const dataKeys        = Object.keys(data);

  let headerRow;

  if (!existingHeaders.length) {
    // Fresh sheet — write headers
    headerRow = ['Timestamp', ...dataKeys];
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: 'Sheet1!A1',
      valueInputOption: 'RAW',
      requestBody: { values: [headerRow] },
    });
  } else {
    headerRow = existingHeaders;
    // Add any new columns that don't exist yet
    const newCols = dataKeys.filter(k => !existingHeaders.includes(k));
    if (newCols.length) {
      const updatedHeaders = [...existingHeaders, ...newCols];
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: 'Sheet1!A1',
        valueInputOption: 'RAW',
        requestBody: { values: [updatedHeaders] },
      });
      headerRow = updatedHeaders;
    }
  }

  // 2. Build the data row aligned to header columns
  const timestamp = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  });

  const row = headerRow.map(col => {
    if (col === 'Timestamp') return timestamp;
    const val = data[col];
    if (Array.isArray(val)) return val.join(', ');
    return val !== undefined && val !== null ? String(val) : '';
  });

  // 3. Append the row
  const appendRes = await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Sheet1!A1',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });

  return {
    updatedRange: appendRes.data.updates?.updatedRange,
    rowsAdded:    appendRes.data.updates?.updatedRows || 1,
  };
}

/**
 * Create a new Google Sheet for a mini site in the organizer's Drive.
 * Returns the new sheet's file ID.
 */
async function createSheetForSite(auth, siteName) {
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.create({
    requestBody: {
      properties: {
        title: `${siteName} — Registrations (Honourix)`,
      },
      sheets: [
        {
          properties: {
            title:     'Sheet1',
            gridProperties: { frozenRowCount: 1 },
          },
        },
      ],
    },
  });

  const sheetId = res.data.spreadsheetId;

  // Format the header row (will be filled on first submission)
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.016, green: 0.031, blue: 0.059 },
                textFormat: { bold: true, foregroundColor: { red: 0, green: 0.831, blue: 1 } },
              },
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat)',
          },
        },
      ],
    },
  });

  return sheetId;
}

/* ═══════════════════════════════════════════════════════════════
   ROUTE 1 — POST /api/minisite/submit (PUBLIC — no auth required)
   Visitor submits a registration form → row appended to Sheet.
═══════════════════════════════════════════════════════════════ */
router.post('/submit', async (req, res) => {
  try {
    const { siteId, sheetId, slug, data, submittedAt, userAgent } = req.body;

    // ── Basic validation
    if (!data || typeof data !== 'object' || !Object.keys(data).length) {
      return res.status(400).json({ error: 'No form data provided' });
    }
    if (!siteId && !slug) {
      return res.status(400).json({ error: 'Site identifier required' });
    }

    // ── Rate limit by IP
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || 'unknown';
    if (checkRateLimit(ip)) {
      return res.status(429).json({ error: 'Too many submissions. Please try again later.' });
    }

    // ── Honeypot check (server-side echo)
    if (data.hp_field) {
      return res.status(200).json({ ok: true }); // silently accept
    }

    // ── Fetch site from Supabase to get owner's userId
    let siteRecord;
    if (siteId) {
      const { data: row } = await supabase
        .from('mini_sites')
        .select('*')
        .eq('id', siteId)
        .single();
      siteRecord = row;
    } else if (slug) {
      const { data: row } = await supabase
        .from('mini_sites')
        .select('*')
        .eq('slug', slug)
        .single();
      siteRecord = row;
    }

    if (!siteRecord) {
      return res.status(404).json({ error: 'Site not found' });
    }

    if (siteRecord.registration_open === false) {
      return res.status(403).json({ error: 'Registrations are closed for this event.' });
    }

    // ── Get the target sheet ID (from request or from site record)
    const targetSheetId = sheetId || siteRecord.sheet_id;
    if (!targetSheetId) {
      return res.status(422).json({ error: 'No Google Sheet linked to this site yet. The organiser needs to connect a Sheet.' });
    }

    // ── Fetch organizer's OAuth tokens from Supabase
    const { data: organizer } = await supabase
      .from('users')
      .select('access_token, refresh_token, google_id')
      .eq('id', siteRecord.user_id)
      .single();

    if (!organizer) {
      return res.status(500).json({ error: 'Could not find site owner.' });
    }

    // ── Build OAuth client with organizer's tokens
    const oauth2 = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    oauth2.setCredentials({
      access_token:  organizer.access_token,
      refresh_token: organizer.refresh_token,
    });
    // Persist any token refresh
    oauth2.on('tokens', async (tokens) => {
      if (tokens.access_token) {
        await supabase
          .from('users')
          .update({ access_token: tokens.access_token })
          .eq('google_id', organizer.google_id);
      }
    });

    // ── Strip internal fields before writing
    const cleanData = { ...data };
    delete cleanData.hp_field;

    // ── Append to Sheet
    const result = await appendRowToSheet(oauth2, targetSheetId, cleanData);

    // ── Increment submission count in Supabase
    await supabase
      .from('mini_sites')
      .update({ submission_count: (siteRecord.submission_count || 0) + 1 })
      .eq('id', siteRecord.id);

    return res.json({
      ok:           true,
      rowsAdded:    result.rowsAdded,
      updatedRange: result.updatedRange,
    });

  } catch (err) {
    console.error('[minisite/submit]', err.message);
    return res.status(500).json({ error: 'Submission failed. Please try again.' });
  }
});

/* ═══════════════════════════════════════════════════════════════
   ROUTE 2 — POST /api/minisite/sheet/create (AUTH REQUIRED)
   Organizer creates a linked Google Sheet for their mini site.
═══════════════════════════════════════════════════════════════ */
router.post('/sheet/create', async (req, res) => {
  try {
    const user     = getUserFromToken(req);
    const { siteId, siteName } = req.body;
    if (!siteId) return res.status(400).json({ error: 'siteId required' });

    // Verify site belongs to this user
    const { data: site } = await supabase
      .from('mini_sites')
      .select('id, sheet_id, name')
      .eq('id', siteId)
      .eq('user_id', user.googleId)
      .single();

    if (!site) return res.status(404).json({ error: 'Site not found' });
    if (site.sheet_id) return res.json({ sheetId: site.sheet_id, alreadyExists: true });

    const auth    = await getOAuthClient(user);
    const sheetId = await createSheetForSite(auth, siteName || site.name);

    // Persist sheet ID to Supabase
    await supabase
      .from('mini_sites')
      .update({ sheet_id: sheetId })
      .eq('id', siteId);

    return res.json({ ok: true, sheetId });
  } catch (err) {
    console.error('[minisite/sheet/create]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════
   ROUTE 3 — GET /api/minisite/sheet/:sheetId (AUTH REQUIRED)
   Get submission stats and last few rows for the editor dashboard.
═══════════════════════════════════════════════════════════════ */
router.get('/sheet/:sheetId', async (req, res) => {
  try {
    const user    = getUserFromToken(req);
    const { sheetId } = req.params;
    const auth    = await getOAuthClient(user);
    const sheets  = google.sheets({ version: 'v4', auth });

    const meta = await sheets.spreadsheets.get({
      spreadsheetId: sheetId,
      includeGridData: false,
    });

    const firstSheet = meta.data.sheets?.[0];
    const rowCount   = (firstSheet?.properties?.gridProperties?.rowCount || 1) - 1;
    const title      = meta.data.properties?.title || '';
    const sheetUrl   = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;

    return res.json({ ok: true, title, rowCount: Math.max(0, rowCount), sheetUrl });
  } catch (err) {
    console.error('[minisite/sheet/:id]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════
   ROUTE 4 — GET /api/minisite/config/:slug (PUBLIC)
   Fetch a published site's config for the public site.html renderer.
═══════════════════════════════════════════════════════════════ */
router.get('/config/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    const { data: site, error } = await supabase
      .from('mini_sites')
      .select('id, name, slug, status, config, registration_open, submission_count')
      .eq('slug', slug)
      .eq('status', 'published')
      .single();

    if (error || !site) {
      return res.status(404).json({ error: 'Site not found or not published yet.' });
    }

    return res.json({
      id:               site.id,
      name:             site.name,
      slug:             site.slug,
      registrationOpen: site.registration_open !== false,
      submissionCount:  site.submission_count  || 0,
      config:           site.config || {},
    });
  } catch (err) {
    console.error('[minisite/config/:slug]', err.message);
    return res.status(500).json({ error: 'Could not load site.' });
  }
});

/* ═══════════════════════════════════════════════════════════════
   ROUTE 5a — POST /api/minisite/publish (AUTH REQUIRED)
   Dedicated publish endpoint — always sets status='published'.
   Separate from /save so the client can distinguish draft vs live.
═══════════════════════════════════════════════════════════════ */
router.post('/publish', async (req, res) => {
  try {
    const user = getUserFromToken(req);
    const { siteId, slug, name, registrationOpen, config } = req.body;

    if (!siteId || !slug) return res.status(400).json({ error: 'siteId and slug required' });
    if (slug.length < 3)   return res.status(400).json({ error: 'Slug must be at least 3 characters' });

    // Slug uniqueness (excluding this site)
    const { data: existing } = await supabase
      .from('mini_sites')
      .select('id')
      .eq('slug', slug)
      .neq('id', siteId)
      .single();

    if (existing) return res.status(409).json({ error: 'Slug already taken. Choose another in Site Settings.' });

    // Upsert with status = 'published'
    const { error } = await supabase
      .from('mini_sites')
      .upsert({
        id:               siteId,
        user_id:          user.googleId,
        name:             name || 'Untitled',
        slug,
        status:           'published',
        registration_open: registrationOpen !== false,
        config:           config || {},
        updated_at:       new Date().toISOString(),
      }, { onConflict: 'id' });

    if (error) throw new Error(error.message);

    const publicUrl = `/site.html?slug=${slug}`;

    return res.json({ success: true, slug, publicUrl });
  } catch (err) {
    console.error('[minisite/publish]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════
   ROUTE 5b — POST /api/minisite/save (AUTH REQUIRED)
   Save or update a mini site config to Supabase.
═══════════════════════════════════════════════════════════════ */
router.post('/save', async (req, res) => {
  try {
    const user = getUserFromToken(req);
    const { id, name, slug, status, config } = req.body;

    if (!id || !slug) return res.status(400).json({ error: 'id and slug required' });

    // Check slug uniqueness (excluding current site)
    const { data: existing } = await supabase
      .from('mini_sites')
      .select('id')
      .eq('slug', slug)
      .neq('id', id)
      .single();

    if (existing) return res.status(409).json({ error: 'Slug already taken. Please choose another.' });

    // Upsert
    const { error } = await supabase
      .from('mini_sites')
      .upsert({
        id,
        user_id:           user.googleId,
        name:              name || 'Untitled',
        slug,
        status:            status || 'draft',
        registration_open: config?.registrationOpen !== false,
        config:            config || {},
        updated_at:        new Date().toISOString(),
      }, { onConflict: 'id' });

    if (error) throw new Error(error.message);

    return res.json({ ok: true });
  } catch (err) {
    console.error('[minisite/save]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════
   ROUTE 6 — GET /api/minisite/list (AUTH REQUIRED)
   List all mini sites for the logged-in organizer.
═══════════════════════════════════════════════════════════════ */
router.get('/list', async (req, res) => {
  try {
    const user = getUserFromToken(req);

    const { data: sites, error } = await supabase
      .from('mini_sites')
      .select('id, name, slug, status, registration_open, submission_count, sheet_id, updated_at, created_at')
      .eq('user_id', user.googleId)
      .order('updated_at', { ascending: false });

    if (error) throw new Error(error.message);

    return res.json({ ok: true, sites: sites || [] });
  } catch (err) {
    console.error('[minisite/list]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════
   ROUTE 7 — DELETE /api/minisite/:id (AUTH REQUIRED)
   Delete a mini site. Sheet is NOT deleted (data stays in Drive).
═══════════════════════════════════════════════════════════════ */
router.delete('/:id', async (req, res) => {
  try {
    const user = getUserFromToken(req);
    const { id } = req.params;

    const { error } = await supabase
      .from('mini_sites')
      .delete()
      .eq('id', id)
      .eq('user_id', user.googleId);

    if (error) throw new Error(error.message);

    return res.json({ ok: true });
  } catch (err) {
    console.error('[minisite/delete]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;