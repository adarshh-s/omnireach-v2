import { google } from 'googleapis';

function getOAuthClient(refreshToken: string) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret || !refreshToken) return null;

  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oAuth2Client.setCredentials({ refresh_token: refreshToken });
  return oAuth2Client;
}

export interface CreateMeetingParams {
  refreshToken: string;
  calendarId?: string;
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

/**
 * Lightweight, read-only check that the org's stored refresh token still works and the
 * Calendar API is actually enabled on the underlying Google Cloud project — the two
 * failure modes that otherwise only surface later, mid-booking, when a real lead replies
 * (see lib/whatsappWebhookHandler.ts / lib/emailWebhookHandler.ts's booking try/catch).
 * Used by the Channel Health panel so an org can catch this before a demo or a real lead.
 */
export async function checkCalendarAccess(refreshToken: string, calendarId?: string): Promise<CalendarHealthResult> {
  const auth = getOAuthClient(refreshToken);
  if (!auth) return { ok: false, message: 'Google OAuth is not configured on the server.' };

  try {
    const calendar = google.calendar({ version: 'v3', auth });
    // events.list, not calendarList.get — the OAuth consent this app requests only grants
    // the narrower `calendar.events` scope (see lib/googleOAuthFlow.ts), which is enough to
    // create meetings but NOT enough for calendarList.get (needs the broader `calendar`/
    // `calendar.readonly` scope) — that mismatch is exactly what showed up as a false
    // "Insufficient Permission" here even though real booking works fine.
    await calendar.events.list({ calendarId: calendarId || 'primary', maxResults: 1 });
    return { ok: true, message: 'Connected and working.' };
  } catch (err: any) {
    const apiMessage = err?.errors?.[0]?.message || err?.response?.data?.error?.message || err?.message || 'Unknown error';
    return { ok: false, message: apiMessage };
  }
}

export async function createMeetingEvent(params: CreateMeetingParams): Promise<CreateMeetingResult | null> {
  const auth = getOAuthClient(params.refreshToken);
  if (!auth) return null;

  const calendar = google.calendar({ version: 'v3', auth });
  const calendarId = params.calendarId || 'primary';

  const start = new Date(params.startIso);
  const end = new Date(start.getTime() + params.durationMinutes * 60000);

  // The bot tends to offer the same default slots ("tomorrow 3pm") to every lead, so two
  // different prospects can independently confirm the identical time — without this check,
  // both would get a real, separate Google Meet booked on top of each other with no warning
  // to the org. Uses events.list (not freebusy.query) since that's the scope this app's
  // OAuth consent already requests (see checkCalendarAccess above).
  const existing = await calendar.events.list({
    calendarId,
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
  });
  const hasConflict = (existing.data.items || []).some((e) => e.status !== 'cancelled');
  if (hasConflict) {
    throw new Error('SLOT_ALREADY_BOOKED');
  }

  const event = await calendar.events.insert({
    calendarId,
    conferenceDataVersion: 1,
    sendUpdates: 'all',
    requestBody: {
      summary: params.summary,
      description: params.description,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      attendees: params.attendeeEmail ? [{ email: params.attendeeEmail, displayName: params.attendeeName }] : undefined,
      conferenceData: {
        createRequest: {
          requestId: `omnireach-${Date.now()}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    },
  });

  const meetLink =
    event.data.hangoutLink ||
    event.data.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri ||
    '';

  return {
    eventId: event.data.id || '',
    meetLink,
    htmlLink: event.data.htmlLink || '',
  };
}

/**
 * Cancels a previously-booked meeting — used when a prospect disputes/retracts a
 * confirmation (including one the bot mistakenly registered) or asks to reschedule, so the
 * org's calendar doesn't keep a real event that the conversation itself no longer considers
 * booked. Treats "already gone" as success rather than an error, since the org may have
 * already deleted it manually.
 */
export async function cancelMeetingEvent(refreshToken: string, calendarId: string | undefined, eventId: string): Promise<boolean> {
  const auth = getOAuthClient(refreshToken);
  if (!auth || !eventId) return false;

  const calendar = google.calendar({ version: 'v3', auth });
  try {
    await calendar.events.delete({ calendarId: calendarId || 'primary', eventId, sendUpdates: 'all' });
    return true;
  } catch (err: any) {
    if (err?.code === 410 || err?.code === 404) return true; // already gone
    console.error('[Calendar] Failed to cancel meeting event:', err);
    return false;
  }
}
