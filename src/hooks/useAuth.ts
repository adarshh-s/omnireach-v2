import { useEffect, useState } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { supabase, isSupabaseBrowserConfigured } from '../lib/supabaseClient';

export type OrgRole = 'owner' | 'admin' | 'member';

export interface AuthState {
  configured: boolean;
  session: Session | null;
  user: User | null;
  /** The workspace this user acts as — the one they were invited into, else their own
   * (see get_my_org in supabase/schema.sql). Use this, not user.id, to scope org data. */
  orgId: string | null;
  orgRole: OrgRole | null;
  /** Invited teammates arrive signed in from the invite link but with no password yet. */
  needsPassword: boolean;
  accessToken: string | null;
  loading: boolean;
  setPassword: (password: string) => Promise<{ error: string | null }>;
  signUp: (email: string, password: string) => Promise<{ error: string | null }>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

export function useAuth(): AuthState {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(isSupabaseBrowserConfigured);
  const [org, setOrg] = useState<{ forUser: string; orgId: string; role: OrgRole } | null>(null);

  useEffect(() => {
    if (!supabase) return;

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  const userId = session?.user?.id;
  useEffect(() => {
    if (!supabase || !userId) return;
    let cancelled = false;
    supabase.rpc('get_my_org').then(({ data, error }) => {
      if (cancelled) return;
      const row = Array.isArray(data) ? data[0] : data;
      // Before the schema update that adds get_my_org, every user is their own org.
      setOrg({ forUser: userId, orgId: (!error && row?.org_id) || userId, role: (!error && row?.role) || 'owner' });
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const orgReady = !userId || org?.forUser === userId;

  return {
    configured: isSupabaseBrowserConfigured,
    session,
    user: session?.user ?? null,
    orgId: userId && orgReady ? org!.orgId : null,
    orgRole: userId && orgReady ? org!.role : null,
    needsPassword: !!session?.user?.user_metadata?.needs_password,
    accessToken: session?.access_token ?? null,
    loading: loading || !orgReady,
    setPassword: async (password) => {
      if (!supabase) return { error: 'Not configured' };
      const { error } = await supabase.auth.updateUser({ password, data: { needs_password: false } });
      return { error: error?.message ?? null };
    },
    signUp: async (email, password) => {
      if (!supabase) return { error: 'Not configured' };
      const { error } = await supabase.auth.signUp({ email, password });
      return { error: error?.message ?? null };
    },
    signIn: async (email, password) => {
      if (!supabase) return { error: 'Not configured' };
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      return { error: error?.message ?? null };
    },
    signOut: async () => {
      if (!supabase) return;
      await supabase.auth.signOut();
    },
  };
}
