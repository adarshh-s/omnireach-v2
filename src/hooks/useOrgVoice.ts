import { useCallback, useEffect, useState } from 'react';
import { supabase, isSupabaseBrowserConfigured } from '../lib/supabaseClient';

export interface OrgVoiceState {
  assistantId: string | null;
  phoneNumber: string | null;
  hasNumber: boolean;
  inboundEnabled: boolean;
}

/** The org's own voice number and assistant (org_voice — assigned by the platform admin,
 * readable but not writable by the org), plus turning on AI-answered incoming calls. */
export function useOrgVoice(orgId: string | null | undefined, accessToken: string | null) {
  const [voice, setVoice] = useState<OrgVoiceState | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isSupabaseBrowserConfigured || !supabase || !orgId) return;
    const { data } = await supabase
      .from('org_voice')
      .select('assistant_id, phone_number_id, phone_number, inbound_enabled')
      .eq('org_id', orgId)
      .maybeSingle();
    setVoice({
      assistantId: data?.assistant_id || null,
      phoneNumber: data?.phone_number || null,
      hasNumber: !!data?.phone_number_id,
      inboundEnabled: !!data?.inbound_enabled,
    });
  }, [orgId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const enableInbound = useCallback(async () => {
    if (!accessToken) return;
    setEnabling(true);
    setError(null);
    try {
      const res = await fetch('/api/voice/vapi?action=enable-inbound', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) setError(data.error || 'Could not turn on incoming calls.');
      await refresh();
    } catch (err: any) {
      setError(err.message || 'Failed to reach the server.');
    } finally {
      setEnabling(false);
    }
  }, [accessToken, refresh]);

  return { voice, error, enabling, enableInbound, refresh };
}
