import type { IncomingMessage } from 'http';
import { parseInboundEmailFields, readRawBody } from '../../lib/parseMultipart.js';
import { verifyResendSignature, handleResendEvent } from '../../lib/emailBounces.js';
import { verifyEmailWebhookToken, processInboundEmail } from '../../lib/emailWebhookHandler.js';
import { handleUnsubscribe } from '../../lib/emailCompliance.js';

interface ApiResponse {
  status: (code: number) => ApiResponse;
  json: (data: unknown) => void;
  setHeader: (name: string, value: string) => void;
  send: (data: unknown) => void;
}

/**
 * Inbound email webhook target — accepts either SendGrid's Inbound Parse (multipart/form-data)
 * or our own Cloudflare Email Worker (application/json), see lib/parseMultipart.ts and
 * cloudflare/email-worker.js. Whichever provider is used, configure it to POST to:
 *   https://<your-domain>/api/email/inbound?token=<EMAIL_INBOUND_WEBHOOK_SECRET>
 */
export default async function handler(req: IncomingMessage & { method?: string; query?: Record<string, unknown> }, res: ApiResponse) {
  // The unsubscribe link in outreach emails (and the inbox's one-click unsubscribe) — kept
  // on this route to stay under Vercel Hobby's 12-function cap. See lib/emailCompliance.ts.
  const params = new URL(req.url || '', 'http://localhost').searchParams;
  if (params.get('action') === 'unsubscribe') {
    const result = await handleUnsubscribe(req.method, params.get('t') || undefined);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(result.status).send(result.html);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Resend's bounce/complaint webhook (lib/emailBounces.ts) — add it in Resend → Webhooks as
  // https://<your-domain>/api/email/inbound?action=resend-events with the email.bounced and
  // email.complained events, and put its signing secret in RESEND_WEBHOOK_SECRET.
  if (params.get('action') === 'resend-events') {
    const raw = typeof (req as any).rawBody === 'string' ? (req as any).rawBody : await readRawBody(req);
    if (!verifyResendSignature(raw, req.headers as any, process.env.RESEND_WEBHOOK_SECRET)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
    try {
      return res.status(200).json(await handleResendEvent(JSON.parse(raw)));
    } catch (err) {
      console.error('[Resend Webhook] Processing error:', err);
      return res.status(500).json({ error: 'Processing failed' });
    }
  }

  const url = new URL(req.url || '', 'http://localhost');
  const token = url.searchParams.get('token') || undefined;
  if (!verifyEmailWebhookToken(token)) {
    return res.status(403).json({ error: 'Invalid webhook token' });
  }

  // Must await fully before responding — Vercel's Node runtime does not reliably keep a
  // serverless function alive for work started after the response is sent, so an
  // "ack now, process after" pattern here silently drops the processing mid-flight.
  try {
    const fields = await parseInboundEmailFields(req);
    await processInboundEmail(fields);
  } catch (err) {
    console.error('[Email Webhook] Processing error:', err);
  }

  return res.status(200).json({ received: true });
}
