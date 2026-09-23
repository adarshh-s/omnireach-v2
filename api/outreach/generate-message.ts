import { GoogleGenAI } from '@google/genai';
import { generateViaGroq } from '../../lib/groqClient.js';
import { getOrgIdFromAuthHeader } from '../../lib/supabaseServerAuth.js';

interface ApiRequest {
  method?: string;
  body?: any;
  headers?: Record<string, string | string[] | undefined>;
}

interface ApiResponse {
  status: (code: number) => ApiResponse;
  json: (data: unknown) => void;
  setHeader?: (name: string, value: string) => void;
}

function interpolate(templateText: string, vars: Record<string, string>): string {
  if (!templateText) return '';
  let result = templateText;
  for (const [key, value] of Object.entries(vars)) {
    const reg = new RegExp(`{{${key}}}`, 'gi');
    result = result.replace(reg, value || '');
  }
  return result;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method === 'OPTIONS') {
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Without this, anyone who finds this URL could burn through the platform's shared
  // Gemini/Groq quota for free — this endpoint has no per-org cost of its own otherwise,
  // so an unauthenticated caller could generate unlimited messages at the platform's expense.
  const orgId = await getOrgIdFromAuthHeader(req.headers?.authorization as string | undefined);
  if (!orgId) {
    return res.status(401).json({ error: 'Sign in required.' });
  }

  try {
    const { lead, settings, template } = req.body || {};

    const clientCompany = lead?.company || 'their organization';
    const clientName = lead?.name || 'there';
    const firstName = clientName.split(' ')[0];
    const companyName = settings?.companyName || 'our company';
    const senderName = settings?.senderName || 'our team';
    const senderEmail = settings?.senderEmail || '';
    const senderPhone = settings?.senderPhone || '';
    const leadNotes = lead?.notes || lead?.industry || 'B2B outreach prospect';

    const vars: Record<string, string> = {
      name: lead?.name || 'there',
      first_name: firstName,
      company: clientCompany,
      email: lead?.email || '',
      phone: lead?.phone || '',
      company_name: companyName,
      sender_name: senderName,
      sender_email: senderEmail,
      sender_phone: senderPhone,
    };

    const prompt = `You are an expert B2B copywriter specialized in high-converting WhatsApp messages and cold/warm outreach emails.
Generate a personalized WhatsApp message AND Email for this prospect:
- Client Name: ${lead?.name || 'Prospect'}
- Client Company: ${clientCompany}
- Client Email: ${lead?.email || ''}
- Client Phone: ${lead?.phone || ''}
- Context/Notes: "${leadNotes}"
- Sender Company: ${companyName}
- Sender Name: ${senderName}
- Value Prop: ${settings?.serviceDescription || 'Outreach automation synced with Google Calendar and spreadsheets'}
- Custom Instructions: "${settings?.customInstructions || 'Keep it friendly, high-value, crisp, and direct.'}"
${template ? `- Base Template Guidance:\nWhatsApp Base: ${template.whatsAppContent}\nEmail Subject Base: ${template.emailSubject}\nEmail Body Base: ${template.emailBody}` : ''}

There is no booking link or scheduling page — do NOT invent or include one. Instead, the
call to action must ask the prospect to simply reply with a day/time that works for them;
an AI assistant will read their reply and confirm the meeting directly on the calendar.

Output strict JSON with these 3 keys:
{
  "whatsApp": "A concise, engaging WhatsApp message formatted with natural emojis, bolding (*text*), ending with a call-to-action to reply with a day/time that works",
  "emailSubject": "High-open rate email subject line (under 60 chars)",
  "emailBody": "Clear, professional, punchy email with greeting, value prop, bullet points, a call-to-action asking them to reply with a day/time that works, and sender sign-off"
}`;

    let aiResult: { whatsApp?: string; emailSubject?: string; emailBody?: string } | null = null;

    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      try {
        const ai = new GoogleGenAI({
          apiKey,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build',
            },
          },
        });

        const response = await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
          },
        });

        const parsed = JSON.parse(response.text || '{}');
        if (parsed.whatsApp && parsed.emailSubject && parsed.emailBody) {
          aiResult = parsed;
        }
      } catch (geminiError) {
        console.warn('Gemini generation failed, trying Groq fallback:', geminiError);
      }
    }

    // Groq (free tier, much higher daily ceiling) — tried whenever Gemini didn't produce a
    // usable result, whether that's a quota/overload failure or GEMINI_API_KEY being unset.
    if (!aiResult && process.env.GROQ_API_KEY) {
      try {
        const { text } = await generateViaGroq(prompt);
        const parsed = JSON.parse(text || '{}');
        if (parsed.whatsApp && parsed.emailSubject && parsed.emailBody) {
          aiResult = parsed;
        }
      } catch (groqError) {
        console.warn('Groq generation fallback failed:', groqError);
      }
    }

    if (aiResult) {
      return res.status(200).json({
        whatsApp: aiResult.whatsApp,
        emailSubject: aiResult.emailSubject,
        emailBody: aiResult.emailBody,
        isAiGenerated: true,
      });
    }

    // Fallback template interpolation
    if (template) {
      return res.status(200).json({
        whatsApp: interpolate(template.whatsAppContent, vars),
        emailSubject: interpolate(template.emailSubject, vars),
        emailBody: interpolate(template.emailBody, vars),
        isAiGenerated: false,
      });
    }

    // Standard fallback
    return res.status(200).json({
      whatsApp: `Hi ${firstName} 👋! ${senderName} from ${companyName} here. We noticed your work at *${clientCompany}* and wanted to share how you can automate client outreach directly from spreadsheets. Open to a quick call? Just reply with a day/time that works and I'll lock it in!`,
      emailSubject: `Automating outreach workflow for ${clientCompany}`,
      emailBody: `Hi ${firstName},\n\nI hope you're having a productive week.\n\nI'm reaching out from ${companyName}. We help teams at ${clientCompany} eliminate manual messaging by connecting spreadsheets directly to automated WhatsApp and Email dispatch.\n\nWould you be open to a brief 10-minute introduction this week?\n\nJust reply with a day/time that works for you and I'll get it on the calendar.\n\nBest regards,\n${senderName}\n${companyName}`,
      isAiGenerated: false,
    });
  } catch (error: any) {
    return res.status(500).json({
      error: error.message || 'Failed to generate message',
    });
  }
}
