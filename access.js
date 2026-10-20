// ============================================================
// QFwork.ai — Access control
// ------------------------------------------------------------
// The product is a paid demo: every live call spends Tavus minutes and
// Groq tokens, so the trial is gated behind a shared access code.
//
// Three tiers:
//   demo   → our own demos. Full report, no run cap. One shared, reusable code.
//   sales  → prospects. One run, and the deep sections of the report are
//            withheld so a recruitment expert can walk them through it
//            on the follow-up call.
//   paid   → subscribers. A code minted by a payment (see payments.js) that
//            works while its subscription is active, with a weekly allowance
//            of sessions. Full report.
//
// The sales tier is reached two ways:
//   • ACCESS_CODES_TRIAL — a list of ONE-TIME codes (QFWORK-TRIAL-a308b5).
//     The run counter lives on the code, not the session, so a reload, a
//     private tab or a second device all present the same spent code and
//     are refused. This is the intended path.
//   • ACCESS_CODE_SALES  — the older shared code. Still honoured so nothing
//     breaks mid-flight, but its cap is per session and therefore only
//     costs a reload to reset. Prefer the one-time list.
//
// The code check is a plain string compare. The real control is that the
// three token-spending endpoints require a session token issued here, so
// the codes never reach the browser and a bypassed front-end gate buys
// nothing.
// ============================================================

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const db     = require('./db');

const SESSION_TTL_MS   = 4 * 60 * 60 * 1000;   // a trial session is good for an afternoon
const UNLIMITED        = Infinity;

// token → { tier, code, runs, at }
// In memory on purpose: a restart resets it, which costs nothing now that a
// one-time code's run counter is persisted separately — a fresh session on a
// spent code is still refused. `runs` here only caps the shared env codes.
const sessions = new Map();

// ip → { count, windowStart } — blunt brute-force guard on the code check.
const attempts = new Map();
const ATTEMPT_WINDOW_MS = 60 * 1000;
const ATTEMPT_MAX       = 8;


// ── configuration ───────────────────────────────────────────
function norm(s) {
  return String(s || '').trim().toLowerCase();
}

// One-time codes get typed off an email, often on a phone, so the match is
// deliberately forgiving: case, spaces and dashes are stripped before
// comparing. 'QFWORK-TRIAL-A308B5', 'qfwork trial a308b5' and the canonical
// form are all the same code.
function normCode(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// How long ONE call may run, in seconds. This is a separate cap from the
// number of runs: the demo tier is uncapped on runs but was, until now, still
// cut off at the shared 5-minute TAVUS_MAX_CALL_SECONDS like a prospect.
// TAVUS_MAX_CALL_SECONDS_DEMO overrides it for our own demos; blank falls back
// to the shared value so nothing changes for the sales tier.
// TAVUS_MAX_CALL_SECONDS_PAID does the same for paying customers, whose
// session is a product rather than a taste of one.
function callSeconds(tier) {
  const shared = parseInt(process.env.TAVUS_MAX_CALL_SECONDS || '300', 10);
  const base   = Number.isFinite(shared) && shared > 0 ? shared : 300;
  const own = tier === 'demo' ? process.env.TAVUS_MAX_CALL_SECONDS_DEMO
            : tier === 'paid' ? process.env.TAVUS_MAX_CALL_SECONDS_PAID
            : null;
  const n = parseInt(own, 10);
  return Number.isFinite(n) && n > 0 ? n : base;
}

// Number of runs a tier gets. Blank or 0 in the environment means unlimited.
// Not used for the paid tier, whose cap is the weekly allowance below.
function runCap(tier) {
  const raw = tier === 'demo' ? process.env.TRIAL_RUNS_DEMO : process.env.TRIAL_RUNS_SALES;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return tier === 'demo' ? UNLIMITED : 1;
  return n;
}

function configuredCodes() {
  return {
    demo:  norm(process.env.ACCESS_CODE_DEMO),
    sales: norm(process.env.ACCESS_CODE_SALES)
  };
}

// True when at least one code is set. With none set the gate would lock
// everybody out, so the server refuses to run that way (see server.js).
function isConfigured() {
  const c = configuredCodes();
  return !!(c.demo || c.sales || trialCodes().size);
}


// ── one-time trial codes ────────────────────────────────────
// The issued list is configuration; what each code has SPENT is state, and
// state is the part that has to outlive a restart. So only the run counts are
// stored, in the trial_code_runs table — the list itself stays in the
// environment.
//
// Issue a batch with:
//   node -e "for(let i=0;i<25;i++)console.log('QFWORK-TRIAL-'+require('crypto').randomBytes(3).toString('hex'))"
// and paste them into ACCESS_CODES_TRIAL, comma separated.

// Parsed from the environment and memoised on the raw string, so editing the
// variable takes effect without a code change but a request does not re-split
// the whole list.
let trialSrc = null;
let trialSet = new Set();
function trialCodes() {
  const src = String(process.env.ACCESS_CODES_TRIAL || '');
  if (src !== trialSrc) {
    trialSrc = src;
    trialSet = new Set(src.split(/[\s,;]+/).map(normCode).filter(Boolean));
  }
  return trialSet;
}

async function trialRunsUsed(code) {
  const r = await db.query('SELECT runs FROM trial_code_runs WHERE code = $1', [code]);
  return r.rows.length ? Number(r.rows[0].runs) : 0;
}

// For the boot banner, so the state of the trial is visible at a glance.
async function trialStats() {
  const codes = trialCodes();
  const cap = runCap('sales');
  let used = 0;
  if (codes.size && cap !== UNLIMITED) {
    const r = await db.query('SELECT code FROM trial_code_runs WHERE runs >= $1', [cap]);
    for (const row of r.rows) if (codes.has(row.code)) used++;
  }
  return { total: codes.size, used };
}

// ── one-time trial codes issued-email list ────────────────────────────────────
// The issued-email list is state, so it is written to disk 
// — the list itself stays in the environment.
//
// Issue a batch with:
//   node -e "for(let i=0;i<25;i++)console.log('QFWORK-TRIAL-'+require('crypto').randomBytes(3).toString('hex'))"
// and paste them into ACCESS_CODES_TRIAL, comma separated.
//
// Get a code from issued list (different from issued-email list)
// Assign a code for a given email.
// Same email → same code. 
// New email → next unused code.

let issuedTo = new Map();

const ISSUED_FILE = process.env.TRIAL_CODES_ISSUED_STATE || path.join(__dirname, 'trial-codes-issued.json');
function loadIssued() {
  try {
    const obj = JSON.parse(fs.readFileSync(ISSUED_FILE, 'utf8'));
    issuedTo = new Map(Object.entries(obj));
  } catch (e) {
    issuedTo = new Map();
  }
}

function saveIssued() {
  try {
    const tmp = ISSUED_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(issuedTo), null, 2));
    fs.renameSync(tmp, ISSUED_FILE);
  } catch (e) {
    if (!saveIssued.warned) {
      saveIssued.warned = true;
      console.warn(`[access] cannot write ${ISSUED_FILE} (${e.code || e.message}) — issued-code map will reset on restart`);
    }
  }
}
loadIssued();

function issueCode(email) {
  if (!email) return null;

  // Already issued to this email? Return the same code.
  if (issuedTo.has(email)) return issuedTo.get(email);

  // Find a code not yet issued to anyone.
  const codes = trialCodes();
  for (const c of codes) {
    const alreadyIssued = Array.from(issuedTo.values()).includes(c);
    if (!alreadyIssued) {
      issuedTo.set(email, c);
      saveIssued();      // writes trial-codes-issued.json
      return c;
    }
  }
  return null;
}

// The run counts used to live in a JSON file (TRIAL_CODES_STATE, default
// trial-codes-used.json). Copy them across once, the first time the table is
// empty, so a code that was spent before the move stays spent after it.
const LEGACY_STATE_FILE = process.env.TRIAL_CODES_STATE || path.join(__dirname, 'trial-codes-used.json');

async function importLegacyState() {
  let obj;
  try { obj = JSON.parse(fs.readFileSync(LEGACY_STATE_FILE, 'utf8')); } catch (e) { return 0; }
  const r = await db.query('SELECT 1 FROM trial_code_runs LIMIT 1');
  if (r.rows.length) return 0;
  let n = 0;
  for (const [code, runs] of Object.entries(obj || {})) {
    const k = normCode(code);
    const v = Number(runs) || 0;
    if (!k || v <= 0) continue;
    await db.query('INSERT INTO trial_code_runs (code, runs) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING', [k, v]);
    n++;
  }
  if (n) console.log(`[access] imported ${n} spent trial code(s) from ${path.basename(LEGACY_STATE_FILE)}`);
  return n;
}


// ── paid codes ──────────────────────────────────────────────
// Minted by payments.js when an order is paid. Unlike a trial code, a paid
// code is effectively cash, so it is long enough that guessing one is
// hopeless even without the rate limiter: 12 symbols from a 32-letter
// alphabet with the look-alikes (0/O, 1/I/L) removed, about 60 bits.
//
// Shown as QF-7KQ2-M9XD-4TPA; stored normalised ("qf7kq2m9xd4tpa"), the same
// way every code is compared.
const PAID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // 31 symbols
const PAID_LEN      = 12;

function newPaidCode() {
  const bytes = crypto.randomBytes(PAID_LEN * 2);
  let out = '';
  for (let i = 0; out.length < PAID_LEN && i < bytes.length; i++) {
    // Reject the top of the byte range so every symbol is equally likely.
    if (bytes[i] >= 248) continue;
    out += PAID_ALPHABET[bytes[i] % PAID_ALPHABET.length];
  }
  if (out.length < PAID_LEN) return newPaidCode();
  return normCode('QF' + out);
}

// "qf7kq2m9xd4tpa" → "QF-7KQ2-M9XD-4TPA"
function displayCode(code) {
  const c = normCode(code).toUpperCase();
  if (!c.startsWith('QF') || c.length !== PAID_LEN + 2) return c;
  return 'QF-' + c.slice(2).match(/.{4}/g).join('-');
}

// Sessions a subscriber gets per billing period (a week). 0 or blank means
// unlimited. A code can override it (sessions_per_period), e.g. a
// complimentary code issued by admin for several weeks.
function sessionsPerWeek() {
  const n = parseInt(process.env.SUB_SESSIONS_PER_WEEK, 10);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

// A subscription renews at period_end, and the provider's webhook saying so
// can lag a little. One day of grace stops a renewing subscriber from being
// locked out in that gap.
const GRACE = "interval '1 day'";
const LIVE_STATUSES = ['active', 'trialing'];

async function subscription(code) {
  const r = await db.query(
    `SELECT *, (status = ANY($2) AND period_end + ${GRACE} > now()) AS live
       FROM subscriptions WHERE code = $1`, [code, LIVE_STATUSES]);
  return r.rows[0] || null;
}

// What the client is told about a subscriber's plan.
function subSummary(sub) {
  if (!sub) return null;
  const allowance = sub.sessions_per_period != null ? Number(sub.sessions_per_period) : sessionsPerWeek();
  return {
    active:            !!sub.live,
    status:            sub.status,
    periodEnd:         sub.period_end,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    allowance:         allowance || null,                 // null → unlimited
    used:              Number(sub.sessions_used),
    coaching:          !!sub.coaching,
    manageable:        sub.provider !== 'manual' && !!sub.customer_id
  };
}

async function subInfo(session) {
  if (!session || session.tier !== 'paid') return null;
  return subSummary(await subscription(session.code));
}


// ── code check ──────────────────────────────────────────────
// Resolves to { tier, code } or null. Case- and whitespace-insensitive, so a
// code read off a slide still works when someone types it with a capital.
//
// `code` is the normalised one-time or paid code that the run counter hangs
// off. It is null for the two shared env codes, which are counted per session
// instead.
async function checkCode(input) {
  const given = norm(input);
  if (!given) return null;
  const c = configuredCodes();
  if (c.demo  && given === c.demo)  return { tier: 'demo',  code: null };
  if (c.sales && given === c.sales) return { tier: 'sales', code: null };
  const one = normCode(input);
  if (!one) return null;
  if (trialCodes().has(one)) return { tier: 'sales', code: one };
  if (await subscription(one)) return { tier: 'paid', code: one };
  return null;
}

// True when a one-time TRIAL code has nothing left, so it is refused at the
// door. A paid code whose subscription has lapsed, or whose week is used up,
// is still let in — the customer needs a session to see their plan and
// resubscribe — and is refused at the call instead.
async function trialSpent(match) {
  if (!match || match.tier !== 'sales' || !match.code) return false;
  const cap = runCap('sales');
  return cap !== UNLIMITED && (await trialRunsUsed(match.code)) >= cap;
}

// Rate limit by IP so the codes can't be guessed in a loop.
function tooManyAttempts(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.windowStart > ATTEMPT_WINDOW_MS) {
    attempts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  rec.count++;
  return rec.count > ATTEMPT_MAX;
}

function clearAttempts(ip) {
  attempts.delete(ip);
}


// ── sessions ────────────────────────────────────────────────
function purgeStale() {
  const now = Date.now();
  for (const [token, s] of sessions) if (now - s.at > SESSION_TTL_MS) sessions.delete(token);
  for (const [ip, a] of attempts) if (now - a.windowStart > ATTEMPT_WINDOW_MS) attempts.delete(ip);
}

function openSession(tier, code) {
  purgeStale();
  const token = crypto.randomUUID();
  sessions.set(token, { tier, code: code || null, runs: 0, at: Date.now() });
  return token;
}

function getSession(token) {
  purgeStale();
  if (!token) return null;
  const s = sessions.get(String(token));
  if (!s) return null;
  s.at = Date.now();          // sliding expiry — an active trial doesn't time out mid-call
  return s;
}

// Resolves to a number, or null when the tier is uncapped.
async function runsLeft(session) {
  if (session.tier === 'paid') {
    const sub = subSummary(await subscription(session.code));
    if (!sub || !sub.active) return 0;
    if (!sub.allowance) return null;
    return Math.max(0, sub.allowance - sub.used);
  }
  const cap = runCap(session.tier);
  if (cap === UNLIMITED) return null;              // null → "no cap" for the client
  // A one-time code counts against the CODE, so a brand new session opened on
  // an already-used code still sees the runs it has spent.
  const used = session.code ? await trialRunsUsed(session.code) : session.runs;
  return Math.max(0, cap - used);
}

// Charge one run. Called only from /api/conversation, the point at which Tavus
// starts billing.
//
// For a one-time or paid code the charge lands on the code, in the database,
// which is what makes a reload, a private tab or a second device unable to
// buy another call. Each charge is a single conditional UPDATE, so two calls
// started at the same instant on the same code cannot both slip under the cap.
// For the shared env codes it lands on the session, as before.
// Resolves to { ok:true, runsLeft } or { ok:false, reason }.
async function consumeRun(session) {
  if (session.tier === 'paid') {
    const r = await db.query(
      `UPDATE subscriptions SET sessions_used = sessions_used + 1, updated_at = now()
        WHERE code = $1
          AND status = ANY($3) AND period_end + ${GRACE} > now()
          AND (COALESCE(sessions_per_period, $2) = 0 OR sessions_used < COALESCE(sessions_per_period, $2))
        RETURNING sessions_used, COALESCE(sessions_per_period, $2) AS allowance`,
      [session.code, sessionsPerWeek(), LIVE_STATUSES]);
    if (!r.rows.length) {
      const sub = await subscription(session.code);
      return { ok: false, reason: sub && sub.live ? 'week-used' : 'sub-inactive' };
    }
    session.runs++;
    const allowance = Number(r.rows[0].allowance);
    return { ok: true, runsLeft: allowance ? Math.max(0, allowance - Number(r.rows[0].sessions_used)) : null };
  }

  const cap = runCap(session.tier);
  if (cap === UNLIMITED) {
    session.runs++;
    return { ok: true, runsLeft: null };
  }

  if (session.code) {
    const r = await db.query(
      `INSERT INTO trial_code_runs (code, runs) VALUES ($1, 1)
       ON CONFLICT (code) DO UPDATE SET runs = trial_code_runs.runs + 1, updated_at = now()
         WHERE trial_code_runs.runs < $2
       RETURNING runs`, [session.code, cap]);
    if (!r.rows.length) return { ok: false, reason: 'trial-spent' };
    session.runs++;
    return { ok: true, runsLeft: Math.max(0, cap - Number(r.rows[0].runs)) };
  }

  if (session.runs >= cap) return { ok: false, reason: 'trial-spent' };
  session.runs++;
  return { ok: true, runsLeft: await runsLeft(session) };
}

// Give a run back when the call it paid for never started (Tavus refused to
// create the conversation). Lands wherever consumeRun charged it — before
// this existed, only the session counter was decremented, so a one-time code
// stayed charged for our own outage.
async function refundRun(session) {
  session.runs = Math.max(0, session.runs - 1);
  if (session.tier === 'paid') {
    await db.query('UPDATE subscriptions SET sessions_used = GREATEST(sessions_used - 1, 0) WHERE code = $1', [session.code]);
  } else if (session.code && runCap(session.tier) !== UNLIMITED) {
    await db.query('UPDATE trial_code_runs SET runs = GREATEST(runs - 1, 0), updated_at = now() WHERE code = $1', [session.code]);
  }
}


// ── express helper ──────────────────────────────────────────
// Reads the token from the X-QF-Access header (or an accessToken body field
// for sendBeacon calls, which cannot set headers) and resolves the session.
// Responds 401 and returns null when there isn't a valid one.
function requireSession(req, res) {
  const token = req.get('X-QF-Access') || (req.body && req.body.accessToken) || req.query.accessToken;
  const session = getSession(token);
  if (!session) {
    res.status(401).json({ error: 'Your trial session has expired. Reload the page and enter your access code again.', code: 'no-session' });
    return null;
  }
  return session;
}


// ── report gating (tier: sales) ─────────────────────────────
// Withheld sections are REMOVED from the payload rather than hidden in CSS,
// so they are absent from view-source, from Print / Save as PDF and from the
// downloadReport() export. The client renders a locked placeholder for each.
const LOCKED_SECTIONS = ['presence', 'voice', 'corrections', 'model', 'detail'];

function redactForTier(feedback, tier) {
  if (tier !== 'sales' || !feedback) return { feedback, locked: [] };

  const f = { ...feedback };
  const locked = [];

  // Keep the headline verdict intact — score, band, coach's take, summary and
  // the four metrics are what make the follow-up call worth booking.

  // One strength and one improvement stay visible as a taste of the detail.
  const strengths    = Array.isArray(f.strengths)    ? f.strengths.filter(Boolean)    : [];
  const improvements = Array.isArray(f.improvements) ? f.improvements.filter(Boolean) : [];
  f.strengthsHeldBack    = Math.max(0, strengths.length - 1);
  f.improvementsHeldBack = Math.max(0, improvements.length - 1);
  f.strengths    = strengths.slice(0, 1);
  f.improvements = improvements.slice(0, 1);
  if (f.strengthsHeldBack || f.improvementsHeldBack) locked.push('detail');

  if (f.presenceFeedback || (Array.isArray(f.presencePoints) && f.presencePoints.filter(Boolean).length)) {
    locked.push('presence');
  }
  f.presenceFeedback = '';
  f.presencePoints   = [];

  const va = f.voiceAnalysis || {};
  if (va.toneIntonation || va.pacing || va.clarityPronunciation || va.vocalEnergy) locked.push('voice');
  f.voiceAnalysis = {};

  if (Array.isArray(f.sentenceCorrections) && f.sentenceCorrections.length) locked.push('corrections');
  f.sentenceCorrections = [];

  if (f.rewrittenResponse) locked.push('model');
  f.rewrittenResponse = '';

  // The transcript-derived language notes are left in — they read as
  // measurement rather than coaching, and they show the report is real.

  return { feedback: f, locked };
}


module.exports = {
  isConfigured,
  importLegacyState,
  checkCode,
  trialSpent,
  trialStats,
  newPaidCode,
  displayCode,
  subscription,
  subSummary,
  subInfo,
  sessionsPerWeek,
  normCode,
  tooManyAttempts,
  clearAttempts,
  openSession,
  getSession,
  requireSession,
  consumeRun,
  refundRun,
  runsLeft,
  runCap,
  callSeconds,
  redactForTier,
  issueCode,
  LOCKED_SECTIONS,
  UNLIMITED
};
