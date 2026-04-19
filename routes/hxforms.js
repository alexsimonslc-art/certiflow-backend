// ================================================================
//  Honourix — HX Forms  |  routes/hxforms.js
//  All form CRUD + publish/close + public view + submit
// ================================================================

const express   = require('express');
const router    = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── Auth middleware (same as minisite.js) ─────────────────────────
const jwt = require('jsonwebtoken');

function verifyToken(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ── Slug generator ────────────────────────────────────────────────
function makeSlug(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48)
    + '-' + Math.random().toString(36).slice(2, 7);
}

// ================================================================
//  AUTHENTICATED ROUTES (organizer only)
// ================================================================

// ── GET /api/hxforms/list ─────────────────────────────────────────
// Returns all forms belonging to the organizer
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

// ── GET /api/hxforms/get/:id ──────────────────────────────────────
// Returns a single form (full config) for the editor
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

// ── POST /api/hxforms/save ────────────────────────────────────────
// Upsert: creates on first save, updates on subsequent saves
// Body: { id?, name, slug, config }
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
      // Update existing form
      const { data, error } = await supabase
        .from('hx_forms')
        .update(payload)
        .eq('id', id)
        .eq('user_id', req.user.googleId)
        .select('id, name, slug, status, updated_at')
        .single();

      if (error) throw error;
      result = data;
    } else {
      // Insert new form
      const { data, error } = await supabase
        .from('hx_forms')
        .insert({ ...payload, status: 'draft' })
        .select('id, name, slug, status, updated_at')
        .single();

      if (error) throw error;
      result = data;
    }

    res.json({ ok: true, form: result });
  } catch (err) {
    console.error('[hxforms] save error:', err.message);
    // Slug collision
    if (err.message?.includes('unique') || err.message?.includes('duplicate')) {
      return res.status(409).json({ error: 'A form with that slug already exists. Choose a different name.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/hxforms/delete/:id ───────────────────────────────
router.delete('/delete/:id', verifyToken, async (req, res) => {
  try {
    const { error } = await supabase
      .from('hx_forms')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.googleId);

    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[hxforms] delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/hxforms/publish/:id ────────────────────────────────
// Sets status → published. Google Sheet creation happens in Batch 4.
// For now: just flips the status and assigns sheet_id placeholder.
router.post('/publish/:id', verifyToken, async (req, res) => {
  try {
    const { data: form, error: fetchErr } = await supabase
      .from('hx_forms')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.googleId)
      .single();

    if (fetchErr || !form) return res.status(404).json({ error: 'Form not found' });

    // Validate: must have at least one field
    const fields = form.config?.fields || [];
    if (fields.length === 0) {
      return res.status(400).json({ error: 'Add at least one field before publishing.' });
    }

    const { data, error } = await supabase
      .from('hx_forms')
      .update({ status: 'published', updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', req.user.googleId)
      .select('id, name, slug, status')
      .single();

    if (error) throw error;

    const publicUrl = `${process.env.FRONTEND_URL || 'https://certiflow-frontend.vercel.app'}/hx-form-view.html?f=${data.slug}`;
    res.json({ ok: true, form: data, publicUrl });
  } catch (err) {
    console.error('[hxforms] publish error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/hxforms/close/:id ───────────────────────────────────
router.post('/close/:id', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('hx_forms')
      .update({ status: 'closed', updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', req.user.googleId)
      .select('id, status')
      .single();

    if (error) throw error;
    res.json({ ok: true, form: data });
  } catch (err) {
    console.error('[hxforms] close error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/hxforms/reopen/:id ─────────────────────────────────
router.post('/reopen/:id', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('hx_forms')
      .update({ status: 'published', updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', req.user.googleId)
      .select('id, status')
      .single();

    if (error) throw error;
    res.json({ ok: true, form: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  PUBLIC ROUTES (no auth — used by hx-form-view.html)
//  Note: These are the BACKEND fallback.
//  Primary path: hx-form-view.html reads Supabase directly via anon key.
// ================================================================

// ── GET /api/hxforms/view/:slug ───────────────────────────────────
// Returns form config for public rendering (no personal data, config only)
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
    console.error('[hxforms] view error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/hxforms/submit/:slug ───────────────────────────────
// Handles public form submission.
// Writes to organizer's Google Sheet. ZERO personal data stored in Supabase.
// Full implementation in Batch 4 (needs refresh_token + Drive API).
router.post('/submit/:slug', async (req, res) => {
  try {
    const { data: form, error } = await supabase
      .from('hx_forms')
      .select('id, user_id, status, config, sheet_id, drive_folder_id, uploads_folder_id, submission_count')
      .eq('slug', req.params.slug)
      .single();

    if (error || !form) return res.status(404).json({ error: 'Form not found' });
    if (form.status === 'closed') return res.status(403).json({ error: 'This form is closed.' });
    if (form.status !== 'published') return res.status(403).json({ error: 'Form is not accepting submissions.' });

    // ── Sheet write will be added in Batch 4 ──
    // For now: just increment the counter so the list page stays accurate
    await supabase
      .from('hx_forms')
      .update({ submission_count: (form.submission_count || 0) + 1 })
      .eq('id', form.id);

    const successMsg = form.config?.settings?.successMessage
      || 'Your response has been recorded. Thank you!';

    res.json({ ok: true, message: successMsg });
  } catch (err) {
    console.error('[hxforms] submit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;