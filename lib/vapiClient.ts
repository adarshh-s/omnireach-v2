/**
 * Minimal Vapi (vapi.ai) integration — triggers an outbound AI voice call and receives
 * Vapi's webhook events. Platform-wide credentials only (VAPI_API_KEY/ASSISTANT_ID/
 * PHONE_NUMBER_ID env vars), matching the same shared-platform-key pattern already used
 * for Gemini/Resend elsewhere in this app — no per-org settings UI yet, built fast for a
 * live demo. Docs: https://docs.vapi.ai/api-reference/calls/create
 */

const VAPI_BASE_URL = 'https://api.vapi.ai';

export interface StartCallResult {
  ok: boolean;
  callId?: string;
  status?: string;
  error?: string;
}

export function isVapiConfigured(): boolean {
  return !!(process.env.VAPI_API_KEY && process.env.VAPI_ASSISTANT_ID && process.env.VAPI_PHONE_NUMBER_ID);
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
}): Promise<StartCallResult> {
  const apiKey = process.env.VAPI_API_KEY;
  const assistantId = process.env.VAPI_ASSISTANT_ID;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;

  if (!apiKey || !assistantId || !phoneNumberId) {
    return { ok: false, error: 'Vapi is not configured — set VAPI_API_KEY, VAPI_ASSISTANT_ID, and VAPI_PHONE_NUMBER_ID.' };
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
