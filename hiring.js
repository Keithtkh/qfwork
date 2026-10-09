// ============================================================
// QFwork.ai — Hiring flow
// ------------------------------------------------------------
// Private AI interview flow for hiring marketing talent.
//
// Candidates access a private page (/hire.html) with a unique token.
// The flow: fill form → talk to AI interviewer → report sent to manager.
//
// Routes mounted by server.js:
//   GET  /api/hire/verify-token   → is this token valid and unused?
//   POST /api/hire/start          → create a Tavus conversation for the candidate
//   POST /api/hire/feedback       → end of call → transcript → hiring report
//   GET  /api/hire/config         → Calendly follow-up URL for the frontend
//
// All routes and state live here. server.js just calls `attach(app)`.
// ============================================================

const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');

const { createConversation, getConversationTranscript, endConversation } = require('./tavus');
const { generateHiringReport } = require('./hiring-feedback');

const Brevo = require('@getbrevo/brevo');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Token pool (from .env) ───────────────────────────────────
let hiringTokensSrc = null;
let hiringTokensSet = new Set();
function hiringTokens() {
  const src = String(process.env.HIRING_TOKENS || '');
  if (src !== hiringTokensSrc) {
    hiringTokensSrc = src;
    hiringTokensSet = new Set(src.split(/[\s,;]+/).filter(Boolean));
  }
  return hiringTokensSet;
}

// ── Session state (used tokens → candidate info) ─────────────
const HIRING_SESSIONS_FILE = process.env.HIRING_SESSIONS_STATE
  || path.join(__dirname, 'hiring-sessions.json');

const hiringSessions = new Map();

const cvStore = new Map();  // token → cvText (in-memory only, never persisted)

// Purge CVs older than 2 hours
const CV_TTL_MS = 2 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [key] of cvStore) {
    const session = hiringSessions.get(key);
    if (!session || now - new Date(session.usedAt).getTime() > CV_TTL_MS) {
      cvStore.delete(key);
    }
  }
}, 15 * 60 * 1000);

function loadHiringSessions() {
  try {
    const obj = JSON.parse(fs.readFileSync(HIRING_SESSIONS_FILE, 'utf8'));
    for (const [token, session] of Object.entries(obj)) {
      hiringSessions.set(token, session);
    }
    console.log(`[hire] loaded ${hiringSessions.size} used token(s)`);
  } catch {
    // First boot — empty
  }
}

function saveHiringSessions() {
  try {
    const tmp = HIRING_SESSIONS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(hiringSessions), null, 2));
    fs.renameSync(tmp, HIRING_SESSIONS_FILE);
  } catch (e) {
    console.warn('[hire] could not save sessions:', e.message);
  }
}

loadHiringSessions();

// ── Emails ───────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

async function sendHiringReportEmail(session, report, cvText) {
  const brevo = new Brevo.BrevoClient({ apiKey: process.env.BREVO_API_KEY });

  const strengths = report.strengths.map(s => `<li>${s}</li>`).join('');
  const concerns  = report.concerns.map(c => `<li>${c}</li>`).join('');

  const cvBlock = cvText
    ? `<h3>Candidate's CV</h3>
       <pre style="white-space:pre-wrap; font-family:monospace; font-size:12px; background:#f6f8fa; padding:14px; border-radius:8px; border:1px solid #e7eaee; max-height:500px; overflow:auto;">${escapeHtml(cvText)}</pre>`
    : `<p style="color:#667085; font-style:italic;">No CV was uploaded by the candidate.</p>`;

  await brevo.transactionalEmails.sendTransacEmail({
    subject: `Hiring Report: ${session.candidateName} — ${report.recommendation}`,
    htmlContent: `
      <div style="font-family:sans-serif;max-width:700px;">
        <h2>Marketing Interview Report</h2>
        <p><strong>Candidate:</strong> ${escapeHtml(session.candidateName)}</p>
        <p><strong>Email:</strong> ${escapeHtml(session.candidateEmail)}</p>
        <p><strong>Score:</strong> ${report.overallScore}/100</p>
        <p><strong>Recommendation:</strong> ${report.recommendation}</p>

        <h3>Summary</h3>
        <p>${report.summary}</p>

        <h3>Strengths</h3>
        <ul>${strengths}</ul>

        <h3>Concerns</h3>
        <ul>${concerns}</ul>

        <h3>Detailed</h3>
        <p><strong>Campaign Experience:</strong> ${report.campaignExperience}</p>
        <p><strong>Technical Skills:</strong> ${report.technicalSkills}</p>
        <p><strong>Strategic Thinking:</strong> ${report.strategicThinking}</p>
        <p><strong>Communication:</strong> ${report.communication}</p>

        ${cvBlock}
      </div>
    `,
    sender: {
      name:  process.env.BREVO_SENDER_NAME  || 'QFwork.ai',
      email: process.env.BREVO_SENDER_EMAIL
    },
    to: [{ email: process.env.MANAGER_EMAIL }]
  });
}

async function sendNoTranscriptEmail(session, cvText) {
  const brevo = new Brevo.BrevoClient({ apiKey: process.env.BREVO_API_KEY });

    const cvBlock = cvText
    ? `<h3>Candidate's CV</h3>
       <pre style="white-space:pre-wrap; font-family:monospace; font-size:12px; background:#f6f8fa; padding:14px; border-radius:8px; border:1px solid #e7eaee; max-height:500px; overflow:auto;">${escapeHtml(cvText)}</pre>`
    : `<p style="color:#667085; font-style:italic;">No CV was provided.</p>`;

  await brevo.transactionalEmails.sendTransacEmail({
    subject: `Interview completed (no audio) — ${session.candidateName}`,
    htmlContent: `
      <div style="font-family:sans-serif;max-width:600px;">
        <h2>Interview completed — no audio captured</h2>
        <p><strong>Candidate:</strong> ${escapeHtml(session.candidateName)}</p>
        <p><strong>Email:</strong> ${escapeHtml(session.candidateEmail)}</p>
        <p><strong>Session time:</strong> ${new Date().toLocaleString()}</p>

        <p style="margin-top:18px;">
          The candidate joined the AI interview but no usable speech was captured.
          This usually means the microphone was muted, denied permission, or the
          candidate ended the call immediately.
        </p>

        <p style="color:#667085;font-size:13px;">
          No report was generated. You may want to follow up with the candidate
          to reschedule.
        </p>

        ${cvBlock}
      </div>
    `,
    sender: {
      name:  process.env.BREVO_SENDER_NAME  || 'QFwork.ai',
      email: process.env.BREVO_SENDER_EMAIL
    },
    to: [{ email: process.env.MANAGER_EMAIL }]
  });
}

async function sendHireFailureEmail(session, errorMessage, cvText) {
  const brevo = new Brevo.BrevoClient({ apiKey: process.env.BREVO_API_KEY });

  const cvBlock = cvText
    ? `<h3>Candidate's CV</h3>
       <pre style="white-space:pre-wrap; font-family:monospace; font-size:12px; background:#f6f8fa; padding:14px; border-radius:8px; border:1px solid #e7eaee; max-height:500px; overflow:auto;">${escapeHtml(cvText)}</pre>`
    : `<p style="color:#667085; font-style:italic;">No CV was provided.</p>`;

  await brevo.transactionalEmails.sendTransacEmail({
    subject: `Interview completed (report failed) — ${session.candidateName}`,
    htmlContent: `
      <div style="font-family:sans-serif;max-width:600px;">
        <h2>Interview completed — report generation failed</h2>
        <p><strong>Candidate:</strong> ${escapeHtml(session.candidateName)}</p>
        <p><strong>Email:</strong> ${escapeHtml(session.candidateEmail)}</p>
        <p><strong>Session time:</strong> ${new Date().toLocaleString()}</p>

        <p style="margin-top:18px;">
          The candidate completed the AI interview. However, the automated report could
          not be generated because the analysis service returned an error.
        </p>

        <p style="background:#fef2f2; border:1px solid #fecaca; color:#b42318; padding:12px; border-radius:8px; font-family:monospace; font-size:12px;">
          ${escapeHtml(errorMessage || 'Unknown error')}
        </p>

        <p style="color:#667085;font-size:13px;">
          You may want to follow up with the candidate directly, or re-run the report
          if the issue is temporary.
        </p>

        ${cvBlock}
      </div>
    `,
    sender: {
      name:  process.env.BREVO_SENDER_NAME  || 'QFwork.ai',
      email: process.env.BREVO_SENDER_EMAIL
    },
    to: [{ email: process.env.MANAGER_EMAIL }]
  });
}

// ── Route mounting ───────────────────────────────────────────
function attach(app) {

  app.get('/api/hire/verify-token', (req, res) => {
    const { token } = req.query;

    if (!token || !hiringTokens().has(token)) {
      return res.status(403).json({ ok: false, error: 'Invalid link.' });
    }

    if (hiringSessions.has(token)) {
      return res.status(403).json({ ok: false, error: 'This link has already been used.' });
    }

    return res.json({ ok: true });
  });

  app.post('/api/hire/start', async (req, res) => {
    const { name, email, token, cvText } = req.body;

    if (!token || !hiringTokens().has(token)) {
      return res.status(403).json({ error: 'Invalid token.' });
    }
    if (hiringSessions.has(token)) {
      return res.status(403).json({ error: 'This link has already been used.' });
    }

    try {
      const context = `
        You are conducting a screening interview for a marketing role. The candidate's name is ${name}.

        Follow this flow:
        1. OPENING — Greet them warmly and ask them to introduce themselves. ("Tell me a bit about yourself and your marketing background.")
        2. EXPERIENCE — Ask about specific campaigns they have run. Probe for:
            - What the campaign was
            - What metrics they moved (conversion rates, ROAS, traffic, engagement)
            - What tools they used (Google Analytics, HubSpot, SEO, paid ads, email marketing)
            - What they would do differently
        3. STRATEGY — Ask how they would approach a new market or product launch. Probe their reasoning.
        4. CLOSING — Thank them and tell them the hiring manager will review the interview and be in touch.

        RULES:
        - Ask ONE question at a time.
        - Keep each turn to 1-2 sentences.
        - React briefly to what they say before asking the next question.
        - Never give feedback, corrections, or scores during the call.
        - If they pause to think, wait patiently. Don't fill silence.
        - After 4-5 minutes, move to the closing phase naturally.
      `;

      let contextWithCv = context;
      if (cvText && cvText.trim()) {
        contextWithCv += `\n\nThe candidate has uploaded their CV. Use it to tailor your questions — ask about specific roles, projects, skills, or transitions mentioned in the CV. Do NOT read the CV back verbatim or ask them to summarise it. CV content:\n"""\n${cvText.trim().slice(0, 5000)}\n"""`;
      }

      const convo = await createConversation({
        conversationName: `Hiring — ${name}`,
        conversationalContext: contextWithCv,
        customGreeting: `Hi ${name}, thanks for taking the time. Let's start — could you tell me a bit about yourself and your marketing background?`,
        personaId: process.env.TAVUS_HIRE_PERSONA_ID,
        maxSeconds: parseInt(process.env.TAVUS_HIRE_MAX_SECONDS || '600', 10)
      });

      hiringSessions.set(token, {
        candidateName: name,
        candidateEmail: email,
        conversationId: convo.conversation_id,
        usedAt: new Date().toISOString()
      });
      saveHiringSessions();

      // Store the CV in memory only — never persisted
      if (cvText && cvText.trim()) {
        cvStore.set(token, cvText.trim().slice(0, 5000));
      }

      res.json({
        conversationId: convo.conversation_id,
        conversationUrl: convo.conversation_url
      });
    } catch (error) {
      console.error('[hire] start error:', error.message);
      res.status(502).json({ error: error.message });
    }
  });

  app.post('/api/hire/feedback', async (req, res) => {
    const { conversationId } = req.body;

    let session = null, sessionToken = null;
    for (const [token, s] of hiringSessions) {
      if (s.conversationId === conversationId) {
        session = s; sessionToken = token; break;
      }
    }
    if (!session) return res.status(404).json({ error: 'Session not found.' });
    // Retrieve the CV from memory and wipe it
    const cvText = cvStore.get(sessionToken) || '';
    cvStore.delete(sessionToken);
    res.json({ ok: true, message: 'Processing in the background.' });

    (async () => {
      try {
        await endConversation(conversationId);

        let result = { userText: '', dialogue: '' };
        for (let i = 0; i < 20; i++) {
          await sleep(3000);
          result = await getConversationTranscript(conversationId);
          if (result.userText && result.userText.length >= 15) break;
        }

        if (!result.userText || result.userText.length < 15) {
          console.warn(`[hire] no usable transcript for ${conversationId}`);
          try {
            await sendNoTranscriptEmail(session, cvText);
            console.log(`[hire] no-transcript notice sent for ${session.candidateName}`);
          } catch (e) {
            console.error('[hire] failed to send no-transcript notice:', e.message);
          }
          return;
        }

        const report = await generateHiringReport({
          transcript: result.userText,
          candidateName: session.candidateName,
          cvText: cvText
        });

        await sendHiringReportEmail(session, report);
        hiringSessions.delete(sessionToken);
        saveHiringSessions();
        console.log(`[hire] report sent for ${session.candidateName}`);
      } catch (e) {
        console.error('[hire] background processing failed:', e.message);
        try {
          await sendHireFailureEmail(session, e.message, cvText);
          console.log(`[hire] failure notice sent for ${session.candidateName}`);
        } catch (emailErr) {
          console.error('[hire] failed to send failure notice:', emailErr.message);
        }
      }
    })();
  });

  app.get('/api/hire/config', (req, res) => {
    res.json({
      calendlyFollowupUrl: process.env.CALENDLY_FOLLOWUP_URL || ''
    });
  });
}

module.exports = { attach };