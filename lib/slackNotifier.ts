/**
 * Posts to a Slack Incoming Webhook (api.slack.com/apps -> Incoming Webhooks) — no OAuth, no
 * Slack app review, just a URL the org pastes into Channel Setup. Fire-and-forget: a
 * notification failing (bad/revoked webhook URL, Slack hiccup) should never break the actual
 * booking flow that triggered it, so callers don't need to await or handle errors from this.
 */
export async function sendSlackNotification(webhookUrl: string | undefined | null, text: string): Promise<void> {
  if (!webhookUrl?.trim()) return;
  try {
    await fetch(webhookUrl.trim(), {
      method: 'POST',
      // text/plain (not application/json) avoids a CORS preflight — Slack's webhook endpoint
      // parses the body as JSON regardless of the declared content-type. Matters when this
      // runs client-side (the "Send Test" button); harmless server-side too.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ text }),
    });
  } catch {
    // Deliberately swallowed — see function doc.
  }
}
