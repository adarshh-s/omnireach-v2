import { getSupabaseAdmin } from './supabaseAdmin.js';
import { safeEqual } from './security.js';
import {
  getOrgChannelSettings,
  saveOrgVoice,
  getOrgIdByVoicePhoneNumberId,
  getOrgAccessStatus,
  getOrgProfile,
  resolveOrgVoiceSetup,
} from './orgSettings.js';
import { startVapiCall, fetchAssistant, configurePhoneNumberForInbound, VapiCredentials } from './vapiClient.js';
import { getConnectedCalendar, bookMeeting, meetingLinkLabel } from './calendarProvider.js';
import { checkCallingHours, getLocalTodayInfo, getTimezoneForCountry, toMeetingStartIso } from './countryTiming.js';
import { sendSlackNotification } from './slackNotifier.js';
import { buildLearnedGuidance, reviewAfterConversation, stripLearnedBlock } from './aiLearning.js';
import { voiceLanguageOverrides, VoiceLanguageOverrides } from './voiceLanguages.js';
import { scheduleVoiceFollowUp } from './voiceFollowUp.js';
import { markQueuedCallFinished, processCallQueue } from './callQueue.js';
import { optOutClient } from './suppression.js';
import { emitCrmEvent } from './crm/index.js';
import { needsAiDisclosure, legalRegion } from './regionRules.js';
import { recordUsage, usageRoom, limitReachedMessage } from './usage.js';
import { meetingRulesFor, checkMeetingTime, meetingRulesPrompt } from './bookingRules.js';
import type { ChannelApiSettings } from '../src/types.js';

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

/** Hands the call to a person on the org's team (Channel Setup → Voice → transfer number). */
export function transferTool(number: string) {
  return {
    type: 'transferCall',
    destinations: [
      {
        type: 'number',
        number,
        message: "Sure — I'll connect you with someone from the team now. One moment.",
        description: 'A person on the team, for callers who ask to speak to a human or need something the assistant cannot answer.',
      },
    ],
  };
}

export function withoutTransferTool(overrides: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!overrides?.model?.tools) return overrides;
  return { ...overrides, model: { ...overrides.model, tools: overrides.model.tools.filter((t: any) => t?.type !== 'transferCall') } };
}

export function validTransferNumber(value: string | undefined | null): string | null {
  const n = (value || '').replace(/[\s()-]/g, '');
  return /^\+[1-9]\d{6,14}$/.test(n) ? n : null;
}

const DO_NOT_CONTACT_TOOL = {
  type: 'function',
  function: {
    name: 'do_not_contact',
    description:
      "Records that this person doesn't want to be contacted again (no more calls, WhatsApp or email). Call this as soon as they ask not to be called or contacted again, then apologise and end the call politely.",
    parameters: { type: 'object', properties: {} },
  },
};

/** What the agent says up front. "I'm an AI" is legally required for leads in the EU/EEA
 * and the US (lib/regionRules.ts) and said there by default; "this call may be recorded" is
 * required much more widely (UAE, India's DPDP Act, UK, Canada, many US states…), so it's
 * said on every call while recording is on. */
export interface CallNotice {
  ai: boolean;
  recording: boolean;
}

export function noticeSentence(notice: CallNotice): string {
  if (notice.ai && notice.recording) return "Just so you know, I'm an AI assistant, and this call may be recorded.";
  if (notice.ai) return "Just so you know, I'm an AI assistant.";
  if (notice.recording) return 'Just so you know, this call may be recorded.';
  return '';
}

export function noticeForLead(settings: ChannelApiSettings | null | undefined, country: string | null | undefined, phone: string | null | undefined): CallNotice {
  // voiceAiDisclosure: false is the earlier on/off switch — read as "never".
  const mode = settings?.voiceAiDisclosureMode || (settings?.voiceAiDisclosure === false ? 'never' : 'required');
  return { ai: needsAiDisclosure(mode, country, phone), recording: settings?.voiceRecordingNotice !== false };
}

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
  return safeEqual(headerSecret, expected) || safeEqual(queryToken, expected);
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

export interface CallLead {
  name?: string;
  company?: string;
  email?: string;
  country?: string;
}

export async function buildCallOverrides(
  orgId: string,
  org: VapiCredentials,
  baseUrl: string | null,
  lead: CallLead,
  language: VoiceLanguageOverrides | null,
  notice: CallNotice,
  inbound?: { callerNumber?: string; knownCaller: boolean; companyName?: string },
  /** A browser test call (lib/voiceTest.ts): the webhook is reached with a short-lived test
   * token instead of the real secret (which must never reach the browser), and the call
   * context still applies when there's no public URL (local dev) — just without tools. */
  test?: { token: string | null }
): Promise<Record<string, unknown> | undefined> {
  // The org's chosen language swaps how the caller is heard and the voice that speaks —
  // applied even when the webhook can't be attached (local dev).
  const languageFields = language ? { transcriber: language.transcriber, voice: language.voice } : {};
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  const server = test
    ? baseUrl && test.token
      ? { url: `${baseUrl}/api/voice/vapi?action=webhook&test=${encodeURIComponent(test.token)}` }
      : null
    : baseUrl && secret
      ? { url: `${baseUrl}/api/voice/vapi?action=webhook`, headers: { 'x-vapi-secret': secret } }
      : null;
  if (!server && !test) return language ? languageFields : undefined;

  const settings = await getOrgChannelSettings(orgId);
  const transferNumber = test ? null : validTransferNumber(settings?.voiceTransferNumber);
  const overrides: Record<string, unknown> = {
    ...(server ? { server, serverMessages: ['status-update', 'end-of-call-report', 'tool-calls'] } : {}),
    ...languageFields,
    // Safety caps: a call never runs past the org's limit (default 10 min), and hangs up
    // after 30 seconds of silence (a dropped line or a phone left on the table).
    maxDurationSeconds: Math.round(Math.min(60, Math.max(2, settings?.voiceMaxCallMinutes ?? 10)) * 60),
    silenceTimeoutSeconds: 30,
  };

  // The booking tool and call context ride on the model, so the assistant's current model
  // config has to be read first — overriding `model` replaces it wholesale.
  const [assistant, learnedGuidance] = await Promise.all([fetchAssistant(org), buildLearnedGuidance(orgId, ['voice'])]);

  if (assistant?.model) {
    const timeZone = getTimezoneForCountry(lead.country);
    const { label: todayLabel } = getLocalTodayInfo(new Date(), timeZone);
    const who = inbound
      ? [
          `- This is an INCOMING call: ${inbound.knownCaller ? `${lead.name || 'a known contact'}${lead.company ? ` from ${lead.company}` : ''}` : 'someone'} called ${inbound.companyName || 'us'}${inbound.callerNumber ? ` from ${inbound.callerNumber}` : ''}. They called you, so don't pitch as if you'd reached out.`,
          inbound.knownCaller
            ? '- Greet them, ask how you can help, and answer their questions.'
            : "- Ask for their name and what they're calling about, then help them. If they want to talk further with the team, offer to book a meeting.",
        ]
      : [`- You are speaking with ${lead.name || 'the prospect'}${lead.company ? ` from ${lead.company}` : ''}.`];
    // The disclosure is spoken word for word in English; in other languages the model writes
    // the opening line itself (in that language) and is told to include it.
    const english = !language || language.language.code.startsWith('en');
    const openingLanguage = language && language.language.promptName ? language.language.promptName : 'the language of your greeting';
    const disclosureLines: string[] = [
      // Never deceive, whatever the region: if asked, the agent says what it is.
      "- If anyone asks whether you're a person or a bot, say honestly that you're an AI assistant.",
    ];
    const sentence = noticeSentence(notice);
    if (sentence) {
      if (!english) {
        const what = [notice.ai ? "that you're an AI assistant" : '', notice.recording ? 'that the call may be recorded' : ''].filter(Boolean).join(' and ');
        disclosureLines.push(
          inbound
            ? `- OPENING LINE: greet the caller in ${openingLanguage}, and in the same opening say ${what}.`
            : `- OPENING LINE: greet them in ${openingLanguage}, based on this greeting: "${assistant.firstMessage || ''}", and in the same opening say ${what}.`
        );
        if (!inbound) overrides.firstMessageMode = 'assistant-speaks-first-with-model-generated-message';
      } else if (!inbound && assistant.firstMessage) {
        overrides.firstMessage = `${String(assistant.firstMessage).trim()} ${sentence}`;
      }
    }
    const context = [
      'CALL CONTEXT (added automatically for this call):',
      ...who,
      ...(language ? [language.instruction] : []),
      ...disclosureLines,
      "- DO NOT CONTACT: if they ask not to be called or contacted again, call the do_not_contact tool, apologise, and end the call politely. Never try to change their mind.",
      `- Today is ${todayLabel}${timeZone ? ` in the prospect's local time zone (${timeZone})` : ''}. Every date and time you discuss is in the prospect's local time.`,
      "- BOOKING: if the prospect wants a meeting, agree on ONE specific date and time, repeat it back, and once they confirm, call the book_meeting tool. Never tell them it's booked until the tool confirms it. If the tool says the slot is taken, offer a different time.",
      meetingRulesPrompt(meetingRulesFor(settings, timeZone), timeZone),
      transferNumber
        ? '- A PERSON: if they ask to speak to a human, or need something you can\'t answer (exact pricing, contracts), offer to connect them and use the transferCall tool.'
        : "- A PERSON: if they ask to speak to a human, say a team member will call them back, and offer to book a time for that call.",
      lead.email
        ? `- Their email on file is ${lead.email}; the invite goes there unless they give a different one.`
        : "- We don't have their email on file. Before booking, ask for it, spell it back to confirm, and pass it to book_meeting.",
      ...(learnedGuidance ? ['', learnedGuidance] : []),
    ].join('\n');

    overrides.model = {
      ...assistant.model,
      // The saved prompt's AI Learning block is swapped for the per-call copy in `context`,
      // so the call always gets the current lessons exactly once.
      messages: [
        ...(assistant.model.messages || []).map((m: any) =>
          m.role === 'system' && typeof m.content === 'string' ? { ...m, content: stripLearnedBlock(m.content) } : m
        ),
        { role: 'system', content: context },
      ],
      // Tools need the webhook to answer them, so a test call without one runs without them.
      tools: server
        ? [
            ...(assistant.model.tools || []).filter((t: any) => !['book_meeting', 'do_not_contact'].includes(t?.function?.name) && t?.type !== 'transferCall'),
            BOOK_MEETING_TOOL,
            DO_NOT_CONTACT_TOOL,
            ...(transferNumber ? [transferTool(transferNumber)] : []),
          ]
        : (assistant.model.tools || []).filter((t: any) => !['book_meeting', 'do_not_contact'].includes(t?.function?.name) && t?.type !== 'transferCall'),
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
  /** The browser's copy of the lead's country — only a fallback for leads not saved to the
   * database yet, so the calling-hours check still applies to them. */
  country?: string;
  variables?: Record<string, string>;
  baseUrl: string | null;
  /** Which try this is for the lead (retries after no answer — lib/voiceFollowUp.ts). */
  attempt?: number;
}): Promise<ApiResult> {
  const { orgId, phone, name, clientId, variables, baseUrl, attempt = 1 } = params;

  const { creds: org, ownAccount, settings } = await resolveOrgVoiceSetup(orgId);
  if (!org.phoneNumberId) {
    return {
      httpStatus: 400,
      body: {
        error: ownAccount
          ? 'Add your Vapi Phone Number ID in Channel Setup → Voice to place calls.'
          : 'No phone number is assigned to your workspace yet — contact support to get one.',
      },
    };
  }
  if (!phone) {
    return { httpStatus: 400, body: { error: 'phone is required.' } };
  }
  for (const metric of ['calls', 'call_minutes'] as const) {
    if ((await usageRoom(orgId, metric)) <= 0) return { httpStatus: 400, body: { error: limitReachedMessage(metric), limitReached: true } };
  }

  const supabase = getSupabaseAdmin();
  let client: { name?: string; company?: string; email?: string; country?: string; opted_out?: boolean; call_consent?: boolean } | null = null;
  if (supabase && clientId) {
    const { data } = await supabase
      .from('clients')
      .select('name, company, email, country, opted_out, call_consent')
      .eq('id', clientId)
      .eq('org_id', orgId)
      .maybeSingle();
    client = data;
  }

  if (client?.opted_out) {
    return { httpStatus: 400, body: { error: `${client.name || name || 'This lead'} has opted out of contact — not calling.` } };
  }

  const country = client?.country || params.country || undefined;
  // US law (TCPA): AI-voice marketing calls to US numbers need the lead's prior written consent.
  if (settings?.voiceUsConsentRequired !== false && !client?.call_consent && legalRegion(country, phone) === 'us') {
    return {
      httpStatus: 400,
      body: { error: `${client?.name || name || 'This lead'} has a US number and no recorded consent to calls — US law requires it for AI calls. Tick "Agreed to be called" on the lead once you have it.` },
    };
  }
  const hours = checkCallingHours(country, new Date(), { phone, skipHolidays: settings?.voiceSkipHolidays !== false });
  if (!hours.allowed) {
    return {
      httpStatus: 400,
      body: {
        error: hours.holiday
          ? `It's ${hours.holiday} for ${client?.name || name || 'this lead'} (a public holiday there) — no calls today.`
          : `It's ${hours.localTimeLabel} for ${client?.name || name || 'this lead'} (${hours.timeZone}). Calls only go out 9 AM–8 PM on their working days — try again then.`,
      },
    };
  }

  const lead = {
    name: client?.name || name,
    company: client?.company || variables?.company,
    email: client?.email || undefined,
    country,
  };
  const language = voiceLanguageOverrides(settings?.vapiLanguage, settings?.vapiVoiceGender);
  const [overrides, profile] = await Promise.all([
    buildCallOverrides(orgId, org, baseUrl, lead, language, noticeForLead(settings, lead.country, phone)),
    getOrgProfile(orgId),
  ]);

  // Voicemail: leave a short message (or just hang up) rather than pitching to a machine.
  // The default message is English, so other languages only get one if the org wrote it.
  const firstName = (lead.name || '').trim().split(/\s+/)[0];
  const sender = profile?.senderName || profile?.companyName;
  const voicemailMessage =
    settings?.voicemailMessage?.trim() ||
    (!language || language.language.code.startsWith('en')
      ? `Hi${firstName ? ` ${firstName}` : ''}, this is ${sender || 'a quick call'}${profile?.companyName && sender !== profile.companyName ? ` from ${profile.companyName}` : ''}. Sorry I missed you — I'll send you a quick message, or just call me back on this number.`
      : undefined);
  const voicemailFields = {
    voicemailDetection: { provider: 'vapi' },
    ...(voicemailMessage ? { voicemailMessage } : {}),
  };

  let callOverrides = overrides;
  let result = await startVapiCall({ phone, name: lead.name, variables, org, overrides: { ...(callOverrides || {}), ...voicemailFields } });
  // Transfer to a person is an extra too — if Vapi rejects the inline transfer tool, call without it.
  if (!result.ok && /transfer|destination/i.test(result.error || '')) {
    console.warn('[Vapi] Transfer tool rejected, calling without it:', result.error);
    callOverrides = withoutTransferTool(callOverrides);
    result = await startVapiCall({ phone, name: lead.name, variables, org, overrides: { ...(callOverrides || {}), ...voicemailFields } });
  }
  // Voicemail detection is an extra — if this Vapi account or number rejects it, call without it.
  if (!result.ok && /voicemail/i.test(result.error || '')) {
    console.warn('[Vapi] Voicemail settings rejected, calling without them:', result.error);
    result = await startVapiCall({ phone, name: lead.name, variables, org, overrides: callOverrides });
  }

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
      attempt,
    });
    if (error) console.error('[Vapi] Failed to log call', result.callId, error.message);
  }
  if (result.ok) await recordUsage(orgId, 'calls');

  return { httpStatus: result.ok ? 200 : 400, body: { ...result, webhookAttached: !!overrides?.server } };
}

function classifyOutcome(endedReason: string | undefined, userTurns: number): string {
  const reason = (endedReason || '').toLowerCase();
  if (reason.includes('voicemail')) return 'voicemail';
  if (reason.includes('did-not-answer') || reason.includes('no-answer')) return 'no-answer';
  if (reason.includes('busy')) return 'busy';
  if ((reason.includes('error') || reason.includes('failed') || reason.includes('fault')) && userTurns === 0) return 'failed';
  return 'answered';
}

/** Vapi's end-of-call report (webhook) and its GET /call/:id object share the fields used
 * here, so the same function finalizes a call from either source. */
async function handleEndOfCallReport(message: any, callId: string): Promise<{ orgId: string; answered: boolean } | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

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

  // The report can arrive twice (webhook, then the stale-call reconciler) — count minutes once.
  const { data: before } = await supabase.from('voice_calls').select('outcome').eq('vapi_call_id', callId).maybeSingle();
  const firstReport = !!before && !before.outcome;

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
    .select('org_id, client_id, status')
    .maybeSingle();
  if (row && firstReport && durationSeconds) await recordUsage(row.org_id, 'call_minutes', Math.ceil(durationSeconds / 60));

  // Log the call in the org's CRM (if connected): outcome, length and the AI's summary.
  if (row?.client_id) {
    const outcomeLabel: Record<string, string> = { answered: 'Answered', 'no-answer': 'No answer', busy: 'Busy', voicemail: 'Voicemail', failed: "Couldn't connect" };
    await emitCrmEvent(row.org_id, row.client_id, {
      kind: 'note',
      title: `OmniReach AI call: ${outcomeLabel[outcome] || outcome}`,
      text: [
        durationSeconds ? `Length: ${Math.floor(durationSeconds / 60)}m ${durationSeconds % 60}s` : '',
        message.analysis?.summary || message.summary || '',
      ]
        .filter(Boolean)
        .join('\n') || 'No conversation.',
      stage: outcome === 'answered' ? 'replied' : 'contacted',
    });
  }

  // Nobody picked up — schedule the next try, or follow up on WhatsApp/email after the last one.
  if (row && outcome !== 'answered') await scheduleVoiceFollowUp(callId).catch((err) => console.error('[Vapi] Follow-up scheduling failed', callId, err));

  // A real conversation moves a fresh lead forward in the pipeline; a booked call already
  // set 'Meeting Scheduled' during the tool call, and anything further along is left alone.
  if (row?.client_id && outcome === 'answered' && row.status !== 'confirmed') {
    await supabase
      .from('clients')
      .update({ status: 'Contacted', last_contacted: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', row.client_id)
      .in('status', ['Pending', 'In Progress']);
  }
  return row ? { orgId: row.org_id, answered: outcome === 'answered' } : null;
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
  const rules = meetingRulesFor(await getOrgChannelSettings(row.org_id), timeZone);
  const fits = checkMeetingTime(startIso, 30, rules, timeZone);
  if (!fits.ok) return `Not booked: ${fits.message} Apologise and offer the prospect a time that fits.`;
  if (row.direction === 'test') {
    // Browser test call: every check ran, but nothing goes on the calendar.
    await supabase
      .from('voice_calls')
      .update({ summary: `Test booking (not on the calendar): ${date} at ${time}`, updated_at: new Date().toISOString() })
      .eq('id', row.id);
    return `Booked for ${date} at ${time}${timeZone ? ` (${timeZone})` : ''}. (Test call — confirm it to the caller as booked; nothing was added to the real calendar.)`;
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
  await emitCrmEvent(row.org_id, row.client_id, {
    kind: 'meeting',
    title: `Discovery call with ${row.lead_name || row.phone}`,
    startIso,
    durationMinutes: 30,
    link: meetLink,
    notes: 'Booked by OmniReach AI on a phone call.',
  });

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

/** The person asked not to be contacted again — opt them out everywhere (lib/suppression.ts). */
async function doNotContactFromCall(callId: string): Promise<string> {
  const supabase = getSupabaseAdmin();
  const { data: row } = supabase ? await supabase.from('voice_calls').select('org_id, client_id, phone, lead_email, direction').eq('vapi_call_id', callId).maybeSingle() : { data: null };
  // Test calls from the browser never touch the real do-not-contact list.
  if (row && row.direction !== 'test') await optOutClient(row.org_id, row.client_id, 'asked on a call', { phone: row.phone, email: row.lead_email });
  return "Done — they won't be contacted again by call, WhatsApp or email. Apologise for the interruption, say goodbye, and end the call.";
}

/**
 * Finalizes calls still showing as in flight when Vapi's end-of-call webhook never arrived —
 * it isn't sent at all for calls that fail before connecting (e.g. a carrier rejecting the
 * call), which otherwise sit at "Calling…" in the AI Inbox forever. Called when the inbox
 * loads; checks Vapi directly for anything older than a couple of minutes.
 */
export async function reconcileStaleVoiceCalls(orgId: string, rows: any[]): Promise<boolean> {
  const cutoff = Date.now() - 2 * 60 * 1000;
  const stale = rows
    .filter((r) => r.call_status !== 'ended' && new Date(r.created_at).getTime() < cutoff)
    .slice(0, 10);
  if (stale.length === 0) return false;

  const settings = await getOrgChannelSettings(orgId);
  const apiKey = settings?.vapiApiKey?.trim() || process.env.VAPI_API_KEY;
  if (!apiKey) return false;

  let changed = false;
  await Promise.all(
    stale.map(async (row) => {
      try {
        const res = await fetch(`https://api.vapi.ai/call/${row.vapi_call_id}`, { headers: { Authorization: `Bearer ${apiKey}` } });
        if (!res.ok) return;
        const call = await res.json();
        if (call?.status !== 'ended') return;
        await handleEndOfCallReport(call, row.vapi_call_id);
        await markQueuedCallFinished(row.vapi_call_id, null);
        changed = true;
      } catch {
        // Best effort — retried on the next inbox load.
      }
    })
  );
  return changed;
}

/** Handles one Vapi server message. The return value is the JSON response body — only
 * tool-calls needs a meaningful one ({ results }); everything else is just acked, since
 * Vapi retries non-2xx responses. */
export async function handleVapiServerMessage(message: any, baseUrl: string | null, scope?: { testOrgId: string }): Promise<Record<string, unknown>> {
  const type = message?.type;
  const callId: string | undefined = message?.call?.id;

  // A browser test call's webhook (lib/voiceTest.ts) may only act on that org's test calls.
  if (scope) {
    if (type === 'assistant-request' || !callId) return { received: true };
    const ok = await ensureTestCallRow(scope.testOrgId, callId, message?.call);
    if (!ok) return { received: true };
  } else if (type === 'assistant-request') {
    return handleInboundCall(message, baseUrl);
  }

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
          name === 'book_meeting' && callId
            ? await bookMeetingFromCall(callId, args)
            : name === 'do_not_contact' && callId
              ? await doNotContactFromCall(callId)
              : `Tool "${name}" isn't available on this call.`;
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
    const ended = await handleEndOfCallReport(message, callId);
    // That call's slot in the queue is free — start the next queued call for this org now,
    // rather than waiting for the scheduled dispatcher.
    if (scope) return { received: true }; // test calls: no queue, follow-up or automatic learning
    const queueOrgId = await markQueuedCallFinished(callId, ended ? (ended.answered ? 'answered' : 'not answered') : null);
    if (queueOrgId) await processCallQueue(baseUrl, placeOrgVoiceCall, queueOrgId).catch((err) => console.error('[Vapi] Call queue failed', err));
    // A real conversation happened — review it for lessons the voice agent can use next call.
    if (ended?.answered) await reviewAfterConversation(ended.orgId);
  }

  return { received: true };
}

/** The voice_calls row for a browser test call, created on its first webhook. A call id that
 * already belongs to a real call or another org is refused. */
async function ensureTestCallRow(orgId: string, callId: string, call: any): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return false;
  const { data: row } = await supabase.from('voice_calls').select('org_id, direction').eq('vapi_call_id', callId).maybeSingle();
  if (row) return row.org_id === orgId && row.direction === 'test';
  const vars = call?.assistantOverrides?.variableValues || {};
  const { error } = await supabase.from('voice_calls').insert({
    org_id: orgId,
    vapi_call_id: callId,
    phone: 'browser test',
    direction: 'test',
    lead_name: typeof vars.name === 'string' ? vars.name.slice(0, 120) : 'Test caller',
    lead_company: typeof vars.company === 'string' ? vars.company.slice(0, 120) : null,
    lead_country: typeof vars.country === 'string' ? vars.country.slice(0, 80) : null,
    lead_email: typeof vars.email === 'string' ? vars.email.slice(0, 200) : null,
    call_status: 'in-progress',
  });
  if (!error) return true;
  // Two webhooks for a new call can race to create it — the loser checks what won.
  const { data: again } = await supabase.from('voice_calls').select('org_id, direction').eq('vapi_call_id', callId).maybeSingle();
  return !!again && again.org_id === orgId && again.direction === 'test';
}

function digitsOnly(phone: string | undefined | null): string {
  return (phone || '').replace(/\D/g, '');
}

/** Finds the caller among the org's clients. Stored numbers are formatted any which way
 * ("+971 50 123 4567"), so this narrows by the last 4 digits and compares the last 9. */
async function findClientByPhone(orgId: string, callerNumber: string | undefined) {
  const supabase = getSupabaseAdmin();
  const digits = digitsOnly(callerNumber);
  if (!supabase || digits.length < 7) return null;
  const { data } = await supabase
    .from('clients')
    .select('id, name, company, email, country, opted_out, phone')
    .eq('org_id', orgId)
    .ilike('phone', `%${digits.slice(-4)}`)
    .limit(50);
  const tail = digits.slice(-9);
  return (data || []).find((c: any) => digitsOnly(c.phone).endsWith(tail)) || null;
}

/**
 * Someone dialed an org's number. Vapi asks which assistant should answer (the number has
 * none fixed — see configurePhoneNumberForInbound); this answers with the org's own
 * assistant plus the same webhook, booking tool and lessons as an outbound call, and a
 * greeting for an incoming caller. Has to respond within Vapi's ~7.5s limit.
 */
async function handleInboundCall(message: any, baseUrl: string | null): Promise<Record<string, unknown>> {
  const call = message?.call || {};
  const phoneNumberId: string | undefined = call.phoneNumberId || message?.phoneNumber?.id;
  const callerNumber: string | undefined = call.customer?.number || message?.customer?.number;
  const sorry = "Sorry, this number isn't taking calls right now. Please try again later.";

  const orgId = phoneNumberId ? await getOrgIdByVoicePhoneNumberId(phoneNumberId) : null;
  if (!orgId) {
    console.warn('[Vapi] Inbound call to a number not assigned to any org:', phoneNumberId);
    return { error: sorry };
  }
  if ((await getOrgAccessStatus(orgId)) === 'locked') return { error: sorry };

  const [{ creds, settings }, profile, client] = await Promise.all([
    resolveOrgVoiceSetup(orgId),
    getOrgProfile(orgId),
    findClientByPhone(orgId, callerNumber),
  ]);
  const assistantId = creds.assistantId || process.env.VAPI_ASSISTANT_ID;
  if (!assistantId) return { error: sorry };

  const lead: CallLead = client
    ? { name: client.name, company: client.company, email: client.email || undefined, country: client.country || undefined }
    : {};
  const companyName = profile?.companyName || undefined;
  const notice = noticeForLead(settings, client?.country, callerNumber);
  const language = voiceLanguageOverrides(settings?.vapiLanguage, settings?.vapiVoiceGender);
  const overrides =
    (await buildCallOverrides(orgId, { ...creds, assistantId }, baseUrl, lead, language, notice, {
      callerNumber,
      knownCaller: !!client,
      companyName,
    })) || {};

  // The built-in default greeting is English; in any other language the model writes the
  // greeting itself (in that language) unless the org typed its own.
  const customGreeting = settings?.vapiInboundFirstMessage?.trim();
  const englishGreeting = !language || language.language.code.startsWith('en');
  const sentence = noticeSentence(notice);
  const withNotice = (text: string) => (sentence ? `${text.trim()} ${sentence}` : text);
  const greeting = customGreeting && (englishGreeting || !sentence)
    ? { firstMessage: withNotice(customGreeting), firstMessageMode: 'assistant-speaks-first' }
    : englishGreeting
      ? {
          firstMessage: sentence
            ? `Hi, thanks for calling${companyName ? ` ${companyName}` : ''}! ${sentence} How can I help you today?`
            : `Hi, thanks for calling${companyName ? ` ${companyName}` : ''}! ${client?.name ? `Am I speaking with ${client.name.split(' ')[0]}? ` : ''}How can I help you today?`,
          firstMessageMode: 'assistant-speaks-first',
        }
      : { firstMessageMode: 'assistant-speaks-first-with-model-generated-message' };

  const supabase = getSupabaseAdmin();
  if (supabase && call.id) {
    const { error } = await supabase.from('voice_calls').insert({
      org_id: orgId,
      vapi_call_id: call.id,
      client_id: client?.id || null,
      phone: callerNumber || 'unknown',
      lead_name: client?.name || null,
      lead_company: client?.company || null,
      lead_email: client?.email || null,
      lead_country: client?.country || null,
      call_status: 'ringing',
      direction: 'inbound',
    });
    if (error) console.error('[Vapi] Failed to log inbound call', call.id, error.message);
  }

  return {
    assistantId,
    assistantOverrides: { ...overrides, ...greeting },
  };
}

/**
 * Makes an org's number answer incoming calls with its AI agent: points the number at this
 * app on Vapi, and records it in org_voice so inbound calls route to this org. On the
 * platform account the number must already be the one the admin assigned; on an org's own
 * account, Vapi accepting the update with the org's key is the proof it owns the number.
 */
export async function enableInboundCalls(orgId: string, baseUrl: string | null): Promise<{ ok: boolean; error?: string; phoneNumber?: string | null }> {
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (!baseUrl) return { ok: false, error: "Inbound calls need the app's public URL — set APP_URL on the server (localhost can't receive calls)." };
  if (!secret) return { ok: false, error: 'VAPI_WEBHOOK_SECRET is not set on the server.' };

  const { creds, ownAccount } = await resolveOrgVoiceSetup(orgId);
  const apiKey = creds.apiKey || process.env.VAPI_API_KEY;
  if (!apiKey) return { ok: false, error: 'Voice calling is not set up on the platform yet.' };
  if (!creds.phoneNumberId) {
    return { ok: false, error: ownAccount ? 'Add your Vapi Phone Number ID first.' : 'No phone number is assigned to your workspace yet — contact support to get one.' };
  }

  const result = await configurePhoneNumberForInbound(apiKey, creds.phoneNumberId, { url: `${baseUrl}/api/voice/vapi?action=webhook`, secret });
  if (!result.ok) return { ok: false, error: result.error };

  const saved = await saveOrgVoice(orgId, {
    phone_number_id: creds.phoneNumberId,
    phone_number: result.number?.number || null,
    inbound_enabled: true,
  });
  if (saved.error) return { ok: false, error: saved.error };
  return { ok: true, phoneNumber: result.number?.number || null };
}
