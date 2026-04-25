// ================================================================
//  Honourix — HX Forms  |  routes/hxforms.js  (Batch 4)
//  All form CRUD + publish (Drive/Sheet creation) + submit (Sheet append)
//  + file upload to Drive
// ================================================================

const express          = require('express');
const router           = express.Router();
const multer           = require('multer');
const { createClient } = require('@supabase/supabase-js');
const jwt              = require('jsonwebtoken');
const { randomUUID }   = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const QRCode = require('qrcode');

const passSupabase = (process.env.PASS_SUPABASE_URL && process.env.PASS_SUPABASE_KEY)
  ? createClient(process.env.PASS_SUPABASE_URL, process.env.PASS_SUPABASE_KEY)
  : null;

// Multer: memory storage, 25 MB limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

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

/* ── Slug generator ─────────────────────────────────────────────── */
function makeSlug(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48)
    + '-' + Math.random().toString(36).slice(2, 7);
}

/* ════════════════════════════════════════════════════════════════
   GOOGLE API HELPERS
════════════════════════════════════════════════════════════════ */

/** Exchange refresh_token for a fresh access_token */
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
  if (!res.ok || data.error) {
    throw new Error(data.error_description || data.error || 'Token refresh failed');
  }
  return data.access_token;
}

/** Find an existing Drive folder by name inside a parent (returns {id} or null) */
async function findDriveFolder(name, parentId, accessToken) {
  const escaped = name.replace(/'/g, "\\'");
  const parentQ = parentId ? ` and '${parentId}' in parents` : '';
  const q       = `name='${escaped}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentQ}`;
  const res     = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`,
    { headers: { Authorization: 'Bearer ' + accessToken } }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Drive search failed');
  return data.files?.[0] || null;
}

/** Create a Drive folder, returns its ID */
async function createDriveFolder(name, parentId, accessToken) {
  const meta = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) meta.parents = [parentId];
  const res  = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method:  'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body:    JSON.stringify(meta),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Create folder failed');
  return data.id;
}

/** Ensure the root "HX Forms" folder exists in organizer's Drive, return its ID */
async function ensureRootFolder(googleId, accessToken) {
  // 1. Check Supabase user record
  const { data: user } = await supabase
    .from('users')
    .select('hx_root_folder_id')
    .eq('google_id', googleId)
    .single();

  if (user?.hx_root_folder_id) return user.hx_root_folder_id;

  // 2. Check Drive (in case user deleted our DB record)
  const existing = await findDriveFolder('HX Forms', null, accessToken);
  const folderId = existing ? existing.id : await createDriveFolder('HX Forms', null, accessToken);

  // 3. Save back to user record
  await supabase.from('users')
    .update({ hx_root_folder_id: folderId })
    .eq('google_id', googleId);

  return folderId;
}

/** Create a Google Sheet inside a Drive folder, return its ID */
async function createSheet(name, parentFolderId, accessToken) {
  const res = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method:  'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents:  [parentFolderId],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Create sheet failed');
  return data.id;
}

/** Write header row to a Google Sheet (replaces row 1) */
async function writeSheetHeaders(sheetId, headers, accessToken) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A1?valueInputOption=RAW`,
    {
      method:  'PUT',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ values: [headers] }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Write headers failed');
  return data;
}

/** Append one row to a Google Sheet (with 2 retries) */
async function appendSheetRow(sheetId, row, accessToken, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        {
          method:  'POST',
          headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ values: [row] }),
        }
      );
      const data = await res.json();
      if (res.ok) return data;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      throw new Error(data.error?.message || 'Sheet append failed');
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}

/** Upload a file buffer to Google Drive, returns { id, webViewLink, name } */
async function uploadFileToDrive(fileName, buffer, mimeType, folderId, accessToken) {
  const safeName = `${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const meta     = JSON.stringify({ name: safeName, parents: [folderId] });
  const boundary = 'hxforms_multipart_boundary';

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`),
    Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,name',
    {
      method:  'POST',
      headers: {
        Authorization:   'Bearer ' + accessToken,
        'Content-Type':  `multipart/related; boundary="${boundary}"`,
        'Content-Length': body.length,
      },
      body,
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'File upload failed');
  return data; // { id, webViewLink, name }
}

/* ════════════════════════════════════════════════════════════════
   AUTHENTICATED ROUTES (organizer only)
════════════════════════════════════════════════════════════════ */

/* ── GET /api/hxforms/list ──────────────────────────────────────── */
router.get('/list', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('hx_forms')
      .select('id, name, slug, status, submission_count, created_at, updated_at, sheet_id, drive_folder_id')
      .eq('user_id', req.user.googleId)
      .order('updated_at', { ascending: false });
    if (error) throw error;
    res.json({ forms: data || [] });
  } catch (err) {
    console.error('[hxforms] list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/hxforms/get/:id ───────────────────────────────────── */
router.get('/get/:id', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('hx_forms')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.googleId)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Form not found' });
    res.json({ form: data });
  } catch (err) {
    console.error('[hxforms] get error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/hxforms/save ─────────────────────────────────────── */
router.post('/save', verifyToken, async (req, res) => {
  try {
    const { id, name, slug, config } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const payload = {
      user_id:    req.user.googleId,
      name:       name.trim(),
      slug:       slug || makeSlug(name),
      config:     config || {},
      updated_at: new Date().toISOString(),
    };

    let result;
    if (id) {
      const { data, error } = await supabase
        .from('hx_forms').update(payload)
        .eq('id', id).eq('user_id', req.user.googleId)
        .select('id, name, slug, status, updated_at').single();
      if (error) throw error;
      result = data;
    } else {
      const { data, error } = await supabase
        .from('hx_forms').insert({ ...payload, status: 'draft' })
        .select('id, name, slug, status, updated_at').single();
      if (error) throw error;
      result = data;
    }
    res.json({ ok: true, form: result });
  } catch (err) {
    console.error('[hxforms] save error:', err.message);
    if (err.message?.includes('unique') || err.message?.includes('duplicate')) {
      return res.status(409).json({ error: 'A form with that slug already exists.' });
    }
    res.status(500).json({ error: err.message });
  }
});

/* ── DELETE /api/hxforms/delete/:id ────────────────────────────── */
router.delete('/delete/:id', verifyToken, async (req, res) => {
  try {
    const { error } = await supabase.from('hx_forms').delete()
      .eq('id', req.params.id).eq('user_id', req.user.googleId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/hxforms/close/:id ────────────────────────────────── */
router.post('/close/:id', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase.from('hx_forms')
      .update({ status: 'closed', updated_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('user_id', req.user.googleId)
      .select('id, status').single();
    if (error) throw error;
    res.json({ ok: true, form: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/hxforms/reopen/:id ───────────────────────────────── */
router.post('/reopen/:id', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase.from('hx_forms')
      .update({ status: 'published', updated_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('user_id', req.user.googleId)
      .select('id, status').single();
    if (error) throw error;
    res.json({ ok: true, form: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════════════════════
   PUBLISH — creates Drive folder structure + Google Sheet  (Batch 4)
════════════════════════════════════════════════════════════════ */
router.post('/publish/:id', verifyToken, async (req, res) => {
  try {
    // 1. Load form
    const { data: form, error: fetchErr } = await supabase
      .from('hx_forms').select('*')
      .eq('id', req.params.id).eq('user_id', req.user.googleId).single();
    if (fetchErr || !form) return res.status(404).json({ error: 'Form not found' });

    const fields = form.config?.fields || [];
    if (fields.length === 0) {
      return res.status(400).json({ error: 'Add at least one field before publishing.' });
    }

    // Auto-generate passStaffCode if pass is enabled and none exists
    let configNeedsUpdate = false;
    if (form.config?.settings?.passEnabled && !form.config?.settings?.passStaffCode) {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      form.config.settings.passStaffCode = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
      configNeedsUpdate = true;
      console.log(`[hxforms] Generated passStaffCode for form ${form.id}`);
    }

    // 2. Load user's refresh_token
    const { data: user } = await supabase
      .from('users').select('refresh_token, hx_root_folder_id')
      .eq('google_id', req.user.googleId).single();

    if (!user?.refresh_token) {
      return res.status(403).json({
        error: 'Google account not fully connected. Please sign out and sign in again to grant permissions.',
      });
    }

    // 3. Get fresh access token
    const accessToken = await getAccessToken(user.refresh_token);

    // 4. If Drive/Sheet already set up from a previous publish, just flip status
    let { sheet_id, drive_folder_id, uploads_folder_id } = form;

    if (!sheet_id) {
      // ── First publish: create Drive folder structure ──

      // 4a. Ensure "HX Forms/" root folder
      const rootFolderId = await ensureRootFolder(req.user.googleId, accessToken);

      // 4b. Create form folder: "HX Forms / <FormName>"
      const safeName     = form.name.slice(0, 80); // Drive name limit safety
      drive_folder_id    = await createDriveFolder(safeName, rootFolderId, accessToken);

      // 4c. Create uploads subfolder
      uploads_folder_id  = await createDriveFolder('uploads', drive_folder_id, accessToken);

      // 4d. Create "Registrations" Google Sheet
      sheet_id           = await createSheet('Registrations', drive_folder_id, accessToken);

      // 4e. Write header row: [Submission ID, Submitted At, ...field labels]
      const dataFields = fields.filter(f => f.type !== 'section_break');
      const headers    = [
        'Submission ID',
        'Submitted At',
        ...dataFields.map(f => f.label || f.id),
      ];
      if (form.config?.settings?.passEnabled && form.config?.settings?.passShowAttendance) {
        headers.push('Pass Token', 'Attendance Status', 'Checked In At', 'Checked In By');
      }
      await writeSheetHeaders(sheet_id, headers, accessToken);

      console.log(`[hxforms] Created Drive structure for form ${form.id}: folder=${drive_folder_id}, sheet=${sheet_id}`);
    }

    // 5. Update hx_forms: status + Drive/Sheet IDs (+ config if passStaffCode was generated)
    const publishPayload = {
      status:            'published',
      sheet_id,
      drive_folder_id,
      uploads_folder_id,
      updated_at:        new Date().toISOString(),
    };
    if (configNeedsUpdate) publishPayload.config = form.config;

    const { data: updated, error: updateErr } = await supabase.from('hx_forms')
      .update(publishPayload)
      .eq('id', form.id)
      .select('id, name, slug, status')
      .single();

    if (updateErr) throw updateErr;

    const frontendUrl = process.env.FRONTEND_URL || 'https://certiflow-frontend.vercel.app';
    const publicUrl   = `${frontendUrl}/hx-form-view.html?f=${updated.slug}`;

    res.json({ ok: true, form: updated, publicUrl });
  } catch (err) {
    console.error('[hxforms] publish error:', err.message);

    // Detect token revocation
    if (err.message?.includes('invalid_grant') || err.message?.includes('Token has been expired')) {
      return res.status(403).json({
        error: 'Google access expired. Please sign out and sign in again.',
      });
    }
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════════════════════
   PUBLIC ROUTES (no auth)
════════════════════════════════════════════════════════════════ */

/* ── GET /api/hxforms/view/:slug ────────────────────────────────── */
// Backend fallback — primary path is Supabase anon key direct from frontend
router.get('/view/:slug', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('hx_forms')
      .select('id, name, slug, status, config, submission_count')
      .eq('slug', req.params.slug)
      .in('status', ['published', 'closed'])
      .single();
    if (error || !data) return res.status(404).json({ error: 'Form not found' });
    res.json({ form: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════════════════════
   SUBMIT — appends row to organizer's Google Sheet  (Batch 4)
════════════════════════════════════════════════════════════════ */
router.post('/submit/:slug', async (req, res) => {
  try {
    // 1. Load form
    const { data: form, error } = await supabase
      .from('hx_forms')
      .select('id, name, user_id, status, config, sheet_id, drive_folder_id, uploads_folder_id, submission_count')
      .eq('slug', req.params.slug)
      .single();

    if (error || !form) return res.status(404).json({ error: 'Form not found' });
    if (form.status === 'closed')    return res.status(403).json({ error: 'This form is closed.' });
    if (form.status !== 'published') return res.status(403).json({ error: 'Form is not accepting submissions.' });

    // Max submissions check
    const maxSub = form.config?.settings?.maxSubmissions;
    if (maxSub && form.submission_count >= maxSub) {
      return res.status(403).json({ error: 'This form has reached its maximum number of responses.' });
    }

    // 2. Build Sheet row from submitted data
    const submittedData = req.body.data      || {};
    const fieldMeta     = req.body.fieldMeta || {};
    const dataFields    = (form.config?.fields || []).filter(f => f.type !== 'section_break');
    const submissionId  = randomUUID();
    const submittedAt   = new Date().toISOString();

    const row = [
      submissionId,
      submittedAt,
      ...dataFields.map(f => {
        const val = submittedData[f.id];
        if (Array.isArray(val)) return val.join(', ');
        return String(val ?? '');
      }),
    ];

    // ── Option Caps enforcement (before writing) ──────────────────
    const liveConfig   = form.config || {};
    const optionCounts = liveConfig.optionCounts || {};
    for (const field of (liveConfig.fields || [])) {
      if (!['radio','dropdown'].includes(field.type)) continue;
      if (!field.optionCaps?.some(c => c)) continue;
      const submittedVal = submittedData[field.id];
      if (!submittedVal) continue;
      const optIdx = (field.options || []).indexOf(submittedVal);
      if (optIdx < 0) continue;
      const cap = field.optionCaps?.[optIdx];
      if (!cap) continue;
      const current = (optionCounts[field.id]?.[submittedVal]) || 0;
      if (current >= cap) {
        return res.status(409).json({ error: `"${submittedVal}" is full (${cap}/${cap} seats taken).`, optionFull: true, fieldId: field.id, option: submittedVal });
      }
    }

    // 3. Write to Sheet (if sheet exists)
    let passResult = null;
    if (form.sheet_id) {
      try {
        // Get organizer's refresh_token
        const { data: user } = await supabase
          .from('users').select('refresh_token')
          .eq('google_id', form.user_id).single();

        if (user?.refresh_token) {
          const accessToken = await getAccessToken(user.refresh_token);
          const appendData  = await appendSheetRow(form.sheet_id, row, accessToken);
          console.log(`[hxforms] Appended row to sheet ${form.sheet_id} for form ${form.id}`);

          // ── Generate entry pass if enabled ─────────────────────
          if (form.config?.settings?.passEnabled === true && passSupabase) {
            try {
              const passToken   = randomUUID();
              const scannerUrl  = `${process.env.FRONTEND_URL}/hx-scanner.html?token=${passToken}`;
              const qrDataUrl   = await QRCode.toDataURL(scannerUrl, { width: 300, margin: 2, color: { dark: '#000000', light: '#ffffff' } });

              const updatedRange = appendData?.updates?.updatedRange || '';
              const rowMatch     = updatedRange.match(/:([A-Z]+)(\d+)$/);
              const sheetRow     = rowMatch ? parseInt(rowMatch[2], 10) : null;

              const nameFieldId   = form.config.settings?.passNameField;
              const emailFieldId  = form.config.settings?.passEmailField;
              const attendeeName  = nameFieldId  ? String(submittedData[nameFieldId]  || '') : '';
              const attendeeEmail = emailFieldId ? String(submittedData[emailFieldId] || '') : '';

              const passConfig = {
                eventName:   form.config.settings?.passEventName  || form.name,
                venue:       form.config.settings?.passVenue      || '',
                date:        form.config.settings?.passDate       || '',
                time:        form.config.settings?.passTime       || '',
                rules:       form.config.settings?.passRules      || [],
                bannerColor: form.config.settings?.passBannerColor || '#1a1a2e',
                textColor:   form.config.settings?.passTextColor   || '#ffffff',
                logoUrl:     form.config.settings?.passLogoUrl     || '',
              };

              // Fire-and-forget — do not await, do not block response
              passSupabase.from('hx_passes').insert({
                pass_token:      passToken,
                form_id:         form.id,
                form_slug:       req.params.slug,
                submission_id:   submissionId,
                sheet_row:       sheetRow,
                attendee_name:   attendeeName,
                attendee_email:  attendeeEmail,
                submission_data: submittedData,
                pass_config:     passConfig,
                status:          'valid',
              }).then(({ error: passErr }) => {
                if (passErr) console.error('[hxforms] Pass Supabase insert failed:', passErr.message);
              });

              passResult = { enabled: true, token: passToken, qrDataUrl, config: passConfig, attendeeName, submissionId };
            } catch (passErr) {
              console.error('[hxforms] Pass generation failed (non-fatal):', passErr.message);
            }
          }
        } else {
          console.warn(`[hxforms] No refresh_token for user ${form.user_id} — skipping Sheet write`);
        }
      } catch (sheetErr) {
        // Sheet write failed — log but don't block the submission response
        console.error(`[hxforms] Sheet write failed (non-fatal): ${sheetErr.message}`);
      }
    }

    // 4. Increment submission_count + update optionCounts
    const newCounts = JSON.parse(JSON.stringify(optionCounts));
    for (const field of (liveConfig.fields || [])) {
      if (!['radio','dropdown'].includes(field.type)) continue;
      if (!field.optionCaps?.some(c => c)) continue;
      const submittedVal = submittedData[field.id];
      if (!submittedVal) continue;
      if (!newCounts[field.id]) newCounts[field.id] = {};
      newCounts[field.id][submittedVal] = (newCounts[field.id][submittedVal] || 0) + 1;
    }
    await supabase.from('hx_forms')
      .update({
        submission_count: (form.submission_count || 0) + 1,
        config: { ...liveConfig, optionCounts: newCounts },
      })
      .eq('id', form.id);

    const successMsg = form.config?.settings?.successMessage || 'Thank you for your response!';
    const response   = { ok: true, message: successMsg };
    if (passResult) response.pass = passResult;
    res.json(response);

  } catch (err) {
    console.error('[hxforms] submit error:', err.message);
    res.status(500).json({ error: 'Submission failed. Please try again.' });
  }
});

/* ════════════════════════════════════════════════════════════════
   FILE UPLOAD — uploads file to organizer's Drive  (Batch 4)
   Called immediately when respondent selects a file.
   Returns a Drive URL that gets included in the submission payload.
════════════════════════════════════════════════════════════════ */
router.post('/upload/:slug', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    // 1. Load form (need user_id + uploads_folder_id)
    const { data: form, error } = await supabase
      .from('hx_forms')
      .select('id, user_id, status, config, uploads_folder_id')
      .eq('slug', req.params.slug)
      .single();

    if (error || !form)          return res.status(404).json({ error: 'Form not found' });
    if (form.status !== 'published') return res.status(403).json({ error: 'Form is not live' });
    if (!form.uploads_folder_id) return res.status(503).json({ error: 'Upload folder not configured. Re-publish the form.' });

    // 2. Validate file against form field config
    const fileFields = (form.config?.fields || []).filter(f => f.type === 'file_upload');
    const fieldId    = req.body.fieldId;
    const field      = fileFields.find(f => f.id === fieldId);
    const maxBytes   = ((field?.maxMB || 10) * 1024 * 1024);
    if (req.file.size > maxBytes) {
      return res.status(413).json({ error: `File too large. Max ${field?.maxMB || 10} MB.` });
    }

    // 3. Get organizer's access token
    const { data: user } = await supabase
      .from('users').select('refresh_token')
      .eq('google_id', form.user_id).single();

    if (!user?.refresh_token) {
      return res.status(503).json({ error: 'Organizer account not connected. Contact the form owner.' });
    }

    const accessToken = await getAccessToken(user.refresh_token);

    // 4. Upload to Drive
    const driveFile = await uploadFileToDrive(
      req.file.originalname,
      req.file.buffer,
      req.file.mimetype,
      form.uploads_folder_id,
      accessToken
    );

    console.log(`[hxforms] Uploaded file ${driveFile.name} to folder ${form.uploads_folder_id}`);

    res.json({
      ok:          true,
      fileId:      driveFile.id,
      fileName:    driveFile.name,
      driveUrl:    driveFile.webViewLink,
      originalName: req.file.originalname,
      sizeBytes:   req.file.size,
    });

  } catch (err) {
    console.error('[hxforms] upload error:', err.message);
    if (err.message?.includes('invalid_grant')) {
      return res.status(403).json({ error: 'Organizer Google access expired. Please contact the form owner.' });
    }
    res.status(500).json({ error: 'File upload failed. Please try again.' });
  }
});
router.get('/public/caps', async (req, res) => {
  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: 'slug required' });
  const { data: form } = await supabase
    .from('hx_forms').select('config').eq('slug', slug).eq('status','published').single();
  if (!form) return res.status(404).json({ error: 'not found' });
  res.json({
    optionCounts: form.config?.optionCounts || {},
    fields: (form.config?.fields || []).filter(f => ['radio','dropdown'].includes(f.type)),
  });
});
module.exports = router;