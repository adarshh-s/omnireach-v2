import { getOrgIdFromAuthHeader } from '../../lib/supabaseServerAuth.js';
import { generateOutreachCopy } from '../../lib/outreachCopy.js';

interface ApiRequest {
  method?: string;
  body?: any;
  headers?: Record<string, string | string[] | undefined>;
}

interface ApiResponse {
  status: (code: number) => ApiResponse;
  json: (data: unknown) => void;
  setHeader?: (name: string, value: string) => void;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method === 'OPTIONS') {
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Without this, anyone who finds this URL could burn through the platform's shared
  // Gemini/Groq quota for free — this endpoint has no per-org cost of its own otherwise,
  // so an unauthenticated caller could generate unlimited messages at the platform's expense.
  const orgId = await getOrgIdFromAuthHeader(req.headers?.authorization as string | undefined);
  if (!orgId) {
    return res.status(401).json({ error: 'Sign in required.' });
  }

  try {
    const { lead, settings, template } = req.body || {};
    return res.status(200).json(await generateOutreachCopy(orgId, lead, settings, template));
  } catch (error: any) {
    return res.status(500).json({
      error: error.message || 'Failed to generate message',
    });
  }
}
