import { zonedTimeToUtc } from './countryTiming.js';
import type { ChannelApiSettings } from '../src/types.js';

/**
 * When the AI may book meetings: the org's meeting days and hours in the org's own time
 * zone, and a minimum notice. Checked server-side before every booking (WhatsApp, email and
 * the voice agent's book_meeting tool) — the AI is told the hours too, but the check is what
 * guarantees a 7 AM Sunday slot never lands on the team's calendar.
 *
 * Defaults: Monday–Friday, 9:00–18:00, at least 2 hours ahead. Without a saved time zone the
 * hours apply in the lead's own time zone (better than none).
 */

export interface MeetingRules {
  days: number[]; // 0 = Sunday … 6 = Saturday
  startHour: number;
  endHour: number;
  timeZone: string | null;
  minNoticeHours: number;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function validZone(tz: string | null | undefined): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

export function meetingRulesFor(settings: ChannelApiSettings | null | undefined, leadTimeZone?: string | null): MeetingRules {
  const days = (settings?.meetingDays || [1, 2, 3, 4, 5]).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  const startHour = Math.min(23, Math.max(0, Math.floor(settings?.meetingStartHour ?? 9)));
  const endHour = Math.min(24, Math.max(startHour + 1, Math.floor(settings?.meetingEndHour ?? 18)));
  return {
    days: days.length ? days : [1, 2, 3, 4, 5],
    startHour,
    endHour,
    timeZone: validZone(settings?.meetingTimeZone) || validZone(leadTimeZone) || null,
    minNoticeHours: Math.min(168, Math.max(0, settings?.meetingMinNoticeHours ?? 2)),
  };
}

function localParts(date: Date, timeZone: string | null) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'UTC',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { weekday: SHORT.indexOf(p.weekday), minutes: Number(p.hour) * 60 + Number(p.minute), year: Number(p.year), month: Number(p.month), day: Number(p.day) };
}

function dayRange(days: number[]): string {
  const sorted = [...days].sort();
  const consecutive = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  if (consecutive && sorted.length > 2) return `${DAY_NAMES[sorted[0]]}–${DAY_NAMES[sorted[sorted.length - 1]]}`;
  return sorted.map((d) => DAY_NAMES[d]).join(', ');
}

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;
const zoneLabel = (tz: string | null) => (tz ? tz.split('/').pop()!.replace(/_/g, ' ') + ' time' : 'the lead’s local time');

/** "Monday–Friday, 09:00–18:00 Dubai time (10:30–19:30 your time)" — the lead's part only when it differs. */
export function describeMeetingHours(rules: MeetingRules, leadTimeZone?: string | null, now = new Date()): string {
  let base = `${dayRange(rules.days)}, ${hh(rules.startHour)}–${hh(rules.endHour)} ${zoneLabel(rules.timeZone)}`;
  const lead = validZone(leadTimeZone);
  if (rules.timeZone && lead && lead !== rules.timeZone) {
    const today = localParts(now, rules.timeZone);
    const toLead = (h: number) =>
      zonedTimeToUtc(today.year, today.month, today.day, h, 0, rules.timeZone!).toLocaleTimeString('en-GB', { timeZone: lead, hour: '2-digit', minute: '2-digit' });
    const startLead = toLead(rules.startHour);
    const endLead = toLead(rules.endHour % 24);
    if (startLead !== hh(rules.startHour) || endLead !== hh(rules.endHour % 24)) base += ` (${startLead}–${endLead} the lead’s time)`;
  }
  return base;
}

export interface MeetingCheck {
  ok: boolean;
  reason?: 'past' | 'notice' | 'day' | 'hours';
  /** Why it can't be booked (empty when ok). */
  message: string;
}

/** Whether a meeting starting at startIso (lasting durationMinutes) fits the org's rules. */
export function checkMeetingTime(startIso: string, durationMinutes: number, rules: MeetingRules, leadTimeZone?: string | null, now = new Date()): MeetingCheck {
  const start = new Date(startIso);
  if (isNaN(start.getTime()) || start.getTime() <= now.getTime()) return { ok: false, reason: 'past', message: 'That time has already passed.' };
  if (start.getTime() < now.getTime() + rules.minNoticeHours * 3_600_000) {
    return { ok: false, reason: 'notice', message: `Meetings need at least ${rules.minNoticeHours} hour${rules.minNoticeHours === 1 ? '' : 's'} notice.` };
  }
  const hours = describeMeetingHours(rules, leadTimeZone, now);
  const local = localParts(start, rules.timeZone);
  if (!rules.days.includes(local.weekday)) return { ok: false, reason: 'day', message: `Meetings can only be booked ${hours}.` };
  const endMinutes = local.minutes + Math.max(1, durationMinutes);
  if (local.minutes < rules.startHour * 60 || endMinutes > rules.endHour * 60) return { ok: false, reason: 'hours', message: `Meetings can only be booked ${hours}.` };
  return { ok: true, message: '' };
}

/** What the booking AI is told, so it proposes times that will pass the check. */
export function meetingRulesPrompt(rules: MeetingRules, leadTimeZone?: string | null, now = new Date()): string {
  return `- AVAILABILITY: only propose or accept meetings ${describeMeetingHours(rules, leadTimeZone, now)}, starting at least ${rules.minNoticeHours} hour${rules.minNoticeHours === 1 ? '' : 's'} from now. Convert to the prospect's local time when you talk about times. If they ask for a time outside this, kindly offer the nearest times that fit.`;
}
