import { google } from 'googleapis';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { getSupabaseAdmin } from './supabaseAdmin.js';
import { signOAuthState, verifyOAuthStateWithPurpose } from './googleOAuthState.js';
import { getMicrosoftOAuthCredentials, MICROSOFT_AUTHORITY } from './microsoftOAuthFlow.js';

/**
 * "Connect Gmail" / "Connect Outlook" for sending campaign email and AI replies from an
 * org's own mailbox, instead of an SMTP app password or an API key. Reuses the platform's
 * Google and Microsoft OAuth apps (the same ones as the calendar connect buttons) with a
 * send-only scope, and stores one refresh token per org in org_email_oauth.
 *
 * Replies still route back to the AI bot: every send sets the platform's Reply-To tracking
 * address, exactly like the other providers (see lib/emailWebhookHandler.ts).
 */

const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/userinfo.email'];
const OUTLOOK_SCOPES = ['offline_access', 'Mail.Send', 'User.Read', 'openid', 'email', 'profile'].join(' ');

function getGoogleClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function buildGmailAuthUrl(orgId: string): string | null {
  const client = getGoogleClient();
  if (!client) return null;
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GMAIL_SCOPES,
    state: signOAuthState(orgId, 'email'),
  });
}

export function buildOutlookMailAuthUrl(orgId: string): string | null {
  const creds = getMicrosoftOAuthCredentials();
  if (!creds) return null;
  const params = new URLSearchParams({
    client_id: creds.clientId,
    response_type: 'code',
    redirect_uri: creds.redirectUri,
    response_mode: 'query',
    scope: OUTLOOK_SCOPES,
    state: signOAuthState(orgId, 'email'),
    prompt: 'consent',
  });
  return `${MICROSOFT_AUTHORITY}/oauth2/v2.0/authorize?${params.toString()}`;
}

/** True when the callback's state was signed for the email-connect flow rather than the
 * calendar one — both share one redirect URI per provider. */
export function isEmailConnectState(state: string | undefined): boolean {
  return verifyOAuthStateWithPurpose(state)?.purpose === 'email';
}

async function saveEmailOAuth(orgId: string, provider: 'gmail' | 'outlook', refreshToken: string, connectedEmail?: string) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error('Server database is not configured.');
  const { error } = await supabase.from('org_email_oauth').upsert(
    { org_id: orgId, provider, refresh_token: refreshToken, connected_email: connectedEmail || null, updated_at: new Date().toISOString() },
    { onConflict: 'org_id' }
  );
  if (error) throw new Error(error.message);
  // The connect button redirects away before the dashboard's own (debounced) save of the
  // chosen method would land, so switch the org to sending through it here.
  await setEmailProvider(orgId, () => provider);
}

async function setEmailProvider(orgId: string, next: (current: string | undefined) => string | undefined) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  const { data } = await supabase.from('org_channel_settings').select('settings').eq('org_id', orgId).maybeSingle();
  const settings = (data?.settings as Record<string, unknown>) || {};
  const provider = next(settings.emailProvider as string | undefined);
  if (provider === settings.emailProvider) return;
  await supabase
    .from('org_channel_settings')
    .upsert({ org_id: orgId, settings: { ...settings, emailProvider: provider }, updated_at: new Date().toISOString() }, { onConflict: 'org_id' });
}

export async function disconnectEmailOAuth(orgId: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  await supabase.from('org_email_oauth').delete().eq('org_id', orgId);
  // Back to automatic sending rather than a provider that can no longer send.
  await setEmailProvider(orgId, (current) => (current === 'gmail' || current === 'outlook' ? 'resend' : current));
}

export async function handleGmailCallback(code: string | undefined, state: string | undefined): Promise<{ ok: boolean; error?: string }> {
  const verified = verifyOAuthStateWithPurpose(state);
  if (!verified || verified.purpose !== 'email') return { ok: false, error: 'Invalid or expired connection request. Please try connecting again.' };
  if (!code) return { ok: false, error: 'Google did not return an authorization code.' };
  const client = getGoogleClient();
  if (!client) return { ok: false, error: 'Google OAuth is not configured on the server.' };

  try {
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      return {
        ok: false,
        error: 'Google did not return a refresh token. Remove this app at https://myaccount.google.com/permissions and connect again.',
      };
    }
    client.setCredentials(tokens);
    const info = await google.oauth2({ version: 'v2', auth: client }).userinfo.get().catch(() => null);
    await saveEmailOAuth(verified.orgId, 'gmail', tokens.refresh_token, info?.data.email || undefined);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message || 'Failed to connect Gmail.' };
  }
}

export async function handleOutlookMailCallback(code: string | undefined, state: string | undefined): Promise<{ ok: boolean; error?: string }> {
  const verified = verifyOAuthStateWithPurpose(state);
  if (!verified || verified.purpose !== 'email') return { ok: false, error: 'Invalid or expired connection request. Please try connecting again.' };
  if (!code) return { ok: false, error: 'Microsoft did not return an authorization code.' };
  const creds = getMicrosoftOAuthCredentials();
  if (!creds) return { ok: false, error: 'Microsoft OAuth is not configured on the server.' };

  try {
    const tokenRes = await fetch(`${MICROSOFT_AUTHORITY}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        code,
        redirect_uri: creds.redirectUri,
        grant_type: 'authorization_code',
        scope: OUTLOOK_SCOPES,
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) return { ok: false, error: tokens?.error_description || 'Microsoft rejected the authorization code.' };
    if (!tokens.refresh_token) return { ok: false, error: 'Microsoft did not return a refresh token — try connecting again.' };

    const me = await fetch('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: `Bearer ${tokens.access_token}` } })
      .then((r) => r.json())
      .catch(() => null);
    await saveEmailOAuth(verified.orgId, 'outlook', tokens.refresh_token, me?.mail || me?.userPrincipalName || undefined);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message || 'Failed to connect Outlook.' };
  }
}

export interface OAuthMail {
  to: string;
  toName?: string;
  subject: string;
  text: string;
  html: string;
  fromName: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

export async function sendViaGmail(refreshToken: string, fromAddress: string | undefined, mail: OAuthMail): Promise<{ ok: boolean; error?: string; id?: string }> {
  const client = getGoogleClient();
  if (!client) return { ok: false, error: 'Google OAuth is not configured on the server.' };
  client.setCredentials({ refresh_token: refreshToken });

  try {
    // Gmail sends as the connected account whatever From says, so From is that address.
    const raw = await new MailComposer({
      from: fromAddress ? `${mail.fromName} <${fromAddress}>` : mail.fromName,
      to: mail.toName ? `${mail.toName} <${mail.to}>` : mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
      ...(mail.headers ? { headers: mail.headers } : {}),
    })
      .compile()
      .build();
    const res = await google.gmail({ version: 'v1', auth: client }).users.messages.send({
      userId: 'me',
      requestBody: { raw: raw.toString('base64url') },
    });
    return { ok: true, id: res.data.id || undefined };
  } catch (err: any) {
    const reason = err?.response?.data?.error_description || err?.response?.data?.error?.message || err?.message;
    if (/invalid_grant/i.test(String(reason))) {
      return { ok: false, error: 'Gmail access was revoked or expired — reconnect Gmail in Channel Setup.' };
    }
    return { ok: false, error: reason || 'Failed to send via Gmail.' };
  }
}

export async function sendViaOutlook(refreshToken: string, mail: OAuthMail): Promise<{ ok: boolean; error?: string }> {
  const creds = getMicrosoftOAuthCredentials();
  if (!creds) return { ok: false, error: 'Microsoft OAuth is not configured on the server.' };

  try {
    const tokenRes = await fetch(`${MICROSOFT_AUTHORITY}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        scope: OUTLOOK_SCOPES,
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.access_token) {
      return { ok: false, error: 'Outlook access was revoked or expired — reconnect Outlook in Channel Setup.' };
    }
    // Microsoft may rotate the refresh token; keep the newest one.
    if (tokens.refresh_token && tokens.refresh_token !== refreshToken) {
      const supabase = getSupabaseAdmin();
      await supabase
        ?.from('org_email_oauth')
        .update({ refresh_token: tokens.refresh_token, updated_at: new Date().toISOString() })
        .eq('refresh_token', refreshToken);
    }

    const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject: mail.subject,
          body: { contentType: 'HTML', content: mail.html },
          toRecipients: [{ emailAddress: { address: mail.to, ...(mail.toName ? { name: mail.toName } : {}) } }],
          ...(mail.replyTo ? { replyTo: [{ emailAddress: { address: mail.replyTo } }] } : {}),
        },
        saveToSentItems: true,
      }),
    });
    if (res.status === 202 || res.ok) return { ok: true };
    const data = await res.json().catch(() => ({}));
    return { ok: false, error: data?.error?.message || `Outlook rejected the email (${res.status}).` };
  } catch (err: any) {
    return { ok: false, error: err.message || 'Failed to send via Outlook.' };
  }
}
