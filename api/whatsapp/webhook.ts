import type { IncomingMessage } from 'http';
import { readRawBody } from '../../lib/parseMultipart.js';
import {
  verifyWhatsAppWebhook,
  verifyWhatsAppSignature,
  resolveWhatsAppSignatureSecret,
  processWhatsAppWebhookPayload,
} from '../../lib/whatsappWebhookHandler.js';

interface ApiRequest extends IncomingMessage {
  method?: string;
  query?: Record<string, unknown>;
}

interface ApiResponse {
  status: (code: number) => ApiResponse;
  send: (data: unknown) => void;
  json: (data: unknown) => void;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method === 'GET') {
    const result = verifyWhatsAppWebhook((req.query || {}) as Record<string, unknown>);
    if (result) {
      return res.status(200).send(result.challenge);
    }
    return res.status(403).send('Forbidden');
  }

  if (req.method === 'POST') {
    // Must await fully before responding — Vercel's Node runtime does not reliably keep
    // a serverless function alive for work started after the response is sent (unlike a
    // long-running Express process), so an "ack now, process after" pattern here silently
    // drops the processing mid-flight. Meta's webhook timeout is generous enough (~20s)
    // to tolerate the extra latency from the AI call + WhatsApp send happening first.
    try {
      const rawBody = await readRawBody(req);
      const signature = req.headers['x-hub-signature-256'] as string | undefined;
      const secret = await resolveWhatsAppSignatureSecret(rawBody);
      if (!verifyWhatsAppSignature(rawBody, signature, secret)) {
        console.warn('[WhatsApp Webhook] Signature verification failed — rejecting payload.');
        return res.status(403).json({ error: 'Invalid signature' });
      }
      await processWhatsAppWebhookPayload(JSON.parse(rawBody || '{}'));
    } catch (err) {
      console.error('[WhatsApp Webhook] Processing error:', err);
    }
    return res.status(200).json({ received: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
