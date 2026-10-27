import { getOrgIdFromAuthHeader, getCallerFromAuthHeader } from '../../lib/supabaseServerAuth.js';
import { logAudit } from '../../lib/auditLog.js';
import { buildTestCallConfig, verifyTestToken } from '../../lib/voiceTest.js';
import { enqueueCampaignCalls, processCallQueue, getQueueStatus, setOrgQueueStatus } from '../../lib/callQueue.js';
import { getOrgChannelSettings, saveOrgChannelSettings, getOrgProfile, saveOrgVoice, resolveOrgVoiceSetup } from '../../lib/orgSettings.js';
import { getAssistantConfig, syncAssistantPrompt } from '../../lib/vapiClient.js';
import {
  placeOrgVoiceCall,
  handleVapiServerMessage,
  verifyVapiWebhook,
  getPublicBaseUrl,
  enableInboundCalls,
} from '../../lib/voiceCalls.js';
import { withLearnedBlock } from '../../lib/aiLearning.js';
import { voiceLanguageOverrides, applyLanguageBlock, VoiceGender } from '../../lib/voiceLanguages.js';

interface ApiRequest {
  method?: string;
  query?: Record<string, unknown>;
  body?: {
    phone?: string;
    name?: string;
    clientId?: string;
    country?: string;
    variables?: Record<string, string>;
    systemPrompt?: string;
    firstMessage?: string;
    language?: string | null;
    voiceGender?: VoiceGender;
    leads?: { clientId: string; name?: string; phone?: string; country?: string }[];
    batchSize?: number;
    concurrency?: number;
    batchGapMinutes?: number;
    control?: 'pause' | 'resume' | 'cancel';
  };
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

  // The "Test Voice Agent" page: everything the browser needs to start a test call (lib/voiceTest.ts).
  if (req.query?.action === 'test-config') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const tester = await getCallerFromAuthHeader(req.headers?.authorization as string | undefined);
    if (!tester) return res.status(401).json({ error: 'Sign in required.' });
    const result = await buildTestCallConfig(tester.orgId, getPublicBaseUrl(req.headers), (req.body as any)?.persona || {});
    return res.status(result.ok ? 200 : 400).json(result);
  }

  if (req.query?.action === 'get-assistant') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    return handleGetAssistant(req, res);
  }

  if (req.query?.action === 'sync-assistant') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    return handleSyncAssistant(req, res);
  }

  // Voice campaigns run from the server-side call queue (lib/callQueue.ts), not the browser.
  if (req.query?.action === 'queue-calls') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    return handleQueueCalls(req, res);
  }

  if (req.query?.action === 'queue-status') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const orgId = await getOrgIdFromAuthHeader(req.headers?.authorization as string | undefined);
    if (!orgId) return res.status(401).json({ error: 'Sign in required.' });
    return res.status(200).json(await getQueueStatus(orgId));
  }

  if (req.query?.action === 'queue-control') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const controller = await getCallerFromAuthHeader(req.headers?.authorization as string | undefined);
    if (!controller) return res.status(401).json({ error: 'Sign in required.' });
    const orgId = controller.orgId;
    const control = req.body?.control;
    if (control !== 'pause' && control !== 'resume' && control !== 'cancel') {
      return res.status(400).json({ error: 'control must be pause, resume or cancel.' });
    }
    await setOrgQueueStatus(orgId, control);
    await logAudit(orgId, { userId: controller.userId, email: controller.email }, `call_campaign.${control}`);
    if (control === 'resume') await processCallQueue(getPublicBaseUrl(req.headers), placeOrgVoiceCall, orgId);
    return res.status(200).json({ ok: true, status: await getQueueStatus(orgId) });
  }

  if (req.query?.action === 'enable-inbound') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const orgId = await getOrgIdFromAuthHeader(req.headers?.authorization as string | undefined);
    if (!orgId) return res.status(401).json({ error: 'Sign in required.' });
    const result = await enableInboundCalls(orgId, getPublicBaseUrl(req.headers));
    return res.status(result.ok ? 200 : 400).json(result);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  return handleTriggerCall(req, res);
}

async function handleTriggerCall(req: ApiRequest, res: ApiResponse) {
  const orgId = await getOrgIdFromAuthHeader(req.headers?.authorization as string | undefined);
  if (!orgId) {
    return res.status(401).json({ error: 'Sign in required.' });
  }

  const { phone, name, clientId, country, variables } = req.body || {};
  const result = await placeOrgVoiceCall({ orgId, phone, name, clientId, country, variables, baseUrl: getPublicBaseUrl(req.headers) });
  return res.status(result.httpStatus).json(result.body);
}

async function handleQueueCalls(req: ApiRequest, res: ApiResponse) {
  const caller = await getCallerFromAuthHeader(req.headers?.authorization as string | undefined);
  if (!caller) return res.status(401).json({ error: 'Sign in required.' });

  // Refuse up front if the org can't call at all, instead of queueing calls that will fail.
  const { creds, ownAccount } = await resolveOrgVoiceSetup(caller.orgId);
  if (!creds.phoneNumberId) {
    return res.status(400).json({
      ok: false,
      error: ownAccount
        ? 'Add your Vapi Phone Number ID in Channel Setup → Voice first.'
        : 'No phone number is assigned to your workspace yet — contact support to get one.',
    });
  }

  const { leads, batchSize, concurrency, batchGapMinutes } = req.body || {};
  if (!Array.isArray(leads) || leads.length === 0) return res.status(400).json({ ok: false, error: 'No leads to call.' });
  const result = await enqueueCampaignCalls(caller.orgId, caller.userId, leads, { batchSize, concurrency, batchGapMinutes });
  if (!result.ok) return res.status(400).json(result);
  await logAudit(caller.orgId, { userId: caller.userId, email: caller.email }, 'call_campaign.started', null, { queued: result.queued, skipped: result.skipped.length });

  // Start the first calls now; the rest follow as calls end (and on the scheduled dispatcher).
  await processCallQueue(getPublicBaseUrl(req.headers), placeOrgVoiceCall, caller.orgId);
  return res.status(200).json({ ...result, status: await getQueueStatus(caller.orgId) });
}

/** Lets the Channel Setup UI prefill its prompt editor with whatever's actually live on the
 * org's Vapi assistant right now, instead of starting blank every time the modal opens. */
async function handleGetAssistant(req: ApiRequest, res: ApiResponse) {
  const orgId = await getOrgIdFromAuthHeader(req.headers?.authorization as string | undefined);
  if (!orgId) {
    return res.status(401).json({ error: 'Sign in required.' });
  }

  const { creds } = await resolveOrgVoiceSetup(orgId);
  // No assistant of the org's own yet — nothing to prefill (and the platform's shared
  // template assistant isn't theirs to show).
  if (!creds.assistantId) return res.status(200).json({ ok: false, error: 'No voice agent saved yet.' });
  const result = await getAssistantConfig(creds);
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

  const { systemPrompt, firstMessage, language: languageCode, voiceGender } = req.body || {};
  if (!systemPrompt || !firstMessage) {
    return res.status(400).json({ error: 'systemPrompt and firstMessage are required.' });
  }

  const [{ creds, ownAccount }, existingSettings, profile] = await Promise.all([
    resolveOrgVoiceSetup(orgId),
    getOrgChannelSettings(orgId),
    getOrgProfile(orgId),
  ]);
  const assistantName = profile?.companyName ? `${profile.companyName} — AI Voice Agent` : undefined;
  // The language and lessons blocks are ours — whatever the editor sent for them is replaced
  // with the current language instruction and lessons.
  const language = voiceLanguageOverrides(languageCode, voiceGender);
  const promptWithLessons = await withLearnedBlock(orgId, applyLanguageBlock(systemPrompt, language?.instruction || null));
  const result = await syncAssistantPrompt(creds, {
    systemPrompt: promptWithLessons,
    firstMessage,
    assistantName,
    speech: language ? { transcriber: language.transcriber, voice: language.voice } : null,
  });

  // A newly provisioned assistant on the platform account is recorded server-side only; on
  // the org's own account it belongs with the rest of its own Vapi settings (the browser
  // also stores the returned id, so its next save doesn't drop it).
  if (result.ok) {
    // Calls read the language from settings too (per-call overrides in lib/voiceCalls.ts).
    await saveOrgChannelSettings(orgId, {
      ...(existingSettings || ({} as any)),
      vapiLanguage: language?.language.code,
      vapiVoiceGender: voiceGender,
      ...(result.assistantId && ownAccount ? { vapiAssistantId: result.assistantId } : {}),
    });
    if (result.assistantId && !ownAccount) await saveOrgVoice(orgId, { assistant_id: result.assistantId });
  }

  return res.status(result.ok ? 200 : 400).json(result);
}

async function handleWebhook(req: ApiRequest, res: ApiResponse) {
  // Real calls carry the webhook secret; browser test calls a short-lived token that only
  // reaches that org's test calls (lib/voiceTest.ts).
  const trusted = verifyVapiWebhook(req.headers?.['x-vapi-secret'], req.query?.token);
  const testOrgId = trusted ? null : verifyTestToken(req.query?.test);
  if (!trusted && !testOrgId) {
    return res.status(403).json({ error: 'Invalid token' });
  }
  try {
    return res
      .status(200)
      .json(await handleVapiServerMessage((req.body as any)?.message, getPublicBaseUrl(req.headers), testOrgId ? { testOrgId } : undefined));
  } catch (err: any) {
    // Still 200 — Vapi retries non-2xx, and a retried end-of-call report would just fail again.
    console.error('[Vapi] Webhook handling failed:', err);
    return res.status(200).json({ received: true });
  }
}
