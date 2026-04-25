// @ts-nocheck
const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const Razorpay = require('razorpay');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

/* ══════════════════════════════════════════════════════════════
   GET /api/settings/usage
   Returns aggregate usage stats for the logged-in user
══════════════════════════════════════════════════════════════ */
router.get('/usage', async (req, res) => {
  try {
    const gid = req.user.googleId;

    // User row — tokens, certs total, mails
    const { data: user, error: uErr } = await supabase
      .from('users')
      .select('certs_total, ai_tokens_input, ai_tokens_output, sent_today, total_sent')
      .eq('google_id', gid)
      .single();

    if (uErr || !user) return res.status(404).json({ error: 'User not found' });

    // Mini sites count
    const { count: sitesCount } = await supabase
      .from('mini_sites')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', gid);

    // Forms count
    const { count: formsCount } = await supabase
      .from('hx_forms')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', gid);

    res.json({
      certsTotal:    user.certs_total    || 0,
      tokensInput:   user.ai_tokens_input  || 0,
      tokensOutput:  user.ai_tokens_output || 0,
      tokensTotal:   (user.ai_tokens_input || 0) + (user.ai_tokens_output || 0),
      mailsSentToday: user.sent_today    || 0,
      mailsTotalSent: user.total_sent    || 0,
      sitesCount:    sitesCount          || 0,
      sitesLimit:    10,
      formsCount:    formsCount          || 0,
    });
  } catch (e) {
    console.error('Settings usage error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ══════════════════════════════════════════════════════════════
   GET /api/settings/plan
   Returns the user's current plan + token data
══════════════════════════════════════════════════════════════ */
router.get('/plan', async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('plan, plan_expires_at, ai_tokens_input, ai_tokens_output')
      .eq('google_id', req.user.googleId)
      .single();

    if (error || !user) return res.status(404).json({ error: 'User not found' });

    const isPro = user.plan === 'pro'
      && (!user.plan_expires_at || new Date(user.plan_expires_at) > new Date());

    res.json({
      plan:          isPro ? 'pro' : 'free',
      planExpiresAt: user.plan_expires_at || null,
      tokensInput:   user.ai_tokens_input  || 0,
      tokensOutput:  user.ai_tokens_output || 0,
      tokensTotal:   (user.ai_tokens_input || 0) + (user.ai_tokens_output || 0),
    });
  } catch (e) {
    console.error('Settings plan error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ══════════════════════════════════════════════════════════════
   GET /api/settings/transactions
   Returns payment history for the logged-in user
══════════════════════════════════════════════════════════════ */
router.get('/transactions', async (req, res) => {
  try {
    const { data: payments, error } = await supabase
      .from('payments')
      .select('razorpay_payment_id, amount, currency, plan, months, created_at')
      .eq('user_email', req.user.email)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ payments: payments || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ══════════════════════════════════════════════════════════════
   POST /api/settings/create-order
   Creates a Razorpay order for the Pro plan (₹299 / 3 months)
══════════════════════════════════════════════════════════════ */
router.post('/create-order', async (req, res) => {
  try {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      return res.status(503).json({ error: 'Payment gateway not configured' });
    }
    const razorpay = new Razorpay({
      key_id:     process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
    const order = await razorpay.orders.create({
      amount:   29900, // ₹299 in paise
      currency: 'INR',
      receipt:  `hx_${req.user.googleId}_${Date.now()}`,
      notes:    { email: req.user.email, plan: 'pro', months: '3' },
    });
    res.json({
      orderId:  order.id,
      amount:   order.amount,
      currency: order.currency,
      keyId:    process.env.RAZORPAY_KEY_ID,
    });
  } catch (e) {
    console.error('Create order error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ══════════════════════════════════════════════════════════════
   POST /api/settings/verify-payment
   Verifies Razorpay signature and upgrades plan in Supabase
══════════════════════════════════════════════════════════════ */
router.post('/verify-payment', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment fields' });
    }

    const expectedSig = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + '|' + razorpay_payment_id)
      .digest('hex');

    if (expectedSig !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment verification failed' });
    }

    // Upgrade plan: +90 days from now (or from current expiry if still active)
    const { data: userRow } = await supabase
      .from('users')
      .select('plan, plan_expires_at')
      .eq('google_id', req.user.googleId)
      .single();

    const base = (userRow?.plan === 'pro' && userRow?.plan_expires_at && new Date(userRow.plan_expires_at) > new Date())
      ? new Date(userRow.plan_expires_at)
      : new Date();
    base.setDate(base.getDate() + 90);

    await supabase
      .from('users')
      .update({ plan: 'pro', plan_expires_at: base.toISOString() })
      .eq('google_id', req.user.googleId);

    // Record transaction
    await supabase.from('payments').insert({
      user_email:         req.user.email,
      razorpay_order_id,
      razorpay_payment_id,
      amount:             29900,
      currency:           'INR',
      plan:               'pro',
      months:             3,
    });

    res.json({ ok: true, planExpiresAt: base.toISOString() });
  } catch (e) {
    console.error('Verify payment error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ══════════════════════════════════════════════════════════════
   GET /api/settings/permissions
   Returns granted_scopes stored for the user
══════════════════════════════════════════════════════════════ */
router.get('/permissions', async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('granted_scopes')
      .eq('google_id', req.user.googleId)
      .single();

    if (error || !user) return res.status(404).json({ error: 'User not found' });

    const granted = (user.granted_scopes || '').split(' ').filter(Boolean);
    res.json({ grantedScopes: granted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
