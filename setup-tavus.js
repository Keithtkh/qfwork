// ============================================================
// One-time Tavus setup — run:  node setup-tavus.js
// ------------------------------------------------------------
// Creates BOTH QFwork personas and lists stock REPLICA faces,
// then prints the ids to paste into your .env:
//   TAVUS_PERSONA_ID=...               (interviewer — most scenarios)
//   TAVUS_PRESENTATION_PERSONA_ID=...  (executive audience — Business Presentation)
//   TAVUS_REPLICA_ID=...
// Requires TAVUS_API_KEY in .env first. Safe to re-run: existing
// personas with the same names are reused, not duplicated.
// ============================================================

require('dotenv').config();
const fetch = require('node-fetch');

const BASE = 'https://tavusapi.com/v2';
const key  = process.env.TAVUS_API_KEY;
const H    = { 'x-api-key': key, 'Content-Type': 'application/json' };

// Raven-1 vision: targeted end-of-call questions → a HIGH-QUALITY, focused
// presence analysis (instead of Tavus's generic default summary). These are
// answered once, at the end, from the whole conversation, and shape the
// application.perception_analysis event we read for feedback.
// NOTE: without this layer the presence section of the report stays EMPTY —
// the server also self-checks this at boot (see tavus.js ensurePerceptionLayer).
const PERCEPTION = {
  perception_model: 'raven-1',
  perception_analysis_queries: [
    "Eye contact: Did the candidate maintain steady, direct eye contact with the camera, or did they frequently look away, down, or around? Describe how their eye contact changed across the conversation.",
    "Facial expression: What expressions did the candidate show while speaking and listening — engaged and animated, neutral and flat, tense or anxious, or warm and smiling? Note changes at key moments.",
    "Body language: Describe the candidate's posture and body language — upright and composed, relaxed, stiff, slouching, leaning, or fidgeting. Note any repeated or distracting gestures, and whether their hands/movements supported or undercut their message.",
    "Confidence and composure: Overall, did the candidate appear confident and at ease on camera, or visibly nervous and uncomfortable? Cite the specific visual signals you based this on.",
    "Engagement: How engaged and present did the candidate seem throughout — actively listening and reacting to the interviewer, or distracted, disengaged, or looking elsewhere?"
  ]
};

// Natural, emotion-capable voice + the speed/quality-balanced LLM.
// LLM inference is the dominant latency cost in the CVI pipeline;
// `tavus-gemini-2.5-flash` is much faster than the deprecated
// `tavus-gpt-5.2` while keeping strong reasoning for the role-play.
// speculative_inference (LLM starts before the user finishes speaking)
// is the single biggest perceived-latency win — keep it ON.
const TTS = { tts_engine: 'cartesia', tts_model_name: 'sonic-3', tts_emotion_control: true };
const LLM = { model: 'tavus-gemini-2.5-flash', speculative_inference: true };

const PERSONAS = [
  {
    envVar: 'TAVUS_PERSONA_ID',
    body: {
      persona_name: 'QFwork Interviewer',
      system_prompt:
        'You are a professional but friendly workplace-English interview partner for QFwork.ai. ' +
        'You run realistic spoken practice — interviews, salary negotiations and client meetings — ' +
        'to help the candidate improve their professional spoken English. Speak naturally and conversationally, ' +
        'ask ONE thing at a time, keep your turns short (1-3 sentences), and ask natural follow-up questions based ' +
        'on what the candidate actually says. The specific situation and your opening line are provided per conversation. ' +
        'Never break character, and never give feedback, corrections or scores during the conversation — that happens afterwards.',
      context: 'QFwork.ai helps Hong Kong professionals practise workplace English through realistic spoken role-play.',
      pipeline_mode: 'full',
      layers: {
        perception: PERCEPTION,
        tts: TTS,
        llm: LLM,
        stt:  { stt_engine: 'tavus-advanced', participant_pause_sensitivity: 'medium',
                participant_interrupt_sensitivity: 'medium', smart_turn_detection: true },
        conversational_flow: { turn_detection_model: 'sparrow-1', turn_taking_patience: 'medium',
                               replica_interruptibility: 'medium', voice_isolation: 'near' }
      }
    }
  },
  {
    envVar: 'TAVUS_PRESENTATION_PERSONA_ID',
    body: {
      persona_name: 'QFwork Presentation Exec',
      // A PRESENTATION AUDIENCE, not an interviewer: patient turn-taking so the
      // presenter can pause and think without being jumped on, and a phased
      // script — brief them in, stay quiet through the delivery (only nudging
      // or briefly reacting if they stall), then grill them in Q&A.
      system_prompt:
        'You are a senior business executive listening to a live practice presentation for QFwork.ai. ' +
        'This is a PRESENTATION, not an interview — the presenter holds the floor and you are the audience. ' +
        'PHASES: (1) BRIEF: after your opening line, if they have not yet said what they are presenting, ask; ' +
        'then hand them the floor ("Go ahead — the floor is yours.") and go quiet. ' +
        '(2) DELIVERY: while they present, do NOT ask questions and do NOT take over the conversation. ' +
        'If they pause briefly, stay silent and let them think. If a pause stretches long and they have not asked you anything, ' +
        'respond with ONE short sentence only: either invite them to continue ("Please, carry on — you were on the cost savings."), ' +
        'or give one brief, specific reaction to something they actually said ("That 30% figure is compelling.") and then ask them to continue. ' +
        'Never turn a delivery pause into a question round. If they ask you a direct question mid-delivery, answer briefly and return the floor. ' +
        '(3) Q&A: only when they clearly wrap up ("that\'s it", "thank you", "happy to take questions", or they have plainly finished) ' +
        'switch to executive Q&A: probing, businesslike questions ONE at a time — test a number, ask "so what?", challenge a risk or a next step. ' +
        'Push back once or twice like a real time-pressed executive, but stay professional, fair and courteous. ' +
        'STYLE: busy, sharp, courteous executive; every turn 1-2 sentences. Never give feedback, corrections, language coaching or scores ' +
        'during the call — that happens afterwards. The specific situation and your opening line are provided per conversation.',
      context: 'QFwork.ai helps Hong Kong professionals practise workplace English through realistic spoken role-play.',
      pipeline_mode: 'full',
      layers: {
        perception: PERCEPTION,
        tts: TTS,
        llm: LLM,
        // LOW pause sensitivity + HIGH patience → the AI tolerates long
        // thinking pauses mid-presentation instead of grabbing the turn.
        // HIGH interruptibility → the presenter can talk over the exec's
        // brief interjections and immediately reclaim the floor.
        stt:  { stt_engine: 'tavus-advanced', participant_pause_sensitivity: 'low',
                participant_interrupt_sensitivity: 'medium', smart_turn_detection: true },
        conversational_flow: { turn_detection_model: 'sparrow-1', turn_taking_patience: 'high',
                               replica_interruptibility: 'high', voice_isolation: 'near' }
      }
    }
  },
  {
    envVar: 'TAVUS_HIRE_PERSONA_ID',
    body: {
      persona_name: 'QFwork Marketing Hiring Manager',
      system_prompt:
        'You are a senior marketing hiring manager conducting a screening interview. ' +
        'Your goal is to assess the candidate\'s marketing experience, strategic thinking, and communication skills. ' +
        'PHASES: (1) OPENING — greet warmly, ask them to introduce themselves. ' +
        '(2) EXPERIENCE — ask about specific marketing campaigns they have run, metrics they have moved (conversion rates, ROAS, traffic), and tools they use (Google Analytics, HubSpot, SEO, paid ads). ' +
        '(3) STRATEGY — ask how they approach a new market or product launch. Probe their thinking. ' +
        '(4) CLOSING — thank them and tell them the hiring manager will review the interview. ' +
        'Ask ONE question at a time, keep turns to 1-2 sentences, be professional but warm. ' +
        'Never give feedback or scores during the call.',
      context: 'QFwork.ai is a Hong Kong company hiring marketing talent for workplace English training tools.',
      pipeline_mode: 'full',
      layers: {
        perception: PERCEPTION,
        tts: TTS,
        llm: LLM,
        stt: { stt_engine: 'tavus-auto', participant_pause_sensitivity: 'medium',
              participant_interrupt_sensitivity: 'medium', smart_turn_detection: true },
        conversational_flow: { turn_detection_model: 'sparrow-1', turn_taking_patience: 'medium',
                              replica_interruptibility: 'medium', voice_isolation: 'near' }
        }
    }
  }
];

async function ensurePersona({ envVar, body }) {
  // Reuse an existing persona with the same name — safe to re-run.
  // (persona_type=user is required: the default listing only returns
  // Tavus's stock personas, not the ones this account created.)
  const lr = await fetch(`${BASE}/personas?persona_type=user&limit=100`, { headers: H });
  if (!lr.ok) throw new Error(`Could not list personas (${lr.status}): ${(await lr.text()).slice(0, 200)}`);
  const ldata = await lr.json().catch(() => ({}));
  const existing = (ldata.data || []).find(p => (p.persona_name || '') === body.persona_name);
  if (existing) {
    console.log(`Reusing existing persona "${body.persona_name}": ${existing.persona_id}`);
    return { envVar, id: existing.persona_id };
  }
  const r = await fetch(`${BASE}/personas`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Persona "${body.persona_name}" creation failed (${r.status}): ${JSON.stringify(data).slice(0, 300)}`);
  const id = data.persona_id || data.id;
  console.log(`Created persona "${body.persona_name}": ${id}`);
  return { envVar, id };
}

async function main() {
  if (!key) {
    console.error('❌  Set TAVUS_API_KEY in your .env first.');
    process.exit(1);
  }

  const results = [];
  for (const p of PERSONAS) results.push(await ensurePersona(p));

  console.log('\nAdd these to your .env and to your deployment environment variables:');
  for (const r of results) console.log(`    ${r.envVar}=${r.id}`);

  // List stock replicas so you can pick a face. Prefer phoenix-4 models —
  // Tavus's latest renderer (better lip-sync/expressions at lower latency).
  try {
    const rr = await fetch(`${BASE}/replicas?replica_type=system&verbose=true&limit=100`, { headers: H });
    const rdata = await rr.json().catch(() => ({}));
    const list = (rdata.data || rdata.replicas || []);
    const p4 = list.filter(r => (r.model_name || '') === 'phoenix-4').slice(0, 10);
    const show = p4.length ? p4 : list.slice(0, 10);
    if (show.length) {
      console.log(`\nStock replica faces${p4.length ? ' (phoenix-4)' : ''} - pick one for TAVUS_REPLICA_ID:`);
      for (const r of show) {
        console.log('    ' + (r.replica_id || r.id) + '   —   ' + (r.replica_name || r.name || ''));
      }
    } else {
      console.log('\n(Could not list replicas automatically - copy a replica_id from the Tavus dashboard.)');
    }
  } catch (_) {
    console.log('\n(Could not list replicas automatically - see the Tavus dashboard.)');
  }

  console.log('\nThen restart the server and confirm the Vision lines in the boot output.\n');
}

main().catch(e => { console.error(e); process.exit(1); });
