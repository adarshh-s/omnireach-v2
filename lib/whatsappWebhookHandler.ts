import { createHmac, timingSafeEqual } from 'crypto';
import { getSupabaseAdmin } from './supabaseAdmin.js';
import {
  getOrgIdByPhoneNumberId,
  getOrgProfile,
  getOrgChannelSettings,
  getOrgGoogleCalendarToken,
  markClientOptedOut,
} from './orgSettings.js';
import { sendWhatsAppText } from './whatsappSender.js';
import { runConversationTurn, ConversationTurn } from './conversationEngine.js';
import { createMeetingEvent, cancelMeetingEvent } from './googleCalendar.js';
import { getGeminiClient } from './geminiClient.js';
import { OPT_OUT_PATTERN, OPT_OUT_REPLY } from './compliance.js';
import { toMeetingStartIso } from './countryTiming.js';

/**
 * Verifies Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw request body, keyed
 * with the Meta App Secret) so this endpoint can't be spoofed — without this, anyone who
 * discovers the webhook URL could POST a forged payload claiming to be any org's
 * phone_number_id, book fake meetings, or make the org's real WhatsApp number auto-send
 * AI-generated messages to any phone number of their choosing.
 *
 * The secret is passed in rather than read from a single env var, because each org brings
 * their own separate Meta App with its own App Secret — see resolveWhatsAppSignatureSecret.
 * Fails OPEN (returns true) when no secret is available for this specific org yet, so this
 * doesn't break an org's traffic before they've configured theirs — but their traffic stays
 * unverified until they do. Each org sets theirs from Settings -> WhatsApp Cloud API,
 * copied from their own Meta App Dashboard -> Settings -> Basic -> App Secret.
 */
export function verifyWhatsAppSignature(rawBody: string, signatureHeader: string | undefined, secret: string | undefined): boolean {
  if (!secret) {
    console.warn('[WhatsApp Webhook] No App Secret configured for this org yet — accepting unverified payload.');
    return true;
  }
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;

  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const provided = signatureHeader.slice('sha256='.length);

  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(provided, 'hex');
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Looks up which org's App Secret to verify an inbound payload against, from the
 * phone_number_id embedded in the (not-yet-verified) payload — present on every Meta
 * webhook delivery, message or status callback alike. Resolving it this way, rather than
 * trusting an org-scoped route, is what lets one shared webhook URL serve every org.
 */
export async function resolveWhatsAppSignatureSecret(rawBody: string): Promise<string | undefined> {
  try {
    const body = JSON.parse(rawBody || '{}');
    const phoneNumberId: string | undefined = body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
    if (!phoneNumberId) return undefined;
    const orgId = await getOrgIdByPhoneNumberId(phoneNumberId);
    if (!orgId) return undefined;
    const settings = await getOrgChannelSettings(orgId);
    return settings?.whatsappAppSecret || undefined;
  } catch {
    return undefined;
  }
}

const LOCK_STALE_MS = 30000; // a crashed/timed-out holder shouldn't wedge the conversation forever
const LOCK_MAX_WAIT_MS = 8000; // stays well within Meta's ~20s webhook tolerance alongside the AI+send work after

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serializes processing per (org, phone) so two messages sent seconds apart — a very
 * common real WhatsApp pattern (e.g. "Yes" then "Friday" as separate texts) — can't be
 * picked up by two concurrent serverless invocations that each read the conversation's
 * history before the other has written back. Without this, both compute a reply from the
 * same stale state, both get sent to the user, and whichever upsert lands last silently
 * overwrites the other's turn — a distinct race from the message-id redelivery one above
 * (different message ids, so that dedup check doesn't catch it).
 *
 * Backed by a plain conditional UPDATE (and an INSERT for the first-ever message from a
 * number), not a Postgres advisory lock — those are session-scoped, and Supabase's REST
 * interface doesn't guarantee the same underlying connection across calls, so a session
 * lock could never be reliably released.
 */
async function acquireConversationLock(supabase: any, orgId: string, phone: string): Promise<boolean> {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const staleThreshold = new Date(Date.now() - LOCK_STALE_MS).toISOString();
    const { data: claimed } = await supabase
      .from('whatsapp_conversations')
      .update({ locked_at: new Date().toISOString() })
      .eq('org_id', orgId)
      .eq('phone', phone)
      .or(`locked_at.is.null,locked_at.lt.${staleThreshold}`)
      .select('id');
    if (claimed && claimed.length > 0) return true;

    // Row might not exist yet (first-ever message from this number) — creating it also
    // claims the lock. A unique-constraint error here just means it now exists (created
    // by this call or a concurrent one) — fall through and retry the conditional update.
    const { error: insertError } = await supabase
      .from('whatsapp_conversations')
      .insert({ org_id: orgId, phone, locked_at: new Date().toISOString() });
    if (!insertError) return true;

    await sleep(400 + Math.random() * 400);
  }
  console.warn('[WhatsApp Bot] Could not acquire conversation lock for', phone, '— proceeding unlocked to avoid dropping the message.');
  return false;
}

async function releaseConversationLock(supabase: any, orgId: string, phone: string): Promise<void> {
  await supabase.from('whatsapp_conversations').update({ locked_at: null }).eq('org_id', orgId).eq('phone', phone);
}

export function verifyWhatsAppWebhook(query: Record<string, unknown>): { challenge: string } | null {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode === 'subscribe' && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return { challenge: String(challenge ?? '') };
  }
  return null;
}

/**
 * Processes one incoming Meta WhatsApp Cloud API webhook delivery. A single webhook URL
 * serves every org — the org is resolved from `value.metadata.phone_number_id` (each org
 * connects their own Meta phone number in Settings). Runs the AI scheduling conversation,
 * books a real Google Calendar meeting on that org's calendar if a time was confirmed,
 * persists the conversation to Supabase scoped to that org, and sends the reply back.
 */
/**
 * Meta's send-time API response only means a message was ACCEPTED for processing — the
 * real sent/delivered/read/failed outcome arrives later as one of these async status
 * callbacks, keyed by the message id issued at send time (see BatchCampaignRunner.tsx /
 * api/cron/dispatch-scheduled.ts, which now persist that id onto
 * campaign_recipients.whatsapp_message_id for exactly this lookup). Without this, a
 * campaign kept showing "Delivered" the instant Meta accepted the send, even when the
 * message was later held back or genuinely failed to reach the device.
 */
async function processWhatsAppStatusCallbacks(value: any): Promise<void> {
  const statuses: any[] = value?.statuses || [];
  if (statuses.length === 0) return;

  const supabase = getSupabaseAdmin();
  if (!supabase) return;

  for (const status of statuses) {
    const messageId: string | undefined = status?.id;
    const metaStatus: string | undefined = status?.status; // 'sent' | 'delivered' | 'read' | 'failed'
    if (!messageId || !metaStatus) continue;

    // 'sent' is already reflected the moment we dispatch — nothing new to record.
    if (metaStatus === 'sent') continue;

    const newStatus = metaStatus === 'delivered' ? 'Delivered' : metaStatus === 'read' ? 'Read' : metaStatus === 'failed' ? 'Failed' : null;
    if (!newStatus) continue;

    const err = status.errors?.[0];
    const errorDetail = metaStatus === 'failed' ? err?.message || err?.title || err?.error_data?.details || 'Delivery failed' : null;
    if (metaStatus === 'failed') {
      console.warn('[WhatsApp Bot] Delivery failed for', status.recipient_id, '- code:', err?.code, 'title:', err?.title, 'message:', errorDetail);
    }

    const { data: recipientRow } = await supabase
      .from('campaign_recipients')
      .select('id, client_id')
      .eq('whatsapp_message_id', messageId)
      .maybeSingle();
    if (!recipientRow) continue; // no matching send on record (e.g. sent before this tracking existed)

    await supabase
      .from('campaign_recipients')
      .update({ whatsapp_status: newStatus, error_detail: errorDetail, updated_at: new Date().toISOString() })
      .eq('id', recipientRow.id);

    if (recipientRow.client_id) {
      await supabase
        .from('clients')
        .update({ whatsapp_status: newStatus, updated_at: new Date().toISOString() })
        .eq('id', recipientRow.client_id);
    }
  }
}

export async function processWhatsAppWebhookPayload(body: any): Promise<void> {
  const value = body?.entry?.[0]?.changes?.[0]?.value;
  const message = value?.messages?.[0];
  if (!message || message.type !== 'text') {
    if (value?.statuses?.length) {
      await processWhatsAppStatusCallbacks(value);
    } else {
      console.log('[WhatsApp Bot] Ignoring non-text/empty payload:', JSON.stringify(body)?.slice(0, 500));
    }
    return; // ignore status callbacks, media, reactions, etc.
  }
  console.log('[WhatsApp Bot] Processing text message from', message.from, '- phoneNumberId:', value?.metadata?.phone_number_id);

  const phoneNumberId: string | undefined = value?.metadata?.phone_number_id;
  const fromPhone: string = message.from;
  const incomingText: string = message.text?.body || '';
  const contactName: string | undefined = value?.contacts?.[0]?.profile?.name;

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    console.warn('[WhatsApp Bot] Supabase is not configured — cannot persist conversation state or reply.');
    return;
  }

  if (!phoneNumberId) {
    console.warn('[WhatsApp Bot] Webhook payload had no phone_number_id — cannot resolve which org this belongs to.');
    return;
  }

  const orgId = await getOrgIdByPhoneNumberId(phoneNumberId);
  if (!orgId) {
    console.warn(`[WhatsApp Bot] No org has WhatsApp phone_number_id ${phoneNumberId} configured — dropping message.`);
    return;
  }

  const [orgProfile, orgChannelSettings, calendarToken] = await Promise.all([
    getOrgProfile(orgId),
    getOrgChannelSettings(orgId),
    getOrgGoogleCalendarToken(orgId),
  ]);

  const locked = await acquireConversationLock(supabase, orgId, fromPhone);
  try {
    await processLockedMessage();
  } finally {
    if (locked) await releaseConversationLock(supabase, orgId, fromPhone);
  }

  async function processLockedMessage(): Promise<void> {
  const { data: existing } = await supabase
    .from('whatsapp_conversations')
    .select('*')
    .eq('org_id', orgId)
    .eq('phone', fromPhone)
    .maybeSingle();

  // Meta guarantees at-least-once webhook delivery and retries if our response is slow —
  // without this, a retry racing the original in-flight request can overwrite newer
  // conversation state (e.g. a just-confirmed meeting) with a stale reply.
  const inboundMessageId: string | undefined = message.id;
  if (inboundMessageId && existing?.last_inbound_message_id === inboundMessageId) {
    console.log('[WhatsApp Bot] Duplicate delivery of message', inboundMessageId, '— skipping.');
    return;
  }

  const history: ConversationTurn[] = existing?.history || [];
  const nowIso = new Date().toISOString();
  history.push({ role: 'user', text: incomingText, timestamp: nowIso });

  // A genuine inbound reply — record it on the client so the Dashboard's "Replied" stat
  // and per-campaign channel breakdowns are accurate. Nothing else in this file writes
  // whatsapp_status='Replied' anywhere, so this stayed permanently 0 for every org
  // regardless of how many prospects actually replied.
  if (existing?.client_id) {
    await supabase
      .from('clients')
      .update({ whatsapp_status: 'Replied', updated_at: new Date().toISOString() })
      .eq('id', existing.client_id);
  } else {
    await supabase
      .from('clients')
      .update({ whatsapp_status: 'Replied', updated_at: new Date().toISOString() })
      .eq('org_id', orgId)
      .in('phone', [fromPhone, `+${fromPhone}`]);
  }

  if (OPT_OUT_PATTERN.test(incomingText.trim())) {
    history.push({ role: 'assistant', text: OPT_OUT_REPLY, timestamp: new Date().toISOString() });

    // Mark the client opted-out — prefer the id already linked to this conversation
    // (set whenever a campaign contacted them); fall back to matching by phone.
    if (existing?.client_id) {
      await markClientOptedOut(orgId, existing.client_id);
    } else {
      await supabase
        .from('clients')
        .update({ opted_out: true, updated_at: new Date().toISOString() })
        .eq('org_id', orgId)
        .in('phone', [fromPhone, `+${fromPhone}`]);
    }

    await supabase.from('whatsapp_conversations').upsert(
      {
        org_id: orgId,
        phone: fromPhone,
        lead_id: existing?.lead_id,
        client_id: existing?.client_id,
        campaign_recipient_id: existing?.campaign_recipient_id,
        lead_name: existing?.lead_name || contactName,
        lead_email: existing?.lead_email,
        lead_company: existing?.lead_company,
        status: 'declined',
        history,
        last_inbound_message_id: inboundMessageId || existing?.last_inbound_message_id,
        collected: existing?.collected || {},
        meeting_date: existing?.meeting_date,
        meeting_time: existing?.meeting_time,
        meeting_datetime_iso: existing?.meeting_datetime_iso,
        meet_link: existing?.meet_link,
        calendar_event_id: existing?.calendar_event_id,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'org_id,phone' }
    );

    if (existing?.campaign_recipient_id) {
      await supabase
        .from('campaign_recipients')
        .update({ ai_conversation_status: 'declined', updated_at: new Date().toISOString() })
        .eq('id', existing.campaign_recipient_id);
    }

    await sendWhatsAppText(orgChannelSettings?.whatsappCloudApiKey, orgChannelSettings?.whatsappCloudPhoneId, fromPhone, OPT_OUT_REPLY);
    return;
  }

  const ai = getGeminiClient();
  const result = ai
    ? await runConversationTurn({
        aiClient: ai,
        leadName: existing?.lead_name || contactName,
        leadCompany: existing?.lead_company,
        leadCountry: existing?.lead_country,
        companyName: orgProfile?.companyName,
        senderName: orgProfile?.senderName,
        serviceDescription: orgProfile?.serviceDescription,
        history,
        nowIso,
      })
    : { reply: "Thanks for your message! We'll get back to you shortly.", status: 'active' as const, meeting: null, meetingTimeZone: null };

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
          summary: `Discovery Call with ${existing?.lead_name || contactName || fromPhone}`,
          description: `Booked automatically via OmniReach AI WhatsApp bot.\n\nConversation:\n${history
            .map((h) => `${h.role}: ${h.text}`)
            .join('\n')}`,
          startIso,
          durationMinutes: result.meeting.durationMinutes,
          attendeeEmail: existing?.lead_email || undefined,
          attendeeName: existing?.lead_name || contactName || undefined,
        });
        if (event) {
          meetingDateTimeIso = startIso;
          meetLink = event.meetLink || null;
          calendarEventId = event.eventId || null;
        } else {
          finalStatus = 'active';
        }
      } catch (err: any) {
        console.error('[WhatsApp Bot] Google Calendar booking failed:', err);
        finalStatus = 'active';
        replyText =
          err?.message === 'SLOT_ALREADY_BOOKED'
            ? `${replyText}\n\n(Looks like that exact time just got taken by another booking — could you suggest a different time?)`
            : `${replyText}\n\n(I had trouble locking that into the calendar — mind confirming the date and time once more?)`;
      }
    } else {
      // No calendar connected for this org yet — still record the requested time, just no real event.
      meetingDateTimeIso = toMeetingStartIso(result.meeting.date, result.meeting.time, result.meetingTimeZone);
    }
  }

  if (meetLink) {
    replyText = `${replyText}\n\n📅 Meeting confirmed! Google Meet link: ${meetLink}`;
  }

  // The prospect's latest message walked back a meeting that was confirmed in an earlier
  // turn (a mistaken confirmation, a dispute, or a reschedule/cancel request) — cancel the
  // real event rather than leaving a stale booking on the org's calendar while the
  // conversation itself has moved on.
  const retractedMeeting = existing?.status === 'confirmed' && !!existing?.calendar_event_id && finalStatus !== 'confirmed';
  if (retractedMeeting && calendarToken) {
    await cancelMeetingEvent(calendarToken.refreshToken, calendarToken.calendarId, existing!.calendar_event_id);
  }

  history.push({ role: 'assistant', text: replyText, timestamp: new Date().toISOString() });

  await supabase.from('whatsapp_conversations').upsert(
    {
      org_id: orgId,
      phone: fromPhone,
      lead_id: existing?.lead_id,
      lead_name: existing?.lead_name || contactName,
      lead_email: existing?.lead_email,
      lead_company: existing?.lead_company,
      status: finalStatus,
      history,
      last_inbound_message_id: inboundMessageId || existing?.last_inbound_message_id,
      collected: existing?.collected || {},
      meeting_date: meetingDateTimeIso ? meetingDateTimeIso.slice(0, 10) : retractedMeeting ? null : existing?.meeting_date,
      meeting_time: meetingDateTimeIso ? result.meeting?.time : retractedMeeting ? null : existing?.meeting_time,
      meeting_datetime_iso: meetingDateTimeIso || (retractedMeeting ? null : existing?.meeting_datetime_iso),
      meet_link: meetLink || (retractedMeeting ? null : existing?.meet_link),
      calendar_event_id: calendarEventId || (retractedMeeting ? null : existing?.calendar_event_id),
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'org_id,phone' }
  );

  if (existing?.campaign_recipient_id) {
    await supabase
      .from('campaign_recipients')
      .update({
        ai_conversation_status: finalStatus,
        meeting_booked: finalStatus === 'confirmed',
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.campaign_recipient_id);
  }

  const sendResult = await sendWhatsAppText(
    orgChannelSettings?.whatsappCloudApiKey,
    orgChannelSettings?.whatsappCloudPhoneId,
    fromPhone,
    replyText
  );
  if (!sendResult.ok) {
    console.error('[WhatsApp Bot] Failed to send auto-reply:', sendResult.error);
  }
  }
}

/**
 * Seeds a conversation row with the lead's identity when an outbound campaign message
 * goes out, so when they reply, the bot already knows who it's talking to.
 */
export async function seedConversationFromLead(
  orgId: string,
  lead: { id?: string; name?: string; company?: string; email?: string; phone?: string; country?: string },
  campaignRecipientId?: string | null
): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  const phoneDigits = (lead?.phone || '').replace(/\D/g, '');
  if (!phoneDigits) return;

  try {
    await supabase.from('whatsapp_conversations').upsert(
      {
        org_id: orgId,
        phone: phoneDigits,
        lead_id: lead.id,
        client_id: lead.id,
        campaign_recipient_id: campaignRecipientId || null,
        lead_name: lead.name,
        lead_email: lead.email,
        lead_company: lead.company,
        lead_country: lead.country,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'org_id,phone' }
    );
  } catch (err) {
    console.warn('[WhatsApp Bot] Failed to seed conversation from lead:', err);
  }
}
