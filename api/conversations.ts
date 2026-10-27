import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { getOrgIdFromAuthHeader, getCallerFromAuthHeader } from '../lib/supabaseServerAuth.js';
import { replyAsTeammate, setAiPaused } from '../lib/inboxActions.js';
import { reconcileStaleVoiceCalls } from '../lib/voiceCalls.js';
import { handleLearningRequest } from '../lib/aiLearning.js';
import { buildAnalytics } from '../lib/analytics.js';

interface ApiRequest {
  method?: string;
  query?: Record<string, unknown>;
  body?: any;
  headers?: Record<string, string | string[] | undefined>;
}

interface ApiResponse {
  status: (code: number) => ApiResponse;
  json: (data: unknown) => void;
}

// Merges what used to be two near-identical routes (api/whatsapp/conversations.ts,
// api/email/conversations.ts — same query, different table) into one, freeing a slot
// under Vercel's Hobby-plan 12-serverless-function cap for the Vapi voice routes below.
// ?action=learning is the AI Learning page's API (lib/aiLearning.ts), here for the same reason.
export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.query?.action === 'learning') {
    const orgId = await getOrgIdFromAuthHeader(req.headers?.authorization as string | undefined);
    if (!orgId) return res.status(401).json({ error: 'Sign in required.' });
    const result = await handleLearningRequest(orgId, req.method, req.body);
    return res.status(result.httpStatus).json(result.body);
  }

  // ?action=analytics — the Reports page (lib/analytics.ts).
  if (req.query?.action === 'analytics') {
    const orgId = await getOrgIdFromAuthHeader(req.headers?.authorization as string | undefined);
    if (!orgId) return res.status(401).json({ error: 'Sign in required.' });
    return res.status(200).json(await buildAnalytics(orgId));
  }

  // ?action=inbox — a teammate replying in place of the AI, or pausing/resuming it (lib/inboxActions.ts).
  if (req.query?.action === 'inbox') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const caller = await getCallerFromAuthHeader(req.headers?.authorization as string | undefined);
    if (!caller) return res.status(401).json({ error: 'Sign in required.' });
    const { op, channel, id, text } = req.body || {};
    if (channel !== 'whatsapp' && channel !== 'email') return res.status(400).json({ ok: false, error: 'Only WhatsApp and email conversations can be taken over.' });
    const actor = { userId: caller.userId, email: caller.email };
    const result =
      op === 'reply'
        ? await replyAsTeammate(caller.orgId, actor, channel, String(id || ''), String(text || ''))
        : op === 'pause' || op === 'resume'
          ? await setAiPaused(caller.orgId, actor, channel, String(id || ''), op === 'pause')
          : { ok: false, error: 'Unknown inbox action.' };
    return res.status(result.ok ? 200 : 400).json(result);
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const channel = req.query?.channel === 'email' ? 'email' : req.query?.channel === 'voice' ? 'voice' : 'whatsapp';
  const table = channel === 'email' ? 'email_conversations' : channel === 'voice' ? 'voice_calls' : 'whatsapp_conversations';

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return res.status(200).json({ configured: false, conversations: [] });
  }

  const orgId = await getOrgIdFromAuthHeader(req.headers?.authorization as string | undefined);
  if (!orgId) {
    return res.status(401).json({ error: 'Sign in required.' });
  }

  // Browser test calls (Test Voice Agent page) aren't real conversations.
  const query = () => {
    let q = supabase.from(table).select('*').eq('org_id', orgId);
    if (channel === 'voice') q = q.neq('direction', 'test');
    return q.order('last_message_at', { ascending: false }).limit(200);
  };
  let { data, error } = await query();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // Calls whose end-of-call webhook never arrived (e.g. failed before connecting) — finalize
  // them from Vapi directly so they don't sit at "Calling…" forever.
  if (channel === 'voice' && (await reconcileStaleVoiceCalls(orgId, data || []))) {
    ({ data, error } = await query());
    if (error) return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ configured: true, conversations: data });
}
