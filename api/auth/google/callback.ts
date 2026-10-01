import { handleGoogleOAuthCallback } from '../../../lib/googleOAuthFlow.js';
import { handleMicrosoftOAuthCallback } from '../../../lib/microsoftOAuthFlow.js';

interface ApiRequest {
  method?: string;
  query?: Record<string, unknown>;
}

interface ApiResponse {
  status: (code: number) => ApiResponse;
  redirect: (url: string) => void;
  send: (data: unknown) => void;
}

/** Handles both Google and Outlook OAuth callbacks — see api/auth/google/connect.ts for why
 * this stays one file instead of two. */
export default async function handler(req: ApiRequest, res: ApiResponse) {
  const code = (req.query?.code as string) || undefined;
  const state = (req.query?.state as string) || undefined;

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
