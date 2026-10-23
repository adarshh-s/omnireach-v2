import { getSupabaseAdmin } from './supabaseAdmin.js';
import { getOrgIdFromAuthHeader } from './supabaseServerAuth.js';
import type { VapiCredentials } from './vapiClient.js';
import type { CampaignSettings, ChannelApiSettings } from '../src/types.js';

export interface OrgSummary {
  orgId: string;
  email: string | null;
  companyName: string | null;
  createdAt: string;
  status: 'active' | 'locked';
  memberCount: number;
  voicePhoneNumberId: string | null;
  voicePhoneNumber: string | null;
}

/** Fields getOrgChannelSettings merges in from server-only tables. Never stored in the
 * settings row, and never taken from a browser-supplied copy of the settings. */
const SERVER_ONLY_KEYS = ['savedSecrets', 'gmailRefreshToken', 'gmailAddress', 'outlookRefreshToken', 'outlookAddress', 'verifiedFromAddress'] as const;

/** Every signed-up org, for the admin dashboard's org list. Combines Supabase Auth's user
 * list (email, signup date) with org_profile (company name) and org_access (active/locked) —
 * a missing org_access row means 'active', matching every org that existed before that table
 * was introduced (see supabase/schema.sql). Admin-only: callers must check isAdminEmail
 * themselves before calling this — it deliberately bypasses RLS via the service role. */
export async function adminListOrgs(): Promise<OrgSummary[]> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return [];

  const [{ data: usersData }, { data: accessRows }, { data: profileRows }, { data: memberRows }, { data: voiceRows }] = await Promise.all([
    supabase.auth.admin.listUsers({ perPage: 1000 }),
    supabase.from('org_access').select('org_id, status'),
    supabase.from('org_profile').select('org_id, settings'),
    supabase.from('org_members').select('user_id, org_id'),
    supabase.from('org_voice').select('org_id, phone_number_id, phone_number'),
  ]);

  const statusByOrg = new Map((accessRows || []).map((r: any) => [r.org_id, r.status]));
  const profileByOrg = new Map((profileRows || []).map((r: any) => [r.org_id, r.settings]));
  const voiceByOrg = new Map((voiceRows || []).map((r: any) => [r.org_id, r]));
  // Invited teammates are auth users too, but they belong to someone else's org, not their own.
  const memberUserIds = new Set((memberRows || []).map((r: any) => r.user_id));
  const memberCountByOrg = new Map<string, number>();
  for (const r of memberRows || []) memberCountByOrg.set((r as any).org_id, (memberCountByOrg.get((r as any).org_id) || 0) + 1);

  return (usersData?.users || [])
    .filter((u) => !memberUserIds.has(u.id))
    .map((u) => ({
      orgId: u.id,
      email: u.email || null,
      companyName: (profileByOrg.get(u.id) as CampaignSettings | undefined)?.companyName || null,
      createdAt: u.created_at,
      status: (statusByOrg.get(u.id) as 'active' | 'locked' | undefined) || 'active',
      memberCount: memberCountByOrg.get(u.id) || 0,
      voicePhoneNumberId: voiceByOrg.get(u.id)?.phone_number_id || null,
      voicePhoneNumber: voiceByOrg.get(u.id)?.phone_number || null,
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

/**
 * An org's channel settings as the server uses them: the browser-editable settings row, plus
 * the secrets the database keeps out of it (org_channel_secrets), the connected Gmail/Outlook
 * mailbox (org_email_oauth), and the verified own-domain From address (org_email_domain).
 * Server-side only — never return this object to a browser.
 */
export async function getOrgChannelSettings(orgId: string): Promise<ChannelApiSettings | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;
  const [{ data }, { data: secretsRow }, { data: oauth }, { data: domain }] = await Promise.all([
    supabase.from('org_channel_settings').select('settings').eq('org_id', orgId).maybeSingle(),
    supabase.from('org_channel_secrets').select('secrets').eq('org_id', orgId).maybeSingle(),
    supabase.from('org_email_oauth').select('provider, refresh_token, connected_email').eq('org_id', orgId).maybeSingle(),
    supabase.from('org_email_domain').select('status, from_address').eq('org_id', orgId).maybeSingle(),
  ]);
  if (!data?.settings && !secretsRow && !oauth && !domain) return null;

  const merged: ChannelApiSettings = { ...((data?.settings as ChannelApiSettings) || ({} as ChannelApiSettings)), ...(secretsRow?.secrets || {}) };
  if (oauth?.provider === 'gmail') {
    merged.gmailRefreshToken = oauth.refresh_token;
    merged.gmailAddress = oauth.connected_email || undefined;
  } else if (oauth?.provider === 'outlook') {
    merged.outlookRefreshToken = oauth.refresh_token;
    merged.outlookAddress = oauth.connected_email || undefined;
  }
  if (domain?.status === 'verified') merged.verifiedFromAddress = domain.from_address;
  return merged;
}

/**
 * The settings a send request should use: what's stored for the org, overlaid with the
 * browser's copy of the non-secret fields (they're browser-owned anyway, and the Channel
 * Setup test buttons send unsaved edits). A secret the browser sends is only used when
 * non-empty — e.g. one typed into the form but not saved yet. Server-only fields are always
 * the stored ones, whatever the browser sends.
 */
export async function resolveSendSettings(orgId: string, fromBrowser: Partial<ChannelApiSettings> | undefined): Promise<ChannelApiSettings | null> {
  const stored = await getOrgChannelSettings(orgId);
  const overlay: Record<string, unknown> = { ...(fromBrowser || {}) };
  for (const key of SERVER_ONLY_KEYS) delete overlay[key];
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined || value === null || value === '') delete overlay[key];
  }
  if (!stored && !fromBrowser) return null;
  return { ...(stored || ({} as ChannelApiSettings)), ...(overlay as Partial<ChannelApiSettings>) } as ChannelApiSettings;
}

/**
 * Settings for a send request from the browser. With accounts configured, the caller must be
 * signed in and the org's stored credentials are used (resolveSendSettings) — the request
 * body's credentials alone were never trustworthy, and with the platform's own Resend key as
 * the fallback, an unauthenticated route would be an open relay. Without Supabase at all
 * (standalone single-business mode) the browser's own settings are all there is.
 */
export async function settingsForSendRequest(
  authHeader: string | undefined,
  fromBrowser: Partial<ChannelApiSettings> | undefined
): Promise<{ ok: true; orgId: string | null; settings: ChannelApiSettings | null } | { ok: false }> {
  if (!getSupabaseAdmin()) return { ok: true, orgId: null, settings: (fromBrowser as ChannelApiSettings) || null };
  const orgId = await getOrgIdFromAuthHeader(authHeader);
  if (!orgId) return { ok: false };
  return { ok: true, orgId, settings: await resolveSendSettings(orgId, fromBrowser) };
}

export async function saveOrgChannelSettings(orgId: string, settings: ChannelApiSettings): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  const toStore: Record<string, unknown> = { ...settings };
  for (const key of SERVER_ONLY_KEYS) delete toStore[key];
  await supabase.from('org_channel_settings').upsert(
    {
      org_id: orgId,
      settings: toStore,
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

export interface OrgVoice {
  assistantId: string | null;
  phoneNumberId: string | null;
  phoneNumber: string | null;
  inboundEnabled: boolean;
}

export async function getOrgVoice(orgId: string): Promise<OrgVoice | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;
  const { data } = await supabase
    .from('org_voice')
    .select('assistant_id, phone_number_id, phone_number, inbound_enabled')
    .eq('org_id', orgId)
    .maybeSingle();
  if (!data) return null;
  return {
    assistantId: data.assistant_id,
    phoneNumberId: data.phone_number_id,
    phoneNumber: data.phone_number,
    inboundEnabled: !!data.inbound_enabled,
  };
}

/** Partial upsert — only the fields passed are changed. */
export async function saveOrgVoice(
  orgId: string,
  fields: { assistant_id?: string | null; phone_number_id?: string | null; phone_number?: string | null; inbound_enabled?: boolean }
): Promise<{ error: string | null }> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { error: 'Server database is not configured.' };
  const { error } = await supabase
    .from('org_voice')
    .upsert({ org_id: orgId, ...fields, updated_at: new Date().toISOString() }, { onConflict: 'org_id' });
  if (error?.code === '23505') return { error: 'That phone number is already assigned to another organization.' };
  return { error: error?.message || null };
}

export interface OrgVoiceSetup {
  creds: VapiCredentials;
  settings: ChannelApiSettings | null;
  /** The org is on its own Vapi account (its own API key) rather than the platform's. */
  ownAccount: boolean;
  voice: OrgVoice | null;
}

/**
 * Which Vapi account, assistant and number an org's calls use. An org on its own Vapi key
 * uses the assistant and number it entered (its key can only reach its own). Everyone else
 * is on the platform's account, where the assistant and number come only from org_voice —
 * auto-provisioned and admin-assigned respectively — never from the browser-editable
 * settings, so no org can point its calls at another org's number or assistant.
 */
export async function resolveOrgVoiceSetup(orgId: string): Promise<OrgVoiceSetup> {
  const [settings, voice] = await Promise.all([getOrgChannelSettings(orgId), getOrgVoice(orgId)]);
  const ownKey = settings?.vapiApiKey?.trim();
  if (ownKey) {
    return {
      creds: { apiKey: ownKey, assistantId: settings?.vapiAssistantId || undefined, phoneNumberId: settings?.vapiPhoneNumberId || undefined },
      ownAccount: true,
      voice,
      settings,
    };
  }
  return {
    creds: { assistantId: voice?.assistantId || undefined, phoneNumberId: voice?.phoneNumberId || undefined },
    ownAccount: false,
    voice,
    settings,
  };
}

/** Which org answers calls to a Vapi phone number — used by inbound calls, which arrive with
 * no auth context, only the number that was dialed. */
export async function getOrgIdByVoicePhoneNumberId(phoneNumberId: string): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;
  const { data } = await supabase.from('org_voice').select('org_id').eq('phone_number_id', phoneNumberId).maybeSingle();
  return data?.org_id || null;
}

export async function getOrgAccessStatus(orgId: string): Promise<'active' | 'locked'> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return 'active';
  const { data } = await supabase.from('org_access').select('status').eq('org_id', orgId).maybeSingle();
  return (data?.status as 'active' | 'locked') || 'active';
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
