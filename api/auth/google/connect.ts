import { getOrgIdFromAuthHeader } from '../../../lib/supabaseServerAuth.js';
import { buildGoogleAuthUrl, isGoogleOAuthConfigured } from '../../../lib/googleOAuthFlow.js';
import { buildMicrosoftAuthUrl, isMicrosoftOAuthConfigured } from '../../../lib/microsoftOAuthFlow.js';

interface ApiRequest {
  method?: string;
  query?: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
}

interface ApiResponse {
  status: (code: number) => ApiResponse;
  json: (data: unknown) => void;
}

/**
 * Handles both Google and Outlook calendar "connect" requests — kept in this one file
 * (?provider=microsoft picks the second) to stay under Vercel's Hobby-plan 12-serverless-
 * function cap; vercel.json rewrites /api/auth/microsoft/connect here so the public URL
 * still reads cleanly instead of exposing the ?provider= query param.
 */
export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers?.authorization as string | undefined;
  const orgId = await getOrgIdFromAuthHeader(authHeader);
  if (!orgId) {
    return res.status(401).json({ error: 'Sign in required.' });
  }

  if (req.query?.provider === 'microsoft') {
    if (!isMicrosoftOAuthConfigured()) {
      return res.status(500).json({ error: 'Outlook Calendar OAuth is not configured on the server yet.' });
    }
    const authUrl = buildMicrosoftAuthUrl(orgId);
    if (!authUrl) {
      return res.status(500).json({ error: 'Failed to build Microsoft authorization URL.' });
    }
    return res.status(200).json({ authUrl });
  }

  if (!isGoogleOAuthConfigured()) {
    return res.status(500).json({ error: 'Google Calendar OAuth is not configured on the server yet.' });
  }

  const authUrl = buildGoogleAuthUrl(orgId);
  if (!authUrl) {
    return res.status(500).json({ error: 'Failed to build Google authorization URL.' });
  }

  return res.status(200).json({ authUrl });
}
