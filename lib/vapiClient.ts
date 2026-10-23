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
const DEFAULT_VOICE = { provider: 'vapi', voiceId: 'Elliot' };
const DEFAULT_TRANSCRIBER = { provider: 'deepgram', model: 'nova-2', language: 'en' };

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

/** Org's own credentials win; the API key and assistant fall back to the platform's shared
 * account. The phone number never does — every org calls from its own number (assigned by
 * the platform admin, or its own on its own Vapi account), so there's no shared one. */
function resolveCredentials(org?: VapiCredentials): Required<VapiCredentials> {
  return {
    apiKey: org?.apiKey?.trim() || process.env.VAPI_API_KEY || '',
    assistantId: org?.assistantId?.trim() || process.env.VAPI_ASSISTANT_ID || '',
    phoneNumberId: org?.phoneNumberId?.trim() || '',
  };
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
  /** Merged into the call's assistantOverrides (e.g. server, model) — see lib/voiceCalls.ts. */
  overrides?: Record<string, unknown>;
}): Promise<StartCallResult> {
  const { apiKey, assistantId, phoneNumberId } = resolveCredentials(params.org);

  if (!apiKey || !assistantId) {
    return { ok: false, error: 'Voice calling is not set up yet — save your voice agent prompt in Channel Setup → Voice.' };
  }
  if (!phoneNumberId) {
    return { ok: false, error: 'No phone number is assigned to your workspace yet — contact support to get one.' };
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
        assistantOverrides:
          params.variables || params.overrides
            ? { ...(params.overrides || {}), ...(params.variables ? { variableValues: params.variables } : {}) }
            : undefined,
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

/** The full assistant object (model, voice, ...) — used to build per-call model overrides
 * that add the booking tool on top of whatever's configured, and as the template a newly
 * auto-provisioned org assistant copies its model/voice from. */
export async function fetchAssistant(org: VapiCredentials): Promise<any | null> {
  const { apiKey, assistantId } = resolveCredentials(org);
  if (!apiKey || !assistantId) return null;
  try {
    const res = await fetch(`${VAPI_BASE_URL}/assistant/${assistantId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
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
  params: {
    systemPrompt: string;
    firstMessage: string;
    assistantName?: string;
    /** The org's chosen call language (lib/voiceLanguages.ts) — null means its default voice. */
    speech?: { transcriber: Record<string, unknown>; voice: Record<string, unknown> } | null;
  }
): Promise<AssistantConfigResult> {
  const { apiKey } = resolveCredentials(org);
  // Deliberately the org's OWN assistantId only — not resolveCredentials' fallback to the
  // platform's shared VAPI_ASSISTANT_ID. Falling back here meant an org without its own
  // assistant yet PATCHed the shared one, overwriting every other org's prompt with theirs.
  const assistantId = org?.assistantId?.trim() || '';
  if (!apiKey) {
    return { ok: false, error: 'Voice calling isn\'t set up on the platform yet — contact support.' };
  }

  if (!assistantId) {
    try {
      // Copy model/voice from the platform's shared assistant (when the new one is created
      // under the platform's key) so every org starts with the same tuned setup rather than
      // generic defaults. An org on its own Vapi key can't read the platform's assistant.
      const template = !org?.apiKey?.trim() && process.env.VAPI_ASSISTANT_ID ? await fetchAssistant({}) : null;
      const { messages: _templateMessages, ...templateModel } = template?.model || {};
      const res = await fetch(`${VAPI_BASE_URL}/assistant`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: params.assistantName || 'OmniReach AI Voice Agent',
          firstMessage: params.firstMessage,
          model: {
            provider: 'openai',
            model: 'gpt-4o',
            ...templateModel,
            messages: [{ role: 'system', content: params.systemPrompt }],
          },
          voice: params.speech?.voice || template?.voice || DEFAULT_VOICE,
          ...(params.speech ? { transcriber: params.speech.transcriber } : {}),
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

    // A chosen language sets the voice and transcriber; going back to the default undoes a
    // language voice set here earlier (Azure — the provider every language voice uses).
    let speech: Record<string, unknown> = {};
    if (params.speech) {
      speech = { voice: params.speech.voice, transcriber: params.speech.transcriber };
    } else if (params.speech === null && current.voice?.provider === 'azure') {
      const template = !org?.apiKey?.trim() && process.env.VAPI_ASSISTANT_ID ? await fetchAssistant({}) : null;
      speech = { voice: template?.voice || DEFAULT_VOICE, transcriber: template?.transcriber || DEFAULT_TRANSCRIBER };
    }

    const patchRes = await fetch(`${VAPI_BASE_URL}/assistant/${assistantId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstMessage: params.firstMessage, model: updatedModel, ...speech }),
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

export interface VapiPhoneNumber {
  id: string;
  number: string | null;
  name: string | null;
  provider: string | null;
  assistantId: string | null;
}

function toPhoneNumber(p: any): VapiPhoneNumber {
  return { id: p.id, number: p.number || p.sipUri || null, name: p.name || null, provider: p.provider || null, assistantId: p.assistantId || null };
}

/** Every number on a Vapi account — the admin picks from these when assigning one to an org. */
export async function listPhoneNumbers(apiKey: string): Promise<{ ok: boolean; numbers?: VapiPhoneNumber[]; error?: string }> {
  try {
    const res = await fetch(`${VAPI_BASE_URL}/phone-number?limit=1000`, { headers: { Authorization: `Bearer ${apiKey}` } });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: data?.message || `Vapi rejected the request (${res.status}).` };
    return { ok: true, numbers: (Array.isArray(data) ? data : data?.results || []).map(toPhoneNumber) };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Failed to reach Vapi.' };
  }
}

/**
 * Points a number's incoming calls at this app: with no fixed assistant on the number, Vapi
 * asks the number's server URL which assistant should answer each call (an
 * "assistant-request"), which is how lib/voiceCalls.ts picks the org's own assistant and
 * adds the caller's context and the booking tool. Also proves the key owns the number — Vapi
 * rejects the update otherwise.
 */
export async function configurePhoneNumberForInbound(
  apiKey: string,
  phoneNumberId: string,
  server: { url: string; secret: string }
): Promise<{ ok: boolean; number?: VapiPhoneNumber; error?: string }> {
  try {
    const res = await fetch(`${VAPI_BASE_URL}/phone-number/${phoneNumberId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assistantId: null,
        server: { url: server.url, headers: { 'x-vapi-secret': server.secret } },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = Array.isArray(data?.message) ? data.message.join('; ') : data?.message;
      return { ok: false, error: message || `Vapi rejected the phone number update (${res.status}).` };
    }
    return { ok: true, number: toPhoneNumber(data) };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Failed to reach Vapi.' };
  }
}
