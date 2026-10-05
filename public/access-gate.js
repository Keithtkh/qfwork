// ============================================================
// QFwork.ai — Access gate (shared by index.html and exam.html)
// ------------------------------------------------------------
// The landing page is public. The code prompt is a modal that opens the
// moment a visitor asks for something that costs us money — picking a
// scenario, starting a call — and closes again when they have a session.
// Loaded as a plain script by both pages, so the gate lives in one place
// and neither page needs a build step.
//
// This is the front door, not the lock: it exists so a visitor sees a code
// prompt rather than a live product. The actual control is server-side —
// /api/conversation, /api/analyze and /api/interview-feedback all require
// the session token this script obtains. Clicking past the modal in the
// console gets you a UI that 401s.
//
// The usual call is require(): it runs your callback now if the visitor
// already has a session, and otherwise opens the modal and runs it once
// they enter a working code.
//
//   window.QFAccess.require(fn)     → run fn once unlocked (opens the modal)
//   window.QFAccess.unlocked()      → true when a session is already held
//   window.QFAccess.ready()         → promise, resolves when the boot check ends
//   window.QFAccess.open()          → open the modal with no pending action
//   window.QFAccess.token()         → session token, or null
//   window.QFAccess.tier()          → 'demo' | 'sales' | null
//   window.QFAccess.calendlyUrl()   → booking link from the server
//   window.QFAccess.runsLeft()      → number, or null when uncapped
//   window.QFAccess.headers()       → { 'X-QF-Access': token } for fetch()
//   window.QFAccess.expired()       → drop the session, re-open the modal (401)
// Fires a 'qf-access-granted' event on document each time a code is accepted.
// ============================================================
(function () {
  'use strict';

  var STORE_KEY = 'qfAccess';
  var session = { token: null, tier: null, runsLeft: null, calendlyUrl: '' };

  var pendingAction = null;   // what the visitor clicked before the modal opened
  var pendingErr    = '';     // message to show the first time the modal opens
  var readyPromise  = null;   // resolves once the boot-time check has settled
  var lastFocus     = null;   // element to hand focus back to on close

  // ── persisted session ──
  // sessionStorage, not localStorage: closing the tab ends the trial, and the
  // server-side run counter means a reload cannot buy extra calls anyway.
  function load() {
    try {
      var raw = sessionStorage.getItem(STORE_KEY);
      if (raw) session = Object.assign(session, JSON.parse(raw));
    } catch (e) { /* private mode / storage disabled — just show the gate */ }
  }
  function save() {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify(session)); } catch (e) {}
  }
  function clear() {
    session = { token: null, tier: null, runsLeft: null, calendlyUrl: '' };
    try { sessionStorage.removeItem(STORE_KEY); } catch (e) {}
  }

  // ── styles ──
  var css = document.createElement('style');
  css.textContent = [
    '#qf-gate{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;padding:24px;',
    '  background:rgba(13,27,36,.72);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);',
    '  font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;overflow-y:auto;',
    '  animation:qf-gate-fade .18s ease both;}',
    '#qf-gate[hidden]{display:none;}',
    '@keyframes qf-gate-fade{from{opacity:0}to{opacity:1}}',
    '.qf-gate-card{position:relative;width:100%;max-width:420px;background:#fff;border-radius:20px;padding:34px 30px 30px;',
    '  box-shadow:0 30px 70px rgba(2,6,23,.45);animation:qf-gate-rise .4s cubic-bezier(.22,.61,.36,1) both;}',
    '@keyframes qf-gate-rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}',
    '#qf-gate-close{position:absolute;top:14px;right:14px;width:32px;height:32px;border:0;border-radius:9px;',
    '  background:transparent;color:#98a2b3;font-size:21px;line-height:1;cursor:pointer;transition:.15s;}',
    '#qf-gate-close:hover{background:#f2f4f7;color:#475467;}',
    '.qf-gate-brand{display:flex;align-items:center;gap:10px;margin-bottom:22px;}',
    '.qf-gate-brand img{width:34px;height:34px;object-fit:contain;display:block;}',
    '.qf-gate-brand .qf-gate-mark{width:34px;height:34px;border-radius:9px;display:grid;place-items:center;',
    '  background:linear-gradient(135deg,#ef6a3d,#f59e6b);color:#fff;font-weight:700;font-size:13px;}',
    '.qf-gate-brand .qf-gate-name{font-weight:700;font-size:16px;letter-spacing:-.01em;color:#101828;}',
    '.qf-gate-brand .qf-gate-name span{color:#0d7a6f;}',
    '.qf-gate-card h2{margin:0 0 8px;font-size:21px;letter-spacing:-.01em;color:#101828;font-weight:600;}',
    '.qf-gate-card p.qf-gate-lede{margin:0 0 22px;font-size:14px;line-height:1.55;color:#667085;}',
    '.qf-gate-card p.qf-gate-lede b{color:#101828;font-weight:600;}',
    '.qf-gate-card label{display:block;font-size:13px;font-weight:600;color:#101828;margin-bottom:7px;}',
    '#qf-gate-input{width:100%;box-sizing:border-box;border:1px solid #e7eaee;border-radius:12px;',
    '  padding:13px 15px;font:inherit;font-size:16px;letter-spacing:.06em;color:#101828;background:#fcfdfd;}',
    '#qf-gate-input:focus{outline:none;border-color:#0d7a6f;box-shadow:0 0 0 3px rgba(13,122,111,.14);}',
    '#qf-gate-input.qf-bad{border-color:#dc2626;box-shadow:0 0 0 3px rgba(220,38,38,.12);}',
    '#qf-gate-btn{width:100%;margin-top:14px;border:0;border-radius:12px;background:#0d7a6f;color:#fff;',
    '  font:inherit;font-size:16px;font-weight:600;padding:14px 22px;cursor:pointer;transition:.15s;}',
    '#qf-gate-btn:hover:not(:disabled){background:#0a5f56;}',
    '#qf-gate-btn:disabled{opacity:.55;cursor:not-allowed;}',
    '#qf-gate-err{min-height:19px;margin:11px 0 0;font-size:13px;line-height:1.5;color:#dc2626;}',
    '#qf-gate-err a{display:inline-block;margin-top:7px;color:#0d7a6f;font-weight:600;}',
    '.qf-gate-foot{margin:20px 0 0;padding-top:18px;border-top:1px solid #eef2f4;',
    '  font-size:12.5px;line-height:1.55;color:#98a2b3;}',
    '.qf-gate-foot a{color:#0d7a6f;}',
    'html.qf-locked,body.qf-locked{overflow:hidden;}',
    '#qf-gate .qf-gate-divider{display:flex;align-items:center;gap:12px;margin:22px 0 18px;color:#98a2b3;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;}',
    '#qf-gate .qf-gate-divider::before,#qf-gate .qf-gate-divider::after{content:"";flex:1;height:1px;background:#e7eaee;}',
    '#qf-gate .qf-gate-book{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;box-sizing:border-box;background:linear-gradient(135deg,#ef6a3d,#f59e6b);color:#fff;border:0;border-radius:12px;padding:15px 22px;font:inherit;font-size:15px;font-weight:600;text-decoration:none;cursor:pointer;transition:.16s;box-shadow:0 6px 18px rgba(239,106,61,.28);}',
    '#qf-gate .qf-gate-book:hover{filter:brightness(1.06);transform:translateY(-1px);box-shadow:0 8px 22px rgba(239,106,61,.34);}',
    '#qf-gate .qf-gate-book svg{flex:none;}'
  ].join('');
  document.head.appendChild(css);

  // ── overlay ──
  var overlay = document.createElement('div');
  overlay.id = 'qf-gate';
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Access code required');
  overlay.innerHTML = [
    '<div class="qf-gate-card">',
    '  <button id="qf-gate-close" type="button" aria-label="Close">&times;</button>',
    '  <div class="qf-gate-brand">',
    '    <img src="logo-mark.png" alt="" onerror="this.replaceWith(Object.assign(document.createElement(\'div\'),{className:\'qf-gate-mark\',textContent:\'QF\'}))" />',
    '    <div class="qf-gate-name">QFwork<span>.ai</span></div>',
    '  </div>',
    '  <h2>Enter your access code</h2>',
    '  <p class="qf-gate-lede" id="qf-gate-lede">Live practice sessions are invite-only while we are in trial. Enter the code from your invitation to begin.</p>',
    '  <form id="qf-gate-form" novalidate>',
    '    <label for="qf-gate-input">Access code</label>',
    '    <input id="qf-gate-input" type="text" name="code" autocomplete="off" autocapitalize="off"',
    '           spellcheck="false" placeholder="e.g. QFWORK-TRIAL-a308b5" aria-describedby="qf-gate-err" />',
    '    <p id="qf-gate-err" role="alert" aria-live="polite"></p>',
    '    <button id="qf-gate-btn" type="submit">Continue</button>',
    '  </form>',
    '  <p style="margin: 18px 0;"></p>',
    '  <a href="/book.html" class="qf-gate-book">',
    '    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    '    Book a free trial session',
    '  </a>',
    '  <p class="qf-gate-foot">Book a FREE 1-on-1 consultation session with our team to get a free trial code. You will get advice based on your session report and learn more about how to improve.</p>',
    '</div>'
  ].join('');

  var input, btn, err, lede;
  var DEFAULT_LEDE = 'Live practice sessions are invite-only while we are in trial. Enter the code from your invitation to begin.';

  // `label` names the thing the visitor just clicked, so the modal explains
  // itself ("…to start Salary Negotiation") instead of appearing out of
  // nowhere over a page they were happily reading.
  function open(label) {
    lastFocus = document.activeElement;
    document.documentElement.classList.add('qf-locked');
    if (document.body) document.body.classList.add('qf-locked');
    overlay.hidden = false;
    if (lede) {
      lede.innerHTML = '';
      if (label) {
        lede.appendChild(document.createTextNode('Live practice sessions are invite-only while we are in trial. Enter the code from your invitation to start '));
        var b = document.createElement('b');
        b.textContent = label;
        lede.appendChild(b);
        lede.appendChild(document.createTextNode('.'));
      } else {
        lede.textContent = DEFAULT_LEDE;
      }
    }
    if (err) { err.textContent = pendingErr; pendingErr = ''; }
    if (input) {
      input.value = '';
      input.classList.remove('qf-bad');
      setTimeout(function () { input.focus(); }, 80);
    }
  }

  // Closing abandons whatever the visitor clicked — they are back on a page
  // they can read, which is the whole point of gating late.
  function close() {
    overlay.hidden = true;
    document.documentElement.classList.remove('qf-locked');
    if (document.body) document.body.classList.remove('qf-locked');
    pendingAction = null;
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
    lastFocus = null;
  }

  function granted() {
    var action = pendingAction;
    close();
    document.dispatchEvent(new CustomEvent('qf-access-granted', {
      detail: { tier: session.tier, runsLeft: session.runsLeft, calendlyUrl: session.calendlyUrl }
    }));
    if (action) { try { action(); } catch (e) { console.error(e); } }
  }

  function fail(msg) {
    err.textContent = msg;
    input.classList.add('qf-bad');
    input.focus();
    input.select();
  }

  // A used-up one-time code is a dead end: retyping it will never work, so the
  // refusal offers the booking link instead of inviting another attempt.
  // The message is set as text, never HTML — it comes from the server.
  function failSpent(msg, url) {
    err.textContent = msg;
    input.classList.add('qf-bad');
    if (!url) return;
    err.appendChild(document.createElement('br'));
    var a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Book your free review →';
    err.appendChild(a);
  }

  // A code carried in the link (?code=QFWORK-TRIAL-a308b5). These are emailed
  // to people who open them on a phone, where typing the code by thumb is the
  // worst part of the experience.
  function codeFromUrl() {
    try {
      var v = new URLSearchParams(location.search).get('code');
      return v ? v.trim() : '';
    } catch (e) { return ''; }
  }

  // Trade a code for a session. `quiet` is the boot-time path for a ?code=
  // link: it must not pop the modal open over a page nobody has clicked yet,
  // so a refusal is parked in pendingErr and shown at the first click instead.
  async function redeem(code, quiet) {
    var r = await fetch('/api/access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code })
    });
    var data = await r.json().catch(function () { return {}; });

    if (r.status === 403 && data.code === 'trial-spent') {
      var spent = data.error || 'This code has already been used.';
      if (quiet) { pendingErr = spent; return false; }
      failSpent(spent, data.calendlyUrl);
      return false;
    }
    if (!r.ok) {
      var msg = data.error || 'Could not check that code. Please try again.';
      if (quiet) { pendingErr = msg; return false; }
      fail(msg);
      return false;
    }

    session = {
      token: data.token, tier: data.tier,
      runsLeft: data.runsLeft == null ? null : data.runsLeft,
      calendlyUrl: data.calendlyUrl || ''
    };
    save();
    return true;
  }

  async function submit(e) {
    if (e) e.preventDefault();
    var code = (input.value || '').trim();
    if (!code) return fail('Please enter your access code.');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    err.textContent = '';
    input.classList.remove('qf-bad');
    try {
      if (await redeem(code, false)) granted();
    } catch (e2) {
      fail('Network problem — check your connection and try again.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Continue';
    }
  }

  // A stored token may have expired while the tab sat open, or the server may
  // have restarted. Confirm it before letting a click straight through, so the
  // visitor hits the code prompt now rather than a 401 halfway into a call.
  async function revalidate() {
    if (!session.token) return false;
    try {
      var r = await fetch('/api/access/verify', { headers: { 'X-QF-Access': session.token } });
      if (!r.ok) { clear(); return false; }
      var data = await r.json();
      session.tier        = data.tier;
      session.runsLeft    = data.runsLeft == null ? null : data.runsLeft;
      session.calendlyUrl = data.calendlyUrl || '';
      save();
      return true;
    } catch (e) {
      clear();
      return false;
    }
  }

  // Settle the session question once, in the background, while the visitor
  // reads the page. By the time anyone clicks, require() answers instantly.
  async function boot() {
    load();
    if (await revalidate()) return true;

    var pre = codeFromUrl();
    if (!pre) return false;

    // Take the code back out of the address bar — these links get screen-
    // shared, and a stale one in history is just confusing.
    try {
      var u = new URL(location.href);
      u.searchParams.delete('code');
      history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
    } catch (e) {}

    try { return await redeem(pre, true); } catch (e) { return false; }
  }

  function attach() {
    document.body.appendChild(overlay);
    input = document.getElementById('qf-gate-input');
    btn   = document.getElementById('qf-gate-btn');
    err   = document.getElementById('qf-gate-err');
    lede  = document.getElementById('qf-gate-lede');
    document.getElementById('qf-gate-form').addEventListener('submit', submit);
    document.getElementById('qf-gate-close').addEventListener('click', close);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !overlay.hidden) close();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
  else attach();

  readyPromise = boot();

  window.QFAccess = {
    token:       function () { return session.token; },
    tier:        function () { return session.tier; },
    runsLeft:    function () { return session.runsLeft; },
    calendlyUrl: function () { return session.calendlyUrl; },
    setRunsLeft: function (n) { session.runsLeft = n == null ? null : n; save(); },
    headers:     function () { return session.token ? { 'X-QF-Access': session.token } : {}; },
    unlocked:    function () { return !!session.token; },
    ready:       function () { return readyPromise; },
    open:        function (label) { open(label); },

    // The gate, as the pages use it. Runs `fn` immediately when a session is
    // already in hand; otherwise parks it behind the modal. `label` is the
    // human name of what was clicked, for the modal's opening line.
    require: function (fn, label) {
      if (session.token) return fn();
      pendingAction = fn;
      // The boot check may still be in flight on a fast click — wait for it
      // rather than asking for a code the visitor has already supplied.
      readyPromise.then(function (ok) {
        if (pendingAction !== fn) return;          // closed or superseded
        if (ok && session.token) return granted();
        open(label);
      });
    },

    // Called by the pages when an API returns 401 mid-flow.
    expired: function () {
      clear();
      pendingErr = 'Your session expired. Please enter your code again.';
      open();
    }
  };
})();
