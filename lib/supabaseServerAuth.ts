import { getSupabaseAdmin } from './supabaseAdmin.js';

/**
 * Verifies a Supabase access token (from an `Authorization: Bearer <token>` header sent
 * by the authenticated browser) and returns the org id (= Supabase auth user id), or
 * null if missing/invalid. Org-scoping across the app relies on this.
 */
export async function getOrgIdFromAuthHeader(authHeader: string | undefined): Promise<string | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return null;

  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user.id;
  } catch {
    return null;
  }
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
