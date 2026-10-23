import { createHmac, timingSafeEqual } from 'crypto';
import { getSupabaseAdmin } from './supabaseAdmin.js';
import { emitCrmEvent } from './crm/index.js';

/**
 * The org's do-not-contact list, by phone number and email address rather than by lead — so
 * the same person re-imported as a new lead is still never contacted. Every opt-out path
 * adds to it (WhatsApp/email STOP replies, the email unsubscribe link, "don't call me" on a
 * call, or the org adding someone by hand) and every outbound path checks it.
 */

export function phoneKey(phone: string | null | undefined): string {
  return (phone || '').replace(/\D/g, '');
}

export function emailKey(email: string | null | undefined): string {
  return (email || '').trim().toLowerCase();
}

export async function addToSuppression(
  orgId: string,
  contact: { phone?: string | null; email?: string | null },
  reason: string
): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  const rows = [
    ...(phoneKey(contact.phone).length >= 7 ? [{ org_id: orgId, kind: 'phone', value: phoneKey(contact.phone), reason }] : []),
    ...(emailKey(contact.email).includes('@') ? [{ org_id: orgId, kind: 'email', value: emailKey(contact.email), reason }] : []),
  ];
  if (rows.length) await supabase.from('suppression_list').upsert(rows, { onConflict: 'org_id,kind,value', ignoreDuplicates: true });
}

export interface SuppressionSet {
  phones: Set<string>;
  emails: Set<string>;
}

/** The whole list for one org — for checking many leads at once (starting a campaign). */
export async function loadSuppression(orgId: string): Promise<SuppressionSet> {
  const supabase = getSupabaseAdmin();
  const set: SuppressionSet = { phones: new Set(), emails: new Set() };
  if (!supabase) return set;
  const { data } = await supabase.from('suppression_list').select('kind, value').eq('org_id', orgId).limit(100000);
  for (const r of data || []) (r.kind === 'phone' ? set.phones : set.emails).add(r.value);
  return set;
}

/** Whether this phone and/or email is on the org's list — checked right before each contact. */
export async function isSuppressed(orgId: string, contact: { phone?: string | null; email?: string | null }): Promise<{ phone: boolean; email: boolean }> {
  const supabase = getSupabaseAdmin();
  const result = { phone: false, email: false };
  if (!supabase) return result;
  const phone = phoneKey(contact.phone);
  const email = emailKey(contact.email);
  const checks: PromiseLike<unknown>[] = [];
  if (phone.length >= 7) checks.push(supabase.from('suppression_list').select('id').eq('org_id', orgId).eq('kind', 'phone').eq('value', phone).limit(1).then((r: any) => (result.phone = !!r.data?.length)));
  if (email.includes('@')) checks.push(supabase.from('suppression_list').select('id').eq('org_id', orgId).eq('kind', 'email').eq('value', email).limit(1).then((r: any) => (result.email = !!r.data?.length)));
  await Promise.all(checks);
  return result;
}

/** Marks a lead opted out and adds their number and address to the list. */
export async function optOutClient(orgId: string, clientId: string | null | undefined, reason: string, fallback?: { phone?: string | null; email?: string | null }): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  let contact = fallback || {};
  if (clientId) {
    const { data } = await supabase
      .from('clients')
      .update({ opted_out: true, updated_at: new Date().toISOString() })
      .eq('id', clientId)
      .eq('org_id', orgId)
      .select('phone, email');
    if (data?.[0]) contact = { phone: data[0].phone || contact.phone, email: data[0].email || contact.email };
  }
  await addToSuppression(orgId, contact, reason);
  await emitCrmEvent(orgId, clientId, { kind: 'note', title: 'OmniReach: opted out', text: `Asked not to be contacted (${reason}).`, stage: 'opted_out' });
}

// ---- Email unsubscribe links (one per org + address, signed so they can't be forged) ----

function unsubscribeSecret(): string {
  return process.env.EMAIL_INBOUND_WEBHOOK_SECRET || process.env.OAUTH_STATE_SECRET || process.env.CRON_SECRET || '';
}

function sign(payload: string): string {
  return createHmac('sha256', unsubscribeSecret()).update(payload).digest('base64url').slice(0, 32);
}

/** The https unsubscribe URL for this recipient, or null when the app's public URL or a
 * signing secret isn't configured (emails then fall back to "reply STOP"). */
export function buildUnsubscribeUrl(orgId: string, email: string): string | null {
  const base = process.env.APP_URL?.trim().replace(/\/+$/, '');
  if (!base || !/^https:\/\//.test(base) || !unsubscribeSecret() || !emailKey(email)) return null;
  const payload = Buffer.from(`${orgId}|${emailKey(email)}`).toString('base64url');
  return `${base}/api/email/inbound?action=unsubscribe&t=${payload}.${sign(payload)}`;
}

export function verifyUnsubscribeToken(token: string | undefined): { orgId: string; email: string } | null {
  if (!token || !unsubscribeSecret()) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const [orgId, email] = Buffer.from(payload, 'base64url').toString('utf8').split('|');
  return orgId && email ? { orgId, email } : null;
}

// ---- The org managing its own list (Channel Setup → Do not contact) ----

export async function listSuppression(orgId: string): Promise<{ total: number; entries: { id: string; kind: string; value: string; reason: string | null; createdAt: string }[] }> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { total: 0, entries: [] };
  const [{ count }, { data }] = await Promise.all([
    supabase.from('suppression_list').select('id', { count: 'exact', head: true }).eq('org_id', orgId),
    supabase.from('suppression_list').select('id, kind, value, reason, created_at').eq('org_id', orgId).order('created_at', { ascending: false }).limit(200),
  ]);
  return {
    total: count || 0,
    entries: (data || []).map((r: any) => ({ id: r.id, kind: r.kind, value: r.value, reason: r.reason, createdAt: r.created_at })),
  };
}

/** Adds pasted phone numbers / email addresses (one per line, or comma-separated). */
export async function addManyToSuppression(orgId: string, raw: string): Promise<{ added: number; ignored: number }> {
  const items = (raw || '').split(/[\n,;]+/).map((v) => v.trim()).filter(Boolean).slice(0, 5000);
  let added = 0;
  let ignored = 0;
  for (const item of items) {
    if (item.includes('@') && emailKey(item).includes('.')) {
      await addToSuppression(orgId, { email: item }, 'added manually');
      added++;
    } else if (phoneKey(item).length >= 7) {
      await addToSuppression(orgId, { phone: item }, 'added manually');
      added++;
    } else ignored++;
  }
  return { added, ignored };
}

export async function removeFromSuppression(orgId: string, id: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  await supabase?.from('suppression_list').delete().eq('org_id', orgId).eq('id', id);
}
