// ============================================================
// QFwork.ai — Database
// ------------------------------------------------------------
// Everything that has to outlive a deploy lives here: which one-time trial
// codes are spent, which codes have a subscription and what it allows, every
// checkout, and the offer and promotion counters. The host's filesystem (Railway, Render) is wiped on each deploy, so none of it
// can sit in a file next to server.js any more.
//
// Two backends, one SQL dialect:
//   • DATABASE_URL set   → Postgres over the network (Neon in production).
//   • DATABASE_URL blank → PGlite, real Postgres compiled to WebAssembly and
//                          running in-process, stored under .data/. Nothing to
//                          install and no account, so development and the
//                          placeholder phase work out of the box.
// Both run the same queries, so nothing behaves differently when the
// connection string is pasted in.
//
// The one rule PGlite cannot follow is durability on a host that wipes its
// disk. server.js refuses to take payments on it in production.
// ============================================================

const fs   = require('fs');
const path = require('path');

const PGLITE_DIR = process.env.PGLITE_DIR || path.join(__dirname, '.data', 'pglite');

let backend = null;   // { kind, label, query(text, params), exec(sql), close() }

const SCHEMA = `
  -- Runs spent per one-time trial code (ACCESS_CODES_TRIAL). The issued list
  -- stays in the environment; only what each code has used is state.
  CREATE TABLE IF NOT EXISTS trial_code_runs (
    code        TEXT PRIMARY KEY,
    runs        INTEGER NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- One row per checkout. Created 'pending' when the visitor is sent to the
  -- provider, flipped to 'paid' exactly once by the webhook. The price is
  -- recorded HERE, at checkout, so a webhook can only ever confirm what the
  -- server itself asked for.
  CREATE TABLE IF NOT EXISTS checkouts (
    order_id      TEXT PRIMARY KEY,
    provider      TEXT NOT NULL,
    provider_ref  TEXT,
    plan          TEXT NOT NULL,             -- offer | regular
    amount        INTEGER NOT NULL,          -- minor units (cents), per week
    currency      TEXT NOT NULL,
    offer_id      TEXT,
    code          TEXT,                      -- set at checkout when resubscribing an existing code
    email         TEXT,
    status        TEXT NOT NULL DEFAULT 'pending',   -- pending | paid | cancelled
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at       TIMESTAMPTZ
  );

  -- One row per access code with a subscription behind it. Stored normalised
  -- (lowercase alphanumerics), the same form access.js compares against.
  -- The provider is the source of truth for status and billing period; the
  -- webhook keeps these columns in step. sessions_used counts calls in the
  -- current period and resets when the period moves on.
  CREATE TABLE IF NOT EXISTS subscriptions (
    code                  TEXT PRIMARY KEY,
    provider              TEXT NOT NULL,      -- stripe | mock | manual
    customer_id           TEXT,
    subscription_id       TEXT UNIQUE,
    email                 TEXT,
    plan                  TEXT,
    amount                INTEGER,
    currency              TEXT,
    status                TEXT NOT NULL,      -- active | trialing | past_due | canceled | ...
    period_start          TIMESTAMPTZ,
    period_end            TIMESTAMPTZ,
    cancel_at_period_end  BOOLEAN NOT NULL DEFAULT false,
    sessions_used         INTEGER NOT NULL DEFAULT 0 CHECK (sessions_used >= 0),
    sessions_per_period   INTEGER,            -- NULL → SUB_SESSIONS_PER_WEEK
    coaching              BOOLEAN NOT NULL DEFAULT false,
    note                  TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS subscriptions_email ON subscriptions (lower(email));

  -- Limited-time offers. A visitor's 24 hours start when they first see the
  -- pricing (or when an admin creates a link for them); the offer price is
  -- only given while expires_at is in the future.
  CREATE TABLE IF NOT EXISTS offers (
    offer_id    TEXT PRIMARY KEY,
    source      TEXT NOT NULL DEFAULT 'view',    -- view | link
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL
  );

  -- Limited promotions, e.g. the free coaching call for the first 30
  -- subscribers. Claimed with one conditional UPDATE, so two subscribers
  -- arriving together cannot both take the last place.
  CREATE TABLE IF NOT EXISTS promo_counters (
    name  TEXT PRIMARY KEY,
    used  INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO promo_counters (name, used) VALUES ('coaching', 0) ON CONFLICT (name) DO NOTHING;
`;


async function openPostgres(url) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 30000 });
  // Neon closes idle connections. Without a listener, that error on an idle
  // client would crash the process.
  pool.on('error', (e) => console.warn(`[db] idle connection dropped: ${e.message}`));
  await pool.query('SELECT 1');
  let host = 'postgres';
  try { host = new URL(url).hostname; } catch (e) {}
  return {
    kind:  'postgres',
    label: `Postgres (${host})`,
    query: (text, params) => pool.query(text, params),
    exec:  (sql) => pool.query(sql),
    close: () => pool.end()
  };
}

async function openPglite(dir) {
  // ESM-only package, hence the dynamic import from this CommonJS module.
  const { PGlite } = await import('@electric-sql/pglite');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const db = new PGlite(dir);
  await db.waitReady;
  return {
    kind:  'pglite',
    label: `PGlite, local (${dir.startsWith(__dirname) ? path.relative(__dirname, dir) : dir})`,
    query: async (text, params) => {
      const r = await db.query(text, params);
      return { rows: r.rows, rowCount: r.affectedRows != null ? r.affectedRows : r.rows.length };
    },
    exec:  (sql) => db.exec(sql),
    close: () => db.close()
  };
}

// Connects and creates the tables. Called once before the server listens;
// a failure here stops the boot, because every paid path depends on it.
async function init() {
  const url = (process.env.DATABASE_URL || '').trim();
  backend = url ? await openPostgres(url) : await openPglite(PGLITE_DIR);
  await backend.exec(SCHEMA);
  return backend;
}

function query(text, params) {
  if (!backend) return Promise.reject(new Error('Database not initialised'));
  return backend.query(text, params);
}

module.exports = {
  init,
  query,
  kind:  () => backend && backend.kind,
  label: () => backend ? backend.label : 'not connected',
  close: () => backend && backend.close()
};
