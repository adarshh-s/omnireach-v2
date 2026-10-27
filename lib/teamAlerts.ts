import { getSupabaseAdmin } from './supabaseAdmin.js';
import { sendSlackNotification } from './slackNotifier.js';
import { sendEmailViaOrgProvider } from './emailSender.js';
import type { ChannelApiSettings } from '../src/types.js';

/**
 * Tells the org's team a conversation needs a person: the AI handed it over ("Needs a
 * Human"), or a lead wrote while a teammate has taken the conversation over. Sent to Slack
 * (if connected) and by email to Channel Setup → Notifications → alert email, using the org's
 * own email account. At most one alert per conversation every 30 minutes, so a lead sending
 * five quick messages doesn't send five alerts.
 */

const QUIET_MS = 30 * 60_000;

export interface TeamAlert {
  orgId: string;
  table: 'whatsapp_conversations' | 'email_conversations';
  conversationId: string;
  lastAlertAt?: string | null;
  leadLabel: string;
  channel: 'WhatsApp' | 'email';
  reason: 'handoff' | 'replied_while_paused';
  lastMessage: string;
  appUrl?: string | null;
}

export async function alertTeam(settings: ChannelApiSettings | null, alert: TeamAlert): Promise<boolean> {
  if (alert.lastAlertAt && Date.now() - new Date(alert.lastAlertAt).getTime() < QUIET_MS) return false;
  const supabase = getSupabaseAdmin();
  // Claim the alert first, so two quick messages processed side by side alert once.
  if (supabase) {
    let q = supabase.from(alert.table).update({ team_alerted_at: new Date().toISOString() }).eq('id', alert.conversationId);
    q = alert.lastAlertAt ? q.eq('team_alerted_at', alert.lastAlertAt) : q.is('team_alerted_at', null);
    const { data } = await q.select('id');
    if (!data?.length) return false;
  }

  const headline =
    alert.reason === 'handoff'
      ? `🙋 *${alert.leadLabel}* needs a person (${alert.channel}) — the AI handed the conversation over.`
      : `💬 *${alert.leadLabel}* replied on ${alert.channel} — you've taken this conversation over, so the AI won't answer.`;
  const quote = alert.lastMessage.replace(/\s+/g, ' ').slice(0, 300);
  const link = alert.appUrl ? `${alert.appUrl.replace(/\/+$/, '')}/#inbox` : null;

  await sendSlackNotification(settings?.slackWebhookUrl, `${headline}\n> ${quote}${link ? `\n<${link}|Open the AI Inbox>` : ''}`);

  const to = settings?.handoffNotifyEmail?.trim();
  if (to && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    await sendEmailViaOrgProvider(settings, {
      to,
      subject: alert.reason === 'handoff' ? `${alert.leadLabel} needs a person` : `${alert.leadLabel} replied`,
      body: `${headline.replace(/\*/g, '')}\n\nTheir message:\n"${quote}"\n\n${link ? `Reply from the AI Inbox: ${link}` : 'Reply from the AI Inbox in OmniReach.'}`,
      fromName: 'OmniReach alerts',
      orgId: alert.orgId,
    }).catch(() => {});
  }
  return true;
}
