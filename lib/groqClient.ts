// Groq's free tier (no card required) has a far higher daily request ceiling than
// Gemini's free tier, so it's used as a last-resort fallback wherever a Gemini call can
// fail — the 20/day free quota being exhausted, or a transient 503 overload.
const GROQ_MODEL = 'openai/gpt-oss-120b';

export async function generateViaGroq(prompt: string): Promise<{ text: string }> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not configured');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.65,
    }),
  });
  if (!res.ok) {
    throw new Error(`Groq API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return { text: data?.choices?.[0]?.message?.content || '' };
}
