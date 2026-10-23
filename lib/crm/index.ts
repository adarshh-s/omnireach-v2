import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { signOAuthState, verifyOAuthStateWithPurpose } from '../googleOAuthState.js';
import { CrmAdapter, CrmConnection, CrmLead, CrmProvider, ImportedContact, crmFetch } from './types.js';
import { hubspot } from './hubspot.js';
import { zoho } from './zoho.js';
import { salesforce } from './salesforce.js';

/**
 * CRM integrations — one connected CRM per org (HubSpot, Zoho CRM or Salesforce), via a
 * platform OAuth app per CRM and a refresh token per org, like the calendar connections.
 *
 * What syncs, OmniReach → CRM: each lead OmniReach contacts becomes/updates a lead or contact;
 * call summaries, conversation outcomes and opt-outs become notes; booked meetings become
 * meetings/events. Producers call emitCrmEvent (cheap: a row in crm_events); the scheduled
 * dispatcher and the Campaigns page's pump drain it with processCrmEvents, so a slow or down
 * CRM never slows a call, message or webhook. CRM → OmniReach: "Import from CRM" pulls recent
 * contacts/leads into the Leads list.
 */

const ADAPTERS: Record<CrmProvider, CrmAdapter> = { hubspot, zoho, salesforce };
export const CRM_LABEL: Record<CrmProvider, string> = { hubspot: 'HubSpot', zoho: 'Zoho CRM', salesforce: 'Salesforce' };
const MAX_ATTEMPTS = 5;

interface OAuthApp {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
}

function redirectUri(): string {
  const explicit = process.env.CRM_OAUTH_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  const base = (process.env.APP_URL || 'http://localhost:3000').trim().replace(/\/+$/, '');
  return `${base}/api/auth/crm/callback`;
}

function oauthApp(provider: CrmProvider): OAuthApp | null {
  const env = (k: string) => process.env[k]?.trim() || '';
  if (provider === 'hubspot' && env('HUBSPOT_CLIENT_ID') && env('HUBSPOT_CLIENT_SECRET')) {
    return {
      clientId: env('HUBSPOT_CLIENT_ID'),
      clientSecret: env('HUBSPOT_CLIENT_SECRET'),
      authorizeUrl: 'https://app.hubspot.com/oauth/authorize',
      tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
      scope: 'crm.objects.contacts.read crm.objects.contacts.write oauth',
    };
  }
  if (provider === 'zoho' && env('ZOHO_CLIENT_ID') && env('ZOHO_CLIENT_SECRET')) {
    // accounts.zoho.com signs in users from every data centre once "Multi-DC" is enabled on
    // the client; the callback says which data centre's accounts server issued the code.
    return {
      clientId: env('ZOHO_CLIENT_ID'),
      clientSecret: env('ZOHO_CLIENT_SECRET'),
      authorizeUrl: 'https://accounts.zoho.com/oauth/v2/auth',
      tokenUrl: 'https://accounts.zoho.com/oauth/v2/token',
      scope: 'ZohoCRM.modules.ALL,ZohoCRM.users.READ',
    };
  }
  if (provider === 'salesforce' && env('SALESFORCE_CLIENT_ID') && env('SALESFORCE_CLIENT_SECRET')) {
    const login = env('SALESFORCE_LOGIN_URL') || 'https://login.salesforce.com';
    return {
      clientId: env('SALESFORCE_CLIENT_ID'),
      clientSecret: env('SALESFORCE_CLIENT_SECRET'),
      authorizeUrl: `${login}/services/oauth2/authorize`,
      tokenUrl: `${login}/services/oauth2/token`,
      scope: 'api refresh_token',
    };
  }
  return null;
}

export function configuredCrms(): CrmProvider[] {
  return (['hubspot', 'zoho', 'salesforce'] as CrmProvider[]).filter((p) => !!oauthApp(p));
}

export function isCrmProvider(v: unknown): v is CrmProvider {
  return v === 'hubspot' || v === 'zoho' || v === 'salesforce';
}

export function buildCrmAuthUrl(orgId: string, provider: CrmProvider): string | null {
  const app = oauthApp(provider);
  if (!app) return null;
  const params = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: app.scope,
    state: signOAuthState(orgId, `crm-${provider}`),
    ...(provider === 'zoho' ? { access_type: 'offline', prompt: 'consent' } : {}),
    ...(provider === 'salesforce' ? { prompt: 'consent' } : {}),
  });
  return `${app.authorizeUrl}?${params}`;
}

export function crmProviderFromState(state: string | undefined): CrmProvider | null {
  const purpose = verifyOAuthStateWithPurpose(state)?.purpose;
  return purpose?.startsWith('crm-') ? (purpose.slice(4) as CrmProvider) : null;
}

/** Finishes the OAuth redirect: trades the code for tokens and stores the connection. */
export async function handleCrmCallback(
  code: string | undefined,
  state: string | undefined,
  zohoAccountsServer?: string
): Promise<{ ok: boolean; provider?: CrmProvider; error?: string }> {
  const verified = verifyOAuthStateWithPurpose(state);
  const provider = crmProviderFromState(state);
  if (!verified || !provider) return { ok: false, error: 'Invalid or expired connection request. Please try connecting again.' };
  if (!code) return { ok: false, provider, error: 'The CRM did not return an authorization code.' };
  const app = oauthApp(provider);
  if (!app) return { ok: false, provider, error: `${CRM_LABEL[provider]} isn't set up on the server yet.` };

  // Zoho: exchange the code with the data centre that issued it (only ever a zoho.* host).
  let tokenUrl = app.tokenUrl;
  let accountsBase: string | null = null;
  if (provider === 'zoho' && zohoAccountsServer) {
    const host = new URL(zohoAccountsServer).host;
    if (!/^accounts\.zoho\.[a-z.]+$/.test(host)) return { ok: false, provider, error: 'Unexpected Zoho accounts server.' };
    accountsBase = `https://${host}`;
    tokenUrl = `${accountsBase}/oauth/v2/token`;
  }

  try {
    const tokens = await crmFetch(tokenUrl, {
      label: `${CRM_LABEL[provider]} sign-in`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: app.clientId,
        client_secret: app.clientSecret,
        redirect_uri: redirectUri(),
        code,
      }),
    });
    if (tokens?.error) return { ok: false, provider, error: `${CRM_LABEL[provider]}: ${tokens.error}` };
    if (!tokens?.refresh_token) return { ok: false, provider, error: `${CRM_LABEL[provider]} didn't return a refresh token — try connecting again.` };

    const apiBase = provider === 'zoho' ? tokens.api_domain || 'https://www.zohoapis.com' : provider === 'salesforce' ? tokens.instance_url : null;
    const conn: CrmConnection = { provider, accessToken: tokens.access_token, apiBase };
    const supabase = getSupabaseAdmin();
    if (!supabase) return { ok: false, provider, error: 'Server database is not configured.' };
    const { error } = await supabase.from('org_crm').upsert(
      {
        org_id: verified.orgId,
        provider,
        refresh_token: tokens.refresh_token,
        access_token: tokens.access_token,
        access_expires_at: new Date(Date.now() + (Number(tokens.expires_in) || 3600) * 1000 - 60_000).toISOString(),
        api_base: apiBase,
        accounts_base: accountsBase,
        connected_account: await describeAccount(conn).catch(() => null),
        last_error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'org_id' }
    );
    if (error) return { ok: false, provider, error: error.message };
    // A different CRM than before: old record links point at the wrong system.
    await supabase.from('crm_links').delete().eq('org_id', verified.orgId).neq('provider', provider);
    return { ok: true, provider };
  } catch (err: any) {
    return { ok: false, provider, error: err?.message || `Could not connect ${CRM_LABEL[provider]}.` };
  }
}

/** A human label for the connected account (portal / user / instance). */
async function describeAccount(conn: CrmConnection): Promise<string | null> {
  if (conn.provider === 'hubspot') {
    const info = await crmFetch(`https://api.hubapi.com/oauth/v1/access-tokens/${conn.accessToken}`, { label: 'HubSpot account' });
    return info?.hub_domain || info?.user || null;
  }
  if (conn.provider === 'zoho') {
    const info = await crmFetch(`${conn.apiBase}/crm/v6/users?type=CurrentUser`, {
      label: 'Zoho account',
      headers: { Authorization: `Zoho-oauthtoken ${conn.accessToken}` },
    });
    return info?.users?.[0]?.email || null;
  }
  return conn.apiBase ? new URL(conn.apiBase).host : null;
}

export async function disconnectCrm(orgId: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  await supabase.from('org_crm').delete().eq('org_id', orgId);
  await supabase.from('crm_events').delete().eq('org_id', orgId).eq('status', 'pending');
}

/** A usable connection for the org, refreshing the access token when it has expired. */
export async function getCrmConnection(orgId: string): Promise<CrmConnection | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;
  const { data: row } = await supabase.from('org_crm').select('*').eq('org_id', orgId).maybeSingle();
  if (!row) return null;
  const provider = row.provider as CrmProvider;
  if (row.access_token && row.access_expires_at && new Date(row.access_expires_at).getTime() > Date.now()) {
    return { provider, accessToken: row.access_token, apiBase: row.api_base };
  }
  const app = oauthApp(provider);
  if (!app) throw new Error(`${CRM_LABEL[provider]} isn't set up on the server any more.`);
  const tokenUrl = provider === 'zoho' && row.accounts_base ? `${row.accounts_base}/oauth/v2/token` : app.tokenUrl;
  const tokens = await crmFetch(tokenUrl, {
    label: `${CRM_LABEL[provider]} token refresh`,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: app.clientId, client_secret: app.clientSecret, refresh_token: row.refresh_token }),
  });
  if (!tokens?.access_token) throw new Error(`${CRM_LABEL[provider]} access was revoked — reconnect it in Channel Setup.`);
  const apiBase = provider === 'salesforce' ? tokens.instance_url || row.api_base : provider === 'zoho' ? tokens.api_domain || row.api_base : row.api_base;
  await supabase
    .from('org_crm')
    .update({
      access_token: tokens.access_token,
      access_expires_at: new Date(Date.now() + (Number(tokens.expires_in) || 3600) * 1000 - 60_000).toISOString(),
      api_base: apiBase,
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('org_id', orgId);
  return { provider, accessToken: tokens.access_token, apiBase };
}

// ---- Outbox ----

export type CrmEvent =
  | { kind: 'contact'; stage?: CrmLead['stage'] }
  | { kind: 'note'; title: string; text: string; stage?: CrmLead['stage'] }
  | { kind: 'meeting'; title: string; startIso: string; durationMinutes: number; link?: string | null; notes?: string };

/** Queues something to send to the org's CRM — a no-op when no CRM is connected. Never throws. */
export async function emitCrmEvent(orgId: string, clientId: string | null | undefined, event: CrmEvent): Promise<void> {
  try {
    const supabase = getSupabaseAdmin();
    if (!supabase || !clientId) return;
    const { data: crm } = await supabase.from('org_crm').select('org_id').eq('org_id', orgId).maybeSingle();
    if (!crm) return;
    const { kind, ...payload } = event;
    await supabase.from('crm_events').insert({ org_id: orgId, client_id: clientId, kind, payload });
  } catch (err) {
    console.error('[CRM] Could not queue event', err);
  }
}

/** Sends queued events to each org's CRM until the time budget runs out. */
export async function processCrmEvents(options: { budgetMs: number; onlyOrgId?: string }): Promise<{ sent: number; failed: number }> {
  const supabase = getSupabaseAdmin();
  const counts = { sent: 0, failed: 0 };
  if (!supabase) return counts;
  const deadline = Date.now() + options.budgetMs;

  let query = supabase.from('crm_events').select('*').eq('status', 'pending').order('created_at').limit(100);
  if (options.onlyOrgId) query = query.eq('org_id', options.onlyOrgId);
  const { data: events } = await query;

  const connections = new Map<string, CrmConnection | null | Error>();
  for (const ev of events || []) {
    if (Date.now() > deadline) break;
    if (!connections.has(ev.org_id)) {
      try {
        connections.set(ev.org_id, await getCrmConnection(ev.org_id));
      } catch (err: any) {
        connections.set(ev.org_id, err);
        await supabase.from('org_crm').update({ last_error: err.message }).eq('org_id', ev.org_id);
      }
    }
    const conn = connections.get(ev.org_id);
    if (!conn) {
      await supabase.from('crm_events').update({ status: 'failed', last_error: 'No CRM connected.' }).eq('id', ev.id);
      continue;
    }
    if (conn instanceof Error) continue; // retried once the connection is fixed

    try {
      await deliver(conn, ev);
      await supabase.from('crm_events').update({ status: 'done', updated_at: new Date().toISOString() }).eq('id', ev.id);
      await supabase.from('org_crm').update({ last_sync_at: new Date().toISOString(), last_error: null }).eq('org_id', ev.org_id);
      counts.sent++;
    } catch (err: any) {
      const attempts = (ev.attempts || 0) + 1;
      await supabase
        .from('crm_events')
        .update({ attempts, status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', last_error: err?.message, updated_at: new Date().toISOString() })
        .eq('id', ev.id);
      await supabase.from('org_crm').update({ last_error: err?.message }).eq('org_id', ev.org_id);
      counts.failed++;
    }
  }
  return counts;
}

async function deliver(conn: CrmConnection, ev: any) {
  const supabase = getSupabaseAdmin()!;
  const adapter = ADAPTERS[conn.provider];
  const { data: client } = await supabase.from('clients').select('*').eq('id', ev.client_id).eq('org_id', ev.org_id).maybeSingle();
  if (!client) return; // the lead was deleted — nothing to sync

  const { data: link } = await supabase
    .from('crm_links')
    .select('crm_id')
    .eq('org_id', ev.org_id)
    .eq('client_id', ev.client_id)
    .eq('provider', conn.provider)
    .maybeSingle();
  const stage: CrmLead['stage'] | undefined = ev.kind === 'meeting' ? 'meeting' : ev.payload?.stage;
  const lead: CrmLead = { name: client.name, company: client.company, email: client.email, phone: client.phone, country: client.country, stage };

  // Every event makes sure the lead exists (and is current) in the CRM first.
  let crmId = link?.crm_id || null;
  if (!crmId || ev.kind === 'contact' || stage) {
    crmId = await adapter.upsertContact(conn, lead, crmId);
    await supabase.from('crm_links').upsert({ org_id: ev.org_id, client_id: ev.client_id, provider: conn.provider, crm_id: crmId }, { onConflict: 'org_id,client_id,provider' });
  }
  if (ev.kind === 'note') await adapter.addNote(conn, crmId!, ev.payload.title, ev.payload.text);
  if (ev.kind === 'meeting') await adapter.addMeeting(conn, crmId!, ev.payload);
}

/** Recent contacts/leads from the org's CRM, shaped for the Leads list ("Import from CRM"). */
export async function importFromCrm(orgId: string, limit = 500): Promise<{ provider: CrmProvider; contacts: ImportedContact[] }> {
  const conn = await getCrmConnection(orgId);
  if (!conn) throw new Error('No CRM is connected.');
  return { provider: conn.provider, contacts: await ADAPTERS[conn.provider].listContacts(conn, limit) };
}
