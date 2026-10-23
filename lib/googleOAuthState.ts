import crypto from 'crypto';

/**
 * Signs the org id into the Google OAuth `state` param so the callback (a plain
 * redirect with no session/auth header) can trust which org initiated the connect
 * request, without a guessable or tamperable value.
 */
export type OAuthPurpose = 'calendar' | 'email' | 'crm-hubspot' | 'crm-zoho' | 'crm-salesforce';
const PURPOSES: OAuthPurpose[] = ['calendar', 'email', 'crm-hubspot', 'crm-zoho', 'crm-salesforce'];

/** `purpose` lets the calendar and email-sending connect flows share one redirect URI per
 * provider — the callback reads it back to know which one it's finishing. */
export function signOAuthState(orgId: string, purpose: OAuthPurpose = 'calendar'): string {
  const secret = process.env.OAUTH_STATE_SECRET || '';
  const subject = purpose === 'calendar' ? orgId : `${orgId}~${purpose}`;
  const payload = `${subject}.${Date.now()}`;
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(`${payload}.${signature}`).toString('base64url');
}

/** Calendar-flow states only (an email-flow state returns null here). */
export function verifyOAuthState(state: string | undefined): string | null {
  const verified = verifyOAuthStateWithPurpose(state);
  return verified?.purpose === 'calendar' ? verified.orgId : null;
}

export function verifyOAuthStateWithPurpose(state: string | undefined): { orgId: string; purpose: OAuthPurpose } | null {
  if (!state) return null;
  const secret = process.env.OAUTH_STATE_SECRET || '';
  try {
    const decoded = Buffer.from(state, 'base64url').toString('utf8');
    const parts = decoded.split('.');
    if (parts.length !== 3) return null;
    const [subject, timestamp, signature] = parts;
    const payload = `${subject}.${timestamp}`;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;

    // 15-minute window to complete the OAuth consent flow.
    const age = Date.now() - Number(timestamp);
    if (!Number.isFinite(age) || age < 0 || age > 15 * 60 * 1000) return null;

    const [orgId, purpose] = subject.split('~');
    const resolved = (purpose || 'calendar') as OAuthPurpose;
    if (!PURPOSES.includes(resolved)) return null;
    return { orgId, purpose: resolved };
  } catch {
    return null;
  }
}
