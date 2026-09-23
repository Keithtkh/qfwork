// ============================================================
// QFwork.ai — Backend Server
// ------------------------------------------------------------
//  • POST /api/access               → exchange an access code for a trial session
//  • GET  /api/access/verify        → is this trial session still alive?
//  • POST /api/analyze              → text practice → feedback report
//  • POST /api/conversation         → start a live Tavus video session
//  • POST /api/voice-sample/:id     → receive the mic recording (WAV) for voice analysis
//  • POST /api/interview-feedback   → transcript + perception + voice audio → feedback report
//  • POST /api/abandon              → best-effort end of an abandoned call (stops billing)
//  • POST /api/issue-code           → issue a one-time trial code after a Calendly booking
//
//  API credentials are read from the environment here on the server and
//  are never exposed to the browser.
//
//  Everything that spends money — /api/analyze, /api/conversation and
//  /api/interview-feedback — requires a trial session from /api/access.
//  See access.js.
// ============================================================

const express = require('express');
const cors    = require('cors');
const http    = require('http');
require('dotenv').config();

const { generateFeedback } = require('./feedback');
const { analyzeVoice }     = require('./voice-metrics');
const { createConversation, getConversationTranscript, endConversation, ensurePerceptionLayer } = require('./tavus');
const access = require('./access');

const app  = express();
const PORT = process.env.PORT || 3000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.use(express.json());
app.use(cors());

// Railway and friends sit in front of us; without this every request looks
// like it came from the proxy and the access-code rate limit becomes global.
app.set('trust proxy', 1);

// Make the live interview the front door.
app.get('/', (req, res) => res.redirect('/exam.html'));

app.use(express.static('public'));


// ============================================================
// ACCESS GATE
// ------------------------------------------------------------
// POST /api/access        body: { code }
//   → { ok, token, tier, runsLeft, calendlyUrl }
// GET  /api/access/verify header: X-QF-Access
//   → { ok, tier, runsLeft, calendlyUrl }
//
// The tier decides how much of the report the visitor sees and how many
// calls they get. A one-time code additionally carries its own run counter,
// so a spent code is refused here rather than at the first call; see access.js.
// ============================================================
app.post('/api/access', (req, res) => {
  if (!access.isConfigured()) {
    return res.status(503).json({ error: 'The trial is not accepting codes right now. Please contact us for access.' });
  }
  if (access.tooManyAttempts(req.ip)) {
    return res.status(429).json({ error: 'Too many attempts. Please wait a minute and try again.' });
  }
  const match = access.checkCode(req.body && req.body.code);
  if (!match) {
    return res.status(401).json({ error: "That code isn't valid. Check it and try again, or contact us for access." });
  }
  // Recognising the code proves this is not a guessing loop, so the attempt
  // counter is cleared even when the code turns out to be spent. Without this,
  // someone re-entering their own used code a few times would hit the rate
  // limiter and get "too many attempts" instead of the message that explains
  // what actually happened.
  access.clearAttempts(req.ip);

  // A one-time code with nothing left. The booking link travels with the
  // refusal so the dead end still leads somewhere.
  if (access.trialSpent(match.code)) {
    console.log('[access] one-time code already spent');
    return res.status(403).json({
      error: 'This code has already been used. Book a free review with one of our recruitment experts to go further.',
      code:  'trial-spent',
      calendlyUrl: process.env.CALENDLY_URL || ''
    });
  }

  const token   = access.openSession(match.tier, match.code);
  const session = access.getSession(token);
  console.log(`[access] ${match.tier} session opened${match.code ? ' (one-time code)' : ''}`);
  return res.status(200).json({
    ok: true,
    token,
    tier: match.tier,
    runsLeft:    access.runsLeft(session),
    calendlyUrl: process.env.CALENDLY_URL || ''
  });
});

app.get('/api/access/verify', (req, res) => {
  const token   = req.get('X-QF-Access') || req.query.accessToken;
  const session = access.getSession(token);
  if (!session) return res.status(401).json({ ok: false });
  return res.status(200).json({
    ok: true,
    tier:        session.tier,
    runsLeft:    access.runsLeft(session),
    calendlyUrl: process.env.CALENDLY_URL || ''
  });
});


// ============================================================
// LIVE INTERVIEW SCENARIOS
// ------------------------------------------------------------
// `prompt`  → the situation, also passed to the feedback rubric.
// `context` → conversational_context: how the Tavus replica role-plays.
// `greeting`→ custom_greeting: the first line the replica says.
// Titles MUST match the rubric titles in feedback.js.
// ============================================================
const INTERVIEW_SCENARIOS = {
  "Job Interview": {
    prompt:  "A professional job interview. The interviewer asks about your background, strengths and fit, with natural follow-ups — tailored to whatever role you're pursuing.",
    context: "You are a warm, professional interviewer running a practice job interview. The candidate should have described a particular role and company they are applying for. At the very start, briefly ask the candidate to introduce themselves instead of asking about the role or company they are applying for unless they did not mention it, then adapt ALL of your questions to whatever they say and based on the role that they are applying for. Ask natural, open follow-up questions about their experience, strengths and motivation. Follow the candidate's lead, ask ONE question at a time, and keep each turn to 1-3 sentences. Never give feedback or scores during the interview. Ensure it is a competency based interview.",
    greeting: "Hi, great to meet you — thanks for coming in. Before we dive in, could you tell me a bit about yourself?"
  },
  "Salary Negotiation": {
    prompt:  "A salary negotiation. You've received a job offer and are negotiating the package.",
    context: "You are a friendly hiring manager who has just offered the candidate a role. Do NOT assume their industry. If you don't already know their field, briefly ask what kind of role they're negotiating for, then continue. Present a fair offer and show some flexibility, but only improve it if they negotiate well — a warm opening, a specific ask or range, and value-based justification. Gently push back once or twice to test them. Ask ONE thing at a time, keep turns to 1-3 sentences. Do not give feedback during the conversation.",
    greeting: "Congratulations — we'd really love to have you on the team. Before I lay out the offer, tell me a little about the role you're stepping into so we're on the same page."
  },
  "Business Presentation": {
    prompt:  "A formal business presentation to a time-pressed senior executive. You hold the floor: brief them on your topic, deliver your presentation uninterrupted, then defend it in a short Q&A.",
    // This scenario runs on its OWN persona (patient turn-taking, executive
    // audience behaviour) — see TAVUS_PRESENTATION_PERSONA_ID below.
    context: "You are a senior executive audience for a practice business presentation. Run it in phases: (1) BRIEF — if they haven't told you yet, ask what they're presenting, then hand them the floor and go quiet. (2) DELIVERY — they hold the floor; do NOT ask questions and do NOT take over. If they pause for a long stretch without asking you anything, either invite them to continue in one short sentence, or give ONE brief specific reaction to what they've shared so far and then ask them to carry on. (3) Q&A — only once they clearly finish, switch to probing executive questions ONE at a time: test a number, ask 'so what?', challenge a risk or next step, and push back once or twice like a real time-pressed executive. Stay professional and courteous. Never give feedback, corrections or scores during the call.",
    greeting: "Good to see you — I've got the next few minutes blocked out for you. What are you presenting today? Once you've set it up, the floor is yours; I'll keep my questions for the end.",
    personaIdEnv: 'TAVUS_PRESENTATION_PERSONA_ID'
  },
  "Client Meeting": {
    prompt:  "A first meeting with a prospective client or partner about working together.",
    context: "You are a prospective client or partner meeting the candidate for the first time. Do NOT assume their industry. Be warm but curious: let them introduce themselves and what they or their company do, and ask how working together could benefit your side. Adapt to whatever field they describe. Ask ONE thing at a time, keep turns to 1-3 sentences. Do not give feedback during the conversation.",
    greeting: "Hello, lovely to meet you. I'd love to hear a bit about you and what you do — go ahead."
  }
};


// ============================================================
// POST /api/analyze  — original text-practice feedback
// ============================================================
app.post('/api/analyze', async (req, res) => {
  if (!access.requireSession(req, res)) return;
  const { transcript, scenarioTitle, scenarioPrompt } = req.body;
  if (!transcript || !scenarioTitle) {
    return res.status(400).json({ error: 'Missing transcript or scenario.' });
  }
  try {
    const feedback = await generateFeedback({ transcript, scenarioTitle, scenarioPrompt });
    return res.status(200).json(feedback);
  } catch (error) {
    console.error('Analyze error:', error.message);
    const code = /not set/.test(error.message) ? 500 : 502;
    return res.status(code).json({ error: error.message });
  }
});


// ============================================================
// POST /api/conversation  — start a live Tavus video interview
//   body: { scenarioTitle }
//   returns: { conversationId, conversationUrl, scenarioPrompt }
// ============================================================
app.post('/api/conversation', async (req, res) => {
  const session = access.requireSession(req, res);
  if (!session) return;
  const { scenarioTitle, userContext } = req.body;
  const scenario = INTERVIEW_SCENARIOS[scenarioTitle];
  if (!scenario) {
    return res.status(400).json({ error: `Unknown scenario: ${scenarioTitle}` });
  }
  // This is the moment Tavus starts billing, so it is also the moment the
  // trial run is charged. Doing it here (not in the browser) means a page
  // reload cannot hand someone a fresh set of runs.
  const charged = access.consumeRun(session);
  if (!charged.ok) {
    return res.status(403).json({
      error: "You've used your trial session. Book a free review with one of our recruitment experts to go further.",
      code:  'trial-spent'
    });
  }
  // Tailor the role-play to whatever the user told us about themselves.
  let context = scenario.context;
  if (userContext && userContext.trim()) {
    context += `\n\nThe candidate shared about the role and company that they are applying for, use it to tailor the conversation and do NOT ask the company and the role they are applying for again: "${userContext.trim().slice(0, 500)}"`;
  }
  // Scenario-specific persona (e.g. the patient presentation executive).
  // Falls back to the default interviewer persona if the env var isn't set.
  const personaId = scenario.personaIdEnv ? (process.env[scenario.personaIdEnv] || undefined) : undefined;
  // Per-call time limit for this session's tier — demos get their own, longer
  // cap; the sales tier keeps the shared 5 minutes.
  const maxSeconds = access.callSeconds(session.tier);
  try {
    const convo = await createConversation({
      conversationName:      `QFwork — ${scenarioTitle}`,
      conversationalContext: context,
      customGreeting:        scenario.greeting,
      callbackUrl:           process.env.TAVUS_CALLBACK_URL || undefined,
      personaId,
      maxSeconds
    });
    return res.status(200).json({
      conversationId:  convo.conversation_id,
      conversationUrl: convo.conversation_url,
      scenarioPrompt:  scenario.prompt,
      maxSeconds,
      runsLeft:        charged.runsLeft
    });
  } catch (error) {
    // The call never started, so nothing was billed — give the run back
    // rather than burning a prospect's only try on our own outage.
    session.runs = Math.max(0, session.runs - 1);
    console.error('Create conversation error:', error.message);
    return res.status(502).json({ error: error.message });
  }
});


// ============================================================
// POST /api/voice-sample/:conversationId — the browser uploads the
// candidate's mic recording (mono 16-bit WAV) the moment the call
// ends, right before it requests /api/interview-feedback.
// Held in memory only (never written to disk), purged after use
// or after 20 minutes.
// ============================================================
const voiceStore = new Map(); // conversationId → { buffer, at }
const VOICE_TTL_MS = 20 * 60 * 1000;

function purgeStaleVoice() {
  const now = Date.now();
  for (const [id, v] of voiceStore) if (now - v.at > VOICE_TTL_MS) voiceStore.delete(id);
}

app.post('/api/voice-sample/:conversationId',
  express.raw({ type: () => true, limit: '40mb' }),
  (req, res) => {
    purgeStaleVoice();
    const id = req.params.conversationId;
    if (!id || !Buffer.isBuffer(req.body) || req.body.length < 1000) {
      return res.status(400).json({ error: 'Missing conversation id or empty audio.' });
    }
    voiceStore.set(id, { buffer: req.body, at: Date.now() });
    console.log(`[voice] sample received for ${id}: ${(req.body.length / 1024 / 1024).toFixed(1)} MB`);
    return res.status(200).json({ ok: true, bytes: req.body.length });
  });


// ============================================================
// POST /api/abandon?conversationId=… — fired via sendBeacon when the
// user navigates away mid-call, so the Tavus stream doesn't keep
// running (and billing) until the max-duration cap.
// ============================================================
app.post('/api/abandon', async (req, res) => {
  const conversationId = req.query.conversationId || (req.body && req.body.conversationId);
  if (conversationId) {
    console.log(`[tavus] call abandoned, ending conversation ${conversationId}`);
    endConversation(conversationId); // best-effort, don't block the response
    voiceStore.delete(conversationId);
  }
  return res.status(204).end();
});


// ============================================================
// POST /api/interview-feedback  — end of call → transcript + voice → feedback
//   body: { conversationId, scenarioTitle }
// ============================================================
app.post('/api/interview-feedback', async (req, res) => {
  const session = access.requireSession(req, res);
  if (!session) return;
  const { conversationId, scenarioTitle, durationSeconds } = req.body;
  const scenario = INTERVIEW_SCENARIOS[scenarioTitle];
  if (!conversationId || !scenario) {
    return res.status(400).json({ error: 'Missing conversationId or unknown scenario.' });
  }
  try {
    // Kick off the voice analysis (DSP + Groq Whisper) IN PARALLEL with the
    // transcript polling below — it finishes well within the polling window.
    const voiceEntry = voiceStore.get(conversationId);
    voiceStore.delete(conversationId);
    const voicePromise = voiceEntry
      ? analyzeVoice(voiceEntry.buffer).catch(e => { console.log(`[voice] analysis failed: ${e.message}`); return null; })
      : Promise.resolve(null);

    await endConversation(conversationId); // stop the stream so the transcript finalises

    // The transcript is NOT ready the instant a call ends — poll for it,
    // breaking as soon as we have the candidate's speech.
    // Transcript and the perception (facial/body-language) analysis arrive as
    // SEPARATE events — perception lands a while AFTER the transcript.
    // So once we have the transcript, keep polling a bounded grace period for
    // perception too, so a persona with no vision data never blocks forever.
    let result = { userText: '', dialogue: '', perception: '', rawTurns: [], raw: null };
    let foundAt = 0;
    const MAX = 20;                 // ~60 s worst case for the transcript itself
    const PERCEPTION_GRACE = 8;     // ~24 s extra wait for perception after the transcript
    for (let attempt = 1; attempt <= MAX; attempt++) {
      await sleep(attempt === 1 ? 2000 : 3000);
      try {
        result = await getConversationTranscript(conversationId);
      } catch (e) {
        console.log(`[tavus] fetch attempt ${attempt}/${MAX} failed: ${e.message}`);
        continue;
      }
      const haveTranscript = result.userText && result.userText.length >= 15;
      const havePerception = !!result.perception;
      const evTypes = (result.raw && Array.isArray(result.raw.events)) ? result.raw.events.map(e => e.event_type) : [];
      console.log(`[tavus] poll ${attempt}/${MAX} - turns: ${result.rawTurns?.length || 0}, chars: ${result.userText?.length || 0}, perception: ${havePerception ? 'yes' : 'no'} | events: ${JSON.stringify(evTypes)}`);
      if (haveTranscript && !foundAt) foundAt = attempt;
      if (haveTranscript && havePerception) break;               // both ready → done
      if (foundAt && attempt - foundAt >= PERCEPTION_GRACE) {    // perception is late/absent → move on
        console.log('[tavus] transcript ready; perception did not arrive within the grace window, continuing without it');
        break;
      }
    }
    console.log(`[tavus] perception analysis: ${result.perception ? result.perception.length + ' chars captured' : 'NONE captured'}`);
    if (result.perception) console.log(`         "${result.perception.slice(0, 160)}"`);

    if (!result.userText || result.userText.length < 15) {
      // Dump the raw payload so we can pin the exact transcript field if needed.
      console.log('\n---------- Tavus raw conversation payload (transcript debug) ----------');
      console.log(JSON.stringify(result.raw, null, 2)?.slice(0, 6000));
      console.log('-----------------------------------------------------------------------\n');
      return res.status(422).json({
        error: 'No candidate speech was captured in the transcript. If you did speak, this is a transcript-format mismatch — the raw Tavus payload was printed to the server terminal so we can fix the extractor.',
        dialogue: result.dialogue
      });
    }

    // Real pacing metrics from the transcript (legit — no fabricated WPM/pauses).
    const words = (result.userText.match(/[\w'-]+/g) || []).length;
    const turns = (result.rawTurns || []).filter(t => /^(user|participant|human)$/.test(t.role)).length || 1;
    let dur = Math.round(Number(durationSeconds) || 0);
    if (!dur && result.raw && result.raw.created_at && result.raw.updated_at) {
      dur = Math.round((new Date(result.raw.updated_at) - new Date(result.raw.created_at)) / 1000);
    }
    const pacing = { words, turns, avgWordsPerTurn: Math.round(words / turns), durationSeconds: dur };

    // Voice analysis result (was running in parallel with the polling above).
    const voiceMetrics = await voicePromise;
    if (voiceMetrics) {
      console.log(`[voice] metrics ready - ${voiceMetrics.promptLines.length} measurement line(s)${voiceMetrics.errors.length ? ` | partial: ${voiceMetrics.errors.join('; ')}` : ''}`);
      voiceMetrics.promptLines.forEach(l => console.log(`         ${l}`));
    } else {
      console.log(`[voice] no sample for this call; feedback will use transcript and perception only`);
    }

    const feedback = await generateFeedback({
      transcript:         result.userText,
      scenarioTitle,
      scenarioPrompt:     scenario.prompt,
      visualObservations: result.perception,   // real camera observations (Raven perception)
      pacing,
      voiceMetrics
    });
    console.log(`[feedback] fields - presence: ${feedback.presenceFeedback ? `yes (${feedback.presenceFeedback.length} chars)` : 'EMPTY'}, presencePoints: ${Array.isArray(feedback.presencePoints) ? feedback.presencePoints.filter(Boolean).length : 0}, voice: ${feedback.voiceAnalysis?.toneIntonation ? 'yes' : 'EMPTY'}, pacing: ${feedback.deliveryAnalysis?.pacingFlow ? 'yes' : 'EMPTY'}`);

    // On the sales tier the deep coaching sections are stripped out here, so
    // they never reach the browser at all — the client shows a locked card and
    // a link to book the expert review.
    const gated = access.redactForTier(feedback, session.tier);
    if (gated.locked.length) console.log(`[access] sales tier — withheld: ${gated.locked.join(', ')}`);

    return res.status(200).json({
      feedback:   gated.feedback,
      tier:       session.tier,
      locked:     gated.locked,
      dialogue:   session.tier === 'sales' ? '' : result.dialogue,
      voiceStats: voiceMetrics ? voiceMetrics.uiStats : null
    });
  } catch (error) {
    console.error('Interview feedback error:', error.message);
    return res.status(502).json({ error: error.message });
  }
});

// ── Issue a trial code after a Calendly booking ──
// Called by book-confirm.html with the invitee's email.
// Returns the next unused code, or the same code if this email
// was already issued one.
app.post('/api/issue-code', (req, res) => {
  const { email, name } = req.body || {};

  if (!email) {
    return res.status(400).json({ ok: false, error: 'Missing email.' });
  }

  const code = access.issueCode(email);
  if (!code) {
    return res.status(503).json({
      ok: false,
      error: 'No trial codes available right now. Please contact qfworkai@gmail.com.'
    });
  }

  console.log(`[booking] issued ${code} to ${email}`);
  return res.json({ ok: true, code });
});

// Config endpoint — exposes safe-to-share config values to the frontend.
app.get('/api/config', (req, res) => {
  res.json({
    calendlyUrl: process.env.CALENDLY_URL_TRIAL || ''
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok', message: 'QFwork.ai server is running' }));


const server = http.createServer(app);

server.listen(PORT, () => {
  const state = (ok) => ok ? 'configured' : 'MISSING';
  console.log(`\nQFwork.ai server listening on http://localhost:${PORT}`);
  console.log(`  Groq   : ${state(!!process.env.GROQ_API_KEY)}  (feedback report, speech-to-text)`);
  console.log(`  Tavus  : ${state(!!process.env.TAVUS_API_KEY)}  (live conversational video)`);
  console.log(`  Static : serving /public`);

  // The access gate is the only thing standing between a public URL and our
  // Tavus/Groq bill, so make its state loud at boot.
  const mmss = (sec) => `${Math.floor(sec / 60)}m${sec % 60 ? ` ${sec % 60}s` : ''}`;
  const cap = (t) => `${access.runCap(t) === access.UNLIMITED ? 'unlimited runs' : `${access.runCap(t)} run(s)`}, ${mmss(access.callSeconds(t))}/call`;
  if (access.isConfigured()) {
    console.log(`  Access : demo code ${state(!!process.env.ACCESS_CODE_DEMO)} (${cap('demo')})  ·  sales code ${state(!!process.env.ACCESS_CODE_SALES)} (${cap('sales')})`);
    const t = access.trialStats();
    console.log(t.total
      ? `  Trial  : ${t.total} one-time code(s) · ${t.used} used · ${t.total - t.used} left (${cap('sales')} each)`
      : `  Trial  : no one-time codes set — issue some into ACCESS_CODES_TRIAL`);
  } else {
    console.log(`  Access : NO CODES SET — the trial is closed to everyone. Set ACCESS_CODE_DEMO and/or ACCESS_CODES_TRIAL in .env`);
  }
  // With no URL the booking card is hidden rather than shown broken, so this
  // line is the only place a missing link becomes visible.
  console.log(process.env.CALENDLY_URL
    ? `  Booking: configured  (free-consultation link on the report)`
    : `  Booking: MISSING — set CALENDLY_URL or the consultation card stays hidden`);

  // With no URL the service unavailable word is shown, so this line is 
  // an extra place to show a missing link.
  console.log(process.env.CALENDLY_URL_TRIAL
    ? `  Booking_Trial  : booking link before trial configured  (/book.html)`
    : `  Booking_Trial  : MISSING — set CALENDLY_URL_TRIAL or /book.html shows no calendar`);

  // The on-camera presence feedback requires each persona to carry a Raven
  // perception layer. Verify both at boot and add the layer if it is absent,
  // since a persona without it fails silently (an empty presence section).
  const personas = [
    { label: 'interviewer ', id: process.env.TAVUS_PERSONA_ID },
    { label: 'presentation', id: process.env.TAVUS_PRESENTATION_PERSONA_ID }
  ];
  for (const p of personas) {
    if (!p.id) {
      console.log(`  Vision : ${p.label} persona id not set — run "node setup-tavus.js"`);
      continue;
    }
    ensurePerceptionLayer(p.id)
      .then(st => {
        if (st.ok && st.patched) console.log(`  Vision : ${p.label} persona — perception layer was missing, added ${st.model}`);
        else if (st.ok)          console.log(`  Vision : ${p.label} persona — perception layer ready (${st.model})`);
        else                     console.log(`  Vision : ${p.label} persona — ${st.reason}; presence feedback may be empty`);
      })
      .catch(e => console.log(`  Vision : ${p.label} persona — check failed: ${e.message}`));
  }
  console.log('');
});
