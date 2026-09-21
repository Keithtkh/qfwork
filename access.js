// ============================================================
// QFwork.ai — Access control
// ------------------------------------------------------------
// The product is a paid demo: every live call spends Tavus minutes and
// Groq tokens, so the trial is gated behind a shared access code.
//
// Two tiers:
//   demo   → our own demos. Full report, no run cap. One shared, reusable code.
//   sales  → prospects. One run, and the deep sections of the report are
//            withheld so a recruitment expert can walk them through it
//            on the follow-up call.
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
function callSeconds(tier) {
  const shared = parseInt(process.env.TAVUS_MAX_CALL_SECONDS || '300', 10);
  const base   = Number.isFinite(shared) && shared > 0 ? shared : 300;
  if (tier !== 'demo') return base;
  const demo = parseInt(process.env.TAVUS_MAX_CALL_SECONDS_DEMO, 10);
  return Number.isFinite(demo) && demo > 0 ? demo : base;
}

// Number of runs a tier gets. Blank or 0 in the environment means unlimited.
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
// state is the part that has to outlive a restart. So only the used-map is
// written to disk — the list itself stays in the environment.
//
// Issue a batch with:
//   node -e "for(let i=0;i<25;i++)console.log('QFWORK-TRIAL-'+require('crypto').randomBytes(3).toString('hex'))"
// and paste them into ACCESS_CODES_TRIAL, comma separated.

const STATE_FILE = process.env.TRIAL_CODES_STATE || path.join(__dirname, 'trial-codes-used.json');

// normalised code → runs spent
let codeRuns = new Map();

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

function loadState() {
  try {
    const obj = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    codeRuns = new Map(Object.entries(obj).map(([k, v]) => [k, Number(v) || 0]));
  } catch (e) {
    codeRuns = new Map();          // first boot, or nothing readable — start clean
  }
}

// Written on every burn. A few hundred codes is a sub-millisecond rewrite, and
// tmp-then-rename means a crash mid-write cannot leave a truncated file.
function saveState() {
  try {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(codeRuns), null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    // A read-only filesystem costs us persistence across restarts, not
    // correctness within one. Say so once, then carry on in memory.
    if (!saveState.warned) {
      saveState.warned = true;
      console.warn(`[access] cannot write ${STATE_FILE} (${e.code || e.message}) — spent codes will reset on restart`);
    }
  }
}

loadState();

function trialRunsUsed(code) {
  return codeRuns.get(code) || 0;
}

// True when this one-time code has nothing left. Safe to call with null (the
// shared env codes), which are never spent this way — their cap is counted on
// the session instead.
function trialSpent(code) {
  if (!code) return false;
  const cap = runCap('sales');
  return cap !== UNLIMITED && trialRunsUsed(code) >= cap;
}

// For the boot banner, so the state of the trial is visible at a glance.
function trialStats() {
  const codes = trialCodes();
  let used = 0;
  for (const c of codes) if (trialSpent(c)) used++;
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

// ── code check ──────────────────────────────────────────────
// Returns { tier, code } or null. Case- and whitespace-insensitive, so a code
// read off a slide still works when someone types it with a capital.
//
// `code` is the normalised one-time code that the run counter hangs off. It is
// null for the two shared env codes, which are counted per session instead.
function checkCode(input) {
  const given = norm(input);
  if (!given) return null;
  const c = configuredCodes();
  if (c.demo  && given === c.demo)  return { tier: 'demo',  code: null };
  if (c.sales && given === c.sales) return { tier: 'sales', code: null };
  const one = normCode(input);
  if (one && trialCodes().has(one)) return { tier: 'sales', code: one };
  return null;
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

function runsLeft(session) {
  const cap = runCap(session.tier);
  if (cap === UNLIMITED) return null;              // null → "no cap" for the client
  // A one-time code counts against the CODE, so a brand new session opened on
  // an already-used code still sees the runs it has spent.
  const used = session.code ? trialRunsUsed(session.code) : session.runs;
  return Math.max(0, cap - used);
}

// Charge one run. Called only from /api/conversation, the point at which Tavus
// starts billing.
//
// For a one-time code the charge lands on the code and is persisted, which is
// what makes a reload, a private tab or a second device unable to buy another
// call. For the shared env codes it lands on the session, as before.
// Returns { ok:true, runsLeft } or { ok:false, reason }.
function consumeRun(session) {
  const cap = runCap(session.tier);
  if (cap === UNLIMITED) {
    session.runs++;
    return { ok: true, runsLeft: null };
  }

  if (session.code) {
    const used = trialRunsUsed(session.code);
    if (used >= cap) return { ok: false, reason: 'trial-spent' };
    codeRuns.set(session.code, used + 1);
    saveState();
    session.runs++;
    return { ok: true, runsLeft: runsLeft(session) };
  }

  if (session.runs >= cap) return { ok: false, reason: 'trial-spent' };
  session.runs++;
  return { ok: true, runsLeft: runsLeft(session) };
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
  checkCode,
  trialSpent,
  trialStats,
  tooManyAttempts,
  clearAttempts,
  openSession,
  getSession,
  requireSession,
  consumeRun,
  runsLeft,
  runCap,
  callSeconds,
  redactForTier,
  issueCode,
  LOCKED_SECTIONS,
  UNLIMITED
};
