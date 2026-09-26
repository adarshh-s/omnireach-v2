import { getSupabaseAdmin } from './supabaseAdmin.js';
import {
  getContextFromCampaignRecipientId,
  getContextFromClientId,
  getOrgProfile,
  getOrgChannelSettings,
  getOrgGoogleCalendarToken,
  markClientOptedOut,
} from './orgSettings.js';
import { sendEmailViaOrgProvider } from './emailSender.js';
import { runConversationTurn, ConversationTurn } from './conversationEngine.js';
import { createMeetingEvent, cancelMeetingEvent } from './googleCalendar.js';
import { getGeminiClient } from './geminiClient.js';
import { OPT_OUT_PATTERN, OPT_OUT_REPLY } from './compliance.js';
import { toMeetingStartIso } from './countryTiming.js';

/** Verifies the shared secret appended to the Inbound Parse Destination URL, so this
 * endpoint can't be spammed by anyone who finds the URL. */
export function verifyEmailWebhookToken(token: string | undefined): boolean {
  const expected = process.env.EMAIL_INBOUND_WEBHOOK_SECRET;
  return !!expected && token === expected;
}

/** A domain env value pasted with stray quotes/whitespace (an easy mistake in a dashboard
 * env-var field) silently produced a Reply-To address a mail provider rejects at send time
 * — e.g. `reply+client_x@"quardlink.com"` — which failed the ENTIRE send, not just tracking.
 * Sanitizing and validating it here means a bad value degrades to "no Reply-To" instead of
 * breaking outbound mail outright, and the health check below can flag it directly. */
export function sanitizeInboundDomain(raw: string | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^["']+|["']+$/g, '').trim();
  const domainPattern = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  return domainPattern.test(cleaned) ? cleaned : null;
}

function trackingAddressFor(type: 'cr' | 'client', id: string): string {
  const domain = sanitizeInboundDomain(process.env.EMAIL_INBOUND_DOMAIN) || '';
  return `reply+${type}_${id}@${domain}`;
}

function extractTrackingToken(toHeader: string): { type: 'cr' | 'client'; id: string } | null {
  const match = toHeader.match(/reply\+(cr|client)_([a-zA-Z0-9-]+)@/);
  if (!match) return null;
  return { type: match[1] as 'cr' | 'client', id: match[2] };
}

function extractEmailAddress(fromHeader: string): string {
  const match = fromHeader.match(/<([^>]+)>/);
  return (match ? match[1] : fromHeader).trim().toLowerCase();
}

const LOCK_STALE_MS = 30000; // a crashed/timed-out holder shouldn't wedge the conversation forever
const LOCK_MAX_WAIT_MS = 8000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mirrors lib/whatsappWebhookHandler.ts's acquireConversationLock — two emails from the
 * same prospect sent seconds apart can trigger two concurrent invocations of this webhook
 * that each read the same email_conversations row before the other writes back, silently
 * dropping a turn or double-booking a calendar event. Backed by a plain conditional UPDATE
 * (and an INSERT for the rare case where no row exists yet), not a Postgres advisory lock —
 * those are session-scoped, and Supabase's REST interface doesn't guarantee the same
 * underlying connection across calls, so a session lock could never be reliably released.
 */
async function acquireEmailConversationLock(supabase: any, orgId: string, clientEmail: string): Promise<boolean> {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const staleThreshold = new Date(Date.now() - LOCK_STALE_MS).toISOString();
    const { data: claimed } = await supabase
      .from('email_conversations')
      .update({ locked_at: new Date().toISOString() })
      .eq('org_id', orgId)
      .eq('client_email', clientEmail)
      .or(`locked_at.is.null,locked_at.lt.${staleThreshold}`)
      .select('id');
    if (claimed && claimed.length > 0) return true;

    const { error: insertError } = await supabase
      .from('email_conversations')
      .insert({ org_id: orgId, client_email: clientEmail, locked_at: new Date().toISOString() });
    if (!insertError) return true;

    await sleep(400 + Math.random() * 400);
  }
  console.warn('[Email Bot] Could not acquire conversation lock for', clientEmail, '— proceeding unlocked to avoid dropping the message.');
  return false;
}

async function releaseEmailConversationLock(supabase: any, orgId: string, clientEmail: string): Promise<void> {
  await supabase.from('email_conversations').update({ locked_at: null }).eq('org_id', orgId).eq('client_email', clientEmail);
}

/**
 * Processes one inbound email delivered by SendGrid's Inbound Parse webhook. Identifies
 * the org/client via a Reply-To tracking address embedded in every outbound campaign
 * email (see seedEmailConversationFromLead / the send-email routes' replyTo handling),
 * runs the same AI scheduling conversation used for WhatsApp, books a real Google
 * Calendar meeting if confirmed, and sends the reply back via the org's own provider.
 */
export async function processInboundEmail(fields: Record<string, string>): Promise<void> {
  const toHeader = fields.to || '';
  const fromHeader = fields.from || '';
  const subject = fields.subject || '';
  const bodyText = (fields.text || '').trim();

  if (!bodyText) return; // nothing to react to

  const token = extractTrackingToken(toHeader);
  if (!token) {
    console.warn('[Email Bot] No tracking token found in To header — dropping:', toHeader);
    return;
  }

  const context =
    token.type === 'cr' ? await getContextFromCampaignRecipientId(token.id) : await getContextFromClientId(token.id);
  if (!context) {
    console.warn('[Email Bot] Could not resolve org/client for token', token);
    return;
  }

  const { orgId, clientId } = context;
  const fromEmail = extractEmailAddress(fromHeader);
  const trackingAddress = trackingAddressFor(token.type, token.id);

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    console.warn('[Email Bot] Supabase is not configured — cannot persist conversation state or reply.');
    return;
  }

  const locked = await acquireEmailConversationLock(supabase, orgId, fromEmail);
  try {
    await processLockedEmail();
  } finally {
    if (locked) await releaseEmailConversationLock(supabase, orgId, fromEmail);
  }

  async function processLockedEmail(): Promise<void> {
  const { data: existing } = await supabase
    .from('email_conversations')
    .select('*')
    .eq('org_id', orgId)
    .eq('client_email', fromEmail)
    .maybeSingle();

  const history: ConversationTurn[] = existing?.history || [];
  const nowIso = new Date().toISOString();
  history.push({ role: 'user', text: bodyText, timestamp: nowIso });

  // A genuine inbound reply — record it on the client so the Dashboard's "Replied" stat
  // and per-campaign channel breakdowns are accurate. Nothing else in this file writes
  // email_status='Replied' anywhere, so this stayed permanently 0 for every org
  // regardless of how many prospects actually replied.
  const replyClientId = clientId || existing?.client_id;
  if (replyClientId) {
    await supabase
      .from('clients')
      .update({ email_status: 'Replied', updated_at: new Date().toISOString() })
      .eq('id', replyClientId);
  } else {
    await supabase
      .from('clients')
      .update({ email_status: 'Replied', updated_at: new Date().toISOString() })
      .eq('org_id', orgId)
      .eq('email', fromEmail);
  }

  const [orgProfile, orgChannelSettings, calendarToken] = await Promise.all([
    getOrgProfile(orgId),
    getOrgChannelSettings(orgId),
    getOrgGoogleCalendarToken(orgId),
  ]);
  const fromName = orgProfile?.senderName || orgProfile?.companyName || 'Team';

  if (OPT_OUT_PATTERN.test(bodyText)) {
    history.push({ role: 'assistant', text: OPT_OUT_REPLY, timestamp: new Date().toISOString() });
    if (clientId) await markClientOptedOut(orgId, clientId);

    await supabase.from('email_conversations').upsert(
      {
        org_id: orgId,
        client_email: fromEmail,
        client_id: clientId,
        campaign_recipient_id: token.type === 'cr' ? token.id : existing?.campaign_recipient_id,
        lead_name: existing?.lead_name || context.clientName,
        lead_company: existing?.lead_company || context.clientCompany,
        status: 'declined',
        subject: existing?.subject || subject,
        history,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'org_id,client_email' }
    );

    {
      const recipientId = token.type === 'cr' ? token.id : existing?.campaign_recipient_id;
      if (recipientId) {
        await supabase
          .from('campaign_recipients')
          .update({ ai_conversation_status: 'declined', updated_at: new Date().toISOString() })
          .eq('id', recipientId);
      }
    }

    await sendEmailViaOrgProvider(orgChannelSettings, {
      to: fromEmail,
      subject: subject ? `Re: ${subject}` : 'Unsubscribed',
      body: OPT_OUT_REPLY,
      fromName,
      replyTo: trackingAddress,
    });
    return;
  }

  const ai = getGeminiClient();
  const result = ai
    ? await runConversationTurn({
        aiClient: ai,
        channel: 'email',
        inboundSubject: subject,
        leadName: existing?.lead_name || context.clientName,
        leadCompany: existing?.lead_company || context.clientCompany,
        leadCountry: existing?.lead_country || context.clientCountry,
        companyName: orgProfile?.companyName,
        senderName: orgProfile?.senderName,
        serviceDescription: orgProfile?.serviceDescription,
        history,
        nowIso,
      })
    : {
        reply: "Thanks for your email! We'll get back to you shortly.",
        replySubject: subject ? `Re: ${subject}` : 'Re: your inquiry',
        status: 'active' as const,
        meeting: null,
        meetingTimeZone: null,
      };

  let finalStatus = result.status;
  let meetingDateTimeIso: string | null = null;
  let meetLink: string | null = null;
  let calendarEventId: string | null = null;
  let replyText = result.reply;

  if (result.status === 'confirmed' && result.meeting) {
    if (calendarToken) {
      try {
        const startIso = toMeetingStartIso(result.meeting.date, result.meeting.time, result.meetingTimeZone);
        const event = await createMeetingEvent({
          refreshToken: calendarToken.refreshToken,
          calendarId: calendarToken.calendarId,
          summary: `Discovery Call with ${existing?.lead_name || context.clientName || fromEmail}`,
          // Deliberately no conversation transcript here — Google emails this description
          // verbatim to the attendee (sendUpdates: 'all' in googleCalendar.ts), so anything
          // internal put here leaks straight to the client's inbox. The full conversation is
          // already viewable org-side in the AI Inbox (email_conversations.history below).
          description: `Booked automatically via OmniReach AI.`,
          startIso,
          durationMinutes: result.meeting.durationMinutes,
          attendeeEmail: fromEmail,
          attendeeName: existing?.lead_name || context.clientName || undefined,
        });
        if (event) {
          meetingDateTimeIso = startIso;
          meetLink = event.meetLink || null;
          calendarEventId = event.eventId || null;
        } else {
          finalStatus = 'active';
        }
      } catch (err: any) {
        console.error('[Email Bot] Google Calendar booking failed:', err);
        finalStatus = 'active';
        replyText =
          err?.message === 'SLOT_ALREADY_BOOKED'
            ? `${replyText}\n\n(Looks like that exact time just got taken by another booking — could you suggest a different time?)`
            : `${replyText}\n\n(I had trouble locking that into the calendar — mind confirming the date and time once more?)`;
      }
    } else {
      meetingDateTimeIso = toMeetingStartIso(result.meeting.date, result.meeting.time, result.meetingTimeZone);
    }
  }

  if (meetLink) {
    replyText = `${replyText}\n\nMeeting confirmed! Google Meet link: ${meetLink}`;
  }

  // See lib/whatsappWebhookHandler.ts for the full rationale — the prospect's latest
  // message walked back an earlier confirmation, so cancel the real event instead of
  // leaving a stale booking on the org's calendar.
  const retractedMeeting = existing?.status === 'confirmed' && !!existing?.calendar_event_id && finalStatus !== 'confirmed';
  if (retractedMeeting && calendarToken) {
    await cancelMeetingEvent(calendarToken.refreshToken, calendarToken.calendarId, existing!.calendar_event_id);
  }

  history.push({ role: 'assistant', text: replyText, timestamp: new Date().toISOString() });

  await supabase.from('email_conversations').upsert(
    {
      org_id: orgId,
      client_email: fromEmail,
      client_id: clientId,
      campaign_recipient_id: token.type === 'cr' ? token.id : existing?.campaign_recipient_id,
      lead_name: existing?.lead_name || context.clientName,
      lead_company: existing?.lead_company || context.clientCompany,
      status: finalStatus,
      subject: existing?.subject || subject,
      history,
      meeting_date: meetingDateTimeIso ? meetingDateTimeIso.slice(0, 10) : retractedMeeting ? null : existing?.meeting_date,
      meeting_time: meetingDateTimeIso ? result.meeting?.time : retractedMeeting ? null : existing?.meeting_time,
      meeting_datetime_iso: meetingDateTimeIso || (retractedMeeting ? null : existing?.meeting_datetime_iso),
      meet_link: meetLink || (retractedMeeting ? null : existing?.meet_link),
      calendar_event_id: calendarEventId || (retractedMeeting ? null : existing?.calendar_event_id),
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'org_id,client_email' }
  );

  {
    const recipientId = token.type === 'cr' ? token.id : existing?.campaign_recipient_id;
    if (recipientId) {
      await supabase
        .from('campaign_recipients')
        .update({
          ai_conversation_status: finalStatus,
          meeting_booked: finalStatus === 'confirmed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', recipientId);
    }
  }

  // Mirrors the 'Replied' update above — without this, a real AI-confirmed booking never
  // shows up as "Meeting Scheduled" in the Dashboard's Client Pipeline or Spreadsheet & Leads
  // (those read clients.status, not email_conversations.status, which is what got updated
  // above). Also reverts a client back off "Meeting Scheduled" if they walk the booking back.
  if (finalStatus === 'confirmed' || retractedMeeting) {
    const clientUpdate = finalStatus === 'confirmed'
      ? {
          status: 'Meeting Scheduled',
          meeting_date: meetingDateTimeIso ? meetingDateTimeIso.slice(0, 10) : undefined,
          meeting_time: result.meeting?.time,
          updated_at: new Date().toISOString(),
        }
      : { status: 'Replied', updated_at: new Date().toISOString() };
    if (replyClientId) {
      await supabase.from('clients').update(clientUpdate).eq('id', replyClientId);
    } else {
      await supabase.from('clients').update(clientUpdate).eq('org_id', orgId).eq('email', fromEmail);
    }
  }

  const sendResult = await sendEmailViaOrgProvider(orgChannelSettings, {
    to: fromEmail,
    subject: result.replySubject || (subject ? `Re: ${subject}` : 'Re: your inquiry'),
    body: replyText,
    fromName,
    replyTo: trackingAddress,
  });
  if (!sendResult.ok) {
    console.error('[Email Bot] Failed to send auto-reply:', sendResult.error);
  }
  } // end processLockedEmail
}

/**
 * Seeds a conversation row with the lead's identity when an outbound campaign email
 * goes out, so an inbound reply is matched deterministically from the first message.
 */
export async function seedEmailConversationFromLead(
  orgId: string,
  lead: { id?: string; name?: string; company?: string; email?: string; country?: string },
  campaignRecipientId?: string | null,
  subject?: string
): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  const email = (lead?.email || '').trim().toLowerCase();
  if (!email) return;

  try {
    await supabase.from('email_conversations').upsert(
      {
        org_id: orgId,
        client_email: email,
        client_id: lead.id,
        campaign_recipient_id: campaignRecipientId || null,
        lead_name: lead.name,
        lead_company: lead.company,
        lead_country: lead.country,
        subject: subject || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'org_id,client_email' }
    );
  } catch (err) {
    console.warn('[Email Bot] Failed to seed conversation from lead:', err);
  }
}

/** Builds the Reply-To tracking address to attach to an outbound email. Falls back to a
 * client-keyed address (resolved via getContextFromClientId on inbound) whenever there's no
 * campaign_recipients row yet — a Message Simulator test send, a one-off send outside a
 * batch campaign, or a campaign whose campaign_recipients insert silently failed — so a
 * reply still routes back to the AI bot instead of landing on the plain From address. */
export function buildEmailReplyToAddress(
  campaignRecipientId: string | null | undefined,
  clientId?: string | null
): string | null {
  const domain = sanitizeInboundDomain(process.env.EMAIL_INBOUND_DOMAIN);
  if (!domain) return null;
  if (campaignRecipientId) return trackingAddressFor('cr', campaignRecipientId);
  if (clientId) return trackingAddressFor('client', clientId);
  return null;
}
