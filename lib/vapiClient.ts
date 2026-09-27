/**
 * Vapi (vapi.ai) integration — triggers outbound AI voice calls and manages an org's
 * assistant prompt. Default model: one Vapi account (the platform's), one bill, a separate
 * assistant auto-provisioned per org the first time they save a prompt — a client never
 * sees an API key, just a prompt editor (see syncAssistantPrompt). An org can still bring
 * its own Vapi account instead (see ChannelApiSettings.vapi* in src/types.ts) if it wants
 * its own separate billing; that's an opt-in override, not the expected path. Docs:
 * https://docs.vapi.ai/api-reference/calls/create
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
  /** Only set when syncAssistantPrompt auto-provisioned a brand-new assistant — the caller
   * must persist this onto the org's own settings so future calls/edits reuse it instead of
   * creating a new one every time. */
  assistantId?: string;
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

/** Pushes a new system prompt + first message to an org's Vapi assistant — auto-provisioning
 * a brand-new one first if this org doesn't have an assistantId yet (its own or the
 * platform's shared default hasn't been assigned to it specifically). This is what lets a
 * client just type a prompt and save, with no Vapi account, API key, or assistant ID of
 * their own — the assistant gets created under whichever key resolveCredentials lands on
 * (their own, if they brought one; the platform's shared account otherwise), and the
 * returned assistantId must be persisted onto that org's settings by the caller so it's
 * reused (PATCHed) on every future edit instead of creating a new assistant each time.
 *
 * When an assistantId already exists, this instead fetches the assistant's current `model`
 * object and only replaces the system message within it — Vapi's PATCH replaces
 * `model.messages` wholesale, so blindly sending just the system message would silently
 * drop the model/provider/other message config already set there. */
export async function syncAssistantPrompt(
  org: VapiCredentials,
  params: { systemPrompt: string; firstMessage: string; assistantName?: string }
): Promise<AssistantConfigResult> {
  const { apiKey, assistantId } = resolveCredentials(org);
  if (!apiKey) {
    return { ok: false, error: 'Voice calling isn\'t set up on the platform yet — contact support.' };
  }

  if (!assistantId) {
    try {
      const res = await fetch(`${VAPI_BASE_URL}/assistant`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: params.assistantName || 'OmniReach AI Voice Agent',
          firstMessage: params.firstMessage,
          model: {
            provider: 'openai',
            model: 'gpt-4o',
            messages: [{ role: 'system', content: params.systemPrompt }],
          },
          voice: { provider: 'vapi', voiceId: 'Elliot' },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, error: data?.message || `Vapi rejected the assistant creation (${res.status}).` };
      }
      const systemPrompt = (data?.model?.messages || []).find((m: any) => m.role === 'system')?.content || '';
      return { ok: true, systemPrompt, firstMessage: data?.firstMessage || '', assistantId: data?.id };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to reach Vapi.' };
    }
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
