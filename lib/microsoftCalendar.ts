import { getMicrosoftAccessToken } from './microsoftOAuthFlow.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export interface CreateMeetingParams {
  refreshToken: string;
  summary: string;
  description?: string;
  startIso: string;
  durationMinutes: number;
  attendeeEmail?: string;
  attendeeName?: string;
}

export interface CreateMeetingResult {
  eventId: string;
  meetLink: string;
  htmlLink: string;
}

export interface CalendarHealthResult {
  ok: boolean;
  message: string;
}

/** Same shape as lib/googleCalendar.ts so the webhook handlers can call whichever provider
 * an org has connected without branching logic of their own. */
export async function checkCalendarAccess(refreshToken: string): Promise<CalendarHealthResult> {
  const token = await getMicrosoftAccessToken(refreshToken);
  if (!token) return { ok: false, message: 'Could not refresh the Outlook Calendar connection — try reconnecting.' };

  try {
    const res = await fetch(`${GRAPH_BASE}/me/events?$top=1`, {
      headers: { Authorization: `Bearer ${token.accessToken}` },
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, message: data?.error?.message || `Microsoft Graph rejected the request (${res.status}).` };
    }
    return { ok: true, message: 'Connected and working.' };
  } catch (err: any) {
    return { ok: false, message: err?.message || 'Failed to reach Microsoft Graph.' };
  }
}

export async function createMeetingEvent(params: CreateMeetingParams): Promise<CreateMeetingResult | null> {
  const token = await getMicrosoftAccessToken(params.refreshToken);
  if (!token) return null;

  const start = new Date(params.startIso);
  const end = new Date(start.getTime() + params.durationMinutes * 60000);
  const headers = { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' };

  // Same "two prospects independently confirm the same default slot" guard as Google Calendar
  // — check for any existing event in this window before booking a duplicate.
  const existing = await fetch(
    `${GRAPH_BASE}/me/calendarView?startDateTime=${encodeURIComponent(start.toISOString())}&endDateTime=${encodeURIComponent(end.toISOString())}`,
    { headers }
  );
  if (existing.ok) {
    const data = await existing.json().catch(() => ({ value: [] }));
    if ((data.value || []).length > 0) {
      throw new Error('SLOT_ALREADY_BOOKED');
    }
  }

  const res = await fetch(`${GRAPH_BASE}/me/events`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      subject: params.summary,
      body: { contentType: 'text', content: params.description || '' },
      start: { dateTime: start.toISOString(), timeZone: 'UTC' },
      end: { dateTime: end.toISOString(), timeZone: 'UTC' },
      attendees: params.attendeeEmail
        ? [{ emailAddress: { address: params.attendeeEmail, name: params.attendeeName || params.attendeeEmail }, type: 'required' }]
        : undefined,
      isOnlineMeeting: true,
      onlineMeetingProvider: 'teamsForBusiness',
    }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error?.message || `Microsoft Graph rejected the booking (${res.status}).`);
  }

  const event = await res.json();
  return {
    eventId: event.id,
    meetLink: event.onlineMeeting?.joinUrl || '',
    htmlLink: event.webLink || '',
  };
}

export async function cancelMeetingEvent(refreshToken: string, eventId: string): Promise<void> {
  const token = await getMicrosoftAccessToken(refreshToken);
  if (!token) return;
  try {
    await fetch(`${GRAPH_BASE}/me/events/${eventId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token.accessToken}` },
    });
  } catch {
    // Best-effort — mirrors lib/googleCalendar.ts's cancelMeetingEvent, which also doesn't
    // surface cancel failures to the conversation flow that triggered it.
  }
}
