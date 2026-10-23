import { handleGoogleOAuthCallback } from '../../../lib/googleOAuthFlow.js';
import { handleMicrosoftOAuthCallback } from '../../../lib/microsoftOAuthFlow.js';
import { isEmailConnectState, handleGmailCallback, handleOutlookMailCallback } from '../../../lib/emailOAuth.js';
import { crmProviderFromState, handleCrmCallback } from '../../../lib/crm/index.js';

interface ApiRequest {
  method?: string;
  query?: Record<string, unknown>;
}

interface ApiResponse {
  status: (code: number) => ApiResponse;
  redirect: (url: string) => void;
  send: (data: unknown) => void;
}

/** Handles both Google and Outlook OAuth callbacks, for the calendar and the email-sending
 * connect flows alike (the signed state says which) — see api/auth/google/connect.ts for why
 * this stays one file. */
export default async function handler(req: ApiRequest, res: ApiResponse) {
  const code = (req.query?.code as string) || undefined;
  const state = (req.query?.state as string) || undefined;

  // CRM connections all come back to /api/auth/crm/callback (rewritten here); the signed
  // state says which CRM. Zoho also says which data centre issued the code.
  if (crmProviderFromState(state)) {
    const result = await handleCrmCallback(code, state, (req.query?.['accounts-server'] as string) || undefined);
    const redirectTo = result.ok
      ? `/?crm_connect=connected&crm=${result.provider}`
      : `/?crm_connect=error&crm=${result.provider || ''}&message=${encodeURIComponent(result.error || 'Connection failed')}`;
    return res.status(302).redirect(redirectTo);
  }

  if (isEmailConnectState(state)) {
    const provider = req.query?.provider === 'microsoft' ? 'outlook' : 'gmail';
    const result = provider === 'outlook' ? await handleOutlookMailCallback(code, state) : await handleGmailCallback(code, state);
    const redirectTo = result.ok
      ? `/?email_connect=connected&provider=${provider}`
      : `/?email_connect=error&provider=${provider}&message=${encodeURIComponent(result.error || 'Connection failed')}`;
    return res.status(302).redirect(redirectTo);
  }

  if (req.query?.provider === 'microsoft') {
    const result = await handleMicrosoftOAuthCallback(code, state);
    const redirectTo = result.ok
      ? `/?outlook_calendar=connected`
      : `/?outlook_calendar=error&message=${encodeURIComponent(result.error || 'Connection failed')}`;
    return res.status(302).redirect(redirectTo);
  }

  const result = await handleGoogleOAuthCallback(code, state);

  const redirectTo = result.ok
    ? `/?google_calendar=connected`
    : `/?google_calendar=error&message=${encodeURIComponent(result.error || 'Connection failed')}`;

  res.status(302).redirect(redirectTo);
}
