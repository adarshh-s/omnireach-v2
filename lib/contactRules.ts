import { getSupabaseAdmin } from './supabaseAdmin.js';
import type { ChannelApiSettings } from '../src/types.js';

/**
 * Don't pile on: when a new campaign (messages or calls) starts, leave out leads who
 *   - were contacted by another campaign or call in the last N hours (default 24), or
 *   - are in the middle of a conversation with the AI (wrote in the last 3 days), or
 *   - were handed to a person (status "Needs a Human") in the last 14 days.
 * Retries and follow-ups belonging to an earlier campaign aren't affected — they're part of
 * that campaign's own plan.
 */

const CONVERSATION_WINDOW_MS = 3 * 24 * 3_600_000;
const HANDOFF_WINDOW_MS = 14 * 24 * 3_600_000;

export function campaignGapHours(settings: ChannelApiSettings | null | undefined): number {
  const h = settings?.minHoursBetweenCampaigns;
  return h === undefined || h === null || !Number.isFinite(h) ? 24 : Math.min(720, Math.max(0, h));
}

interface LeadRef {
  id: string;
  last_contacted?: string | null;
}

/** clientId → why the lead is left out of this campaign. */
export async function contactBlocks(orgId: string, leads: LeadRef[], gapHours: number, now = Date.now()): Promise<Map<string, string>> {
  const blocks = new Map<string, string>();
  const supabase = getSupabaseAdmin();
  if (!supabase || leads.length === 0) return blocks;
  const ids = leads.map((l) => l.id);
  const gapCutoff = now - gapHours * 3_600_000;

  if (gapHours > 0) {
    for (const l of leads) {
      if (l.last_contacted && new Date(l.last_contacted).getTime() > gapCutoff) {
        blocks.set(l.id, `contacted in the last ${gapHours} hours`);
      }
    }
  }

  const inChunks = async (table: string, cols: string, extra: (q: any) => any) => {
    const out: any[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const { data } = await extra(supabase.from(table).select(cols).eq('org_id', orgId).in('client_id', ids.slice(i, i + 500)));
      out.push(...(data || []));
    }
    return out;
  };

  const since = new Date(now - Math.max(CONVERSATION_WINDOW_MS, HANDOFF_WINDOW_MS)).toISOString();
  const [calls, waConvs, emConvs] = await Promise.all([
    gapHours > 0
      ? inChunks('voice_calls', 'client_id, created_at', (q) => q.eq('direction', 'outbound').gte('created_at', new Date(gapCutoff).toISOString()))
      : Promise.resolve([]),
    inChunks('whatsapp_conversations', 'client_id, status, history, last_message_at', (q) => q.in('status', ['active', 'handoff']).gte('last_message_at', since)),
    inChunks('email_conversations', 'client_id, status, history, last_message_at', (q) => q.in('status', ['active', 'handoff']).gte('last_message_at', since)),
  ]);

  for (const c of calls) if (c.client_id && !blocks.has(c.client_id)) blocks.set(c.client_id, `called in the last ${gapHours} hours`);
  for (const c of [...waConvs, ...emConvs]) {
    if (!c.client_id || blocks.has(c.client_id)) continue;
    const lastFromLead = Math.max(0, ...(c.history || []).filter((h: any) => h?.role === 'user' && h.timestamp).map((h: any) => new Date(h.timestamp).getTime()));
    if (c.status === 'handoff' && new Date(c.last_message_at).getTime() > now - HANDOFF_WINDOW_MS) blocks.set(c.client_id, 'a person on your team is handling this lead');
    else if (lastFromLead > now - CONVERSATION_WINDOW_MS) blocks.set(c.client_id, 'already in a conversation with the AI');
  }
  return blocks;
}
