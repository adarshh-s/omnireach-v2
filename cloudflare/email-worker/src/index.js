import PostalMime from 'postal-mime';

/**
 * Cloudflare Email Worker — receives inbound mail via Cloudflare Email Routing (free,
 * no SendGrid account needed) and forwards it as JSON to OmniReach's inbound webhook,
 * which parses it exactly the same way it parses SendGrid's multipart payload.
 *
 * Required bindings (see wrangler.toml / README.md):
 *   env.INBOUND_WEBHOOK_BASE_URL — e.g. https://<your-vercel-domain>/api/email/inbound
 *   env.INBOUND_WEBHOOK_TOKEN    — set via `wrangler secret put INBOUND_WEBHOOK_TOKEN`,
 *                                   must match EMAIL_INBOUND_WEBHOOK_SECRET in the main app.
 */
export default {
  async email(message, env, ctx) {
    try {
      const parsed = await PostalMime.parse(message.raw);
      const payload = {
        to: message.to,
        from: message.from,
        subject: parsed.subject || '',
        text: parsed.text || parsed.html || '',
        // Raw "Name: value" lines, same shape as SendGrid's `headers` field — lets the app
        // tell bounces and out-of-office replies from real replies.
        headers: (parsed.headers || []).map((h) => `${h.key}: ${h.value}`).join('\n'),
      };

      const url = `${env.INBOUND_WEBHOOK_BASE_URL}?token=${encodeURIComponent(env.INBOUND_WEBHOOK_TOKEN)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        console.error('[email-worker] webhook forward failed', res.status, await res.text());
      }
    } catch (err) {
      console.error('[email-worker] error handling inbound email', err);
    }
  },
};
