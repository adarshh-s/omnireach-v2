import { getOrgGoogleCalendarToken, getOrgMicrosoftCalendarToken } from './orgSettings.js';
import * as googleCalendar from './googleCalendar.js';
import * as microsoftCalendar from './microsoftCalendar.js';

export type CalendarProvider = 'google' | 'microsoft';

export interface ConnectedCalendar {
  provider: CalendarProvider;
  refreshToken: string;
  calendarId?: string; // Google only
}

/** An org connects at most one calendar provider — whichever is connected wins. Google is
 * checked first only because it shipped first; there's no real preference if both were
 * somehow connected. */
export async function getConnectedCalendar(orgId: string): Promise<ConnectedCalendar | null> {
  const [google, microsoft] = await Promise.all([getOrgGoogleCalendarToken(orgId), getOrgMicrosoftCalendarToken(orgId)]);
  if (google) return { provider: 'google', refreshToken: google.refreshToken, calendarId: google.calendarId };
  if (microsoft) return { provider: 'microsoft', refreshToken: microsoft.refreshToken };
  return null;
}

export interface BookMeetingParams {
  calendar: ConnectedCalendar;
  summary: string;
  description?: string;
  startIso: string;
  durationMinutes: number;
  attendeeEmail?: string;
  attendeeName?: string;
}

export interface BookMeetingResult {
  eventId: string;
  meetLink: string;
}

/** Dispatches to whichever provider is connected. Throws 'SLOT_ALREADY_BOOKED' the same way
 * both underlying implementations do, so callers' existing catch blocks don't need to change. */
export async function bookMeeting(params: BookMeetingParams): Promise<BookMeetingResult | null> {
  const { calendar } = params;
  if (calendar.provider === 'google') {
    return googleCalendar.createMeetingEvent({
      refreshToken: calendar.refreshToken,
      calendarId: calendar.calendarId,
      summary: params.summary,
      description: params.description,
      startIso: params.startIso,
      durationMinutes: params.durationMinutes,
      attendeeEmail: params.attendeeEmail,
      attendeeName: params.attendeeName,
    });
  }
  return microsoftCalendar.createMeetingEvent({
    refreshToken: calendar.refreshToken,
    summary: params.summary,
    description: params.description,
    startIso: params.startIso,
    durationMinutes: params.durationMinutes,
    attendeeEmail: params.attendeeEmail,
    attendeeName: params.attendeeName,
  });
}

export async function cancelMeeting(calendar: ConnectedCalendar, eventId: string): Promise<void> {
  if (calendar.provider === 'google') {
    await googleCalendar.cancelMeetingEvent(calendar.refreshToken, calendar.calendarId || 'primary', eventId);
  } else {
    await microsoftCalendar.cancelMeetingEvent(calendar.refreshToken, eventId);
  }
}

/** meetLink's label differs by provider ("Google Meet" vs "Microsoft Teams") — small enough
 * that duplicating a ternary in both webhook handlers wasn't worth it either. */
export function meetingLinkLabel(provider: CalendarProvider): string {
  return provider === 'google' ? 'Google Meet' : 'Microsoft Teams';
}
