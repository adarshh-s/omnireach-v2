import { getSupabaseAdmin } from './supabaseAdmin.js';
import type { CampaignSettings, ChannelApiSettings } from '../src/types.js';

export interface OrgSummary {
  orgId: string;
  email: string | null;
  companyName: string | null;
  createdAt: string;
  status: 'active' | 'locked';
}

/** Every signed-up org, for the admin dashboard's org list. Combines Supabase Auth's user
 * list (email, signup date) with org_profile (company name) and org_access (active/locked) —
 * a missing org_access row means 'active', matching every org that existed before that table
 * was introduced (see supabase/schema.sql). Admin-only: callers must check isAdminEmail
 * themselves before calling this — it deliberately bypasses RLS via the service role. */
export async function adminListOrgs(): Promise<OrgSummary[]> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return [];

  const [{ data: usersData }, { data: accessRows }, { data: profileRows }] = await Promise.all([
    supabase.auth.admin.listUsers({ perPage: 1000 }),
    supabase.from('org_access').select('org_id, status'),
    supabase.from('org_profile').select('org_id, settings'),
  ]);

  const statusByOrg = new Map((accessRows || []).map((r: any) => [r.org_id, r.status]));
  const profileByOrg = new Map((profileRows || []).map((r: any) => [r.org_id, r.settings]));

  return (usersData?.users || [])
    .map((u) => ({
      orgId: u.id,
      email: u.email || null,
      companyName: (profileByOrg.get(u.id) as CampaignSettings | undefined)?.companyName || null,
      createdAt: u.created_at,
      status: (statusByOrg.get(u.id) as 'active' | 'locked' | undefined) || 'active',
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Manually flips an org's access on/off — the "unlock after payment" step in the admin
 * dashboard. Admin-only: callers must check isAdminEmail themselves before calling this. */
export async function adminSetOrgAccess(orgId: string, status: 'active' | 'locked'): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  await supabase.from('org_access').upsert(
    { org_id: orgId, status, updated_at: new Date().toISOString() },
    { onConflict: 'org_id' }
  );
}

export async function getOrgProfile(orgId: string): Promise<CampaignSettings | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;
  const { data } = await supabase.from('org_profile').select('settings').eq('org_id', orgId).maybeSingle();
  return (data?.settings as CampaignSettings) || null;
}

export async function saveOrgProfile(orgId: string, settings: CampaignSettings): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  await supabase.from('org_profile').upsert(
    { org_id: orgId, settings, updated_at: new Date().toISOString() },
    { onConflict: 'org_id' }
  );
}

export async function getOrgChannelSettings(orgId: string): Promise<ChannelApiSettings | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;
  const { data } = await supabase.from('org_channel_settings').select('settings').eq('org_id', orgId).maybeSingle();
  return (data?.settings as ChannelApiSettings) || null;
}

export async function saveOrgChannelSettings(orgId: string, settings: ChannelApiSettings): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  await supabase.from('org_channel_settings').upsert(
    {
      org_id: orgId,
      settings,
      whatsapp_cloud_phone_id: settings.whatsappCloudPhoneId || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'org_id' }
  );
}

/**
 * Resolves which org owns a given Meta WhatsApp phone_number_id — used by the inbound
 * webhook (which has no session/auth context) to route an incoming message to the right
 * org's credentials, identity, and calendar.
 */
export async function getOrgIdByPhoneNumberId(phoneNumberId: string): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;
  const { data } = await supabase
    .from('org_channel_settings')
    .select('org_id')
    .eq('whatsapp_cloud_phone_id', phoneNumberId)
    .maybeSingle();
  return data?.org_id || null;
}

export interface OrgGoogleCalendarToken {
  refreshToken: string;
  calendarId: string;
  connectedEmail?: string;
}

export async function getOrgGoogleCalendarToken(orgId: string): Promise<OrgGoogleCalendarToken | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;
  const { data } = await supabase
    .from('org_google_calendar')
    .select('refresh_token, calendar_id, connected_email')
    .eq('org_id', orgId)
    .maybeSingle();
  if (!data) return null;
  return { refreshToken: data.refresh_token, calendarId: data.calendar_id || 'primary', connectedEmail: data.connected_email };
}

export async function saveOrgGoogleCalendarToken(
  orgId: string,
  token: { refreshToken: string; connectedEmail?: string; calendarId?: string }
): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  await supabase.from('org_google_calendar').upsert(
    {
      org_id: orgId,
      refresh_token: token.refreshToken,
      connected_email: token.connectedEmail,
      calendar_id: token.calendarId || 'primary',
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'org_id' }
  );
}

export interface OrgMicrosoftCalendarToken {
  refreshToken: string;
  connectedEmail?: string;
}

/** Deliberately a separate table from org_google_calendar rather than one table with a
 * provider column — an org picks one or the other, and keeping them separate means neither
 * provider's code has to know the other exists. See supabase/schema.sql for org_microsoft_calendar. */
export async function getOrgMicrosoftCalendarToken(orgId: string): Promise<OrgMicrosoftCalendarToken | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;
  const { data } = await supabase
    .from('org_microsoft_calendar')
    .select('refresh_token, connected_email')
    .eq('org_id', orgId)
    .maybeSingle();
  if (!data) return null;
  return { refreshToken: data.refresh_token, connectedEmail: data.connected_email };
}

export async function saveOrgMicrosoftCalendarToken(
  orgId: string,
  token: { refreshToken: string; connectedEmail?: string }
): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  await supabase.from('org_microsoft_calendar').upsert(
    {
      org_id: orgId,
      refresh_token: token.refreshToken,
      connected_email: token.connectedEmail,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'org_id' }
  );
}

export interface RecipientContext {
  orgId: string;
  clientId: string | null;
  clientName?: string;
  clientCompany?: string;
  clientEmail?: string;
  clientCountry?: string;
}

/**
 * Resolves the org + client behind a campaign_recipients row — used by the inbound email
 * webhook, which identifies the reply deterministically via a Reply-To tracking address
 * (reply+cr_<campaignRecipientId>@...) rather than fuzzy From-address matching.
 */
export async function getContextFromCampaignRecipientId(campaignRecipientId: string): Promise<RecipientContext | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;
  const { data } = await supabase
    .from('campaign_recipients')
    .select('org_id, client_id, clients(name, company, email, country)')
    .eq('id', campaignRecipientId)
    .maybeSingle();
  if (!data) return null;
  const client: any = Array.isArray((data as any).clients) ? (data as any).clients[0] : (data as any).clients;
  return {
    orgId: data.org_id,
    clientId: data.client_id,
    clientName: client?.name,
    clientCompany: client?.company,
    clientEmail: client?.email,
    clientCountry: client?.country,
  };
}

/** Fallback resolver for a reply+client_<clientId>@... tracking address (no campaign involved). */
export async function getContextFromClientId(clientId: string): Promise<RecipientContext | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;
  const { data } = await supabase.from('clients').select('id, org_id, name, company, email, country').eq('id', clientId).maybeSingle();
  if (!data) return null;
  return { orgId: data.org_id, clientId: data.id, clientName: data.name, clientCompany: data.company, clientEmail: data.email, clientCountry: data.country };
}

export async function markClientOptedOut(orgId: string, clientId: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  await supabase.from('clients').update({ opted_out: true, updated_at: new Date().toISOString() }).eq('id', clientId).eq('org_id', orgId);
}
