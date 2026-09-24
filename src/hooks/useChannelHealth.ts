import { useCallback, useEffect, useState } from 'react';

export interface HealthStatus {
  ok: boolean;
  message: string;
}

export interface HealthState {
  whatsappToken: HealthStatus;
  whatsapp: HealthStatus;
  calendar: HealthStatus;
  email: HealthStatus;
  emailReplyTracking: HealthStatus;
}

/** Shared by the Dashboard's channel cards and the diagnostics panel so both read off one
 * fetch instead of hitting /api/whatsapp/subscribe-app?action=health twice in parallel. */
export function useChannelHealth(accessToken?: string | null) {
  const [health, setHealth] = useState<HealthState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    fetch(`/api/whatsapp/subscribe-app?action=health&_=${Date.now()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    })
      .then((res) => res.json())
      .then((data) => {
        if (data?.whatsapp) setHealth(data);
        else setError('Could not run health checks.');
      })
      .catch(() => setError('Could not reach the server to run health checks.'))
      .finally(() => setLoading(false));
  }, [accessToken]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  return { health, loading, error, reload: load };
}
