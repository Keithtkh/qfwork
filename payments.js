// ============================================================
// QFwork.ai — Payments (weekly subscription)
// ------------------------------------------------------------
// There are no user accounts. Subscribing mints an ACCESS CODE that works
// while the subscription is active, with a weekly allowance of sessions
// (access.js). The code is shown on the return page and emailed.
//
//   1. POST /api/checkout       → a checkout is recorded here as 'pending',
//                                 at the price the SERVER chose (launch offer
//                                 or regular), and the visitor is sent to
//                                 the provider's page.
//   2. provider → webhook       → signature checked by the provider adapter;
//                                 the checkout flips to 'paid' and the
//                                 subscription row is written in one SQL
//                                 statement. A retried webhook finds nothing
//                                 pending and does nothing.
//      Later webhooks (renewal, failed payment, cancellation) keep the
//      subscription's status and billing period in step.
//   3. checkout-return.html     → polls GET /api/checkout/status, shows the
//                                 code and signs the browser in.
//
// LIMITED-TIME OFFER. SUB_OFFER_PRICE is available for OFFER_HOURS (24) from
// when the visitor first sees the pricing, or from when an admin creates an
// offer link (POST /api/admin/offer-link) to send on WhatsApp. After that,
// SUB_REGULAR_PRICE. A subscriber keeps the price they signed up at.
//
// FIRST N SUBSCRIBERS (COACHING_SLOTS, 30) get a free coaching call; the
// booking link (COACHING_URL) is in their email and on the return page.
//
// The provider is a plug-in under providers/, chosen by PAYMENT_PROVIDER:
//   stripe → the real thing (providers/stripe.js)
//   mock   → a fake checkout page with Pay / Cancel, for building and demos
//
// A provider module exports:
//   name
//   createCheckout({ order, returnUrl, cancelUrl, expiresAt, customerId })
//                                     → { url, providerRef }
//   parseWebhook(rawBody, headers)    → async; a normalised event (below) or
//                                       null to ignore. THROWS on a bad signature.
//   checkoutResult(checkoutRow)       → async; the 'checkout.completed' event if
//                                       the provider says it is paid (the
//                                       fallback for a late webhook), else null
//   portalUrl({ customerId, returnUrl }) → async; the provider's "manage
//                                       subscription" page, or null
//   routes(app, ctx)                  → optional extra routes (the mock's page)
//   configProblems({ production })    → optional; [string] reasons it cannot run
//
// Normalised events:
//   { type:'checkout.completed', orderId, amount, currency, email,
//     customerId, subscriptionId, sub }
//   { type:'checkout.cancelled', orderId }
//   { type:'subscription.updated', subscriptionId, sub }
// where sub = { status, periodStart: Date, periodEnd: Date, cancelAtPeriodEnd }
// ============================================================

const crypto = require('crypto');
const db     = require('./db');
const access = require('./access');
const email  = require('./email');

const PROVIDERS = {
  mock:   () => require('./providers/mock'),
  stripe: () => require('./providers/stripe')
};


// ── configuration ───────────────────────────────────────────
function providerName() {
  return String(process.env.PAYMENT_PROVIDER || '').trim().toLowerCase();
}

function enabled() {
  return !!providerName();
}

let cached = null;
function provider() {
  const name = providerName();
  if (!cached || cached.name !== name) {
    const load = PROVIDERS[name];
    if (!load) throw new Error(`Unknown PAYMENT_PROVIDER "${name}". Known: ${Object.keys(PROVIDERS).join(', ')}`);
    cached = load();
  }
  return cached;
}

function money(envName, fallback) {
  const n = Number(process.env[envName]);
  return Math.round((Number.isFinite(n) && n > 0 ? n : fallback) * 100);
}

function intEnv(envName, fallback) {
  const n = parseInt(process.env[envName], 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// The plan, read from the environment on every call so a change to .env (or
// the host's variables) needs a restart but no code change.
//   SUB_OFFER_PRICE    launch-offer weekly price   (placeholder 38)
//   SUB_REGULAR_PRICE  weekly price after the offer (placeholder 58)
//   SUB_CURRENCY       HKD
//   OFFER_HOURS        how long the offer lasts    (24)
//   OFFER_START        view → starts when pricing is first seen; link → only
//                      admin-made links carry the offer
//   COACHING_SLOTS     subscribers who get the coaching bonus (30)
//   COACHING_URL       booking link for it (falls back to CALENDLY_URL)
function plan() {
  return {
    currency:     String(process.env.SUB_CURRENCY || 'HKD').trim().toUpperCase(),
    offerPrice:   money('SUB_OFFER_PRICE', 38),
    regularPrice: money('SUB_REGULAR_PRICE', 58),
    interval:     'week',
    offerHours:   intEnv('OFFER_HOURS', 24) || 24,
    offerStart:   String(process.env.OFFER_START || 'view').trim().toLowerCase() === 'link' ? 'link' : 'view',
    coachingSlots: intEnv('COACHING_SLOTS', 30),
    coachingUrl:  process.env.COACHING_URL || process.env.CALENDLY_URL || ''
  };
}

function isProduction() {
  // Railway and Render set these on every deployed service; NODE_ENV covers
  // any other host.
  return process.env.NODE_ENV === 'production' ||
         !!process.env.RAILWAY_ENVIRONMENT_NAME || !!process.env.RAILWAY_ENVIRONMENT ||
         !!process.env.RENDER;
}

// Reasons payments must not run, checked once at boot. Each one is fatal:
// a misconfigured payment path either loses customers' money or gives
// sessions away.
function configProblems() {
  if (!enabled()) return [];
  const problems = [];
  let p;
  try { p = provider(); } catch (e) { return [e.message]; }
  const production = isProduction();
  if (production && db.kind() !== 'postgres') {
    problems.push('payments need a durable database in production — set DATABASE_URL (Neon). The local PGlite store is wiped on every deploy.');
  }
  if (typeof p.configProblems === 'function') problems.push(...p.configProblems({ production }));
  return problems;
}


// ── limited-time offer ──────────────────────────────────────
const OFFER_RE = /^off_[0-9a-f]{24}$/;

async function getOffer(offerId) {
  if (!OFFER_RE.test(String(offerId || ''))) return null;
  const r = await db.query('SELECT *, expires_at > now() AS live FROM offers WHERE offer_id = $1', [offerId]);
  return r.rows[0] || null;
}

async function createOffer(source) {
  const id = 'off_' + crypto.randomBytes(12).toString('hex');
  const r = await db.query(
    `INSERT INTO offers (offer_id, source, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))
     RETURNING *, true AS live`, [id, source, plan().offerHours]);
  return r.rows[0];
}

// Called when a visitor sees the pricing. Returns their existing offer (from
// a link or an earlier visit) or, if offers start on view, a fresh one.
async function startOffer(offerId) {
  const existing = await getOffer(offerId);
  if (existing) return existing;
  if (plan().offerStart !== 'view') return null;
  return createOffer('view');
}

function offerSummary(o) {
  return o ? { id: o.offer_id, expiresAt: o.expires_at, active: !!o.live } : null;
}


// ── checkout ────────────────────────────────────────────────
function httpError(status, message, code) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

// `session` is the caller's access session, if any. A subscriber whose plan
// has lapsed resubscribes on the SAME code; an active subscriber is sent to
// manage their plan instead of paying twice.
async function createCheckout({ offerId, baseUrl, session }) {
  const cfg = plan();
  let code = null, customerId = null;
  if (session && session.tier === 'paid') {
    const sub = await access.subscription(session.code);
    if (sub && sub.live) throw httpError(409, 'You already have an active subscription.', 'already-subscribed');
    code = session.code;
    customerId = sub ? sub.customer_id : null;
  }

  const offer = await getOffer(offerId);
  const onOffer = !!(offer && offer.live);
  const amount = onOffer ? cfg.offerPrice : cfg.regularPrice;
  const kind   = onOffer ? 'offer' : 'regular';
  const orderId = 'ord_' + crypto.randomBytes(12).toString('hex');
  const p = provider();

  await db.query(
    `INSERT INTO checkouts (order_id, provider, plan, amount, currency, offer_id, code)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [orderId, p.name, kind, amount, cfg.currency, onOffer ? offer.offer_id : null, code]);

  const back = `${baseUrl}/checkout-return.html?order=${orderId}`;
  const { url, providerRef } = await p.createCheckout({
    order: { id: orderId, plan: kind, amount, currency: cfg.currency, interval: cfg.interval },
    returnUrl: back,
    cancelUrl: back + '&cancelled=1',
    // The offer price must not outlive the offer, even on an open checkout page.
    expiresAt: onOffer ? new Date(offer.expires_at) : null,
    customerId
  });
  if (providerRef) await db.query('UPDATE checkouts SET provider_ref = $2 WHERE order_id = $1', [orderId, providerRef]);
  console.log(`[payments] checkout ${orderId} — ${kind} ${formatAmount(amount, cfg.currency)}/week${code ? ' (resubscribe)' : ''}`);
  return { url, orderId };
}


// ── fulfilment ──────────────────────────────────────────────
// Flip the checkout to 'paid' and write the subscription, as ONE statement.
// The UPDATE only matches a pending checkout, so a duplicate or retried
// webhook falls through it and nothing is written. A resubscribe carries its
// code already, so the INSERT collides and refreshes that row.
// `inserted` (xmax = 0) is true only for a brand-new code.
const FULFIL_SQL = `
  WITH paid AS (
    UPDATE checkouts SET status = 'paid', paid_at = now(), code = COALESCE(code, $2), email = $3
     WHERE order_id = $1 AND status = 'pending'
     RETURNING code, provider, plan, amount, currency
  )
  INSERT INTO subscriptions (code, provider, customer_id, subscription_id, email, plan, amount, currency,
                             status, period_start, period_end, cancel_at_period_end)
  SELECT code, provider, $4, $5, $3, plan, amount, currency, $6, $7, $8, $9 FROM paid
  ON CONFLICT (code) DO UPDATE SET
    provider = EXCLUDED.provider, customer_id = EXCLUDED.customer_id,
    subscription_id = EXCLUDED.subscription_id, email = COALESCE(EXCLUDED.email, subscriptions.email),
    plan = EXCLUDED.plan, amount = EXCLUDED.amount, currency = EXCLUDED.currency,
    status = EXCLUDED.status, period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end,
    cancel_at_period_end = EXCLUDED.cancel_at_period_end, sessions_used = 0, seconds_used = 0, updated_at = now()
  RETURNING code, (xmax = 0) AS inserted`;

async function getCheckout(orderId) {
  if (!/^ord_[0-9a-f]{24}$/.test(String(orderId || ''))) return null;
  const r = await db.query('SELECT * FROM checkouts WHERE order_id = $1', [orderId]);
  return r.rows[0] || null;
}

// The free coaching call for the first COACHING_SLOTS subscribers. One
// conditional UPDATE, so the last place cannot be taken twice.
async function claimCoaching(code) {
  const slots = plan().coachingSlots;
  if (!slots) return false;
  const r = await db.query(
    `UPDATE promo_counters SET used = used + 1 WHERE name = 'coaching' AND used < $1 RETURNING used`, [slots]);
  if (!r.rows.length) return false;
  await db.query('UPDATE subscriptions SET coaching = true WHERE code = $1', [code]);
  console.log(`[payments] coaching slot ${r.rows[0].used}/${slots} claimed`);
  return true;
}

async function coachingLeft() {
  const slots = plan().coachingSlots;
  if (!slots) return 0;
  const r = await db.query(`SELECT used FROM promo_counters WHERE name = 'coaching'`);
  return Math.max(0, slots - (r.rows.length ? Number(r.rows[0].used) : 0));
}

async function fulfil(evt, baseUrl) {
  const checkout = await getCheckout(evt.orderId);
  if (!checkout) {
    console.warn(`[payments] payment for unknown checkout ${evt.orderId} — ignored`);
    return false;
  }
  // The provider confirms what was CHARGED; it must match what we asked for.
  // Anything else is a misconfiguration or tampering, and needs a human.
  if (Number(evt.amount) !== Number(checkout.amount) || String(evt.currency || '').toUpperCase() !== checkout.currency) {
    console.error(`[payments] AMOUNT MISMATCH on ${evt.orderId}: expected ${formatAmount(checkout.amount, checkout.currency)}, provider reported ${evt.amount} ${evt.currency} — not fulfilled`);
    return false;
  }
  const sub = evt.sub || {};
  const r = await db.query(FULFIL_SQL, [
    evt.orderId, access.newPaidCode(), evt.email || null, evt.customerId || null, evt.subscriptionId || null,
    sub.status || 'active', sub.periodStart || null, sub.periodEnd || null, !!sub.cancelAtPeriodEnd
  ]);
  if (!r.rows.length) return true;            // already fulfilled — a retry

  const { code, inserted } = r.rows[0];
  const coaching = inserted ? await claimCoaching(code) : false;
  console.log(`[payments] checkout ${evt.orderId} paid — ${inserted ? 'new subscription' : 'resubscribed'} (${checkout.plan})`);

  // The email must never fail the webhook: the payment is already recorded.
  if (evt.email) {
    const base = (baseUrl || process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
    const display = access.displayCode(code);
    email.welcome({
      to:          evt.email,
      code:        display,
      startUrl:    `${base}/exam.html?code=${encodeURIComponent(display)}`,
      manageUrl:   `${base}/api/billing/manage?code=${encodeURIComponent(display)}`,
      minutes:     access.minutesPerWeek(),
      coachingUrl: coaching ? plan().coachingUrl : ''
    }).catch(e => console.error(`[email] ${e.message}`));
  }
  return true;
}

async function cancelCheckout(orderId) {
  await db.query(`UPDATE checkouts SET status = 'cancelled' WHERE order_id = $1 AND status = 'pending'`, [orderId]);
}

// Renewals, failed payments and cancellations. The billing period moving on
// resets the week's practice minutes and session count.
async function syncSubscription(subscriptionId, sub) {
  const r = await db.query(
    `UPDATE subscriptions SET
        status = $2,
        sessions_used = CASE WHEN period_start IS DISTINCT FROM $3 THEN 0 ELSE sessions_used END,
        seconds_used  = CASE WHEN period_start IS DISTINCT FROM $3 THEN 0 ELSE seconds_used END,
        period_start = $3, period_end = $4, cancel_at_period_end = $5, updated_at = now()
      WHERE subscription_id = $1
      RETURNING code`,
    [subscriptionId, sub.status, sub.periodStart, sub.periodEnd, !!sub.cancelAtPeriodEnd]);
  if (r.rows.length) console.log(`[payments] subscription updated — ${sub.status}${sub.cancelAtPeriodEnd ? ', cancels at period end' : ''}`);
}

// Called by POST /api/payments/webhook with the UNPARSED body, which the
// signature is computed over. Throws when the signature does not verify.
async function handleWebhook(rawBody, headers) {
  const evt = await provider().parseWebhook(rawBody, headers);
  if (!evt) return { handled: false };
  if (evt.type === 'checkout.completed') await fulfil(evt);
  else if (evt.type === 'checkout.cancelled') await cancelCheckout(evt.orderId);
  else if (evt.type === 'subscription.updated') await syncSubscription(evt.subscriptionId, evt.sub);
  return { handled: true };
}

// What the return page polls. The order id is 96 random bits that only the
// payer's browser was given, so it is safe to hand the code back to whoever
// presents it.
async function status(orderId, baseUrl) {
  let checkout = await getCheckout(orderId);
  if (!checkout) return null;

  // Webhooks can lag (or, in local testing, not be forwarded at all). Ask
  // the provider directly.
  const p = provider();
  if (checkout.status === 'pending' && typeof p.checkoutResult === 'function' && checkout.provider_ref) {
    try {
      const evt = await p.checkoutResult(checkout);
      if (evt && evt.type === 'checkout.completed') await fulfil(evt, baseUrl);
      else if (evt && evt.type === 'checkout.cancelled') await cancelCheckout(orderId);
      checkout = await getCheckout(orderId);
    } catch (e) {
      console.warn(`[payments] status check for ${orderId} failed: ${e.message}`);
    }
  }

  const out = { status: checkout.status, plan: checkout.plan, resubscribe: false };
  if (checkout.status === 'paid' && checkout.code) {
    const sub = await access.subscription(checkout.code);
    out.code     = access.displayCode(checkout.code);
    out.email    = checkout.email || (sub && sub.email) || '';
    out.emailed  = email.enabled() && !!out.email;
    out.sub      = access.subSummary(sub);
    out.coachingUrl = sub && sub.coaching ? plan().coachingUrl : '';
  }
  return out;
}

// The provider's own "manage / cancel subscription" page for this code.
async function manageUrl(code, returnUrl) {
  const sub = await access.subscription(code);
  if (!sub || !sub.customer_id) return null;
  const p = provider();
  if (typeof p.portalUrl !== 'function') return null;
  return p.portalUrl({ customerId: sub.customer_id, returnUrl });
}

// "Lost your code?" Emails every code on this address. The caller always
// answers the same way, so it cannot be used to find out who subscribed.
async function recoverCodes(address, baseUrl) {
  const to = String(address || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || to.length > 254) return false;
  const r = await db.query(
    `SELECT code, status, period_end FROM subscriptions WHERE lower(email) = $1 ORDER BY created_at DESC LIMIT 5`, [to]);
  if (!r.rows.length) {
    console.log('[payments] code recovery requested for an address with no subscription');
    return false;
  }
  const codes = r.rows.map(row => ({
    code:  access.displayCode(row.code),
    state: ['active', 'trialing'].includes(row.status) ? 'Active subscription' : 'Subscription ended'
  }));
  await email.recovery({ to, codes, startUrl: `${baseUrl}/exam.html` });
  return true;
}


// ── helpers ─────────────────────────────────────────────────
function formatAmount(minor, currency) {
  return `${currency} ${(Number(minor) / 100).toFixed(Number(minor) % 100 ? 2 : 0)}`;
}

// For the pricing section.
async function publicPlan() {
  if (!enabled()) return { enabled: false };
  const cfg = plan();
  return {
    enabled:         true,
    testMode:        providerName() === 'mock' || String(process.env.PAYMENT_API_KEY || '').startsWith('sk_test'),
    currency:        cfg.currency,
    offerPrice:      cfg.offerPrice,
    regularPrice:    cfg.regularPrice,
    interval:        cfg.interval,
    offerHours:      cfg.offerHours,
    minutesPerWeek:  access.minutesPerWeek(),
    sessionsPerWeek: access.sessionsPerWeek(),
    callSeconds:     access.callSeconds('paid'),
    coachingSlots:   cfg.coachingSlots,
    coachingLeft:    await coachingLeft()
  };
}

// Lets a provider add its own routes (the mock's fake checkout page).
function mountProviderRoutes(app) {
  if (!enabled()) return;
  const p = provider();
  if (typeof p.routes === 'function') p.routes(app, { getCheckout, formatAmount });
}

module.exports = {
  enabled,
  providerName,
  plan,
  publicPlan,
  configProblems,
  startOffer,
  createOffer,
  offerSummary,
  createCheckout,
  handleWebhook,
  status,
  manageUrl,
  recoverCodes,
  coachingLeft,
  getCheckout,
  formatAmount,
  mountProviderRoutes,
  isProduction
};
