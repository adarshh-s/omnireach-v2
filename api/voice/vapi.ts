import { getOrgIdFromAuthHeader } from '../../lib/supabaseServerAuth.js';
import { getOrgChannelSettings, saveOrgChannelSettings, getOrgProfile } from '../../lib/orgSettings.js';
import { getAssistantConfig, syncAssistantPrompt, VapiCredentials } from '../../lib/vapiClient.js';
import { placeOrgVoiceCall, handleVapiServerMessage, verifyVapiWebhook, getPublicBaseUrl } from '../../lib/voiceCalls.js';

interface ApiRequest {
  method?: string;
  query?: Record<string, unknown>;
  body?: { phone?: string; name?: string; clientId?: string; variables?: Record<string, string>; systemPrompt?: string; firstMessage?: string };
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
 * No Vapi dashboard setup is needed for the webhook: every outbound call placed here
 * attaches this route (?action=webhook, authenticated with an `x-vapi-secret:
 * <VAPI_WEBHOOK_SECRET>` header) as its server URL, plus the book_meeting tool — see
 * lib/voiceCalls.ts. Only VAPI_WEBHOOK_SECRET has to be set in the environment.
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

  const { phone, name, clientId, variables } = req.body || {};
  const result = await placeOrgVoiceCall({ orgId, phone, name, clientId, variables, baseUrl: getPublicBaseUrl(req.headers) });
  return res.status(result.httpStatus).json(result.body);
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
 * assistant — so they never have to open Vapi's own dashboard, hold their own Vapi account,
 * or know an API key exists. The first time an org saves a prompt, syncAssistantPrompt
 * auto-creates a dedicated assistant for them (under their own key if they brought one,
 * otherwise the platform's shared account) — that new assistantId gets persisted onto their
 * settings here so every later edit reuses (PATCHes) the same assistant instead of creating
 * a new one each time. */
async function handleSyncAssistant(req: ApiRequest, res: ApiResponse) {
  const orgId = await getOrgIdFromAuthHeader(req.headers?.authorization as string | undefined);
  if (!orgId) {
    return res.status(401).json({ error: 'Sign in required.' });
  }

  const { systemPrompt, firstMessage } = req.body || {};
  if (!systemPrompt || !firstMessage) {
    return res.status(400).json({ error: 'systemPrompt and firstMessage are required.' });
  }

  const [org, existingSettings, profile] = await Promise.all([
    resolveOrgVapiCredentials(orgId),
    getOrgChannelSettings(orgId),
    getOrgProfile(orgId),
  ]);
  const assistantName = profile?.companyName ? `${profile.companyName} — AI Voice Agent` : undefined;
  const result = await syncAssistantPrompt(org, { systemPrompt, firstMessage, assistantName });

  if (result.ok && result.assistantId) {
    await saveOrgChannelSettings(orgId, {
      ...(existingSettings || ({} as any)),
      vapiAssistantId: result.assistantId,
    });
  }

  return res.status(result.ok ? 200 : 400).json(result);
}

async function handleWebhook(req: ApiRequest, res: ApiResponse) {
  if (!verifyVapiWebhook(req.headers?.['x-vapi-secret'], req.query?.token)) {
    return res.status(403).json({ error: 'Invalid token' });
  }
  try {
    return res.status(200).json(await handleVapiServerMessage((req.body as any)?.message));
  } catch (err: any) {
    // Still 200 — Vapi retries non-2xx, and a retried end-of-call report would just fail again.
    console.error('[Vapi] Webhook handling failed:', err);
    return res.status(200).json({ received: true });
  }
}
