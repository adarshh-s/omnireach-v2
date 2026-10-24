import { getSupabaseAdmin } from './supabaseAdmin.js';
import { getOrgChannelSettings, getOrgProfile } from './orgSettings.js';
import { sendWhatsAppText } from './whatsappSender.js';
import { sendCampaignWhatsAppMessage } from './whatsappCampaignSender.js';
import { sendEmailViaOrgProvider } from './emailSender.js';
import { buildEmailReplyToAddress } from './emailWebhookHandler.js';
import { getTimezoneForCountry } from './countryTiming.js';
import { isSuppressed } from './suppression.js';
import { recordUsage } from './usage.js';
import type { ChannelApiSettings, CampaignSettings } from '../src/types.js';

/**
 * Reminders before meetings the AI booked — 24 hours and 1 hour before — to cut no-shows.
 * Run by the scheduled dispatcher (api/cron/dispatch-scheduled.ts), so they're as punctual
 * as it runs (every few minutes with Vercel Pro or an external pinger).
 *
 * Each reminder goes out where the lead booked: a WhatsApp booking gets a WhatsApp message
 * (free text inside WhatsApp's 24-hour window, else the org's approved reminder template,
 * else email), an email booking gets a reply in the same thread, and a call booking gets
 * WhatsApp if that's set up, else email. A reply lands with the AI booking bot as usual, so
 * "can we move it?" is handled there.
 *
 * meeting_reminders holds one row per reminder: inserting it claims the send, so overlapping
 * runs never send twice, and a meeting moved to a new time gets fresh reminders.
 */

type Kind = '24h' | '1h';
type Source = 'whatsapp' | 'email' | 'voice';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Due windows (time until the meeting). A booking made inside a window skips that reminder
// rather than getting one minutes after confirming.
const WINDOWS: Record<Kind, { from: number; to: number; quietAfterMessage: number }> = {
  '24h': { from: 3 * HOUR, to: 24 * HOUR, quietAfterMessage: 2 * HOUR },
  '1h': { from: 10 * MINUTE, to: 75 * MINUTE, quietAfterMessage: 30 * MINUTE },
};
const WHATSAPP_WINDOW_MS = 24 * HOUR;

interface Meeting {
  source: Source;
  id: string;
  orgId: string;
  meetingAt: Date;
  leadName: string | null;
  phone: string | null;
  email: string | null;
  country: string | null;
  clientId: string | null;
  meetLink: string | null;
  subject: string | null;
  campaignRecipientId: string | null;
  lastMessageAt: Date | null;
  lastLeadMessageAt: Date | null;
  history: any[] | null;
}

export function remindersEnabled(settings: ChannelApiSettings | null | undefined, kind: Kind): boolean {
  const mode = settings?.meetingReminders || 'both';
  return mode === 'both' || mode === kind;
}

/** "tomorrow at 3:00 PM (GST)" / "today at 11:30 AM (IST)" / "Friday, 7 Nov at 9:00 AM (CET)", in the lead's time zone. */
export function describeMeetingTime(meetingAt: Date, country: string | null | undefined, now = new Date()): string {
  const timeZone = getTimezoneForCountry(country) || 'UTC';
  const dayKey = (d: Date) => d.toLocaleDateString('en-CA', { timeZone });
  const time = meetingAt.toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
  const zone = meetingAt.toLocaleTimeString('en-US', { timeZone, timeZoneName: 'short' }).split(' ').pop();
  const day =
    dayKey(meetingAt) === dayKey(now)
      ? 'today'
      : dayKey(meetingAt) === dayKey(new Date(now.getTime() + 24 * HOUR))
        ? 'tomorrow'
        : meetingAt.toLocaleDateString('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'short' });
  return `${day} at ${time} (${zone})`;
}

export function reminderText(kind: Kind, meeting: Pick<Meeting, 'leadName' | 'meetingAt' | 'country' | 'meetLink'>, profile: CampaignSettings | null, now = new Date()): string {
  const first = (meeting.leadName || '').trim().split(/\s+/)[0];
  const who = profile?.senderName || profile?.companyName;
  const when = describeMeetingTime(meeting.meetingAt, meeting.country, now);
  const opening = kind === '1h' ? `Hi${first ? ` ${first}` : ''}, our call starts in about an hour — ${when}.` : `Hi${first ? ` ${first}` : ''}, a quick reminder of our call ${when}.`;
  return [
    opening,
    meeting.meetLink ? `Join here: ${meeting.meetLink}` : '',
    `If the time no longer works, just reply here and we'll find another.${who ? `\n\n— ${who}${profile?.companyName && who !== profile.companyName ? `, ${profile.companyName}` : ''}` : ''}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function fillTokens(text: string, meeting: Meeting, profile: CampaignSettings | null, now: Date): string {
  const name = (meeting.leadName || '').trim();
  const values: Record<string, string> = {
    name: name || 'there',
    first_name: name.split(/\s+/)[0] || 'there',
    meeting_time: describeMeetingTime(meeting.meetingAt, meeting.country, now),
    meeting_link: meeting.meetLink || '',
    company_name: profile?.companyName || 'our team',
    sender_name: profile?.senderName || profile?.companyName || 'our team',
  };
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => (key in values ? values[key] : match));
}

function lastLeadMessage(history: any[] | null | undefined): Date | null {
  const times = (history || []).filter((h) => h?.role === 'user' && h.timestamp).map((h) => new Date(h.timestamp).getTime());
  return times.length ? new Date(Math.max(...times)) : null;
}

async function loadMeetings(fromIso: string, toIso: string): Promise<Meeting[]> {
  const supabase = getSupabaseAdmin()!;
  const [{ data: wa }, { data: em }, { data: calls }] = await Promise.all([
    supabase
      .from('whatsapp_conversations')
      .select('id, org_id, phone, lead_name, lead_email, lead_country, client_id, meet_link, meeting_datetime_iso, last_message_at, history')
      .eq('status', 'confirmed')
      .gt('meeting_datetime_iso', fromIso)
      .lte('meeting_datetime_iso', toIso)
      .limit(300),
    supabase
      .from('email_conversations')
      .select('id, org_id, client_email, lead_name, lead_country, client_id, campaign_recipient_id, subject, meet_link, meeting_datetime_iso, last_message_at, history')
      .eq('status', 'confirmed')
      .gt('meeting_datetime_iso', fromIso)
      .lte('meeting_datetime_iso', toIso)
      .limit(300),
    supabase
      .from('voice_calls')
      .select('id, org_id, phone, lead_name, lead_email, lead_country, client_id, meet_link, meeting_datetime_iso, last_message_at')
      .eq('status', 'confirmed')
      .gt('meeting_datetime_iso', fromIso)
      .lte('meeting_datetime_iso', toIso)
      .limit(300),
  ]);
  const date = (v: string | null | undefined) => (v ? new Date(v) : null);
  return [
    ...(wa || []).map((r: any) => ({
      source: 'whatsapp' as const,
      id: r.id,
      orgId: r.org_id,
      meetingAt: new Date(r.meeting_datetime_iso),
      leadName: r.lead_name,
      phone: r.phone,
      email: r.lead_email,
      country: r.lead_country,
      clientId: r.client_id,
      meetLink: r.meet_link,
      subject: null,
      campaignRecipientId: null,
      lastMessageAt: date(r.last_message_at),
      lastLeadMessageAt: lastLeadMessage(r.history),
      history: r.history || [],
    })),
    ...(em || []).map((r: any) => ({
      source: 'email' as const,
      id: r.id,
      orgId: r.org_id,
      meetingAt: new Date(r.meeting_datetime_iso),
      leadName: r.lead_name,
      phone: null,
      email: r.client_email,
      country: r.lead_country,
      clientId: r.client_id,
      meetLink: r.meet_link,
      subject: r.subject,
      campaignRecipientId: r.campaign_recipient_id,
      lastMessageAt: date(r.last_message_at),
      lastLeadMessageAt: lastLeadMessage(r.history),
      history: r.history || [],
    })),
    ...(calls || []).map((r: any) => ({
      source: 'voice' as const,
      id: r.id,
      orgId: r.org_id,
      meetingAt: new Date(r.meeting_datetime_iso),
      leadName: r.lead_name,
      phone: r.phone,
      email: r.lead_email,
      country: r.lead_country,
      clientId: r.client_id,
      meetLink: r.meet_link,
      subject: null,
      campaignRecipientId: null,
      lastMessageAt: date(r.last_message_at),
      // The call itself — WhatsApp's window only opens with a WhatsApp message, so none here.
      lastLeadMessageAt: null,
      history: null,
    })),
  ];
}

export function dueKind(meeting: Pick<Meeting, 'meetingAt' | 'lastMessageAt'>, now: Date): Kind | null {
  const until = meeting.meetingAt.getTime() - now.getTime();
  for (const kind of ['1h', '24h'] as Kind[]) {
    const w = WINDOWS[kind];
    if (until > w.from && until <= w.to) {
      // Just confirmed (or still chatting) — they don't need a reminder yet.
      if (meeting.lastMessageAt && now.getTime() - meeting.lastMessageAt.getTime() < w.quietAfterMessage) return null;
      return kind;
    }
  }
  return null;
}

export async function processMeetingReminders(options: { budgetMs: number; now?: Date }): Promise<{ sent: number; skipped: number; failed: number }> {
  const supabase = getSupabaseAdmin();
  const counts = { sent: 0, skipped: 0, failed: 0 };
  if (!supabase) return counts;
  const deadline = Date.now() + options.budgetMs;
  const now = options.now || new Date();

  const meetings = await loadMeetings(new Date(now.getTime() + WINDOWS['1h'].from).toISOString(), new Date(now.getTime() + WINDOWS['24h'].to).toISOString());
  const orgCache = new Map<string, { settings: ChannelApiSettings | null; profile: CampaignSettings | null }>();

  for (const meeting of meetings) {
    if (Date.now() > deadline) break;
    const kind = dueKind(meeting, now);
    if (!kind) continue;

    if (!orgCache.has(meeting.orgId)) {
      const [settings, profile] = await Promise.all([getOrgChannelSettings(meeting.orgId), getOrgProfile(meeting.orgId)]);
      orgCache.set(meeting.orgId, { settings, profile });
    }
    const { settings, profile } = orgCache.get(meeting.orgId)!;
    if (!remindersEnabled(settings, kind)) continue;

    // Claim it — a duplicate key means another run already sent (or is sending) this one.
    const { data: claim, error: claimError } = await supabase
      .from('meeting_reminders')
      .insert({ org_id: meeting.orgId, source: meeting.source, source_id: meeting.id, kind, meeting_at: meeting.meetingAt.toISOString() })
      .select('id')
      .maybeSingle();
    if (claimError || !claim) continue;

    const outcome = await sendReminder(kind, meeting, settings, profile, now);
    await supabase.from('meeting_reminders').update({ channel: outcome.channel, detail: outcome.detail }).eq('id', claim.id);
    if (outcome.channel === 'none') outcome.skipped ? counts.skipped++ : counts.failed++;
    else counts.sent++;
  }
  return counts;
}

async function sendReminder(
  kind: Kind,
  meeting: Meeting,
  settings: ChannelApiSettings | null,
  profile: CampaignSettings | null,
  now: Date
): Promise<{ channel: 'whatsapp' | 'email' | 'none'; detail: string | null; skipped?: boolean }> {
  const supabase = getSupabaseAdmin()!;
  if (meeting.clientId) {
    const { data: client } = await supabase.from('clients').select('opted_out').eq('id', meeting.clientId).maybeSingle();
    if (client?.opted_out) return { channel: 'none', detail: 'Lead opted out.', skipped: true };
  }
  const blocked = await isSuppressed(meeting.orgId, { phone: meeting.phone, email: meeting.email });
  const text = reminderText(kind, meeting, profile, now);
  const problems: string[] = [];

  // WhatsApp first for WhatsApp and call bookings.
  if (meeting.source !== 'email' && meeting.phone && !blocked.phone && settings) {
    const sent = await sendWhatsAppReminder(meeting, settings, profile, text, now);
    if (sent.ok) {
      await recordUsage(meeting.orgId, 'whatsapp');
      if (meeting.source === 'whatsapp') await appendToHistory('whatsapp_conversations', meeting, text);
      return { channel: 'whatsapp', detail: sent.detail };
    }
    problems.push(`WhatsApp: ${sent.detail}`);
  }

  if (meeting.email && !blocked.email) {
    const firstSubject = meeting.subject?.replace(/^(re:\s*)+/i, '');
    const result = await sendEmailViaOrgProvider(settings, {
      to: meeting.email,
      toName: meeting.leadName || undefined,
      subject: firstSubject ? `Re: ${firstSubject}` : `Reminder: our call ${describeMeetingTime(meeting.meetingAt, meeting.country, now)}`,
      body: text,
      fromName: profile?.senderName || profile?.companyName || 'OmniReach AI',
      fromAddress: profile?.senderEmail,
      replyTo: buildEmailReplyToAddress(meeting.campaignRecipientId, meeting.clientId) || undefined,
      orgId: meeting.orgId,
    });
    if (result.ok) {
      await recordUsage(meeting.orgId, 'emails');
      if (meeting.source === 'email') await appendToHistory('email_conversations', meeting, text);
      return { channel: 'email', detail: problems.join(' · ') || null };
    }
    problems.push(`Email: ${result.error || 'not sent'}`);
  } else if (!meeting.email) {
    problems.push('No email on file.');
  } else {
    problems.push('Email is on the do-not-contact list.');
  }
  return { channel: 'none', detail: problems.join(' · ') };
}

async function sendWhatsAppReminder(
  meeting: Meeting,
  settings: ChannelApiSettings,
  profile: CampaignSettings | null,
  text: string,
  now: Date
): Promise<{ ok: boolean; detail: string | null }> {
  const insideWindow = !!meeting.lastLeadMessageAt && now.getTime() - meeting.lastLeadMessageAt.getTime() < WHATSAPP_WINDOW_MS - 5 * MINUTE;
  const digits = (meeting.phone || '').replace(/\D/g, '');

  if (insideWindow) {
    if (settings.whatsAppProvider === 'cloud_api') {
      const r = await sendWhatsAppText(settings.whatsappCloudApiKey, settings.whatsappCloudPhoneId, digits, text);
      if (r.ok) return { ok: true, detail: null };
    } else if (settings.whatsAppProvider === 'twilio') {
      const r = await sendCampaignWhatsAppMessage({ ...settings, whatsappMessageMode: 'text' }, { toPhone: digits, messageText: text });
      if (r.delivered) return { ok: true, detail: null };
    }
  }

  // Outside the window WhatsApp only delivers approved templates.
  const template = settings.whatsappReminderTemplateName?.trim();
  if (settings.whatsAppProvider === 'cloud_api' && template) {
    const r = await sendCampaignWhatsAppMessage(
      {
        ...settings,
        whatsappMessageMode: 'template',
        whatsappTemplateName: template,
        whatsappTemplateLanguage: settings.whatsappReminderTemplateLanguage?.trim() || settings.whatsappTemplateLanguage,
      },
      { toPhone: digits, messageText: text, templateParams: (settings.whatsappReminderTemplateVariables || []).map((v) => fillTokens(v, meeting, profile, now)) }
    );
    return r.delivered ? { ok: true, detail: 'reminder template' } : { ok: false, detail: r.errorDetail || 'not delivered' };
  }
  return {
    ok: false,
    detail: insideWindow ? 'not delivered' : 'over 24 hours since their last WhatsApp message and no reminder template is set',
  };
}

async function appendToHistory(table: 'whatsapp_conversations' | 'email_conversations', meeting: Meeting, text: string) {
  const supabase = getSupabaseAdmin()!;
  // Fresh copy — the booking bot may have saved a turn since the meetings were loaded.
  const { data: current } = await supabase.from(table).select('history').eq('id', meeting.id).maybeSingle();
  const history = [...(current?.history || meeting.history || []), { role: 'assistant', text, timestamp: new Date().toISOString(), kind: 'reminder' }];
  // last_message_at is left alone: a reminder isn't conversation activity.
  await supabase.from(table).update({ history, updated_at: new Date().toISOString() }).eq('id', meeting.id);
}
