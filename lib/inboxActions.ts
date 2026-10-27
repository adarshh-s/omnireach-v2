import { getSupabaseAdmin } from './supabaseAdmin.js';
import { getOrgChannelSettings, getOrgProfile } from './orgSettings.js';
import { sendWhatsAppText } from './whatsappSender.js';
import { sendEmailViaOrgProvider } from './emailSender.js';
import { buildEmailReplyToAddress } from './emailWebhookHandler.js';
import { recordUsage } from './usage.js';
import { logAudit, AuditActor } from './auditLog.js';

/**
 * A person on the team taking over a conversation in the AI Inbox: replying themselves on
 * WhatsApp or email, and pausing / resuming the AI for that conversation. Replying pauses the
 * AI too, so it doesn't talk over the teammate. While paused, the lead's messages are still
 * saved and the team is alerted (lib/teamAlerts.ts); STOP still opts them out.
 */

type Channel = 'whatsapp' | 'email';
const TABLE: Record<Channel, string> = { whatsapp: 'whatsapp_conversations', email: 'email_conversations' };
// WhatsApp only delivers free text within 24 hours of the lead's last message.
const WHATSAPP_WINDOW_MS = 24 * 3_600_000;

export interface InboxResult {
  ok: boolean;
  error?: string;
  conversation?: any;
}

async function loadConversation(orgId: string, channel: Channel, id: string) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !TABLE[channel] || !id) return null;
  const { data } = await supabase.from(TABLE[channel]).select('*').eq('id', id).eq('org_id', orgId).maybeSingle();
  return data;
}

export async function setAiPaused(orgId: string, actor: AuditActor, channel: Channel, id: string, paused: boolean): Promise<InboxResult> {
  const supabase = getSupabaseAdmin();
  const conv = await loadConversation(orgId, channel, id);
  if (!supabase || !conv) return { ok: false, error: 'Conversation not found.' };
  const { data } = await supabase
    .from(TABLE[channel])
    .update({
      ai_paused: paused,
      ai_paused_by: paused ? actor.email || null : null,
      // Resuming hands it back to the AI, so it's no longer waiting on a person.
      ...(!paused && conv.status === 'handoff' ? { status: 'active' } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('org_id', orgId)
    .select('*')
    .maybeSingle();
  await logAudit(orgId, actor, paused ? 'inbox.ai_paused' : 'inbox.ai_resumed', conv.lead_name || conv.phone || conv.client_email, { channel });
  return { ok: true, conversation: data };
}

export async function replyAsTeammate(orgId: string, actor: AuditActor, channel: Channel, id: string, rawText: string): Promise<InboxResult> {
  const supabase = getSupabaseAdmin();
  const text = String(rawText || '').trim();
  if (!text) return { ok: false, error: 'Write a message first.' };
  if (text.length > 4000) return { ok: false, error: 'That message is too long (4,000 characters max).' };
  const conv = await loadConversation(orgId, channel, id);
  if (!supabase || !conv) return { ok: false, error: 'Conversation not found.' };

  const settings = await getOrgChannelSettings(orgId);
  const history: any[] = conv.history || [];

  if (channel === 'whatsapp') {
    const lastFromLead = Math.max(0, ...history.filter((h) => h?.role === 'user' && h.timestamp).map((h) => new Date(h.timestamp).getTime()));
    if (!lastFromLead || Date.now() - lastFromLead > WHATSAPP_WINDOW_MS) {
      return {
        ok: false,
        error: "WhatsApp only allows a free reply within 24 hours of the lead's last message. Reply by email, or wait for them to write again.",
      };
    }
    const sent = await sendWhatsAppText(settings?.whatsappCloudApiKey, settings?.whatsappCloudPhoneId, conv.phone, text);
    if (!sent.ok) return { ok: false, error: sent.error || 'WhatsApp did not accept the message.' };
    await recordUsage(orgId, 'whatsapp');
  } else {
    const profile = await getOrgProfile(orgId);
    const base = String(conv.subject || 'our conversation').replace(/^(re:\s*)+/i, '');
    const sent = await sendEmailViaOrgProvider(settings, {
      to: conv.client_email,
      toName: conv.lead_name || undefined,
      subject: `Re: ${base}`,
      body: text,
      fromName: profile?.senderName || profile?.companyName || actor.email || 'Team',
      fromAddress: profile?.senderEmail,
      replyTo: buildEmailReplyToAddress(conv.campaign_recipient_id, conv.client_id) || undefined,
      orgId,
    });
    if (!sent.ok) return { ok: false, error: sent.error || 'The email could not be sent.' };
    await recordUsage(orgId, 'emails');
  }

  const now = new Date().toISOString();
  const { data } = await supabase
    .from(TABLE[channel])
    .update({
      history: [...history, { role: 'assistant', text, timestamp: now, by: 'human', author: actor.email || null }],
      // The teammate is handling it now — the AI stays out until it's resumed.
      ai_paused: true,
      ai_paused_by: actor.email || null,
      last_message_at: now,
      updated_at: now,
    })
    .eq('id', id)
    .eq('org_id', orgId)
    .select('*')
    .maybeSingle();
  await logAudit(orgId, actor, 'inbox.reply', conv.lead_name || conv.phone || conv.client_email, { channel });
  return { ok: true, conversation: data };
}
