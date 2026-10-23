import { getSupabaseAdmin } from './supabaseAdmin.js';
import type { Caller } from './supabaseServerAuth.js';

/**
 * Teammates on one workspace. The owner (whose user id is the org id) and admins can invite
 * and remove people; everyone on the team gets the same access to the workspace's data
 * through current_org_id() (supabase/schema.sql). Invites go out as Supabase's own invite
 * email; the invitee sets a password on first sign-in (see AuthGate's needs_password step).
 */

export interface TeamMember {
  userId: string;
  email: string | null;
  role: 'owner' | 'admin' | 'member';
  joinedAt: string | null;
}

export function canManageTeam(caller: Caller): boolean {
  return caller.role === 'owner' || caller.role === 'admin';
}

export async function listTeam(orgId: string): Promise<TeamMember[]> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return [];
  const [{ data: owner }, { data: members }] = await Promise.all([
    supabase.auth.admin.getUserById(orgId),
    supabase.from('org_members').select('user_id, email, role, created_at').eq('org_id', orgId).order('created_at'),
  ]);
  return [
    { userId: orgId, email: owner?.user?.email || null, role: 'owner' as const, joinedAt: owner?.user?.created_at || null },
    ...(members || []).map((m: any) => ({ userId: m.user_id, email: m.email, role: m.role, joinedAt: m.created_at })),
  ];
}

async function findUserByEmail(email: string) {
  const supabase = getSupabaseAdmin()!;
  for (let page = 1; page <= 20; page++) {
    const { data } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    const users = data?.users || [];
    const match = users.find((u) => u.email?.toLowerCase() === email);
    if (match) return match;
    if (users.length < 1000) return null;
  }
  return null;
}

/** An existing account can only join if it isn't already on a team and its own workspace
 * is empty — joining hides the user's own workspace, so it mustn't hold anything. */
async function existingAccountCanJoin(userId: string): Promise<string | null> {
  const supabase = getSupabaseAdmin()!;
  const [{ data: membership }, { count: clientCount }, { count: memberCount }] = await Promise.all([
    supabase.from('org_members').select('org_id').eq('user_id', userId).maybeSingle(),
    supabase.from('clients').select('id', { count: 'exact', head: true }).eq('org_id', userId),
    supabase.from('org_members').select('user_id', { count: 'exact', head: true }).eq('org_id', userId),
  ]);
  if (membership) return 'This person is already on another team.';
  if ((clientCount || 0) > 0 || (memberCount || 0) > 0) {
    return 'This email already has its own workspace with data in it, so it can\'t be added to your team. Ask them to use a different email.';
  }
  return null;
}

export async function inviteTeamMember(
  caller: Caller,
  rawEmail: string,
  role: 'admin' | 'member',
  redirectTo: string | undefined
): Promise<{ ok: boolean; error?: string; invited?: boolean }> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { ok: false, error: 'Server database is not configured.' };
  if (!canManageTeam(caller)) return { ok: false, error: 'Only the workspace owner or an admin can invite people.' };

  const email = (rawEmail || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'Enter a valid email address.' };
  if (role !== 'admin' && role !== 'member') return { ok: false, error: 'Role must be admin or member.' };
  if (email === caller.email?.toLowerCase()) return { ok: false, error: "You're already on this team." };

  let userId: string;
  let invited = false;
  const existing = await findUserByEmail(email);
  if (existing) {
    if (existing.id === caller.orgId) return { ok: false, error: 'That is the workspace owner.' };
    const blocked = await existingAccountCanJoin(existing.id);
    if (blocked) return { ok: false, error: blocked };
    userId = existing.id;
  } else {
    const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, {
      redirectTo,
      data: { needs_password: true },
    });
    if (error || !data?.user) return { ok: false, error: error?.message || 'Could not send the invite.' };
    userId = data.user.id;
    invited = true;
  }

  const { error } = await supabase
    .from('org_members')
    .insert({ user_id: userId, org_id: caller.orgId, email, role, invited_by: caller.userId });
  if (error) return { ok: false, error: error.code === '23505' ? 'This person is already on a team.' : error.message };
  return { ok: true, invited };
}

export async function removeTeamMember(caller: Caller, userId: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { ok: false, error: 'Server database is not configured.' };
  const leaving = userId === caller.userId;
  if (!leaving && !canManageTeam(caller)) return { ok: false, error: 'Only the workspace owner or an admin can remove people.' };
  if (userId === caller.orgId) return { ok: false, error: "The workspace owner can't be removed." };

  const { data: target } = await supabase.from('org_members').select('role').eq('user_id', userId).eq('org_id', caller.orgId).maybeSingle();
  if (!target) return { ok: false, error: 'That person is not on this team.' };
  if (!leaving && target.role === 'admin' && caller.role !== 'owner') return { ok: false, error: 'Only the owner can remove an admin.' };

  await supabase.from('org_members').delete().eq('user_id', userId).eq('org_id', caller.orgId);
  return { ok: true };
}
