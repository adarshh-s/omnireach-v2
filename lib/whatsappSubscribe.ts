export interface SubscribeAppResult {
  ok: boolean;
  error?: string;
}

/**
 * Subscribes this app to an org's WhatsApp Business Account (WABA) so inbound message
 * webhooks actually get delivered — a step Meta requires in addition to the per-app
 * webhook field subscription, but doesn't surface anywhere in its dashboard UI. Without
 * this, an org can configure everything correctly in Settings and still never receive a
 * reply, with no obvious error pointing at why.
 *
 * The org's own access token owns the subscription (not ours) — wabaId is pasted directly
 * from Meta's WhatsApp -> API Setup page rather than derived, since there's no Graph API
 * field on the phone-number node that resolves it (confirmed the hard way: Meta returns
 * "(#100) Tried accessing nonexisting field" for that lookup).
 */
export async function subscribeAppToWaba(accessToken: string, wabaId: string): Promise<SubscribeAppResult> {
  try {
    const subscribeRes = await fetch(`https://graph.facebook.com/v25.0/${encodeURIComponent(wabaId)}/subscribed_apps`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const subscribeData = await subscribeRes.json();
    if (!subscribeRes.ok || !subscribeData?.success) {
      return { ok: false, error: subscribeData?.error?.message || 'Meta rejected the subscription request.' };
    }

    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message || 'Failed connecting to Meta Graph API.' };
  }
}
