import { createHmac } from 'crypto';
import { resolveOrgVoiceSetup } from './orgSettings.js';
import { buildCallOverrides, noticeForLead } from './voiceCalls.js';
import { voiceLanguageOverrides } from './voiceLanguages.js';
import { usageRoom, limitReachedMessage } from './usage.js';
import { safeEqual } from './security.js';

/**
 * Browser test calls for the "Test Voice Agent" page: the team talks to their own agent
 * through the microphone, set up exactly as a real call (voice, language, meeting rules,
 * lessons, booking tool), playing a lead they describe. Nothing real happens: bookings
 * aren't put on the calendar, "don't call me" doesn't touch the do-not-contact list, and
 * test calls stay out of the AI Inbox, follow-ups and automatic learning (voice_calls.direction
 * = 'test'). Minutes are counted, since they cost the same.
 *
 * The browser must never see VAPI_WEBHOOK_SECRET, so the call's webhook URL carries a
 * short-lived token signed with it, which only lets that org's test calls through.
 */

const TOKEN_TTL_MS = 2 * 3_600_000;

export function signTestToken(orgId: string, now = Date.now()): string | null {
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (!secret) return null;
  const payload = `${orgId}.${now + TOKEN_TTL_MS}`;
  const sig = createHmac('sha256', secret).update(`voice-test.${payload}`).digest('base64url');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

/** The org a test-call webhook belongs to, or null if the token is forged or expired. */
export function verifyTestToken(token: unknown, now = Date.now()): string | null {
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (!secret || typeof token !== 'string' || !token) return null;
  try {
    const [orgId, expires, sig] = Buffer.from(token, 'base64url').toString('utf8').split('.');
    if (!orgId || !expires || !sig) return null;
    const expected = createHmac('sha256', secret).update(`voice-test.${orgId}.${expires}`).digest('base64url');
    if (!safeEqual(sig, expected) || Number(expires) < now) return null;
    return orgId;
  } catch {
    return null;
  }
}

export interface TestPersona {
  name?: string;
  company?: string;
  country?: string;
  email?: string;
}

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export async function buildTestCallConfig(orgId: string, baseUrl: string | null, rawPersona: TestPersona) {
  if ((await usageRoom(orgId, 'call_minutes')) <= 0) return { ok: false, error: limitReachedMessage('call_minutes') };
  const { creds, ownAccount, settings } = await resolveOrgVoiceSetup(orgId);
  if (!creds.assistantId) {
    return { ok: false, error: 'Your voice agent isn’t set up yet — save its prompt in Channel Setup → Voice Agent first.' };
  }
  // The public key has to belong to the same Vapi account as the assistant.
  const publicKey = ownAccount ? settings?.vapiPublicKey : process.env.VAPI_PUBLIC_KEY || process.env.VITE_VAPI_PUBLIC_KEY;
  if (!publicKey) {
    return {
      ok: false,
      error: ownAccount
        ? 'Add your Vapi Public Key in Channel Setup → Voice Agent to test in the browser.'
        : 'Browser testing isn’t set up on this server yet (VAPI_PUBLIC_KEY is missing).',
    };
  }

  const persona = {
    name: clean(rawPersona.name, 80) || 'Alex',
    company: clean(rawPersona.company, 80),
    country: clean(rawPersona.country, 60),
    email: clean(rawPersona.email, 120),
  };
  const lead = { name: persona.name, company: persona.company || undefined, email: persona.email || undefined, country: persona.country || undefined };
  const language = voiceLanguageOverrides(settings?.vapiLanguage, settings?.vapiVoiceGender);
  const token = baseUrl ? signTestToken(orgId) : null;
  const overrides = await buildCallOverrides(orgId, creds, baseUrl, lead, language, noticeForLead(settings, lead.country, null), undefined, { token });

  return {
    ok: true,
    publicKey,
    assistantId: creds.assistantId,
    assistantOverrides: {
      ...(overrides || {}),
      // Read back by the webhook to label the test call (lib/voiceCalls.ts ensureTestCallRow).
      variableValues: { name: persona.name, company: persona.company, country: persona.country, email: persona.email },
    },
    // Booking and "don't call me" need the webhook, which Vapi can't reach on localhost.
    toolsAvailable: !!token,
    language: language?.language.label || null,
  };
}
