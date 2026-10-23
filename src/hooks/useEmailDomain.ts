import { useCallback, useEffect, useState } from 'react';

export interface DnsRecord {
  record: string;
  name: string;
  type: string;
  value: string;
  priority?: number;
  status?: string;
}

export interface OrgEmailDomain {
  domain: string;
  status: string;
  records: DnsRecord[];
  fromAddress: string;
}

/** The org's own sending domain on the platform's email account (lib/emailDomains.ts). */
export function useEmailDomain(accessToken: string | null, enabled: boolean) {
  const [domain, setDomain] = useState<OrgEmailDomain | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    try {
      const res = await fetch('/api/whatsapp/subscribe-app?action=email-domain', { headers: { Authorization: `Bearer ${accessToken}` } });
      const data = await res.json();
      setDomain(data.domain || null);
    } catch {
      // Leave the last known state.
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    if (enabled) refresh();
  }, [enabled, refresh]);

  const post = useCallback(
    async (action: string, body: Record<string, unknown> = {}) => {
      if (!accessToken) return false;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/whatsapp/subscribe-app?action=${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          setError(data.error || 'Something went wrong.');
          return false;
        }
        if ('domain' in data) setDomain(data.domain || null);
        else await refresh();
        return true;
      } catch (err: any) {
        setError(err.message || 'Failed to reach the server.');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [accessToken, refresh]
  );

  return {
    domain,
    loading,
    busy,
    error,
    add: (name: string, fromAddress: string) => post('email-domain-add', { domain: name, fromAddress }),
    verify: () => post('email-domain-verify'),
    setFromAddress: (fromAddress: string) => post('email-domain-from', { fromAddress }),
    remove: async () => {
      if (await post('email-domain-remove')) setDomain(null);
    },
  };
}
