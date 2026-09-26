import { getOrgIdFromAuthHeader } from '../../lib/supabaseServerAuth.js';
import { getOrgChannelSettings } from '../../lib/orgSettings.js';
import { startVapiCall, isVapiConfigured, getAssistantConfig, syncAssistantPrompt, VapiCredentials } from '../../lib/vapiClient.js';

interface ApiRequest {
  method?: string;
  query?: Record<string, unknown>;
  body?: { phone?: string; name?: string; variables?: Record<string, string>; systemPrompt?: string; firstMessage?: string };
  headers?: Record<string, string | string[] | undefined>;
}

interface ApiResponse {
  status: (code: number) => ApiResponse;
  json: (data: unknown) => void;
}

/**
 * Combines "trigger an outbound Vapi call", "receive Vapi's webhook events", and "read/sync
 * an org's assistant prompt" into one route (?action=...) to stay under Vercel's Hobby-plan
 * 12-serverless-function cap — see api/conversations.ts, which was merged from two
 * near-identical routes to free the slot this file uses.
 *
 * Vapi dashboard setup: point the assistant's (or phone number's) Server URL at
 *   https://<your-domain>/api/voice/vapi?action=webhook
 * with a custom header `x-vapi-secret: <VAPI_WEBHOOK_SECRET>` (Vapi's own auth
 * convention) — or append `&token=<VAPI_WEBHOOK_SECRET>` to the URL instead if you'd
 * rather not set a custom header. Either one verifies.
 */
export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.query?.action === 'webhook') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    return handleWebhook(req, res);
  }

  if (req.query?.action === 'get-assistant') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    return handleGetAssistant(req, res);
  }

  if (req.query?.action === 'sync-assistant') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    return handleSyncAssistant(req, res);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  return handleTriggerCall(req, res);
}

/** An org's own Vapi credentials (Channel Setup) always win; startVapiCall/isVapiConfigured
 * fall back to the platform's shared VAPI_* env vars field-by-field when a field is unset. */
async function resolveOrgVapiCredentials(orgId: string): Promise<VapiCredentials> {
  const settings = await getOrgChannelSettings(orgId);
  return {
    apiKey: settings?.vapiApiKey,
    assistantId: settings?.vapiAssistantId,
    phoneNumberId: settings?.vapiPhoneNumberId,
  };
}

async function handleTriggerCall(req: ApiRequest, res: ApiResponse) {
  const orgId = await getOrgIdFromAuthHeader(req.headers?.authorization as string | undefined);
  if (!orgId) {
    return res.status(401).json({ error: 'Sign in required.' });
  }

  const org = await resolveOrgVapiCredentials(orgId);
  if (!isVapiConfigured(org)) {
    return res.status(400).json({ error: 'Voice calling is not configured yet — add your Vapi API Key, Assistant ID, and Phone Number ID in Channel Setup.' });
  }

  const { phone, name, variables } = req.body || {};
  if (!phone) {
    return res.status(400).json({ error: 'phone is required.' });
  }

  const result = await startVapiCall({ phone, name, variables, org });
  return res.status(result.ok ? 200 : 400).json(result);
}

/** Lets the Channel Setup UI prefill its prompt editor with whatever's actually live on the
 * org's Vapi assistant right now, instead of starting blank every time the modal opens. */
async function handleGetAssistant(req: ApiRequest, res: ApiResponse) {
  const orgId = await getOrgIdFromAuthHeader(req.headers?.authorization as string | undefined);
  if (!orgId) {
    return res.status(401).json({ error: 'Sign in required.' });
  }

  const org = await resolveOrgVapiCredentials(orgId);
  const result = await getAssistantConfig(org);
  return res.status(result.ok ? 200 : 400).json(result);
}

/** Pushes the prompt/first-message an org edited in our dashboard straight to their Vapi
 * assistant — so they never have to open Vapi's own dashboard to change how their AI Voice
 * Agent talks. */
async function handleSyncAssistant(req: ApiRequest, res: ApiResponse) {
  const orgId = await getOrgIdFromAuthHeader(req.headers?.authorization as string | undefined);
  if (!orgId) {
    return res.status(401).json({ error: 'Sign in required.' });
  }

  const { systemPrompt, firstMessage } = req.body || {};
  if (!systemPrompt || !firstMessage) {
    return res.status(400).json({ error: 'systemPrompt and firstMessage are required.' });
  }

  const org = await resolveOrgVapiCredentials(orgId);
  const result = await syncAssistantPrompt(org, { systemPrompt, firstMessage });
  return res.status(result.ok ? 200 : 400).json(result);
}

/** Vapi supports two ways to authenticate its outgoing webhook: a custom header configured
 * on the assistant/phone number (`x-vapi-secret`, Vapi's own convention), or a `?token=`
 * query string on the Server URL (this app's other webhooks — e.g. the email inbound one —
 * all use that pattern). Accepting either means this works regardless of which way a given
 * assistant was set up. */
function verifyVapiWebhookRequest(req: ApiRequest): boolean {
  const expected = process.env.VAPI_WEBHOOK_SECRET;
  if (!expected) return false;
  const headerSecret = req.headers?.['x-vapi-secret'];
  if (typeof headerSecret === 'string' && headerSecret === expected) return true;
  return req.query?.token === expected;
}

async function handleWebhook(req: ApiRequest, res: ApiResponse) {
  if (!verifyVapiWebhookRequest(req)) {
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
