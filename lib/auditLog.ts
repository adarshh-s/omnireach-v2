import { getSupabaseAdmin } from './supabaseAdmin.js';

/**
 * Who did what in a workspace — the record a security review or a client asks for:
 * campaigns started, team changes, do-not-contact edits, CRM connections, a lead's data
 * exported or erased, a teammate replying in place of the AI, admin changes to access and
 * limits. Shown to the org's owner and admins on the Team page. Never throws.
 */

export interface AuditActor {
  userId?: string | null;
  email?: string | null;
}

export async function logAudit(orgId: string, actor: AuditActor | null, action: string, target?: string | null, detail?: Record<string, unknown>): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase || !orgId) return;
  try {
    await supabase.from('audit_log').insert({
      org_id: orgId,
      actor_user_id: actor?.userId || null,
      actor_email: actor?.email || null,
      action,
      target: target || null,
      detail: detail || {},
    });
  } catch {
    // auditing must never block the action itself
  }
}

export async function listAudit(orgId: string, limit = 200): Promise<any[]> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return [];
  const { data } = await supabase
    .from('audit_log')
    .select('action, target, detail, actor_email, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(Math.min(500, limit));
  return data || [];
}
