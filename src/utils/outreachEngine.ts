import { Lead, MessageTemplate, CampaignSettings, CalendarSlot } from '../types';

/**
 * Replaces placeholders in a template with actual lead & campaign data.
 * Variables supported:
 * {{name}}, {{first_name}}, {{company}}, {{email}}, {{phone}},
 * {{company_name}}, {{sender_name}}, {{sender_email}}, {{sender_phone}}
 *
 * There is no {{booking_link}} — this product has no self-service scheduling page.
 * Booking happens conversationally: the lead replies with a day/time and the AI
 * booking bot (see lib/conversationEngine.ts) confirms it directly on the calendar.
 */
export function interpolateTemplate(
  templateText: string,
  lead: Lead,
  settings: CampaignSettings,
  availableSlots: CalendarSlot[] = []
): string {
  if (!templateText) return '';

  const firstName = (lead.name || 'there').split(' ')[0];

  let text = templateText;
  text = text.replace(/{{name}}/gi, lead.name || 'there');
  text = text.replace(/{{first_name}}/gi, firstName);
  text = text.replace(/{{company}}/gi, lead.company || 'your team');
  text = text.replace(/{{email}}/gi, lead.email || '');
  text = text.replace(/{{phone}}/gi, lead.phone || '');
  text = text.replace(/{{company_name}}/gi, settings.companyName || 'our company');
  text = text.replace(/{{sender_name}}/gi, settings.senderName || 'our team');
  text = text.replace(/{{sender_email}}/gi, settings.senderEmail || '');
  text = text.replace(/{{sender_phone}}/gi, settings.senderPhone || '');
  // Legacy placeholder from an earlier prototype that pointed at a non-existent
  // scheduling page — strip it out so any custom template still using it doesn't 404.
  text = text.replace(/{{booking_link}}/gi, '');

  return text;
}

/**
 * Resolves an ordered list of WhatsApp approved-template variable definitions
 * (each entry may contain {{name}}/{{company}}/etc tokens, or be literal text)
 * into the actual values to send as positional template parameters.
 */
export function resolveTemplateVariables(
  variableDefs: string[],
  lead: Lead,
  settings: CampaignSettings,
  availableSlots: CalendarSlot[] = []
): string[] {
  return (variableDefs || []).map((def) => interpolateTemplate(def, lead, settings, availableSlots));
}

/**
 * Generates direct WhatsApp click-to-chat web URLs:
 * e.g. https://wa.me/919876543211?text=Hi%20Alex...
 */
export function generateWhatsAppLink(phoneNumber: string, messageText: string): string {
  const digitsOnly = (phoneNumber || '').replace(/\D/g, '');
  const encodedText = encodeURIComponent(messageText);
  return `https://wa.me/${digitsOnly}?text=${encodedText}`;
}

/**
 * Generates direct Mailto link:
 * e.g. mailto:alex@example.com?subject=...&body=...
 */
export function generateMailtoLink(email: string, subject: string, body: string): string {
  const encodedSubject = encodeURIComponent(subject);
  const encodedBody = encodeURIComponent(body);
  return `mailto:${email}?subject=${encodedSubject}&body=${encodedBody}`;
}

/**
 * Generates AI-personalized message using server API with graceful client fallback
 */
export async function generateAIPersonalizedMessage(
  lead: Lead,
  settings: CampaignSettings,
  template?: MessageTemplate,
  availableSlots: CalendarSlot[] = [],
  accessToken?: string | null
): Promise<{ whatsApp: string; emailSubject: string; emailBody: string }> {
  try {
    const res = await fetch('/api/outreach/generate-message', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({
        lead,
        settings,
        template,
        availableSlots,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.whatsApp && data.emailSubject && data.emailBody) {
        return data;
      }
    }
  } catch (e) {
    console.warn('Using client template generator:', e);
  }

  // Fallback to local interpolation
  if (template) {
    return {
      whatsApp: interpolateTemplate(template.whatsAppContent, lead, settings, availableSlots),
      emailSubject: interpolateTemplate(template.emailSubject, lead, settings, availableSlots),
      emailBody: interpolateTemplate(template.emailBody, lead, settings, availableSlots),
    };
  }

  const firstName = (lead.name || 'there').split(' ')[0];
  const senderLabel = settings.senderName || 'our team';
  const companyLabel = settings.companyName || 'our company';

  return {
    whatsApp: `Hi ${firstName} 👋! ${senderLabel} from ${companyLabel} here. We'd love to connect with ${lead.company}. Open to a quick call? Just reply with a day/time that works and I'll lock it in!`,
    emailSubject: `Quick intro for ${lead.company}`,
    emailBody: `Hi ${firstName},\n\nI hope you're doing well.\n\nI'm reaching out from ${companyLabel}. Would you have 10 minutes this week for a quick walk-through?\n\nJust reply with a day/time that works for you and I'll get it on the calendar.\n\nBest,\n${senderLabel}`,
  };
}

/**
 * Generates an AI reply to a prospect's WhatsApp/Email message
 */
export async function generateAIAutoReply(
  incomingMessage: string,
  lead: Lead,
  settings: CampaignSettings,
  availableSlots: CalendarSlot[] = [],
  accessToken?: string | null
): Promise<string> {
  try {
    const res = await fetch('/api/ai/auto-reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({
        incomingMessage,
        lead,
        settings,
        availableSlots,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.reply) {
        return data.reply;
      }
    }
  } catch (err) {
    console.warn('AI reply fallback:', err);
  }

  const lower = (incomingMessage || '').toLowerCase();

  if (lower.includes('price') || lower.includes('cost') || lower.includes('how much')) {
    return `Our plans start at flexible tiering based on your contact volume. We'd love to show you an exact breakdown for ${lead.company}. Would you be free for a quick call? Just reply with a day/time that works!`;
  }

  if (lower.includes('yes') || lower.includes('interested') || lower.includes('sure') || lower.includes('demo')) {
    return `Awesome! Just reply with a day/time that works for you and I'll get it on the calendar. Looking forward to speaking!`;
  }

  if (lower.includes('not interested') || lower.includes('stop') || lower.includes('unsubscribe')) {
    return `Understood! I've removed your contact from our outreach list. Wishing you and ${lead.company} all the best!`;
  }

  return `Thanks for getting back to us, ${lead.name.split(' ')[0]}! Would Thursday at 11:00 AM or Friday at 3:00 PM work for a quick call? Or just reply with a time that suits you better.`;
}
