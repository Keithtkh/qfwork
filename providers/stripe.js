// ============================================================
// QFwork.ai — Stripe provider (PAYMENT_PROVIDER=stripe)
// ------------------------------------------------------------
// Stripe Checkout in subscription mode: Stripe hosts the payment page
// (cards, Apple Pay, Google Pay), creates the customer and the weekly
// subscription, and renews it. We only ever see webhooks.
//
//   PAYMENT_API_KEY         sk_test_… (local, staging) or sk_live_… (live)
//   PAYMENT_WEBHOOK_SECRET  whsec_… — from `stripe listen` locally, or from
//                           Dashboard → Developers → Webhooks for the live
//                           endpoint https://<host>/api/payments/webhook
//
// Nothing has to be set up by hand in the Stripe Dashboard. The product and
// its two weekly prices (offer, regular) are created on first use, found
// again by lookup key, and replaced automatically when SUB_OFFER_PRICE or
// SUB_REGULAR_PRICE changes. Existing subscribers keep the price they
// signed up at.
//
// Webhook events to send (Dashboard → Webhooks → endpoint → events):
//   checkout.session.completed, checkout.session.async_payment_succeeded,
//   checkout.session.expired, customer.subscription.updated,
//   customer.subscription.deleted, invoice.paid, invoice.payment_failed
// ============================================================

const Stripe = require('stripe');

const PRODUCT_ID = 'qfwork_weekly';

let client = null;
let clientKey = null;
function stripe() {
  const key = process.env.PAYMENT_API_KEY;
  if (!client || clientKey !== key) {
    client = new Stripe(key);
    clientKey = key;
  }
  return client;
}

// ── product & prices ────────────────────────────────────────
async function ensureProduct() {
  try {
    return (await stripe().products.retrieve(PRODUCT_ID)).id;
  } catch (e) {
    if (e.statusCode !== 404) throw e;
    const p = await stripe().products.create({
      id: PRODUCT_ID,
      name: 'QFwork.ai weekly practice',
      description: 'Live AI practice conversations with a full feedback report.'
    });
    return p.id;
  }
}

const priceCache = new Map();   // lookup key → { id, amount, currency }

async function ensurePrice({ plan, amount, currency, interval }) {
  const key = `qfwork_${interval}_${plan}`;
  const cur = currency.toLowerCase();
  const hit = priceCache.get(key);
  if (hit && hit.amount === amount && hit.currency === cur) return hit.id;

  const found = (await stripe().prices.list({ lookup_keys: [key], active: true, limit: 1 })).data[0];
  let price = found;
  if (!found || found.unit_amount !== amount || found.currency !== cur || !found.recurring || found.recurring.interval !== interval) {
    // New or changed price. transfer_lookup_key moves the key off the old
    // price, which stays attached to the subscriptions already using it.
    price = await stripe().prices.create({
      product: await ensureProduct(),
      unit_amount: amount,
      currency: cur,
      recurring: { interval },
      lookup_key: key,
      transfer_lookup_key: true,
      nickname: plan === 'offer' ? 'Launch offer' : 'Regular'
    });
    console.log(`[stripe] created ${plan} price ${(amount / 100)} ${currency}/${interval}`);
  }
  priceCache.set(key, { id: price.id, amount, currency: cur });
  return price.id;
}

// ── checkout ────────────────────────────────────────────────
async function createCheckout({ order, returnUrl, cancelUrl, expiresAt, customerId }) {
  const price = await ensurePrice(order);
  const params = {
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    client_reference_id: order.id,
    metadata: { order_id: order.id },
    subscription_data: { metadata: { order_id: order.id } },
    success_url: returnUrl,
    cancel_url: cancelUrl
  };
  // A returning subscriber is billed on their existing Stripe customer, so
  // their card and invoices stay in one place.
  if (customerId) params.customer = customerId;

  // Stripe allows a checkout to expire between 30 minutes and 24 hours from
  // now. An offer ending sooner than that still gets the 30-minute minimum.
  if (expiresAt) {
    const now = Math.floor(Date.now() / 1000);
    const want = Math.floor(new Date(expiresAt).getTime() / 1000);
    params.expires_at = Math.min(Math.max(want, now + 31 * 60), now + 23 * 3600 + 3000);
  }

  const s = await stripe().checkout.sessions.create(params);
  return { url: s.url, providerRef: s.id };
}

// ── normalising Stripe objects ──────────────────────────────
function toDate(sec) {
  return sec ? new Date(sec * 1000) : null;
}

// Since API version 2025-03-31 the billing period lives on the subscription
// item rather than the subscription; read either.
function subState(sub) {
  const item = sub.items && sub.items.data && sub.items.data[0];
  return {
    status:            sub.status,
    periodStart:       toDate(sub.current_period_start || (item && item.current_period_start)),
    periodEnd:         toDate(sub.current_period_end   || (item && item.current_period_end)),
    cancelAtPeriodEnd: !!(sub.cancel_at_period_end || sub.cancel_at)
  };
}

function idOf(x) {
  return x && typeof x === 'object' ? x.id : x;
}

async function completedFromSession(s) {
  if (s.mode !== 'subscription' || !s.subscription) return null;
  if (s.payment_status !== 'paid' && s.payment_status !== 'no_payment_required') return null;
  const sub = await stripe().subscriptions.retrieve(idOf(s.subscription));
  return {
    type:           'checkout.completed',
    orderId:        s.client_reference_id || (s.metadata && s.metadata.order_id),
    amount:         s.amount_total,
    currency:       String(s.currency || '').toUpperCase(),
    email:          (s.customer_details && s.customer_details.email) || s.customer_email || null,
    customerId:     idOf(s.customer),
    subscriptionId: sub.id,
    sub:            subState(sub)
  };
}

async function subscriptionEvent(subscriptionId) {
  if (!subscriptionId) return null;
  const sub = await stripe().subscriptions.retrieve(subscriptionId);
  return { type: 'subscription.updated', subscriptionId: sub.id, sub: subState(sub) };
}

// ── webhooks ────────────────────────────────────────────────
async function parseWebhook(rawBody, headers) {
  let evt;
  try {
    evt = stripe().webhooks.constructEvent(rawBody, headers['stripe-signature'], process.env.PAYMENT_WEBHOOK_SECRET || '');
  } catch (e) {
    throw new Error(`bad signature: ${e.message}`);
  }
  const o = evt.data.object;
  switch (evt.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return completedFromSession(o);
    case 'checkout.session.expired':
      return { type: 'checkout.cancelled', orderId: o.client_reference_id };
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return { type: 'subscription.updated', subscriptionId: o.id, sub: subState(o) };
    case 'invoice.paid':
    case 'invoice.payment_failed':
      // Re-read the subscription: the invoice alone does not say what the
      // subscription's status and period now are.
      return subscriptionEvent(idOf(o.subscription) ||
        (o.parent && o.parent.subscription_details && idOf(o.parent.subscription_details.subscription)));
    default:
      return null;
  }
}

// The fallback when the return page is polling and no webhook has arrived.
async function checkoutResult(checkout) {
  const s = await stripe().checkout.sessions.retrieve(checkout.provider_ref);
  if (s.status === 'complete') return completedFromSession(s);
  if (s.status === 'expired') return { type: 'checkout.cancelled', orderId: checkout.order_id };
  return null;
}

// Stripe's hosted page where a subscriber updates their card or cancels.
// Needs the Customer Portal activated (Dashboard → Settings → Billing).
async function portalUrl({ customerId, returnUrl }) {
  const s = await stripe().billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
  return s.url;
}

function configProblems({ production }) {
  const key = process.env.PAYMENT_API_KEY || '';
  const problems = [];
  if (!/^(sk|rk)_(test|live)_/.test(key)) problems.push('PAYMENT_API_KEY must be a Stripe secret key (sk_test_… or sk_live_…).');
  if (production && !process.env.PAYMENT_WEBHOOK_SECRET) {
    problems.push('PAYMENT_WEBHOOK_SECRET is required in production — copy the signing secret of the /api/payments/webhook endpoint from the Stripe Dashboard.');
  }
  if (!production && key.startsWith('sk_live_')) {
    console.warn('[stripe] WARNING: a LIVE key is set outside production — real cards will be charged.');
  }
  if (!process.env.PAYMENT_WEBHOOK_SECRET) {
    console.warn('[stripe] PAYMENT_WEBHOOK_SECRET not set — webhooks will be rejected. Payments still complete via the return page; renewals and cancellations need `stripe listen`.');
  }
  return problems;
}

module.exports = { name: 'stripe', createCheckout, parseWebhook, checkoutResult, portalUrl, configProblems };
