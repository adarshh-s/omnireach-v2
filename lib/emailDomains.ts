import { getSupabaseAdmin } from './supabaseAdmin.js';

/**
 * An org's own sending domain on the platform's shared Resend account. Until an org adds
 * one, its mail goes out from RESEND_FROM_ADDRESS; once the DNS records Resend issues are
 * in place and verified, from the org's own address (see lib/emailSender.ts, which only
 * honours a From on the org's own verified domain).
 *
 * Docs: https://resend.com/docs/api-reference/domains/create-domain
 */

const RESEND_BASE_URL = 'https://api.resend.com';

export interface DnsRecord {
  record: string;
  name: string;
  type: string;
  value: string;
  ttl?: string;
  priority?: number;
  status?: string;
}

export interface OrgEmailDomain {
  domain: string;
  status: string;
  records: DnsRecord[];
  fromAddress: string;
}

function platformKey(): string | null {
  return process.env.RESEND_API_KEY?.trim() || null;
}

async function resend(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(`${RESEND_BASE_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${platformKey()}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function normalizeDomain(raw: string): string | null {
  const domain = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? domain : null;
}

function toRow(row: any): OrgEmailDomain {
  return { domain: row.domain, status: row.status, records: row.records || [], fromAddress: row.from_address };
}

/** The org's domain, re-checked with Resend while it isn't verified yet so the dashboard
 * shows the live status (DNS can take a while to propagate). */
export async function getOrgEmailDomain(orgId: string): Promise<OrgEmailDomain | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;
  const { data: row } = await supabase.from('org_email_domain').select('*').eq('org_id', orgId).maybeSingle();
  if (!row) return null;
  if (row.status === 'verified' || !platformKey()) return toRow(row);

  const { ok, data } = await resend(`/domains/${row.resend_domain_id}`);
  if (!ok) return toRow(row);
  const updated = { status: data.status || row.status, records: data.records || row.records, updated_at: new Date().toISOString() };
  await supabase.from('org_email_domain').update(updated).eq('org_id', orgId);
  return toRow({ ...row, ...updated });
}

export async function addOrgEmailDomain(orgId: string, rawDomain: string, rawFrom: string): Promise<{ ok: boolean; error?: string; domain?: OrgEmailDomain }> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { ok: false, error: 'Server database is not configured.' };
  if (!platformKey()) return { ok: false, error: 'Platform email (RESEND_API_KEY) is not set up on the server.' };

  const domain = normalizeDomain(rawDomain || '');
  if (!domain) return { ok: false, error: `"${rawDomain}" isn't a valid domain — enter it like yourcompany.com.` };
  const localPart = (rawFrom || '').trim().toLowerCase().split('@')[0] || 'outreach';
  if (!/^[a-z0-9._+-]+$/.test(localPart)) return { ok: false, error: `"${rawFrom}" isn't a valid address name.` };
  const fromAddress = `${localPart}@${domain}`;

  const { data: existing } = await supabase.from('org_email_domain').select('domain').eq('org_id', orgId).maybeSingle();
  if (existing) return { ok: false, error: `You already have ${existing.domain} set up — remove it first to use a different domain.` };

  const created = await resend('/domains', { method: 'POST', body: JSON.stringify({ name: domain }) });
  if (!created.ok) {
    const message: string = created.data?.message || `Resend rejected the domain (${created.status}).`;
    return {
      ok: false,
      error: /already|exists|registered/i.test(message) ? `${domain} is already registered on this platform. Contact support if it's yours.` : message,
    };
  }

  const row = {
    org_id: orgId,
    domain,
    resend_domain_id: created.data.id,
    status: created.data.status || 'not_started',
    records: created.data.records || [],
    from_address: fromAddress,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('org_email_domain').insert(row);
  if (error) {
    await resend(`/domains/${created.data.id}`, { method: 'DELETE' });
    return { ok: false, error: error.code === '23505' ? `${domain} is already used by another organization.` : error.message };
  }
  return { ok: true, domain: toRow(row) };
}

/** Asks Resend to check the DNS records now, then returns the refreshed status. */
export async function verifyOrgEmailDomain(orgId: string): Promise<{ ok: boolean; error?: string; domain?: OrgEmailDomain }> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { ok: false, error: 'Server database is not configured.' };
  const { data: row } = await supabase.from('org_email_domain').select('resend_domain_id').eq('org_id', orgId).maybeSingle();
  if (!row) return { ok: false, error: 'Add a domain first.' };
  const triggered = await resend(`/domains/${row.resend_domain_id}/verify`, { method: 'POST' });
  if (!triggered.ok) return { ok: false, error: triggered.data?.message || 'Resend could not start verification.' };
  const domain = await getOrgEmailDomain(orgId);
  return { ok: true, domain: domain || undefined };
}

export async function updateOrgEmailFromAddress(orgId: string, rawFrom: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { ok: false, error: 'Server database is not configured.' };
  const { data: row } = await supabase.from('org_email_domain').select('domain').eq('org_id', orgId).maybeSingle();
  if (!row) return { ok: false, error: 'Add a domain first.' };
  const localPart = (rawFrom || '').trim().toLowerCase().split('@')[0];
  if (!/^[a-z0-9._+-]+$/.test(localPart || '')) return { ok: false, error: `"${rawFrom}" isn't a valid address name.` };
  await supabase.from('org_email_domain').update({ from_address: `${localPart}@${row.domain}`, updated_at: new Date().toISOString() }).eq('org_id', orgId);
  return { ok: true };
}

export async function removeOrgEmailDomain(orgId: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { ok: false, error: 'Server database is not configured.' };
  const { data: row } = await supabase.from('org_email_domain').select('resend_domain_id').eq('org_id', orgId).maybeSingle();
  if (!row) return { ok: true };
  if (platformKey()) await resend(`/domains/${row.resend_domain_id}`, { method: 'DELETE' });
  await supabase.from('org_email_domain').delete().eq('org_id', orgId);
  return { ok: true };
}
