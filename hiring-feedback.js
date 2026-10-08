const fetch = require('node-fetch');

async function generateHiringReport({ transcript, candidateName, cvText }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const systemPrompt = `You are an expert marketing hiring manager. Analyze this interview transcript.

    ${cvText ? `The candidate has provided a CV. Assess whether their spoken answers aligned with and were supported by the CV. Note any gaps or over-claims.\n` : ''}
    
    Assess the candidate on:
    1. CAMPAIGN EXPERIENCE — specific campaigns, metrics moved, results
    2. TECHNICAL SKILLS — tools (Google Analytics, HubSpot, SEO, paid ads)
    3. STRATEGIC THINKING — how they approach problems
    4. COMMUNICATION — clarity, structure, confidence

    Return JSON:
    {
        "overallScore": <0-100>,
        "recommendation": "<Strong Yes / Yes / No / Strong No>",
        "summary": "<2-3 sentences>",
        "strengths": ["<strength with quote>", ...],
        "concerns": ["<concern with quote>", ...],
        "campaignExperience": "<assessment>",
        "technicalSkills": "<assessment>",
        "strategicThinking": "<assessment>",
        "communication": "<assessment>"
    }`;

    const userMessage = `Candidate: ${candidateName}
    Role: Marketing role

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