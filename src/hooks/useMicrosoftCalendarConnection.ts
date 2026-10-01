import { useCallback, useEffect, useState } from 'react';
import { supabase, isSupabaseBrowserConfigured } from '../lib/supabaseClient';

interface CalendarStatus {
  connected: boolean;
  connectedEmail?: string;
}

/** Mirrors useGoogleCalendarConnection.ts exactly — same RPC-for-status / redirect-for-connect
 * pattern, just pointed at the Microsoft side of things. */
export function useMicrosoftCalendarConnection(userId: string | null | undefined, accessToken: string | null) {
  const [status, setStatus] = useState<CalendarStatus>({ connected: false });
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isSupabaseBrowserConfigured || !supabase || !userId) return;
    setLoading(true);
    const { data } = await supabase.rpc('get_microsoft_calendar_status');
    const row = Array.isArray(data) ? data[0] : data;
    setStatus({ connected: !!row?.connected, connectedEmail: row?.connected_email });
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const connect = useCallback(async () => {
    if (!accessToken) {
      setError('Sign in first.');
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/microsoft/connect', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await res.json();
      if (res.ok && data.authUrl) {
        window.location.href = data.authUrl;
      } else {
        setError(data.error || 'Failed to start Outlook connection.');
        setConnecting(false);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to start Outlook connection.');
      setConnecting(false);
    }
  }, [accessToken]);

  return { status, loading, connecting, error, connect, refresh };
}
