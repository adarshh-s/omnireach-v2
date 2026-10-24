import { getSupabaseAdmin } from './supabaseAdmin.js';
import { getOrgChannelSettings, getOrgProfile } from './orgSettings.js';
import { sendCampaignWhatsAppMessage } from './whatsappCampaignSender.js';
import { sendEmailViaOrgProvider } from './emailSender.js';
import { seedConversationFromLead } from './whatsappWebhookHandler.js';
import { seedEmailConversationFromLead, buildEmailReplyToAddress } from './emailWebhookHandler.js';
import { enqueueRetryCall } from './callQueue.js';
import { isSuppressed } from './suppression.js';
import { withComplianceFooter, unsubscribeHeaders } from './emailCompliance.js';
import { recordUsage } from './usage.js';
import { DEFAULT_VOICE_FALLBACK_MESSAGE, type ChannelApiSettings, type CampaignSettings } from '../src/types.js';

/**
 * What happens after an outbound AI call nobody answered (no answer, busy, voicemail, or a
 * call that failed to connect): call again a few hours later, up to the org's number of
 * tries, then switch to WhatsApp (and email if WhatsApp can't reach them) with a short
 * "sorry I missed you" message the AI booking bot then picks up from.
 *
 * The call webhook decides what's next when a call ends (scheduleVoiceFollowUp): a retry is
 * queued in the call queue (lib/callQueue.ts), which places it once it's due — as punctual
 * as the scheduled dispatcher runs (every few minutes on Vercel Pro or an external pinger;
 * once a day on Hobby).
 *
 * voice_calls.followup_status: retry_scheduled → retried (a new call row carries on with
 * attempt + 1), or fallback_whatsapp / fallback_email / gave_up / stopped at the end.
 */

const UNANSWERED_OUTCOMES = new Set(['no-answer', 'busy', 'voicemail', 'failed']);
// A call that failed to connect (carrier or network error) is retried soon; a person who
// didn't pick up gets the org's longer gap.
const FAILED_RETRY_MINUTES = 10;

export interface VoiceFollowUpPlan {
  maxAttempts: number;
  retryHours: number;
  fallback: 'whatsapp_email' | 'email' | 'none';
}

export function voiceFollowUpPlan(settings: ChannelApiSettings | null | undefined): VoiceFollowUpPlan {
  return {
    maxAttempts: Math.min(5, Math.max(1, Math.round(settings?.voiceRetryAttempts ?? 3))),
    retryHours: Math.min(48, Math.max(1, settings?.voiceRetryHours ?? 3)),
    fallback: settings?.voiceFallback ?? 'whatsapp_email',
  };
}

function fillTokens(text: string, lead: { name?: string | null; company?: string | null }, profile: CampaignSettings | null): string {
  const name = (lead.name || '').trim();
  const values: Record<string, string> = {
    name: name || 'there',
    first_name: name.split(/\s+/)[0] || 'there',
    company: lead.company || '',
    company_name: profile?.companyName || 'our team',
    sender_name: profile?.senderName || profile?.companyName || 'our team',
  };
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => (key in values ? values[key] : match));
}

async function setFollowUp(callRowId: string, fields: Record<string, unknown>) {
  const supabase = getSupabaseAdmin();
  await supabase?.from('voice_calls').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', callRowId);
}

/** Called once per finished call (end-of-call webhook, or the stale-call reconciler). */
export async function scheduleVoiceFollowUp(callId: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  const { data: row } = await supabase.from('voice_calls').select('*').eq('vapi_call_id', callId).maybeSingle();
  if (!row || row.followup_status || row.direction === 'inbound' || row.status === 'confirmed') return;
  if (!UNANSWERED_OUTCOMES.has(row.outcome)) return;

  const settings = await getOrgChannelSettings(row.org_id);
  const plan = voiceFollowUpPlan(settings);
  const attempt = row.attempt || 1;

  if (attempt < plan.maxAttempts) {
    const delayMs = row.outcome === 'failed' ? FAILED_RETRY_MINUTES * 60_000 : plan.retryHours * 3_600_000;
    const nextAt = new Date(Date.now() + delayMs);
    // Claim it only if nothing else has (the webhook and the reconciler can both land here).
    const { data: claimed } = await supabase
      .from('voice_calls')
      .update({ followup_status: 'retry_scheduled', next_retry_at: nextAt.toISOString(), updated_at: new Date().toISOString() })
      .eq('id', row.id)
      .is('followup_status', null)
      .select('id');
    if (!claimed?.length) return;
    // The retry goes through the call queue, so it respects the same limits as campaign calls.
    const queued = await enqueueRetryCall({
      orgId: row.org_id,
      clientId: row.client_id,
      phone: row.phone,
      name: row.lead_name,
      country: row.lead_country,
      attempt: attempt + 1,
      notBefore: nextAt,
      retryOfCallId: row.id,
    });
    if (!queued) await setFollowUp(row.id, { followup_status: 'stopped', followup_detail: 'This number is already in the call queue.' });
    return;
  }

  const { data: claimed } = await supabase
    .from('voice_calls')
    .update({ followup_status: 'following_up', updated_at: new Date().toISOString() })
    .eq('id', row.id)
    .is('followup_status', null)
    .select('id');
  if (claimed?.length) await sendFallbackMessage(row, settings, plan);
}

/** The last try went unanswered — reach the lead on WhatsApp, else email, once. */
async function sendFallbackMessage(row: any, settings: ChannelApiSettings | null, plan: VoiceFollowUpPlan): Promise<void> {
  const supabase = getSupabaseAdmin()!;
  if (plan.fallback === 'none') return setFollowUp(row.id, { followup_status: 'gave_up', followup_detail: 'No follow-up message is set up.' });

  const { data: client } = row.client_id
    ? await supabase.from('clients').select('id, name, company, email, phone, country, opted_out').eq('id', row.client_id).maybeSingle()
    : { data: null };
  if (client?.opted_out) return setFollowUp(row.id, { followup_status: 'stopped', followup_detail: 'Lead has opted out.' });
  const blocked = await isSuppressed(row.org_id, { phone: client?.phone || row.phone, email: client?.email || row.lead_email });
  if (blocked.phone && blocked.email) return setFollowUp(row.id, { followup_status: 'stopped', followup_detail: 'On the do-not-contact list.' });

  const profile = await getOrgProfile(row.org_id);
  const lead = {
    id: client?.id || row.client_id || undefined,
    name: client?.name || row.lead_name || undefined,
    company: client?.company || row.lead_company || undefined,
    email: client?.email || row.lead_email || undefined,
    phone: client?.phone || row.phone,
    country: client?.country || row.lead_country || undefined,
  };
  const message = fillTokens(settings?.voiceFallbackMessage?.trim() || DEFAULT_VOICE_FALLBACK_MESSAGE, lead, profile);
  const problems: string[] = [];

  const whatsappReady =
    (settings?.whatsAppProvider === 'cloud_api' && settings.whatsappCloudApiKey && settings.whatsappCloudPhoneId) ||
    (settings?.whatsAppProvider === 'twilio' && settings.twilioAccountSid && settings.twilioAuthToken);
  if (plan.fallback === 'whatsapp_email' && whatsappReady && lead.phone && !blocked.phone) {
    // First contact on WhatsApp needs the org's approved template; free text only reaches
    // someone who messaged in the last 24 hours (which the send will report if so).
    const templateVars = settings!.whatsAppProvider === 'twilio' ? settings!.twilioContentVariables : settings!.whatsappTemplateVariables;
    const result = await sendCampaignWhatsAppMessage(settings, {
      toPhone: lead.phone,
      messageText: message,
      templateParams: settings!.whatsappMessageMode === 'template' ? (templateVars || []).map((v) => fillTokens(v, lead, profile)) : undefined,
    });
    if (result.delivered) {
      await recordUsage(row.org_id, 'whatsapp');
      if (result.provider === 'cloud_api') await seedConversationFromLead(row.org_id, lead, null).catch(() => {});
      return setFollowUp(row.id, { followup_status: 'fallback_whatsapp', followup_detail: null });
    }
    problems.push(`WhatsApp: ${result.errorDetail || 'not delivered'}`);
  }

  if (lead.email && !blocked.email) {
    const subject = `Sorry I missed you${lead.name ? `, ${lead.name.split(/\s+/)[0]}` : ''}`;
    const replyTo = buildEmailReplyToAddress(null, lead.id) || undefined;
    const compliant = withComplianceFooter(row.org_id, lead.email, message, profile);
    const result = await sendEmailViaOrgProvider(settings, {
      to: lead.email,
      toName: lead.name,
      subject,
      body: compliant.body,
      headers: unsubscribeHeaders(compliant.unsubscribeUrl),
      fromName: profile?.senderName || profile?.companyName || 'OmniReach AI',
      fromAddress: profile?.senderEmail,
      replyTo,
      orgId: row.org_id,
    });
    if (result.ok) {
      await recordUsage(row.org_id, 'emails');
      if (replyTo) await seedEmailConversationFromLead(row.org_id, lead, null, subject).catch(() => {});
      return setFollowUp(row.id, { followup_status: 'fallback_email', followup_detail: problems.join(' · ') || null });
    }
    problems.push(`Email: ${result.error || 'not sent'}`);
  } else {
    problems.push('No email on file.');
  }

  return setFollowUp(row.id, { followup_status: 'gave_up', followup_detail: problems.join(' · ') });
}
