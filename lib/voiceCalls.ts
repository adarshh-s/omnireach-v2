import { getSupabaseAdmin } from './supabaseAdmin.js';
import { getOrgChannelSettings } from './orgSettings.js';
import { startVapiCall, isVapiConfigured, fetchAssistant, VapiCredentials } from './vapiClient.js';
import { getConnectedCalendar, bookMeeting, meetingLinkLabel } from './calendarProvider.js';
import { checkCallingHours, getLocalTodayInfo, getTimezoneForCountry, toMeetingStartIso } from './countryTiming.js';
import { sendSlackNotification } from './slackNotifier.js';

/**
 * Server side of the AI Voice Agent: placing an outbound call (with OmniReach's own webhook
 * and booking tool attached per call), and handling what Vapi posts back while/after it
 * runs. Shared by api/voice/vapi.ts (Vercel) and server.ts (local Express) so the two
 * can't drift apart.
 *
 * Why per-call overrides instead of configuring the assistant once in Vapi's dashboard:
 * the assistant's own Server URL may point elsewhere (an n8n test hook, another env), and
 * org-provisioned assistants have none at all. Attaching `server` + the book_meeting tool
 * on every call means call results always land here, whatever the assistant says.
 */

const BOOK_MEETING_TOOL = {
  type: 'function',
  function: {
    name: 'book_meeting',
    description:
      "Books the intro meeting on the team's calendar and sends the prospect a calendar invite. Call this ONLY after the prospect has clearly agreed to one specific date and time and you've repeated it back to them.",
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: "Meeting date as YYYY-MM-DD, in the prospect's own local time zone." },
        time: { type: 'string', description: "Meeting start time as 24-hour HH:MM, in the prospect's own local time zone." },
        email: { type: 'string', description: 'Email address for the calendar invite, only if the prospect gave one on this call.' },
      },
      required: ['date', 'time'],
    },
  },
};

export interface ApiResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

/** Vapi accepts its webhook secret as an `x-vapi-secret` header (its own convention) or
 * a `?token=` query string (this app's other webhooks' pattern) — either verifies. */
export function verifyVapiWebhook(headerSecret: unknown, queryToken: unknown): boolean {
  const expected = process.env.VAPI_WEBHOOK_SECRET;
  if (!expected) return false;
  return headerSecret === expected || queryToken === expected;
}

/** The public origin Vapi should post call events back to. APP_URL wins when it's a real
 * https URL; otherwise derived from the request's own host. Null on localhost — Vapi can't
 * reach it, so calls placed from local dev just fall back to the assistant's own config. */
export function getPublicBaseUrl(headers: Record<string, string | string[] | undefined> | undefined): string | null {
  const explicit = process.env.APP_URL?.trim();
  if (explicit && /^https:\/\//.test(explicit)) return explicit.replace(/\/+$/, '');
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(',')[0].trim();
  const host = first(headers?.['x-forwarded-host']) || first(headers?.host);
  if (!host || /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|$)/.test(host)) return null;
  const proto = first(headers?.['x-forwarded-proto']) || 'https';
  return `${proto}://${host}`;
}

async function buildCallOverrides(
  org: VapiCredentials,
  baseUrl: string | null,
  lead: { name?: string; company?: string; email?: string; country?: string }
): Promise<Record<string, unknown> | undefined> {
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (!baseUrl || !secret) return undefined;

  const overrides: Record<string, unknown> = {
    server: { url: `${baseUrl}/api/voice/vapi?action=webhook`, headers: { 'x-vapi-secret': secret } },
    serverMessages: ['status-update', 'end-of-call-report', 'tool-calls'],
    // On a phone line (especially international, with a second or so of delay) the person
    // naturally says "hello?" again while the agent's intro is still reaching them — with the
    // default any-sound-interrupts behavior, every such "hello" cut the intro off and made the
    // agent restart it, looping. Require 2+ words of real speech to interrupt instead.
    stopSpeakingPlan: { numWords: 2, voiceSeconds: 0.3, backoffSeconds: 1 },
  };

  // The booking tool and call context ride on the model, so the assistant's current model
  // config has to be read first — overriding `model` replaces it wholesale.
  const assistant = await fetchAssistant(org);
  if (assistant?.model) {
    const timeZone = getTimezoneForCountry(lead.country);
    const { label: todayLabel } = getLocalTodayInfo(new Date(), timeZone);
    const context = [
      'CALL CONTEXT (added automatically for this call):',
      `- You are speaking with ${lead.name || 'the prospect'}${lead.company ? ` from ${lead.company}` : ''}.`,
      `- Today is ${todayLabel}${timeZone ? ` in the prospect's local time zone (${timeZone})` : ''}. Every date and time you discuss is in the prospect's local time.`,
      "- BOOKING: if the prospect wants a meeting, agree on ONE specific date and time, repeat it back, and once they confirm, call the book_meeting tool. Never tell them it's booked until the tool confirms it. If the tool says the slot is taken, offer a different time.",
      lead.email
        ? `- Their email on file is ${lead.email}; the invite goes there unless they give a different one.`
        : "- We don't have their email on file. Before booking, ask for it, spell it back to confirm, and pass it to book_meeting.",
    ].join('\n');

    overrides.model = {
      ...assistant.model,
      messages: [...(assistant.model.messages || []), { role: 'system', content: context }],
      tools: [...(assistant.model.tools || []).filter((t: any) => t?.function?.name !== 'book_meeting'), BOOK_MEETING_TOOL],
    };
  }
  return overrides;
}

/** Places one outbound AI call for an org, after the safety checks (opted out, calling
 * hours), and logs it to voice_calls so the webhook can attribute everything that follows. */
export async function placeOrgVoiceCall(params: {
  orgId: string;
  phone?: string;
  name?: string;
  clientId?: string;
  variables?: Record<string, string>;
  baseUrl: string | null;
}): Promise<ApiResult> {
  const { orgId, phone, name, clientId, variables, baseUrl } = params;

  const settings = await getOrgChannelSettings(orgId);
  const org: VapiCredentials = {
    apiKey: settings?.vapiApiKey,
    assistantId: settings?.vapiAssistantId,
    phoneNumberId: settings?.vapiPhoneNumberId,
  };
  if (!isVapiConfigured(org)) {
    return { httpStatus: 400, body: { error: 'Voice calling is not configured yet — add your Vapi API Key, Assistant ID, and Phone Number ID in Channel Setup.' } };
  }
  if (!phone) {
    return { httpStatus: 400, body: { error: 'phone is required.' } };
  }

  const supabase = getSupabaseAdmin();
  let client: { name?: string; company?: string; email?: string; country?: string; opted_out?: boolean } | null = null;
  if (supabase && clientId) {
    const { data } = await supabase
      .from('clients')
      .select('name, company, email, country, opted_out')
      .eq('id', clientId)
      .eq('org_id', orgId)
      .maybeSingle();
    client = data;
  }

  if (client?.opted_out) {
    return { httpStatus: 400, body: { error: `${client.name || name || 'This lead'} has opted out of contact — not calling.` } };
  }

  const hours = checkCallingHours(client?.country);
  if (!hours.allowed) {
    return {
      httpStatus: 400,
      body: {
        error: `It's ${hours.localTimeLabel} for ${client?.name || name || 'this lead'} (${hours.timeZone}). Calls only go out 9 AM–8 PM on their working days — try again then.`,
      },
    };
  }

  const lead = {
    name: client?.name || name,
    company: client?.company || variables?.company,
    email: client?.email || undefined,
    country: client?.country || undefined,
  };
  const overrides = await buildCallOverrides(org, baseUrl, lead);
  const result = await startVapiCall({ phone, name: lead.name, variables, org, overrides });

  if (result.ok && result.callId && supabase) {
    const { error } = await supabase.from('voice_calls').insert({
      org_id: orgId,
      vapi_call_id: result.callId,
      client_id: client ? clientId : null,
      phone,
      lead_name: lead.name,
      lead_company: lead.company,
      lead_email: lead.email,
      lead_country: lead.country,
      call_status: result.status || 'queued',
    });
    if (error) console.error('[Vapi] Failed to log call', result.callId, error.message);
  }

  return { httpStatus: result.ok ? 200 : 400, body: { ...result, webhookAttached: !!overrides } };
}

function classifyOutcome(endedReason: string | undefined, userTurns: number): string {
  const reason = (endedReason || '').toLowerCase();
  if (reason.includes('voicemail')) return 'voicemail';
  if (reason.includes('did-not-answer') || reason.includes('no-answer')) return 'no-answer';
  if (reason.includes('busy')) return 'busy';
  if ((reason.includes('error') || reason.includes('failed') || reason.includes('fault')) && userTurns === 0) return 'failed';
  return 'answered';
}

async function handleEndOfCallReport(message: any, callId: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;

  const artifact = message.artifact || {};
  const rawMessages: any[] = artifact.messages || message.messages || [];
  const history = rawMessages
    .filter((m) => (m.role === 'user' || m.role === 'bot' || m.role === 'assistant') && m.message)
    .map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      text: String(m.message),
      timestamp: m.time ? new Date(m.time).toISOString() : new Date().toISOString(),
    }));

  const startedAt = message.startedAt ? new Date(message.startedAt).getTime() : NaN;
  const endedAt = message.endedAt ? new Date(message.endedAt).getTime() : NaN;
  const durationSeconds =
    typeof message.durationSeconds === 'number'
      ? Math.round(message.durationSeconds)
      : !isNaN(startedAt) && !isNaN(endedAt)
        ? Math.round((endedAt - startedAt) / 1000)
        : null;
  const outcome = classifyOutcome(message.endedReason, history.filter((h) => h.role === 'user').length);

  const { data: row } = await supabase
    .from('voice_calls')
    .update({
      call_status: 'ended',
      outcome,
      ended_reason: message.endedReason || null,
      duration_seconds: durationSeconds,
      summary: message.analysis?.summary || message.summary || null,
      history,
      recording_url: artifact.recordingUrl || message.recordingUrl || null,
      cost: typeof message.cost === 'number' ? message.cost : null,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('vapi_call_id', callId)
    .select('client_id, status')
    .maybeSingle();

  // A real conversation moves a fresh lead forward in the pipeline; a booked call already
  // set 'Meeting Scheduled' during the tool call, and anything further along is left alone.
  if (row?.client_id && outcome === 'answered' && row.status !== 'confirmed') {
    await supabase
      .from('clients')
      .update({ status: 'Contacted', last_contacted: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', row.client_id)
      .in('status', ['Pending', 'In Progress']);
  }
}

async function bookMeetingFromCall(callId: string, args: { date?: string; time?: string; email?: string }): Promise<string> {
  const supabase = getSupabaseAdmin();
  const { data: row } = supabase
    ? await supabase.from('voice_calls').select('*').eq('vapi_call_id', callId).maybeSingle()
    : { data: null };
  if (!supabase || !row) {
    return "Couldn't reach the calendar for this call. Tell the prospect a team member will email them to confirm the time.";
  }
  if (row.status === 'confirmed') {
    return `A meeting is already booked on this call for ${row.meeting_date} at ${row.meeting_time}. Don't book another one.`;
  }

  const date = String(args.date || '').trim();
  const time = String(args.time || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(time)) {
    return 'Invalid date or time format — call book_meeting again with date as YYYY-MM-DD and time as 24-hour HH:MM.';
  }
  const timeZone = getTimezoneForCountry(row.lead_country);
  const startIso = toMeetingStartIso(date, time.padStart(5, '0'), timeZone);
  if (isNaN(new Date(startIso).getTime()) || new Date(startIso).getTime() < Date.now()) {
    return 'That time is in the past. Ask the prospect for a future date and time.';
  }

  const givenEmail = String(args.email || '').trim().toLowerCase();
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(givenEmail) ? givenEmail : row.lead_email || undefined;
  const whenLabel = `${date} at ${time}${timeZone ? ` (${timeZone})` : ''}`;

  const [calendar, settings] = await Promise.all([getConnectedCalendar(row.org_id), getOrgChannelSettings(row.org_id)]);
  let meetLink: string | null = null;
  let calendarEventId: string | null = null;
  if (calendar) {
    try {
      const event = await bookMeeting({
        calendar,
        summary: `Discovery Call with ${row.lead_name || row.phone}`,
        // Emailed verbatim to the attendee — nothing internal goes here (see emailWebhookHandler).
        description: 'Booked automatically via OmniReach AI.',
        startIso,
        durationMinutes: 30,
        attendeeEmail: email,
        attendeeName: row.lead_name || undefined,
      });
      if (!event) throw new Error('NO_EVENT');
      meetLink = event.meetLink || null;
      calendarEventId = event.eventId || null;
    } catch (err: any) {
      console.error(`[Vapi] ${calendar.provider} Calendar booking failed for call ${callId}:`, err);
      return err?.message === 'SLOT_ALREADY_BOOKED'
        ? 'That slot is already taken on our calendar. Apologize and offer the prospect a different time.'
        : "The calendar booking failed. Tell the prospect you've noted the time and a team member will confirm by email.";
    }
  }

  const now = new Date().toISOString();
  await supabase
    .from('voice_calls')
    .update({
      status: 'confirmed',
      meeting_date: date,
      meeting_time: time,
      meeting_datetime_iso: startIso,
      meet_link: meetLink,
      calendar_event_id: calendarEventId,
      lead_email: email || row.lead_email,
      last_message_at: now,
      updated_at: now,
    })
    .eq('id', row.id);

  if (row.client_id) {
    await supabase
      .from('clients')
      .update({ status: 'Meeting Scheduled', meeting_date: date, meeting_time: time, last_contacted: now, updated_at: now })
      .eq('id', row.client_id);
  }

  sendSlackNotification(
    settings?.slackWebhookUrl,
    `📅 *Meeting booked* via AI Voice Agent — ${row.lead_name || row.phone} (${row.phone}) confirmed for ${whenLabel}.${
      meetLink && calendar ? ` <${meetLink}|Join on ${meetingLinkLabel(calendar.provider)}>` : ''
    }`
  );

  if (!calendar) {
    return `Meeting noted for ${whenLabel}. The calendar isn't connected, so tell the prospect the team will email them the invite.`;
  }
  return email
    ? `Booked for ${whenLabel}. A calendar invite with the meeting link was sent to ${email}.`
    : `Booked for ${whenLabel}. There's no email on file, so tell the prospect the team will send the meeting link.`;
}

/** Handles one Vapi server message. The return value is the JSON response body — only
 * tool-calls needs a meaningful one ({ results }); everything else is just acked, since
 * Vapi retries non-2xx responses. */
export async function handleVapiServerMessage(message: any): Promise<Record<string, unknown>> {
  const type = message?.type;
  const callId: string | undefined = message?.call?.id;

  if (type === 'tool-calls') {
    const toolCalls: any[] = message.toolCallList || (message.toolWithToolCallList || []).map((t: any) => t.toolCall) || [];
    const results = await Promise.all(
      toolCalls.map(async (tc) => {
        const name = tc?.function?.name || tc?.name;
        let args = tc?.function?.arguments ?? tc?.arguments ?? {};
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {
            args = {};
          }
        }
        const result =
          name === 'book_meeting' && callId ? await bookMeetingFromCall(callId, args) : `Tool "${name}" isn't available on this call.`;
        return { toolCallId: tc?.id, result };
      })
    );
    return { results };
  }

  if (!callId) return { received: true };

  if (type === 'status-update' && message.status) {
    const supabase = getSupabaseAdmin();
    if (supabase) {
      await supabase
        .from('voice_calls')
        .update({ call_status: message.status, last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('vapi_call_id', callId);
    }
  } else if (type === 'end-of-call-report') {
    await handleEndOfCallReport(message, callId);
  }

  return { received: true };
}
