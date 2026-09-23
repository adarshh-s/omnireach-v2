import { GoogleGenAI } from '@google/genai';
import { getOrgIdFromAuthHeader } from '../../lib/supabaseServerAuth.js';

interface ApiRequest {
  method?: string;
  body?: any;
  headers?: Record<string, string | string[] | undefined>;
}

interface ApiResponse {
  status: (code: number) => ApiResponse;
  json: (data: unknown) => void;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method === 'OPTIONS') {
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Same reasoning as api/outreach/generate-message.ts: unauthenticated access here is
  // free, unlimited use of the platform's shared Gemini quota.
  const orgId = await getOrgIdFromAuthHeader(req.headers?.authorization as string | undefined);
  if (!orgId) {
    return res.status(401).json({ error: 'Sign in required.' });
  }

  try {
    const { incomingMessage, lead, settings } = req.body || {};

    const clientName = lead?.name || 'there';
    const firstName = clientName.split(' ')[0];
    const companyName = settings?.companyName || 'our company';

    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey && incomingMessage) {
      try {
        const ai = new GoogleGenAI({
          apiKey,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build',
            },
          },
        });

        const prompt = `A client named ${clientName} at company ${lead?.company || 'their firm'} replied to our outreach with:
"${incomingMessage}"

Our company: ${companyName}
Our value prop: ${settings?.serviceDescription || 'AI outreach and calendar booking automation'}

There is no booking link or scheduling page. Generate a concise, helpful, polite, and
persuasive response (under 75 words).
- If they are interested or asking for times: ask them to reply with a day/time that works for them so it can be confirmed directly on the calendar.
- If they ask about pricing or features: answer positively with general context and invite them to reply with a day/time for a quick call.
- If they say not interested or unsubscribe: acknowledge politely and confirm they are opted out.

Return strict JSON:
{
  "reply": "The response message text"
}`;

        const response = await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: prompt,
          config: { responseMimeType: 'application/json' },
        });

        try {
          const parsed = JSON.parse(response.text || '{}');
          if (parsed.reply) {
            return res.status(200).json({ reply: parsed.reply });
          }
        } catch {}
      } catch (geminiError) {
        console.warn('Gemini auto-reply fallback:', geminiError);
      }
    }

    const lower = (incomingMessage || '').toLowerCase();
    if (lower.includes('price') || lower.includes('cost')) {
      return res.status(200).json({
        reply: `Our pricing scales flexibly with your contact volume. We'd love to show you a quick breakdown for ${lead?.company || 'your team'} on a 10-minute call — just reply with a day/time that works!`,
      });
    }

    if (lower.includes('yes') || lower.includes('sure') || lower.includes('demo')) {
      return res.status(200).json({
        reply: `Awesome, ${firstName}! Just reply with a day/time that works for you and I'll get it on the calendar. Looking forward to connecting!`,
      });
    }

    return res.status(200).json({
      reply: `Thanks for the response, ${firstName}! Would Thursday at 11:00 AM or Friday at 3:00 PM work for a quick walk-through? Or just reply with a time that suits you better.`,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to generate auto-reply' });
  }
}
