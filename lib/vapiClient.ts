/**
 * Vapi (vapi.ai) integration — triggers outbound AI voice calls and manages an org's
 * assistant prompt. Each org can bring its own Vapi account (see ChannelApiSettings.vapi*
 * in src/types.ts); when an org hasn't configured its own keys, this falls back to the
 * platform's shared VAPI_* env vars — same graceful-degradation pattern already used for
 * Gemini/Resend elsewhere in this app. Docs: https://docs.vapi.ai/api-reference/calls/create
 */

const VAPI_BASE_URL = 'https://api.vapi.ai';

export interface VapiCredentials {
  apiKey?: string;
  assistantId?: string;
  phoneNumberId?: string;
}

export interface StartCallResult {
  ok: boolean;
  callId?: string;
  status?: string;
  error?: string;
}

export interface AssistantConfigResult {
  ok: boolean;
  systemPrompt?: string;
  firstMessage?: string;
  error?: string;
}

/** Org's own credentials win; falls back to the platform's shared account field by field,
 * so an org can set only some of these and still inherit the rest. */
function resolveCredentials(org?: VapiCredentials): Required<VapiCredentials> {
  return {
    apiKey: org?.apiKey?.trim() || process.env.VAPI_API_KEY || '',
    assistantId: org?.assistantId?.trim() || process.env.VAPI_ASSISTANT_ID || '',
    phoneNumberId: org?.phoneNumberId?.trim() || process.env.VAPI_PHONE_NUMBER_ID || '',
  };
}

export function isVapiConfigured(org?: VapiCredentials): boolean {
  const { apiKey, assistantId, phoneNumberId } = resolveCredentials(org);
  return !!(apiKey && assistantId && phoneNumberId);
}

/** Vapi requires E.164 (leading +, digits only after that) — this only reformats, it
 * doesn't validate the number is real/dialable. */
function toE164(raw: string): string | null {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length >= 10) return `+${digits}`;
  return null;
}

export async function startVapiCall(params: {
  phone: string;
  name?: string;
  /** Extra variables the assistant's prompt/first-message can reference as {{key}}. */
  variables?: Record<string, string>;
  org?: VapiCredentials;
}): Promise<StartCallResult> {
  const { apiKey, assistantId, phoneNumberId } = resolveCredentials(params.org);

  if (!apiKey || !assistantId || !phoneNumberId) {
    return { ok: false, error: 'Vapi is not configured — set your Vapi API Key, Assistant ID, and Phone Number ID in Channel Setup.' };
  }

  const number = toE164(params.phone);
  if (!number) {
    return { ok: false, error: `"${params.phone}" doesn't look like a callable phone number.` };
  }

  try {
    const res = await fetch(`${VAPI_BASE_URL}/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        assistantId,
        phoneNumberId,
        customer: {
          number,
          name: params.name || undefined,
        },
        assistantOverrides: params.variables ? { variableValues: params.variables } : undefined,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: data?.message || data?.error || `Vapi rejected the call request (${res.status}).` };
    }
    return { ok: true, callId: data?.id, status: data?.status };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Failed to reach Vapi.' };
  }
}

/** Reads the live system prompt + first message off an org's Vapi assistant, so the
 * Channel Setup UI can prefill its editor with whatever's actually configured on Vapi
 * right now instead of starting blank. */
export async function getAssistantConfig(org: VapiCredentials): Promise<AssistantConfigResult> {
  const { apiKey, assistantId } = resolveCredentials(org);
  if (!apiKey || !assistantId) {
    return { ok: false, error: 'Vapi API Key and Assistant ID are required.' };
  }

  try {
    const res = await fetch(`${VAPI_BASE_URL}/assistant/${assistantId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: data?.message || `Vapi rejected the request (${res.status}).` };
    }
    const systemPrompt = (data?.model?.messages || []).find((m: any) => m.role === 'system')?.content || '';
    return { ok: true, systemPrompt, firstMessage: data?.firstMessage || '' };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Failed to reach Vapi.' };
  }
}

/** Pushes a new system prompt + first message to an org's Vapi assistant. Fetches the
 * assistant's current `model` object first and only replaces the system message within it —
 * Vapi's PATCH replaces `model.messages` wholesale, so blindly sending just the system
 * message would silently drop the model/provider/other message config already set there. */
export async function syncAssistantPrompt(
  org: VapiCredentials,
  params: { systemPrompt: string; firstMessage: string }
): Promise<AssistantConfigResult> {
  const { apiKey, assistantId } = resolveCredentials(org);
  if (!apiKey || !assistantId) {
    return { ok: false, error: 'Vapi API Key and Assistant ID are required.' };
  }

  try {
    const currentRes = await fetch(`${VAPI_BASE_URL}/assistant/${assistantId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const current = await currentRes.json().catch(() => ({}));
    if (!currentRes.ok) {
      return { ok: false, error: current?.message || `Could not load the current assistant (${currentRes.status}).` };
    }

    const updatedModel = {
      ...current.model,
      messages: [{ role: 'system', content: params.systemPrompt }],
    };

    const patchRes = await fetch(`${VAPI_BASE_URL}/assistant/${assistantId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstMessage: params.firstMessage, model: updatedModel }),
    });
    const data = await patchRes.json().catch(() => ({}));
    if (!patchRes.ok) {
      return { ok: false, error: data?.message || `Vapi rejected the update (${patchRes.status}).` };
    }
    const systemPrompt = (data?.model?.messages || []).find((m: any) => m.role === 'system')?.content || '';
    return { ok: true, systemPrompt, firstMessage: data?.firstMessage || '' };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Failed to reach Vapi.' };
  }
}
