/**
 * Country -> timezone/peak-business-hours lookup, used to schedule campaign sends for
 * when a client is actually likely to be awake and checking WhatsApp/email, instead of
 * blasting everyone at once regardless of timezone.
 *
 * Pure functions only (Intl + Date, no Node-only APIs) so this is safe to import from
 * both server code (api/, lib/) and the browser (BatchCampaignRunner.tsx).
 */

interface CountryTimingEntry {
  timezone: string;
  /** 0=Sun..6=Sat */
  weekend: number[];
  /** Local 24h hour ranges, e.g. [10, 12] means 10:00-11:59 local time. */
  windows: [number, number][];
}

const DEFAULT_WINDOWS: [number, number][] = [
  [10, 12],
  [15, 17],
];
const GCC_WEEKEND = [5, 6]; // Friday-Saturday
const STANDARD_WEEKEND = [0, 6]; // Saturday-Sunday

const COUNTRY_TIMING: Record<string, CountryTimingEntry> = {
  uae: { timezone: 'Asia/Dubai', weekend: GCC_WEEKEND, windows: DEFAULT_WINDOWS },
  saudiarabia: { timezone: 'Asia/Riyadh', weekend: GCC_WEEKEND, windows: DEFAULT_WINDOWS },
  qatar: { timezone: 'Asia/Qatar', weekend: GCC_WEEKEND, windows: DEFAULT_WINDOWS },
  kuwait: { timezone: 'Asia/Kuwait', weekend: GCC_WEEKEND, windows: DEFAULT_WINDOWS },
  oman: { timezone: 'Asia/Muscat', weekend: GCC_WEEKEND, windows: DEFAULT_WINDOWS },
  bahrain: { timezone: 'Asia/Bahrain', weekend: GCC_WEEKEND, windows: DEFAULT_WINDOWS },
  india: { timezone: 'Asia/Kolkata', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  pakistan: { timezone: 'Asia/Karachi', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  bangladesh: { timezone: 'Asia/Dhaka', weekend: GCC_WEEKEND, windows: DEFAULT_WINDOWS },
  srilanka: { timezone: 'Asia/Colombo', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  nepal: { timezone: 'Asia/Kathmandu', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  philippines: { timezone: 'Asia/Manila', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  singapore: { timezone: 'Asia/Singapore', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  malaysia: { timezone: 'Asia/Kuala_Lumpur', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  china: { timezone: 'Asia/Shanghai', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  hongkong: { timezone: 'Asia/Hong_Kong', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  indonesia: { timezone: 'Asia/Jakarta', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  japan: { timezone: 'Asia/Tokyo', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  southkorea: { timezone: 'Asia/Seoul', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  egypt: { timezone: 'Africa/Cairo', weekend: GCC_WEEKEND, windows: DEFAULT_WINDOWS },
  jordan: { timezone: 'Asia/Amman', weekend: GCC_WEEKEND, windows: DEFAULT_WINDOWS },
  lebanon: { timezone: 'Asia/Beirut', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  turkey: { timezone: 'Europe/Istanbul', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  southafrica: { timezone: 'Africa/Johannesburg', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  nigeria: { timezone: 'Africa/Lagos', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  unitedkingdom: { timezone: 'Europe/London', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  unitedstates: { timezone: 'America/New_York', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  canada: { timezone: 'America/Toronto', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  germany: { timezone: 'Europe/Berlin', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  france: { timezone: 'Europe/Paris', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  australia: { timezone: 'Australia/Sydney', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  russia: { timezone: 'Europe/Moscow', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
};

const ALIASES: Record<string, keyof typeof COUNTRY_TIMING> = {
  uae: 'uae',
  'united arab emirates': 'uae',
  'u a e': 'uae',
  dubai: 'uae',
  'abu dhabi': 'uae',
  'saudi arabia': 'saudiarabia',
  ksa: 'saudiarabia',
  saudi: 'saudiarabia',
  qatar: 'qatar',
  kuwait: 'kuwait',
  oman: 'oman',
  bahrain: 'bahrain',
  india: 'india',
  pakistan: 'pakistan',
  bangladesh: 'bangladesh',
  'sri lanka': 'srilanka',
  srilanka: 'srilanka',
  nepal: 'nepal',
  philippines: 'philippines',
  singapore: 'singapore',
  malaysia: 'malaysia',
  china: 'china',
  'hong kong': 'hongkong',
  hongkong: 'hongkong',
  indonesia: 'indonesia',
  japan: 'japan',
  'south korea': 'southkorea',
  korea: 'southkorea',
  egypt: 'egypt',
  jordan: 'jordan',
  lebanon: 'lebanon',
  turkey: 'turkey',
  turkiye: 'turkey',
  'south africa': 'southafrica',
  nigeria: 'nigeria',
  'united kingdom': 'unitedkingdom',
  uk: 'unitedkingdom',
  britain: 'unitedkingdom',
  england: 'unitedkingdom',
  'united states': 'unitedstates',
  usa: 'unitedstates',
  us: 'unitedstates',
  'united states of america': 'unitedstates',
  canada: 'canada',
  germany: 'germany',
  france: 'france',
  australia: 'australia',
  russia: 'russia',
};

function normalize(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[.]/g, '')
    .replace(/\s+/g, ' ');
}

function resolveCountry(country: string | undefined | null): CountryTimingEntry | null {
  if (!country) return null;
  const key = ALIASES[normalize(country)];
  return key ? COUNTRY_TIMING[key] : null;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function formatPartsToRecord(date: Date, timeZone: string, weekday: boolean): Record<string, string> {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    ...(weekday ? { weekday: 'short' as const } : {}),
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  return parts;
}

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

function getLocalDateParts(date: Date, timeZone: string): LocalDateParts {
  const parts = formatPartsToRecord(date, timeZone, true);
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    weekday: WEEKDAY_INDEX[parts.weekday] ?? 0,
  };
}

function getTimeZoneOffsetMinutes(utcDate: Date, timeZone: string): number {
  const parts = formatPartsToRecord(utcDate, timeZone, false);
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second)
  );
  return (asUTC - utcDate.getTime()) / 60000;
}

/** Converts a specific local wall-clock time in a given IANA timezone to a UTC Date. */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const offsetMinutes = getTimeZoneOffsetMinutes(utcGuess, timeZone);
  return new Date(utcGuess.getTime() - offsetMinutes * 60000);
}

/** Resolves a lead's country name to its IANA timezone, or null if unrecognized. */
export function getTimezoneForCountry(country: string | undefined | null): string | null {
  return resolveCountry(country)?.timezone || null;
}

/** "Today" as a Date-formattable label and YYYY-MM-DD string, in a given IANA timezone
 * (falling back to the server's own clock/UTC when timeZone is null/unrecognized). */
export function getLocalTodayInfo(now: Date, timeZone: string | null): { label: string; dateStr: string } {
  const label = now.toLocaleDateString('en-US', {
    timeZone: timeZone || undefined,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const dateStr = timeZone
    ? (() => {
        const p = getLocalDateParts(now, timeZone);
        return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
      })()
    : now.toISOString().slice(0, 10);
  return { label, dateStr };
}

/**
 * Returns `now` if the country is unrecognized (never blocks a send on missing data) or
 * if it's currently inside one of that country's peak local business-hour windows on a
 * non-weekend day. Otherwise returns the next qualifying window start as a UTC Date.
 */
export function computeNextPeakSendTime(country: string | undefined | null, now: Date = new Date()): Date {
  const entry = resolveCountry(country);
  if (!entry) return now;

  for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
    const candidate = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const local = getLocalDateParts(candidate, entry.timezone);
    if (entry.weekend.includes(local.weekday)) continue;

    for (const [startHour, endHour] of entry.windows) {
      if (dayOffset === 0 && local.hour >= startHour && local.hour < endHour) {
        return now;
      }
      if (dayOffset > 0 || local.hour < startHour) {
        return zonedTimeToUtc(local.year, local.month, local.day, startHour, 0, entry.timezone);
      }
    }
  }
  return now;
}

/** Human-readable label for a computed schedule time, e.g. "Tue, Sep 9, 10:00 AM (Asia/Dubai)". */
export function describeScheduledTime(date: Date, country: string | undefined | null): string {
  const entry = resolveCountry(country);
  const timeZone = entry?.timezone;
  return date.toLocaleString('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZoneName: 'short' as const } : {}),
  });
}

export function isCountryRecognized(country: string | undefined | null): boolean {
  return resolveCountry(country) !== null;
}

/**
 * Converts an AI-confirmed meeting "date"/"time" (YYYY-MM-DD / HH:MM, understood to be in
 * the given IANA timezone — see ConversationResult.meetingTimeZone) into the correct UTC
 * ISO instant for a calendar event. Falls back to naive local parsing only when no
 * timezone is known (unrecognized country), matching the old (imprecise) behavior rather
 * than failing the booking outright.
 */
export function toMeetingStartIso(date: string, time: string, timeZone: string | null | undefined): string {
  const [hour, minute] = time.split(':').map(Number);
  const [year, month, day] = date.split('-').map(Number);
  if (timeZone && year && month && day && !isNaN(hour) && !isNaN(minute)) {
    return zonedTimeToUtc(year, month, day, hour, minute, timeZone).toISOString();
  }
  return new Date(`${date}T${time}:00`).toISOString();
}
