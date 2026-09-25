import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { getOrgIdFromAuthHeader } from '../lib/supabaseServerAuth.js';

interface ApiRequest {
  method?: string;
  query?: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
}

interface ApiResponse {
  status: (code: number) => ApiResponse;
  json: (data: unknown) => void;
}

// Merges what used to be two near-identical routes (api/whatsapp/conversations.ts,
// api/email/conversations.ts — same query, different table) into one, freeing a slot
// under Vercel's Hobby-plan 12-serverless-function cap for the Vapi voice routes below.
export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const channel = req.query?.channel === 'email' ? 'email' : 'whatsapp';
  const table = channel === 'email' ? 'email_conversations' : 'whatsapp_conversations';

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return res.status(200).json({ configured: false, conversations: [] });
  }

  const orgId = await getOrgIdFromAuthHeader(req.headers?.authorization as string | undefined);
  if (!orgId) {
    return res.status(401).json({ error: 'Sign in required.' });
  }

  const { data, error } = await supabase
    .from(table)
    .select('*')
    .eq('org_id', orgId)
    .order('last_message_at', { ascending: false })
    .limit(200);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ configured: true, conversations: data });
}
