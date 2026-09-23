import { getOrgIdFromAuthHeader } from '../../lib/supabaseServerAuth.js';
import { subscribeAppToWaba } from '../../lib/whatsappSubscribe.js';
import { checkChannelHealth } from '../../lib/channelHealth.js';

interface ApiRequest {
  method?: string;
  query?: Record<string, unknown>;
  body?: { accessToken?: string; wabaId?: string };
  headers?: Record<string, string | string[] | undefined>;
}

interface ApiResponse {
  status: (code: number) => ApiResponse;
  json: (data: unknown) => void;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  const orgId = await getOrgIdFromAuthHeader(req.headers?.authorization as string | undefined);
  if (!orgId) {
    return res.status(401).json({ error: 'Sign in required.' });
  }

  // Reuses this route (rather than adding a new one) to stay under Vercel's Hobby-plan
  // 12-serverless-function cap. Not a new capability — just the actual value of the
  // shared WHATSAPP_VERIFY_TOKEN, which orgs need to paste into their own Meta App's
  // webhook config. Not sensitive: it's Meta's handshake echo string, not a credential —
  // the real access control is the X-Hub-Signature-256 check (WHATSAPP_APP_SECRET).
  if (req.method === 'GET' && req.query?.action === 'health') {
    const health = await checkChannelHealth(orgId);
    return res.status(200).json(health);
  }

  if (req.method === 'GET') {
    return res.status(200).json({ verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || null });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { accessToken, wabaId } = req.body || {};
  if (!accessToken || !wabaId) {
    return res.status(400).json({ error: 'accessToken and wabaId are required.' });
  }

  const result = await subscribeAppToWaba(accessToken, wabaId);
  return res.status(result.ok ? 200 : 400).json(result);
}
