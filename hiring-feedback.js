const fetch = require('node-fetch');

async function generateHiringReport({ transcript, candidateName, cvText }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const systemPrompt = `You are an experienced marketing hiring manager at QFwork, a Hong Kong AI workplace-communication startup.
    
    You are evaluating a candidate for a FREELANCE marketing role supporting QFwork's brand and promotions. This is a hands-on content role, not a strategic or performance-marketing role.

    The role requires:
    - Driving branding and product marketing through online campaigns
    - Setting up and managing social media accounts (Instagram, LinkedIn, Rednote)
    - Planning, designing, and posting 1-2 pieces of social content per week (posts / reels)
    - Ongoing design support
    - Design tools: Canva, Adobe Illustrator, Figma
    - Comfortable in a flexible early-stage startup, takes ownership, respects deadlines, communicates proactively
    - Video editing (CapCut / Premiere Pro) is a plus
    - Proficient in written Chinese AND English

    The transcript of the candidate's interview is provided.

    ${cvText ? `The candidate has provided a CV. It may be in Chinese — read it in its original language and assess whether their spoken English answers align with and are supported by the CV. Do NOT penalise the candidate for the CV being in Chinese — that's expected. The interview is conducted in English, so assess the interview in English. Note any gaps, over-claims, or missed opportunities to draw on their own experience.\n` : ''}
    
    Assess the candidate on:
    1. CONTENT & PORTFOLIO — Did they describe actual posts, reels, or designs they have made? Specific examples beat vague claims.
    2. PLATFORM KNOWLEDGE — Do they know Instagram, LinkedIn, Rednote? Do they understand cadence, format, and audience?
    3. DESIGN TOOLS — Which tools do they use (Canva, Figma, Illustrator)? At what level of proficiency?
    4. BILINGUAL ABILITY — Did they demonstrate written Chinese and English? Reference any evidence from the interview.
    5. STARTUP FIT — Did they show ownership, flexibility, and proactive communication? Do they work well in a small, fast-moving environment?
    6. COMMUNICATION — Clarity, structure, confidence in the interview itself.

    Do NOT penalise the candidate for lacking ROAS, conversion rate, paid-ads, or enterprise marketing experience — those are not relevant to this role.

    Return JSON:
    {
      "overallScore": <0-100>,
      "recommendation": "<Strong Yes / Yes / No / Strong No>",
      "summary": "<2-3 sentences>",
      "strengths": ["<strength with quote>", ...],
      "concerns": ["<concern with quote>", ...],
      "contentAndPortfolio": "<assessment>",
      "platformKnowledge": "<assessment>",
      "designTools": "<assessment>",
      "bilingualAbility": "<assessment>",
      "startupFit": "<assessment>",
      "communication": "<assessment>"
    }`;

    const userMessage = `Candidate: ${candidateName}
    Role: Marketing role at QFwork

    ${cvText ? `CANDIDATE'S CV:\n"""\n${cvText}\n"""\n\n` : ''}

    TRANSCRIPT:
    "${transcript}"

    Analyze and return JSON.`;

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model:       process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
      temperature: 0.4,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ]
    })
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    const msg = errData.error?.message || response.statusText;
    console.error(`[hire] Groq ${response.status}:`, msg);
    throw new Error(`Groq error ${response.status}: ${msg}`);
  }
  const data = await response.json();
  return JSON.parse(data.choices[0].message.content);
}

module.exports = { generateHiringReport };