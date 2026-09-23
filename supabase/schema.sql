-- OmniReach AI — multi-tenant schema
-- Run this in your Supabase project's SQL editor (Project → SQL Editor → New query).
-- Each Supabase Auth user is treated as one organization/workspace (org_id = auth.uid()).
--
-- This file is additive/idempotent and safe to re-run any time you pull a schema change —
-- every statement is a `create table if not exists` / `alter table ... add column if not
-- exists` / `create index if not exists`, so re-running never touches existing data.

-- ---------------------------------------------------------------------------
-- Org identity & business profile (replaces CampaignSettings' identity fields)
-- ---------------------------------------------------------------------------
create table if not exists org_profile (
  org_id uuid primary key references auth.users(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,  -- shape: CampaignSettings (src/types.ts)
  updated_at timestamptz not null default now()
);
alter table org_profile enable row level security;
drop policy if exists "org can manage own profile" on org_profile;
create policy "org can manage own profile" on org_profile
  for all using (auth.uid() = org_id) with check (auth.uid() = org_id);

-- ---------------------------------------------------------------------------
-- Org channel credentials (WhatsApp / Email provider settings — replaces the
-- browser-localStorage Channel Setup modal; configured via the in-app dashboard)
-- ---------------------------------------------------------------------------
create table if not exists org_channel_settings (
  org_id uuid primary key references auth.users(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,  -- shape: ChannelApiSettings (src/types.ts)
  whatsapp_cloud_phone_id text,  -- denormalized copy of settings.whatsappCloudPhoneId, for fast webhook routing
  updated_at timestamptz not null default now()
);
alter table org_channel_settings enable row level security;
drop policy if exists "org can manage own channel settings" on org_channel_settings;
create policy "org can manage own channel settings" on org_channel_settings
  for all using (auth.uid() = org_id) with check (auth.uid() = org_id);

-- Lets the inbound WhatsApp webhook figure out which org owns a given phone number.
create unique index if not exists idx_org_channel_settings_phone_id
  on org_channel_settings(whatsapp_cloud_phone_id) where whatsapp_cloud_phone_id is not null;

-- Keeps the denormalized column in sync automatically, however the row gets written —
-- the dashboard (browser) only ever writes the `settings` jsonb blob, never this column directly.
create or replace function sync_org_channel_settings_phone_id()
returns trigger
language plpgsql
as $$
begin
  new.whatsapp_cloud_phone_id := new.settings->>'whatsappCloudPhoneId';
  return new;
end;
$$;

drop trigger if exists trg_sync_org_channel_settings_phone_id on org_channel_settings;
create trigger trg_sync_org_channel_settings_phone_id
  before insert or update on org_channel_settings
  for each row execute function sync_org_channel_settings_phone_id();

-- ---------------------------------------------------------------------------
-- Per-org Google Calendar connection (OAuth "Connect" flow, one shared platform
-- OAuth Client ID/Secret in server env, but a distinct refresh token per org)
-- ---------------------------------------------------------------------------
create table if not exists org_google_calendar (
  org_id uuid primary key references auth.users(id) on delete cascade,
  refresh_token text not null,
  connected_email text,
  calendar_id text not null default 'primary',
  updated_at timestamptz not null default now()
);
-- Locked down entirely: only the server (service_role key, which bypasses RLS) reads/writes
-- this table directly. The browser never reads refresh_token — see the status function below.
alter table org_google_calendar enable row level security;

-- Safe, column-limited way for the dashboard to check connection status without
-- ever exposing the refresh_token to the browser.
create or replace function get_google_calendar_status()
returns table(connected boolean, connected_email text, calendar_id text)
language sql
security definer
set search_path = public
as $$
  select true, o.connected_email, o.calendar_id
  from org_google_calendar o
  where o.org_id = auth.uid();
$$;
grant execute on function get_google_calendar_status() to authenticated;

-- ---------------------------------------------------------------------------
-- WhatsApp AI booking bot — conversation state, now scoped per org
-- ---------------------------------------------------------------------------
create table if not exists whatsapp_conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references auth.users(id) on delete cascade,
  phone text not null,             -- WhatsApp number, digits only, no '+' (e.g. 971501234567)
  lead_id text,
  lead_name text,
  lead_email text,
  lead_company text,
  status text not null default 'active',  -- active | confirmed | declined | handoff
  history jsonb not null default '[]'::jsonb,   -- [{ role: 'user' | 'assistant', text, timestamp }]
  collected jsonb not null default '{}'::jsonb,
  meeting_date date,
  meeting_time text,
  meeting_datetime_iso timestamptz,
  meet_link text,
  calendar_event_id text,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_whatsapp_conversations_org_phone on whatsapp_conversations(org_id, phone);
create index if not exists idx_whatsapp_conversations_last_message on whatsapp_conversations(last_message_at desc);

alter table whatsapp_conversations enable row level security;
drop policy if exists "org can read own conversations" on whatsapp_conversations;
create policy "org can read own conversations" on whatsapp_conversations
  for select using (auth.uid() = org_id);
-- Inserts/updates come only from the webhook handler (service_role key, bypasses RLS).

-- ---------------------------------------------------------------------------
-- The old single-tenant credential cache is replaced by org_channel_settings.
-- ---------------------------------------------------------------------------
drop table if exists bot_settings;

-- ---------------------------------------------------------------------------
-- Clients — persisted, org-scoped (replaces browser-localStorage-only leads).
-- Column names mirror the `Lead` type in src/types.ts (camelCase -> snake_case).
-- ---------------------------------------------------------------------------
create table if not exists clients (
  id text primary key,  -- client-generated (matches the app's existing Lead.id scheme, not a DB-issued uuid)
  org_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  company text,
  phone text,
  email text,
  status text not null default 'Pending',
  whatsapp_status text not null default 'Pending',
  email_status text not null default 'Pending',
  whatsapp_message text,
  email_subject text,
  email_body text,
  meeting_date text,
  meeting_time text,
  notes text,
  last_contacted timestamptz,
  channel_used text,
  is_valid_phone boolean not null default true,
  is_valid_email boolean not null default true,
  custom_fields jsonb not null default '{}'::jsonb,
  opted_out boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table clients enable row level security;
drop policy if exists "org can manage own clients" on clients;
create policy "org can manage own clients" on clients
  for all using (auth.uid() = org_id) with check (auth.uid() = org_id);

create index if not exists idx_clients_org on clients(org_id);
create index if not exists idx_clients_org_phone on clients(org_id, phone);

-- ---------------------------------------------------------------------------
-- Campaigns — a named, saved outreach run (replaces "just loop over whatever
-- leads are currently in memory"), plus one row per recipient for progress
-- tracking, dashboard KPIs, and analytics.
-- ---------------------------------------------------------------------------
create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  objective text,
  channels jsonb not null default '[]'::jsonb,  -- e.g. ["whatsapp","email"]
  ai_instructions text,
  status text not null default 'draft',  -- draft | running | completed
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table campaigns enable row level security;
drop policy if exists "org can manage own campaigns" on campaigns;
create policy "org can manage own campaigns" on campaigns
  for all using (auth.uid() = org_id) with check (auth.uid() = org_id);

create index if not exists idx_campaigns_org on campaigns(org_id, created_at desc);

create table if not exists campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  org_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  whatsapp_status text not null default 'Pending',
  email_status text not null default 'Pending',
  ai_conversation_status text,
  meeting_booked boolean not null default false,
  error_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table campaign_recipients enable row level security;
drop policy if exists "org can manage own campaign recipients" on campaign_recipients;
create policy "org can manage own campaign recipients" on campaign_recipients
  for all using (auth.uid() = org_id) with check (auth.uid() = org_id);

create index if not exists idx_campaign_recipients_campaign on campaign_recipients(campaign_id);
create index if not exists idx_campaign_recipients_client on campaign_recipients(client_id);

-- Traces an inbound WhatsApp reply back to the client and campaign that triggered it.
alter table whatsapp_conversations add column if not exists client_id text references clients(id) on delete set null;
alter table whatsapp_conversations add column if not exists campaign_recipient_id uuid references campaign_recipients(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Email AI booking bot — mirrors whatsapp_conversations. Identification works
-- differently: campaign emails set Reply-To to a tracking address encoding the
-- campaign_recipient_id, so an inbound reply is matched deterministically
-- (not by fuzzy From-address matching).
-- ---------------------------------------------------------------------------
create table if not exists email_conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references auth.users(id) on delete cascade,
  client_email text not null,
  client_id text references clients(id) on delete set null,
  campaign_recipient_id uuid references campaign_recipients(id) on delete set null,
  lead_name text,
  lead_company text,
  status text not null default 'active',  -- active | confirmed | declined | handoff
  subject text,
  history jsonb not null default '[]'::jsonb,  -- [{ role: 'user' | 'assistant', text, timestamp }]
  meeting_date date,
  meeting_time text,
  meeting_datetime_iso timestamptz,
  meet_link text,
  calendar_event_id text,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_email_conversations_org_email on email_conversations(org_id, client_email);
create index if not exists idx_email_conversations_last_message on email_conversations(last_message_at desc);

alter table email_conversations enable row level security;
drop policy if exists "org can read own email conversations" on email_conversations;
create policy "org can read own email conversations" on email_conversations
  for select using (auth.uid() = org_id);

-- ---------------------------------------------------------------------------
-- Country-based peak-time campaign scheduling. A recipient with a non-null
-- scheduled_for isn't sent immediately by the browser — it's picked up later
-- by the headless dispatcher (api/cron/dispatch-scheduled.ts), which needs the
-- pre-generated message content (payload) since it has no browser/AI context.
-- ---------------------------------------------------------------------------
alter table clients add column if not exists country text;

alter table campaign_recipients add column if not exists scheduled_for timestamptz;
alter table campaign_recipients add column if not exists payload jsonb not null default '{}'::jsonb;

create index if not exists idx_campaign_recipients_due
  on campaign_recipients(scheduled_for) where scheduled_for is not null;
-- Inserts/updates come only from the inbound webhook handler (service_role key, bypasses RLS).

-- ---------------------------------------------------------------------------
-- Idempotency guard for the WhatsApp webhook. Meta guarantees at-least-once
-- delivery and retries if our response is slow — without tracking the last
-- processed message id, a retry racing the original in-flight request can
-- overwrite newer conversation state (e.g. a just-confirmed meeting) with a
-- stale reply. See lib/whatsappWebhookHandler.ts.
-- ---------------------------------------------------------------------------
alter table whatsapp_conversations add column if not exists last_inbound_message_id text;

-- ---------------------------------------------------------------------------
-- Per-conversation processing lock. Two messages sent seconds apart (e.g. "Yes"
-- then "Friday" as separate texts) can trigger two concurrent webhook invocations
-- that each read the conversation before the other writes back — a distinct race
-- from the message-id redelivery one above (different message ids, so that dedup
-- doesn't catch it). See acquireConversationLock in lib/whatsappWebhookHandler.ts.
-- ---------------------------------------------------------------------------
alter table whatsapp_conversations add column if not exists locked_at timestamptz;

-- ---------------------------------------------------------------------------
-- Retry/backoff for failed sends. api/cron/dispatch-scheduled.ts now also picks
-- up rows whose whatsapp_status/email_status is 'Failed', past a backoff window,
-- and under the retry cap — reusing the same payload column (see the peak-time
-- scheduling comment above) which BatchCampaignRunner.tsx now also populates on
-- any failure, not just scheduled sends, so a retry has real content to resend.
-- ---------------------------------------------------------------------------
alter table campaign_recipients add column if not exists retry_count int not null default 0;

-- ---------------------------------------------------------------------------
-- Lightweight CRM fields on clients — tags and a manual follow-up reminder date.
-- Mirrors the existing `notes` column's end-to-end pattern (see src/types.ts's
-- Lead type and src/hooks/useCloudClients.ts's leadToRow/rowToLead mapping).
-- ---------------------------------------------------------------------------
alter table clients add column if not exists tags text[] not null default '{}'::text[];
alter table clients add column if not exists follow_up_date date;

create index if not exists idx_clients_follow_up_date on clients(follow_up_date) where follow_up_date is not null;

-- ---------------------------------------------------------------------------
-- Real WhatsApp delivery tracking. Meta's send-time API response only means the
-- message was ACCEPTED for processing (message id issued) — actual sent/delivered/
-- read/failed status arrives later as an async webhook status callback, keyed by
-- this message id. Without storing it at send time, that callback has nothing to
-- match back to the right campaign_recipients row, so whatsapp_status got stuck on
-- whatever was set optimistically the instant Meta accepted the request (see
-- lib/whatsappWebhookHandler.ts's status-callback handling).
-- ---------------------------------------------------------------------------
alter table campaign_recipients add column if not exists whatsapp_message_id text;

create index if not exists idx_campaign_recipients_whatsapp_message_id
  on campaign_recipients(whatsapp_message_id) where whatsapp_message_id is not null;

-- ---------------------------------------------------------------------------
-- Per-conversation processing lock for the email side of the AI booking bot —
-- mirrors whatsapp_conversations.locked_at (see lib/whatsappWebhookHandler.ts's
-- acquireConversationLock). Two emails from the same prospect sent seconds apart
-- can trigger two concurrent inbound-webhook invocations that each read the same
-- conversation row before the other writes back; without a lock, one reply is
-- silently dropped, or — worse — both branches can independently confirm and book
-- a duplicate calendar event for the same conversation.
-- ---------------------------------------------------------------------------
alter table email_conversations add column if not exists locked_at timestamptz;

-- ---------------------------------------------------------------------------
-- Lead's country, denormalized onto both conversation tables the same way
-- lead_name/lead_company already are — lets the AI booking bot (see
-- lib/conversationEngine.ts) resolve the lead's own local timezone and interpret
-- "3 PM" as 3 PM *their* time instead of naively parsing it as server-local (UTC
-- on Vercel), which previously booked real Google Meet invites hours off from
-- what was actually agreed.
-- ---------------------------------------------------------------------------
alter table whatsapp_conversations add column if not exists lead_country text;
alter table email_conversations add column if not exists lead_country text;
