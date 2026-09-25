import { getOrgIdFromAuthHeader } from '../../lib/supabaseServerAuth.js';
import { startVapiCall, isVapiConfigured } from '../../lib/vapiClient.js';

interface ApiRequest {
  method?: string;
  query?: Record<string, unknown>;
  body?: { phone?: string; name?: string; variables?: Record<string, string> };
  headers?: Record<string, string | string[] | undefined>;
}

interface ApiResponse {
  status: (code: number) => ApiResponse;
  json: (data: unknown) => void;
}

/**
 * Combines "trigger an outbound Vapi call" and "receive Vapi's webhook events" into one
 * route (?action=webhook picks the second) to stay under Vercel's Hobby-plan
 * 12-serverless-function cap — see api/conversations.ts, which was merged from two
 * near-identical routes to free the slot this file uses.
 *
 * Vapi dashboard setup: point the assistant's (or phone number's) Server URL at
 *   https://<your-domain>/api/voice/vapi?action=webhook&token=<VAPI_WEBHOOK_SECRET>
 */
export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.query?.action === 'webhook') {
    return handleWebhook(req, res);
  }

  return handleTriggerCall(req, res);
}

async function handleTriggerCall(req: ApiRequest, res: ApiResponse) {
  const orgId = await getOrgIdFromAuthHeader(req.headers?.authorization as string | undefined);
  if (!orgId) {
    return res.status(401).json({ error: 'Sign in required.' });
  }

  if (!isVapiConfigured()) {
    return res.status(400).json({ error: 'Voice calling is not configured on the server yet (VAPI_API_KEY / VAPI_ASSISTANT_ID / VAPI_PHONE_NUMBER_ID).' });
  }

  const { phone, name, variables } = req.body || {};
  if (!phone) {
    return res.status(400).json({ error: 'phone is required.' });
  }

  const result = await startVapiCall({ phone, name, variables });
  return res.status(result.ok ? 200 : 400).json(result);
}

/** Verifies the shared secret appended to the Vapi Server URL, the same pattern used for
 * the email inbound webhook (lib/emailWebhookHandler.ts's verifyEmailWebhookToken). */
function verifyVapiWebhookToken(token: unknown): boolean {
  const expected = process.env.VAPI_WEBHOOK_SECRET;
  return !!expected && token === expected;
}

async function handleWebhook(req: ApiRequest, res: ApiResponse) {
  if (!verifyVapiWebhookToken(req.query?.token)) {
    return res.status(403).json({ error: 'Invalid token' });
  }

  const message = (req.body as any)?.message;
  const type = message?.type;
  const callId = message?.call?.id;

  // Kept intentionally simple for now (log + 200) rather than persisting to a new table —
  // enough to see live call events during a demo. Vapi retries on a non-2xx response, so
  // this always acks even if a given event type isn't one we specifically care about.
  if (type === 'end-of-call-report') {
    console.log('[Vapi] Call ended', callId, '— reason:', message?.endedReason, '— summary:', message?.summary || message?.analysis?.summary);
  } else if (type === 'status-update') {
    console.log('[Vapi] Call status update', callId, '—', message?.status);
  } else if (type === 'transcript') {
    console.log('[Vapi] Transcript', callId, `[${message?.role}]`, message?.transcript);
  } else if (type) {
    console.log('[Vapi] Event', type, callId || '');
  }

  return res.status(200).json({ received: true });
}
