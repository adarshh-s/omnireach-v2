/**
 * Which legal region a lead is in, for rules that only apply in some markets. Decided from
 * the lead's country when it's known, else from the phone number's country code.
 *
 * - AI disclosure ("I'm an AI assistant") is required for people in the EU/EEA (AI Act,
 *   Art. 50, from 2 Aug 2026) and the US (FCC treats AI voices as "artificial voice" calls;
 *   several states require bot disclosure). Elsewhere — India, the Gulf — there's no such
 *   rule today, so it's only said when the org chooses "always".
 * - US numbers (+1) need prior express written consent for marketing calls made with an
 *   AI/artificial voice (TCPA).
 */

export type LegalRegion = 'eu' | 'us' | 'other' | 'unknown';

const EU_EEA_NAMES = [
  'austria', 'belgium', 'bulgaria', 'croatia', 'cyprus', 'czechia', 'czechrepublic', 'denmark', 'estonia', 'finland',
  'france', 'germany', 'greece', 'hungary', 'ireland', 'italy', 'latvia', 'lithuania', 'luxembourg', 'malta',
  'netherlands', 'holland', 'poland', 'portugal', 'romania', 'slovakia', 'slovenia', 'spain', 'sweden',
  'iceland', 'liechtenstein', 'norway',
];
const EU_EEA_ISO = ['at', 'be', 'bg', 'hr', 'cy', 'cz', 'dk', 'ee', 'fi', 'fr', 'de', 'gr', 'hu', 'ie', 'it', 'lv', 'lt', 'lu', 'mt', 'nl', 'pl', 'pt', 'ro', 'sk', 'si', 'es', 'se', 'is', 'li', 'no'];
const US_NAMES = ['unitedstates', 'unitedstatesofamerica', 'usa', 'us', 'america'];
// EU/EEA calling codes. +1 is the whole North American plan (US, Canada, Caribbean) — treated
// as US, the stricter reading, when the country isn't known.
const EU_EEA_DIAL = ['43', '32', '359', '385', '357', '420', '45', '372', '358', '33', '49', '30', '36', '353', '39', '371', '370', '352', '356', '31', '48', '351', '40', '421', '386', '34', '46', '354', '423', '47'];

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, '');
}

export function legalRegion(country: string | null | undefined, phone: string | null | undefined): LegalRegion {
  if (country && country.trim()) {
    const c = normalize(country);
    if (US_NAMES.includes(c)) return 'us';
    if (EU_EEA_NAMES.includes(c) || (c.length === 2 && EU_EEA_ISO.includes(c))) return 'eu';
    if (c.length > 0) return 'other';
  }
  const raw = (phone || '').trim();
  // Without a leading + (or 00) the country code can't be read reliably.
  if (!/^(\+|00)/.test(raw)) return 'unknown';
  const digits = raw.replace(/\D/g, '').replace(/^00/, '');
  if (digits.startsWith('1')) return 'us';
  if (EU_EEA_DIAL.some((code) => digits.startsWith(code))) return 'eu';
  return 'other';
}

export type AiDisclosureMode = 'required' | 'always' | 'never';

/** Whether to say "I'm an AI assistant" on this call. In "required" mode a lead whose region
 * can't be told is treated as if it needs it (the safe side). */
export function needsAiDisclosure(mode: AiDisclosureMode | undefined, country: string | null | undefined, phone: string | null | undefined): boolean {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  const region = legalRegion(country, phone);
  return region === 'eu' || region === 'us' || region === 'unknown';
}
