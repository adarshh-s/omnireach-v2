import { signOAuthState, verifyOAuthState } from './googleOAuthState.js';
import { saveOrgMicrosoftCalendarToken } from './orgSettings.js';

// 'common' accepts both work/school (any tenant) and personal Microsoft accounts — matches
// the Azure app registration being set to "Any Microsoft Entra ID tenant + personal
// accounts" rather than "My organization only" (which would reject every client outside the
// platform owner's own tenant).
const AUTHORITY = 'https://login.microsoftonline.com/common';
const SCOPES = ['offline_access', 'Calendars.ReadWrite', 'User.Read', 'openid', 'email', 'profile'].join(' ');

function getCredentials() {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const redirectUri = process.env.MICROSOFT_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

export function isMicrosoftOAuthConfigured(): boolean {
  return !!getCredentials();
}

export function buildMicrosoftAuthUrl(orgId: string): string | null {
  const creds = getCredentials();
  if (!creds) return null;
  const params = new URLSearchParams({
    client_id: creds.clientId,
    response_type: 'code',
    redirect_uri: creds.redirectUri,
    response_mode: 'query',
    scope: SCOPES,
    state: signOAuthState(orgId),
    prompt: 'consent', // forces a fresh consent so a refresh_token is actually issued every time
  });
  return `${AUTHORITY}/oauth2/v2.0/authorize?${params.toString()}`;
}

export interface MicrosoftOAuthCallbackResult {
  ok: boolean;
  orgId?: string;
  error?: string;
}

export async function handleMicrosoftOAuthCallback(code: string | undefined, state: string | undefined): Promise<MicrosoftOAuthCallbackResult> {
  const orgId = verifyOAuthState(state);
  if (!orgId) {
    return { ok: false, error: 'Invalid or expired connection request. Please try connecting again.' };
  }
  if (!code) {
    return { ok: false, error: 'Microsoft did not return an authorization code.' };
  }

  const creds = getCredentials();
  if (!creds) {
    return { ok: false, error: 'Outlook Calendar OAuth is not configured on the server.' };
  }

  try {
    const tokenRes = await fetch(`${AUTHORITY}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        code,
        redirect_uri: creds.redirectUri,
        grant_type: 'authorization_code',
        scope: SCOPES,
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) {
      return { ok: false, error: tokens?.error_description || 'Microsoft rejected the authorization code.' };
    }
    if (!tokens.refresh_token) {
      return { ok: false, error: 'Microsoft did not return a refresh token — try connecting again.' };
    }

    let connectedEmail: string | undefined;
    try {
      const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const me = await meRes.json();
      connectedEmail = me?.mail || me?.userPrincipalName || undefined;
    } catch {
      // Non-fatal — email is just a display label.
    }

    await saveOrgMicrosoftCalendarToken(orgId, { refreshToken: tokens.refresh_token, connectedEmail });
    return { ok: true, orgId };
  } catch (err: any) {
    return { ok: false, error: err.message || 'Failed to complete Outlook Calendar connection.' };
  }
}

/** Exchanges a stored refresh token for a fresh access token — Microsoft access tokens are
 * short-lived (~1hr), so every Graph API call needs this first. Also returns a possibly-new
 * refresh token (Microsoft sometimes rotates it), which callers should persist if present. */
export async function getMicrosoftAccessToken(refreshToken: string): Promise<{ accessToken: string; newRefreshToken?: string } | null> {
  const creds = getCredentials();
  if (!creds) return null;
  try {
    const res = await fetch(`${AUTHORITY}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        scope: SCOPES,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) return null;
    return { accessToken: data.access_token, newRefreshToken: data.refresh_token !== refreshToken ? data.refresh_token : undefined };
  } catch {
    return null;
  }
}
