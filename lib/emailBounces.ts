import { createHmac, timingSafeEqual } from 'crypto';
import { getSupabaseAdmin } from './supabaseAdmin.js';
import { addToSuppression, emailKey, optOutClient } from './suppression.js';
import { emitCrmEvent } from './crm/index.js';

/**
 * Undeliverable addresses and spam complaints, from wherever they show up:
 *   - a bounce that reaches the reply-tracking inbox (lib/emailWebhookHandler.ts),
 *   - a send the provider rejected outright as an invalid recipient (lib/messageQueue.ts),
 *   - Resend's webhook (email.bounced / email.complained) for mail sent through the
 *     platform's Resend account — bounces go to the sending account, not to the Reply-To,
 *     so this is where most of them arrive.
 * Mail sent from an org's own Gmail/Outlook bounces into that mailbox, which OmniReach
 * can't read; those addresses are caught when the provider rejects them at send time.
 */

/** Provider error text that means "this address will never work" (not a temporary failure). */
// 5.1.x = bad address/mailbox. Bare 550s are left out: they're also used for spam-policy
// blocks (5.7.x), which say nothing about the address.
export const HARD_BOUNCE_ERROR = /\b5\.1\.[0-9]+\b|invalid (recipient|email address|`?to`? (field|address))|recipient address rejected|user unknown|no such user|mailbox (unavailable|not found|does not exist)|(email )?address (not found|does not exist)/i;

/** The address bounced for good: never email it again, and show it on the lead. */
export async function markEmailBounced(orgId: string, email: string, reason: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const address = emailKey(email);
  if (!supabase || !address.includes('@')) return;
  await addToSuppression(orgId, { email: address }, `email bounced: ${reason}`.slice(0, 200));

  const { data: clients } = await supabase
    .from('clients')
    .update({ email_status: 'Bounced', updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .ilike('email', address.replace(/[\\%_]/g, (c) => `\\${c}`))
    .select('id');
  const clientIds = (clients || []).map((c: any) => c.id);
  if (clientIds.length) {
    // The campaign message that bounced counts as failed delivery, not as sent, in Reports.
    await supabase
      .from('campaign_recipients')
      .update({ email_status: 'Bounced', error_detail: `Email bounced: ${reason}`.slice(0, 300), updated_at: new Date().toISOString() })
      .eq('org_id', orgId)
      .in('client_id', clientIds)
      .in('email_status', ['Sent', 'Delivered', 'Queued', 'Failed']);
    for (const id of clientIds) {
      await emitCrmEvent(orgId, id, { kind: 'note', title: 'OmniReach: email bounced', text: `${address} is undeliverable (${reason}). No more emails will be sent to it.` });
    }
  }
}

/** Marked as spam: treated as an opt-out from everything, like replying STOP. */
export async function markEmailComplained(orgId: string, email: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const address = emailKey(email);
  if (!supabase || !address.includes('@')) return;
  const { data: clients } = await supabase
    .from('clients')
    .select('id')
    .eq('org_id', orgId)
    .ilike('email', address.replace(/[\\%_]/g, (c) => `\\${c}`))
    .limit(20);
  if (!clients?.length) return addToSuppression(orgId, { email: address }, 'marked an email as spam');
  for (const c of clients) await optOutClient(orgId, (c as any).id, 'marked an email as spam', { email: address });
}

// ---- Resend webhook (signed with Svix: https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests) ----

export function verifyResendSignature(rawBody: string, headers: Record<string, string | string[] | undefined>, secret: string | undefined, nowMs = Date.now()): boolean {
  if (!secret) return false;
  const id = String(headers['svix-id'] || '');
  const timestamp = String(headers['svix-timestamp'] || '');
  const signatures = String(headers['svix-signature'] || '');
  if (!id || !timestamp || !signatures) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > 5 * 60) return false; // replayed or badly skewed
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest();
  return signatures.split(' ').some((part) => {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) return false;
    const given = Buffer.from(sig, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

function tagValue(tags: unknown, name: string): string | null {
  if (Array.isArray(tags)) return (tags.find((t: any) => t?.name === name) as any)?.value || null;
  if (tags && typeof tags === 'object') return ((tags as any)[name] as string) || null;
  return null;
}

/** Which org sent it: the org_id tag every send carries, else the org that owns the From domain. */
async function orgForResendEmail(data: any): Promise<string | null> {
  const tagged = tagValue(data?.tags, 'org_id');
  if (tagged && /^[0-9a-f-]{36}$/i.test(tagged)) return tagged;
  const from = String(data?.from || '').match(/<([^>]+)>/)?.[1] || String(data?.from || '');
  const domain = from.split('@')[1]?.trim().toLowerCase();
  const supabase = getSupabaseAdmin();
  if (!domain || !supabase) return null;
  const { data: row } = await supabase.from('org_email_domain').select('org_id').ilike('domain', domain).maybeSingle();
  return row?.org_id || null;
}

export async function handleResendEvent(event: any): Promise<{ handled: boolean; note?: string }> {
  const type = event?.type;
  if (type !== 'email.bounced' && type !== 'email.complained') return { handled: false, note: `ignored ${type || 'unknown'} event` };
  const data = event.data || {};
  const recipients: string[] = (Array.isArray(data.to) ? data.to : [data.to]).filter(Boolean);
  const orgId = await orgForResendEmail(data);
  if (!orgId) return { handled: false, note: 'no org for this email' };

  if (type === 'email.complained') {
    for (const r of recipients) await markEmailComplained(orgId, r);
    return { handled: true };
  }
  // Only permanent bounces; a full mailbox or a temporary rejection may work later.
  const bounceType = String(data.bounce?.type || '').toLowerCase();
  if (bounceType && !/permanent|hard/.test(bounceType)) return { handled: false, note: `temporary bounce (${bounceType})` };
  const reason = data.bounce?.subType || data.bounce?.message || 'rejected by the recipient server';
  for (const r of recipients) await markEmailBounced(orgId, r, String(reason));
  return { handled: true };
}
