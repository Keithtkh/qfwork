// ============================================================
// QFwork.ai — Admin endpoints
// ------------------------------------------------------------
// For support and sales: "my code doesn't work", a goodwill extension, an
// offer link to send on WhatsApp. Every route needs
//   Authorization: Bearer <ADMIN_TOKEN>
// and the whole router answers 404 when ADMIN_TOKEN is not set, so a
// deployment without one exposes nothing.
//
//   GET  /api/admin/stats                   → subscribers, coaching places, offers
//   GET  /api/admin/subscriptions?limit=50  → recent subscriptions
//   GET  /api/admin/codes/:code             → one code, with its checkouts
//   POST /api/admin/codes  { weeks, note, email }
//                                            → issue a free code for N weeks
//   POST /api/admin/codes/:code/extend  { weeks }
//                                            → push a free code's end date out
//   POST /api/admin/offer-link              → a link whose 24-hour offer starts now
//   GET  /api/admin/checkouts?limit=50      → recent checkouts
//   GET  /api/admin/export                  → every table, as JSON
//
// e.g.  curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<host>/api/admin/stats
// ============================================================

const crypto   = require('crypto');
const express  = require('express');
const db       = require('./db');
const access   = require('./access');
const payments = require('./payments');

const router = express.Router();

function tokenOk(given) {
  const want = String(process.env.ADMIN_TOKEN || '');
  if (!want) return false;
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

router.use((req, res, next) => {
  if (!process.env.ADMIN_TOKEN) return res.status(404).end();
  if (access.tooManyAttempts('admin:' + req.ip)) return res.status(429).json({ error: 'Too many attempts.' });
  const m = /^Bearer\s+(.+)$/i.exec(req.get('Authorization') || '');
  if (!m || !tokenOk(m[1].trim())) return res.status(401).json({ error: 'Admin token required.' });
  access.clearAttempts('admin:' + req.ip);
  next();
});

function limitOf(req) {
  const n = parseInt(req.query.limit, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 50;
}

function baseUrl(req) {
  return (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

function subRow(r) {
  return {
    code:      access.displayCode(r.code),
    email:     r.email,
    provider:  r.provider,
    plan:      r.plan,
    price:     r.amount != null ? payments.formatAmount(r.amount, r.currency) : null,
    status:    r.status,
    periodEnd: r.period_end,
    cancelAtPeriodEnd: r.cancel_at_period_end,
    usedThisPeriod: Number(r.sessions_used),
    allowance: r.sessions_per_period != null ? Number(r.sessions_per_period) : access.sessionsPerWeek(),
    coaching:  r.coaching,
    note:      r.note,
    created:   r.created_at
  };
}

const wrap = (fn) => (req, res) => fn(req, res).catch(e => {
  console.error(`[admin] ${e.message}`);
  res.status(500).json({ error: e.message });
});

router.get('/stats', wrap(async (req, res) => {
  const [subs, offers] = await Promise.all([
    db.query(`SELECT status, count(*)::int AS n FROM subscriptions GROUP BY status ORDER BY status`),
    db.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE expires_at > now())::int AS live FROM offers`)
  ]);
  res.json({
    subscriptions: Object.fromEntries(subs.rows.map(r => [r.status, r.n])),
    coaching: { slots: payments.plan().coachingSlots, left: await payments.coachingLeft() },
    offers: offers.rows[0]
  });
}));

router.get('/subscriptions', wrap(async (req, res) => {
  const r = await db.query('SELECT * FROM subscriptions ORDER BY created_at DESC LIMIT $1', [limitOf(req)]);
  res.json({ subscriptions: r.rows.map(subRow) });
}));

router.get('/codes/:code', wrap(async (req, res) => {
  const code = access.normCode(req.params.code);
  const r = await db.query('SELECT * FROM subscriptions WHERE code = $1', [code]);
  if (!r.rows.length) return res.status(404).json({ error: 'No such code.' });
  const c = await db.query('SELECT order_id, plan, amount, currency, status, created_at, paid_at FROM checkouts WHERE code = $1 ORDER BY created_at', [code]);
  res.json({ ...subRow(r.rows[0]), checkouts: c.rows });
}));

// A complimentary code: active for N weeks, the normal weekly allowance for
// each of them. Not tied to any payment, so it simply stops at the end date.
router.post('/codes', wrap(async (req, res) => {
  const weeks = parseInt(req.body && req.body.weeks, 10);
  if (!(weeks > 0 && weeks <= 52)) return res.status(400).json({ error: 'weeks must be 1–52.' });
  const code = access.newPaidCode();
  const perWeek = access.sessionsPerWeek();
  const note = String((req.body && req.body.note) || 'issued by admin').slice(0, 200);
  const emailAddr = req.body && req.body.email ? String(req.body.email).trim().slice(0, 254) : null;
  await db.query(
    `INSERT INTO subscriptions (code, provider, email, plan, status, period_start, period_end, sessions_per_period, note)
     VALUES ($1, 'manual', $2, 'complimentary', 'active', now(), now() + make_interval(weeks => $3), $4, $5)`,
    [code, emailAddr, weeks, perWeek ? perWeek * weeks : 0, note]);
  console.log(`[admin] issued a free code for ${weeks} week(s) — ${note}`);
  res.json({ code: access.displayCode(code), weeks, link: `${baseUrl(req)}/exam.html?code=${access.displayCode(code)}` });
}));

router.post('/codes/:code/extend', wrap(async (req, res) => {
  const code  = access.normCode(req.params.code);
  const weeks = parseInt(req.body && req.body.weeks, 10);
  if (!(weeks > 0 && weeks <= 52)) return res.status(400).json({ error: 'weeks must be 1–52.' });
  const perWeek = access.sessionsPerWeek();
  // Only free codes: a paid subscription's dates belong to the provider and
  // would be overwritten by its next webhook.
  const r = await db.query(
    `UPDATE subscriptions SET
        period_end = GREATEST(period_end, now()) + make_interval(weeks => $2),
        sessions_per_period = CASE WHEN $3 = 0 THEN 0 ELSE COALESCE(sessions_per_period, 0) + $3 * $2 END,
        status = 'active', updated_at = now()
      WHERE code = $1 AND provider = 'manual' RETURNING *`, [code, weeks, perWeek]);
  if (!r.rows.length) return res.status(404).json({ error: 'No such free code. Paid subscriptions are managed in Stripe.' });
  res.json(subRow(r.rows[0]));
}));

// For sending on WhatsApp: the 24 hours start now, not when it is opened.
router.post('/offer-link', wrap(async (req, res) => {
  const o = await payments.createOffer('link');
  res.json({ link: `${baseUrl(req)}/exam.html?offer=${o.offer_id}#pricing`, expiresAt: o.expires_at });
}));

router.get('/checkouts', wrap(async (req, res) => {
  const r = await db.query('SELECT * FROM checkouts ORDER BY created_at DESC LIMIT $1', [limitOf(req)]);
  res.json({ checkouts: r.rows.map(o => ({ ...o, code: o.code ? access.displayCode(o.code) : null })) });
}));

router.get('/export', wrap(async (req, res) => {
  const [subs, checkouts, trial, offers, promos] = await Promise.all([
    db.query('SELECT * FROM subscriptions ORDER BY created_at'),
    db.query('SELECT * FROM checkouts ORDER BY created_at'),
    db.query('SELECT * FROM trial_code_runs ORDER BY code'),
    db.query('SELECT * FROM offers ORDER BY created_at'),
    db.query('SELECT * FROM promo_counters')
  ]);
  res.setHeader('Content-Disposition', `attachment; filename="qfwork-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({
    exportedAt: new Date().toISOString(),
    subscriptions: subs.rows, checkouts: checkouts.rows, trial_code_runs: trial.rows,
    offers: offers.rows, promo_counters: promos.rows
  });
}));

module.exports = router;
