import { getSupabaseAdmin } from './supabaseAdmin.js';

export type OrgRole = 'owner' | 'admin' | 'member';

export interface Caller {
  userId: string;
  email: string | null;
  /** The org this user acts as — the one they were invited into, else their own. */
  orgId: string;
  role: OrgRole;
}

/**
 * Verifies a Supabase access token (from an `Authorization: Bearer <token>` header sent by
 * the authenticated browser) and resolves which org the user acts as: a teammate invited
 * through org_members acts as that org, everyone else is the owner of their own (org id =
 * their user id). Null if missing/invalid. Org-scoping across the app relies on this.
 */
export async function getCallerFromAuthHeader(authHeader: string | undefined): Promise<Caller | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return null;

  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;
    const { data: membership } = await supabase
      .from('org_members')
      .select('org_id, role')
      .eq('user_id', data.user.id)
      .maybeSingle();
    return {
      userId: data.user.id,
      email: data.user.email || null,
      orgId: membership?.org_id || data.user.id,
      role: (membership?.role as OrgRole) || 'owner',
    };
  } catch {
    return null;
  }
}

export async function getOrgIdFromAuthHeader(authHeader: string | undefined): Promise<string | null> {
  return (await getCallerFromAuthHeader(authHeader))?.orgId || null;
}

/** Same token verification as getOrgIdFromAuthHeader, but also returns the caller's email —
 * needed for the admin dashboard's actions, which check the caller against ADMIN_EMAIL
 * rather than just knowing which org they are. */
export async function getUserFromAuthHeader(authHeader: string | undefined): Promise<{ id: string; email: string | null } | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return null;

  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;
    return { id: data.user.id, email: data.user.email || null };
  } catch {
    return null;
  }
}

/** True if the given email matches the platform's single hardcoded admin account
 * (ADMIN_EMAIL env var). Case-insensitive since email providers treat it that way. */
export function isAdminEmail(email: string | null | undefined): boolean {
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!adminEmail || !email) return false;
  return email.trim().toLowerCase() === adminEmail;
}
