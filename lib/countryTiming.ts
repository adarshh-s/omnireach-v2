import { publicHoliday } from './holidays.js';
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
  /** Countries spanning several time zones: a call must be within hours in all of them
   * (e.g. 9 AM in New York is 6 AM in Los Angeles). */
  zones?: string[];
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
  // UAE moved to a Saturday-Sunday weekend in 2022, unlike the rest of the GCC.
  uae: { timezone: 'Asia/Dubai', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
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
  unitedstates: {
    timezone: 'America/New_York',
    zones: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'],
    weekend: STANDARD_WEEKEND,
    windows: DEFAULT_WINDOWS,
  },
  canada: { timezone: 'America/Toronto', zones: ['America/Toronto', 'America/Winnipeg', 'America/Edmonton', 'America/Vancouver'], weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  germany: { timezone: 'Europe/Berlin', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  france: { timezone: 'Europe/Paris', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  australia: { timezone: 'Australia/Sydney', zones: ['Australia/Sydney', 'Australia/Adelaide', 'Australia/Brisbane', 'Australia/Perth'], weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  newzealand: { timezone: 'Pacific/Auckland', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  russia: { timezone: 'Europe/Moscow', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  // Rest of the EU/EEA and Europe — a launch market, so every country is known.
  ireland: { timezone: 'Europe/Dublin', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  spain: { timezone: 'Europe/Madrid', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  portugal: { timezone: 'Europe/Lisbon', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  italy: { timezone: 'Europe/Rome', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  netherlands: { timezone: 'Europe/Amsterdam', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  belgium: { timezone: 'Europe/Brussels', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  luxembourg: { timezone: 'Europe/Luxembourg', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  austria: { timezone: 'Europe/Vienna', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  switzerland: { timezone: 'Europe/Zurich', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  denmark: { timezone: 'Europe/Copenhagen', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  sweden: { timezone: 'Europe/Stockholm', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  norway: { timezone: 'Europe/Oslo', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  finland: { timezone: 'Europe/Helsinki', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  iceland: { timezone: 'Atlantic/Reykjavik', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  poland: { timezone: 'Europe/Warsaw', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  czechia: { timezone: 'Europe/Prague', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  slovakia: { timezone: 'Europe/Bratislava', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  hungary: { timezone: 'Europe/Budapest', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  slovenia: { timezone: 'Europe/Ljubljana', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  croatia: { timezone: 'Europe/Zagreb', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  romania: { timezone: 'Europe/Bucharest', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  bulgaria: { timezone: 'Europe/Sofia', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  greece: { timezone: 'Europe/Athens', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  cyprus: { timezone: 'Asia/Nicosia', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  malta: { timezone: 'Europe/Malta', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  estonia: { timezone: 'Europe/Tallinn', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  latvia: { timezone: 'Europe/Riga', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  lithuania: { timezone: 'Europe/Vilnius', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  israel: { timezone: 'Asia/Jerusalem', weekend: GCC_WEEKEND, windows: DEFAULT_WINDOWS },
  mexico: { timezone: 'America/Mexico_City', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  brazil: { timezone: 'America/Sao_Paulo', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
  kenya: { timezone: 'Africa/Nairobi', weekend: STANDARD_WEEKEND, windows: DEFAULT_WINDOWS },
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
  'new zealand': 'newzealand',
  russia: 'russia',
  ireland: 'ireland',
  spain: 'spain',
  espana: 'spain',
  portugal: 'portugal',
  italy: 'italy',
  italia: 'italy',
  netherlands: 'netherlands',
  'the netherlands': 'netherlands',
  holland: 'netherlands',
  belgium: 'belgium',
  luxembourg: 'luxembourg',
  austria: 'austria',
  switzerland: 'switzerland',
  denmark: 'denmark',
  sweden: 'sweden',
  norway: 'norway',
  finland: 'finland',
  iceland: 'iceland',
  poland: 'poland',
  czechia: 'czechia',
  'czech republic': 'czechia',
  slovakia: 'slovakia',
  hungary: 'hungary',
  slovenia: 'slovenia',
  croatia: 'croatia',
  romania: 'romania',
  bulgaria: 'bulgaria',
  greece: 'greece',
  cyprus: 'cyprus',
  malta: 'malta',
  estonia: 'estonia',
  latvia: 'latvia',
  lithuania: 'lithuania',
  israel: 'israel',
  mexico: 'mexico',
  brazil: 'brazil',
  kenya: 'kenya',
  deutschland: 'germany',
  scotland: 'unitedkingdom',
  wales: 'unitedkingdom',
  'great britain': 'unitedkingdom',
  'northern ireland': 'unitedkingdom',
  america: 'unitedstates',
};

// ISO 3166 two-letter codes, as many spreadsheets and CRMs store the country.
const ISO_CODES: Record<string, keyof typeof COUNTRY_TIMING> = {
  ae: 'uae', sa: 'saudiarabia', qa: 'qatar', kw: 'kuwait', om: 'oman', bh: 'bahrain', in: 'india', pk: 'pakistan',
  bd: 'bangladesh', lk: 'srilanka', np: 'nepal', ph: 'philippines', sg: 'singapore', my: 'malaysia', cn: 'china',
  hk: 'hongkong', id: 'indonesia', jp: 'japan', kr: 'southkorea', eg: 'egypt', jo: 'jordan', lb: 'lebanon', tr: 'turkey',
  za: 'southafrica', ng: 'nigeria', gb: 'unitedkingdom', us: 'unitedstates', ca: 'canada', de: 'germany', fr: 'france',
  au: 'australia', nz: 'newzealand', ru: 'russia', ie: 'ireland', es: 'spain', pt: 'portugal', it: 'italy', nl: 'netherlands',
  be: 'belgium', lu: 'luxembourg', at: 'austria', ch: 'switzerland', dk: 'denmark', se: 'sweden', no: 'norway', fi: 'finland',
  is: 'iceland', pl: 'poland', cz: 'czechia', sk: 'slovakia', hu: 'hungary', si: 'slovenia', hr: 'croatia', ro: 'romania',
  bg: 'bulgaria', gr: 'greece', cy: 'cyprus', mt: 'malta', ee: 'estonia', lv: 'latvia', lt: 'lithuania', il: 'israel',
  mx: 'mexico', br: 'brazil', ke: 'kenya',
};

// International dialling codes → country, for leads saved without a country. Longest match wins.
const DIAL_CODES: [string, keyof typeof COUNTRY_TIMING][] = (
  [
    ['1', 'unitedstates'], ['7', 'russia'], ['20', 'egypt'], ['27', 'southafrica'], ['30', 'greece'], ['31', 'netherlands'],
    ['32', 'belgium'], ['33', 'france'], ['34', 'spain'], ['36', 'hungary'], ['39', 'italy'], ['40', 'romania'],
    ['41', 'switzerland'], ['43', 'austria'], ['44', 'unitedkingdom'], ['45', 'denmark'], ['46', 'sweden'], ['47', 'norway'],
    ['48', 'poland'], ['49', 'germany'], ['52', 'mexico'], ['55', 'brazil'], ['60', 'malaysia'], ['61', 'australia'],
    ['62', 'indonesia'], ['63', 'philippines'], ['64', 'newzealand'], ['65', 'singapore'], ['81', 'japan'], ['82', 'southkorea'],
    ['86', 'china'], ['90', 'turkey'], ['91', 'india'], ['92', 'pakistan'], ['94', 'srilanka'], ['234', 'nigeria'],
    ['254', 'kenya'], ['351', 'portugal'], ['352', 'luxembourg'], ['353', 'ireland'], ['354', 'iceland'], ['356', 'malta'],
    ['357', 'cyprus'], ['358', 'finland'], ['359', 'bulgaria'], ['370', 'lithuania'], ['371', 'latvia'], ['372', 'estonia'],
    ['385', 'croatia'], ['386', 'slovenia'], ['420', 'czechia'], ['421', 'slovakia'], ['852', 'hongkong'], ['880', 'bangladesh'],
    ['961', 'lebanon'], ['962', 'jordan'], ['965', 'kuwait'], ['966', 'saudiarabia'], ['968', 'oman'], ['971', 'uae'],
    ['972', 'israel'], ['973', 'bahrain'], ['974', 'qatar'], ['977', 'nepal'],
  ] as [string, keyof typeof COUNTRY_TIMING][]
).sort((a, b) => b[0].length - a[0].length);

/** The country an international phone number belongs to ("+44 20…", "0044…", or 11+ digits
 * with no leading 0, as WhatsApp stores them). Local-format numbers ("050…") can't be told. */
export function countryKeyFromPhone(phone: string | undefined | null): string | null {
  const raw = (phone || '').trim();
  let digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) {
    // already international
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (!(digits.length >= 11 && !digits.startsWith('0'))) {
    return null;
  }
  const hit = DIAL_CODES.find(([code]) => digits.startsWith(code));
  return hit ? hit[1] : null;
}

function normalize(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[.]/g, '')
    .replace(/\s+/g, ' ');
}

function countryKey(country: string | undefined | null): string | null {
  if (!country) return null;
  const n = normalize(country);
  return ALIASES[n] || (n.length === 2 ? ISO_CODES[n] : undefined) || null;
}

function resolveCountry(country: string | undefined | null): CountryTimingEntry | null {
  const key = countryKey(country);
  return key ? COUNTRY_TIMING[key] : null;
}

/** The lead's country (normalised key, e.g. 'unitedkingdom'), from the country field or else
 * the phone number's dialling code. */
export function resolveCountryKey(country: string | undefined | null, phone?: string | null): string | null {
  return countryKey(country) || countryKeyFromPhone(phone);
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

/**
 * Whether it's a reasonable time to phone someone in this country right now — a wider
 * window than the peak-send windows above (a live call at 6 PM is fine, a WhatsApp at
 * 6 PM just gets buried), but never on their weekend or outside 9:00–19:59 local time.
 * Unrecognized countries are allowed (never blocks on missing data, same as
 * computeNextPeakSendTime). Returns the lead's local time label for error messages.
 */
export function checkCallingHours(
  country: string | undefined | null,
  now: Date = new Date(),
  options: { phone?: string | null; skipHolidays?: boolean } = {}
): { allowed: boolean; localTimeLabel?: string; timeZone?: string; holiday?: string } {
  // No country on the lead: go by the phone number's dialling code.
  const key = resolveCountryKey(country, options.phone);
  const entry = key ? COUNTRY_TIMING[key] : null;
  if (!entry) return { allowed: true };
  const localTimeLabel = now.toLocaleString('en-US', { timeZone: entry.timezone, weekday: 'long', hour: 'numeric', minute: '2-digit' });
  const allowed = (entry.zones || [entry.timezone]).every((tz) => {
    const local = getLocalDateParts(now, tz);
    return !entry.weekend.includes(local.weekday) && local.hour >= 9 && local.hour < 20;
  });
  if (allowed && options.skipHolidays !== false) {
    const local = getLocalDateParts(now, entry.timezone);
    const holiday = publicHoliday(key!, local.year, local.month, local.day);
    if (holiday) return { allowed: false, localTimeLabel, timeZone: entry.timezone, holiday };
  }
  return { allowed, localTimeLabel, timeZone: entry.timezone };
}

export function isCountryRecognized(country: string | undefined | null): boolean {
  return resolveCountry(country) !== null;
}

/** The lead's time zone from the country field, else the phone number. */
export function getTimezoneForLead(country: string | undefined | null, phone?: string | null): string | null {
  const key = resolveCountryKey(country, phone);
  return key ? COUNTRY_TIMING[key].timezone : null;
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
