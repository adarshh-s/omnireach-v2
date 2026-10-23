import { useCallback, useEffect, useState } from 'react';
import { supabase, isSupabaseBrowserConfigured } from '../lib/supabaseClient';

interface EmailOAuthStatus {
  connected: boolean;
  provider?: 'gmail' | 'outlook';
  connectedEmail?: string;
}

/** "Connect Gmail" / "Connect Outlook" as the mailbox campaign email goes out from — same
 * redirect-to-consent flow as the calendar connect buttons (see lib/emailOAuth.ts). */
export function useEmailOAuthConnection(orgId: string | null | undefined, accessToken: string | null) {
  const [status, setStatus] = useState<EmailOAuthStatus>({ connected: false });
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isSupabaseBrowserConfigured || !supabase || !orgId) return;
    const { data } = await supabase.rpc('get_email_oauth_status');
    const row = Array.isArray(data) ? data[0] : data;
    setStatus({ connected: !!row?.connected, provider: row?.provider, connectedEmail: row?.connected_email });
  }, [orgId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const connect = useCallback(
    async (provider: 'gmail' | 'outlook') => {
      if (!accessToken) {
        setError('Sign in first.');
        return;
      }
      setConnecting(true);
      setError(null);
      try {
        const query = provider === 'outlook' ? '?provider=microsoft&purpose=email' : '?purpose=email';
        const res = await fetch(`/api/auth/google/connect${query}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const data = await res.json();
        if (res.ok && data.authUrl) {
          window.location.href = data.authUrl;
          return;
        }
        setError(data.error || 'Failed to start the connection.');
      } catch (err: any) {
        setError(err.message || 'Failed to start the connection.');
      }
      setConnecting(false);
    },
    [accessToken]
  );

  const disconnect = useCallback(async () => {
    if (!accessToken) return;
    await fetch('/api/whatsapp/subscribe-app?action=email-oauth-disconnect', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    }).catch(() => {});
    setStatus({ connected: false });
  }, [accessToken]);

  return { status, connecting, error, connect, disconnect, refresh };
}
