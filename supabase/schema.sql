-- OmniReach AI — multi-tenant schema
-- Run this in your Supabase project's SQL editor (Project → SQL Editor → New query).
-- Each workspace is owned by one Supabase Auth user (org_id = the owner's user id). Teammates
-- the owner invites are other auth users linked to that org through org_members below, so
-- every policy checks current_org_id() rather than auth.uid() directly.
--
-- This file is additive/idempotent and safe to re-run any time you pull a schema change —
-- every statement is a `create table if not exists` / `alter table ... add column if not
-- exists` / `create index if not exists`, so re-running never touches existing data.

-- ---------------------------------------------------------------------------
-- Team members. The owner has no row here (their own user id IS the org id); each invited
-- teammate gets one row pointing at the owner's org. A user belongs to at most one org.
-- Written only by the server (service role) — see lib/teamMembers.ts.
-- ---------------------------------------------------------------------------
create table if not exists org_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  org_id uuid not null references auth.users(id) on delete cascade,
  email text,
  role text not null default 'member' check (role in ('admin', 'member')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_org_members_org on org_members(org_id);

-- The org the signed-in user acts as: the org they were invited into, else their own.
-- security definer so it can read org_members regardless of that table's own RLS.
create or replace function current_org_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select m.org_id from org_members m where m.user_id = auth.uid()), auth.uid());
$$;
grant execute on function current_org_id() to authenticated;

-- What the browser needs to scope itself: which org, and the caller's role in it.
create or replace function get_my_org()
returns table(org_id uuid, role text)
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(m.org_id, auth.uid()), coalesce(m.role, 'owner')
  from (select auth.uid() as uid) me
  left join org_members m on m.user_id = me.uid;
$$;
grant execute on function get_my_org() to authenticated;

alter table org_members enable row level security;
drop policy if exists "org can read own members" on org_members;
create policy "org can read own members" on org_members
  for select using ((select current_org_id()) = org_id);

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
  for all using ((select current_org_id()) = org_id) with check ((select current_org_id()) = org_id);

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
  for all using ((select current_org_id()) = org_id) with check ((select current_org_id()) = org_id);

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
  where o.org_id = current_org_id();
$$;
grant execute on function get_google_calendar_status() to authenticated;

-- ---------------------------------------------------------------------------
-- Per-org Outlook/Microsoft 365 Calendar connection — same shape and same
-- shared-platform-app-registration pattern as org_google_calendar above, kept
-- as its own table rather than adding a provider column to that one so an org
-- can connect either provider without either one's code needing to know the
-- other exists.
-- ---------------------------------------------------------------------------
create table if not exists org_microsoft_calendar (
  org_id uuid primary key references auth.users(id) on delete cascade,
  refresh_token text not null,
  connected_email text,
  updated_at timestamptz not null default now()
);
alter table org_microsoft_calendar enable row level security;

create or replace function get_microsoft_calendar_status()
returns table(connected boolean, connected_email text)
language sql
security definer
set search_path = public
as $$
  select true, o.connected_email
  from org_microsoft_calendar o
  where o.org_id = current_org_id();
$$;
grant execute on function get_microsoft_calendar_status() to authenticated;

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
  for select using ((select current_org_id()) = org_id);
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
  for all using ((select current_org_id()) = org_id) with check ((select current_org_id()) = org_id);

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
  for all using ((select current_org_id()) = org_id) with check ((select current_org_id()) = org_id);

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
  for all using ((select current_org_id()) = org_id) with check ((select current_org_id()) = org_id);

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
  for select using ((select current_org_id()) = org_id);

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

-- ---------------------------------------------------------------------------
-- Org access control — no self-serve subscription checkout. A prospect contacts
-- the platform owner directly, a tier is agreed, payment happens outside the app,
-- and the owner manually flips this row from an admin-only dashboard
-- (src/components/AdminDashboard.tsx, api/whatsapp/subscribe-app.ts's
-- ?action=admin-* routes). Deliberately NOT a jsonb field on org_profile —
-- keeping it a separate table means the org's own RLS policy can grant read-only
-- access to its own row without any write path, so a client can never unlock
-- itself no matter what the client-side code does.
--
-- A missing row means "active" (see App.tsx / api/whatsapp/subscribe-app.ts) so
-- every org that existed before this table was added keeps working exactly as
-- it did — only brand-new signups from here on start locked.
-- ---------------------------------------------------------------------------
create table if not exists org_access (
  org_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'locked')),
  updated_at timestamptz not null default now()
);
alter table org_access enable row level security;
drop policy if exists "org can read own access status" on org_access;
create policy "org can read own access status" on org_access
  for select using ((select current_org_id()) = org_id);
-- No insert/update/delete policy for the authenticated role on purpose — only the
-- service role (which bypasses RLS entirely, used server-side only) can write here.

-- Every new signup starts locked — no email is special-cased. The platform admin (ADMIN_EMAIL)
-- gets past the lock screen anyway and unlocks workspaces, their own included, from Admin.
create or replace function handle_new_org_access()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into org_access (org_id, status)
  values (new.id, 'locked')
  on conflict (org_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_access on auth.users;
create trigger on_auth_user_created_access
  after insert on auth.users
  for each row execute function handle_new_org_access();

-- ---------------------------------------------------------------------------
-- AI Voice Agent (Vapi) call log. A row is inserted the moment an outbound call is
-- placed (api/voice/vapi.ts), then filled in by Vapi's webhook as the call progresses:
-- status updates, a book_meeting tool call mid-conversation, and the end-of-call report
-- (transcript, summary, recording). Shaped like the two *_conversations tables
-- (status/history/meeting_*/last_message_at) so the AI Inbox can render all three alike.
-- See lib/voiceCalls.ts.
-- ---------------------------------------------------------------------------
create table if not exists voice_calls (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references auth.users(id) on delete cascade,
  vapi_call_id text not null,
  client_id text references clients(id) on delete set null,
  phone text not null,
  lead_name text,
  lead_company text,
  lead_email text,
  lead_country text,
  status text not null default 'active',  -- active | confirmed (meeting booked)
  call_status text not null default 'queued',  -- queued | ringing | in-progress | ended
  outcome text,  -- answered | no-answer | busy | voicemail | failed (set when the call ends)
  ended_reason text,  -- Vapi's raw endedReason
  duration_seconds int,
  summary text,
  history jsonb not null default '[]'::jsonb,  -- [{ role: 'user' | 'assistant', text, timestamp }]
  recording_url text,
  cost numeric,
  meeting_date date,
  meeting_time text,
  meeting_datetime_iso timestamptz,
  meet_link text,
  calendar_event_id text,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_voice_calls_vapi_call_id on voice_calls(vapi_call_id);
create index if not exists idx_voice_calls_org on voice_calls(org_id, last_message_at desc);

alter table voice_calls enable row level security;
drop policy if exists "org can read own voice calls" on voice_calls;
create policy "org can read own voice calls" on voice_calls
  for select using ((select current_org_id()) = org_id);
-- Inserts/updates come only from the server (service_role key, bypasses RLS).

-- ---------------------------------------------------------------------------
-- Self-improving prompts (lib/aiLearning.ts). After a conversation or call finishes,
-- Gemini reviews it against its outcome and proposes short lessons; active lessons are
-- appended to every prospect-facing prompt (WhatsApp/email replies, outreach copy, and
-- the Vapi voice agent). Only this lessons layer is learned — core prompts never change.
-- ---------------------------------------------------------------------------
create table if not exists ai_lessons (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references auth.users(id) on delete cascade,
  channel text not null default 'all',      -- all | whatsapp | email | voice
  lesson text not null,
  rationale text,
  status text not null default 'suggested', -- suggested | active | rejected | archived
  source text not null default 'ai',        -- ai | manual
  evidence_count int not null default 1,
  evidence jsonb not null default '[]'::jsonb,  -- [{ channel, conversationId, outcome }]
  retire_reason text,                       -- set when the AI suggests removing a live lesson
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_ai_lessons_org_status on ai_lessons(org_id, status);

alter table ai_lessons enable row level security;
drop policy if exists "org can read own ai lessons" on ai_lessons;
create policy "org can read own ai lessons" on ai_lessons
  for select using ((select current_org_id()) = org_id);
-- Inserts/updates come only from the server (service_role key, bypasses RLS).

-- When each conversation was last reviewed for lessons, and the outcome it had then — a
-- thread is reviewed again only once its outcome changes (e.g. went quiet -> booked).
alter table whatsapp_conversations add column if not exists learning_reviewed_at timestamptz;
alter table whatsapp_conversations add column if not exists learning_outcome text;
alter table email_conversations add column if not exists learning_reviewed_at timestamptz;
alter table email_conversations add column if not exists learning_outcome text;
alter table voice_calls add column if not exists learning_reviewed_at timestamptz;
alter table voice_calls add column if not exists learning_outcome text;

-- ---------------------------------------------------------------------------
-- Channel secrets, kept out of the browser. org_channel_settings is read and written by the
-- dashboard directly (RLS), so anything in its jsonb is visible to the browser. The trigger
-- below moves the secret fields out of every write into org_channel_secrets, which has RLS
-- on and no policies — only the server (service role) can read it, and lib/orgSettings.ts's
-- getOrgChannelSettings merges it back in server-side.
--
-- A write sets a secret when the field is a non-empty string, removes it when the field is
-- JSON null, and leaves it untouched when the field is absent or an empty string — so a
-- browser that never had the secret can't wipe it just by saving other settings.
-- ---------------------------------------------------------------------------
create table if not exists org_channel_secrets (
  org_id uuid primary key references auth.users(id) on delete cascade,
  secrets jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table org_channel_secrets enable row level security;

create or replace function divert_org_channel_secrets()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  k text;
  incoming jsonb := '{}'::jsonb;
  removed text[] := '{}';
begin
  foreach k in array array['twilioAuthToken', 'whatsappCloudApiKey', 'whatsappAppSecret', 'emailApiKey', 'smtpPass', 'vapiApiKey'] loop
    if new.settings ? k then
      if jsonb_typeof(new.settings->k) = 'null' then
        removed := removed || k;
      elsif jsonb_typeof(new.settings->k) = 'string' and length(btrim(new.settings->>k)) > 0 then
        incoming := incoming || jsonb_build_object(k, btrim(new.settings->>k));
      end if;
      new.settings := new.settings - k;
    end if;
  end loop;
  -- Server-only fields merged in by getOrgChannelSettings — never stored in this row.
  new.settings := new.settings - array['savedSecrets', 'gmailRefreshToken', 'gmailAddress', 'outlookRefreshToken', 'outlookAddress', 'verifiedFromAddress'];

  if incoming <> '{}'::jsonb or coalesce(array_length(removed, 1), 0) > 0 then
    insert into org_channel_secrets (org_id, secrets) values (new.org_id, incoming)
    on conflict (org_id) do update
      set secrets = (org_channel_secrets.secrets - removed) || incoming, updated_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_divert_org_channel_secrets on org_channel_settings;
create trigger trg_divert_org_channel_secrets
  before insert or update on org_channel_settings
  for each row execute function divert_org_channel_secrets();

-- Which secrets are saved (never their values) — lets the dashboard show "saved" on a field.
create or replace function get_channel_secret_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select jsonb_object_agg(e.key, true) from org_channel_secrets s, jsonb_each(s.secrets) e where s.org_id = current_org_id()),
    '{}'::jsonb
  );
$$;
grant execute on function get_channel_secret_status() to authenticated;

-- ---------------------------------------------------------------------------
-- AI Voice Agent number + assistant per org. Each org gets its own number — there is no
-- shared one. On the platform's Vapi account the admin assigns it from the Admin dashboard;
-- an org on its own Vapi account gets a row once it enables inbound calls with its own key
-- (which proves it owns the number). Inbound calls are routed to an org by phone_number_id,
-- so it's unique. Written only by the server; orgs can read their own row.
-- ---------------------------------------------------------------------------
create table if not exists org_voice (
  org_id uuid primary key references auth.users(id) on delete cascade,
  assistant_id text,       -- auto-provisioned on the platform's Vapi account (lib/vapiClient.ts)
  phone_number_id text,    -- Vapi's id for the number
  phone_number text,       -- the number itself, E.164, for display
  inbound_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
create unique index if not exists idx_org_voice_phone_number_id
  on org_voice(phone_number_id) where phone_number_id is not null;
alter table org_voice enable row level security;
drop policy if exists "org can read own voice" on org_voice;
create policy "org can read own voice" on org_voice
  for select using ((select current_org_id()) = org_id);

-- Calls placed by the app are outbound; calls answered on an org's number are inbound.
alter table voice_calls add column if not exists direction text not null default 'outbound';

-- ---------------------------------------------------------------------------
-- "Connect Gmail" / "Connect Outlook" for sending email from an org's own mailbox — same
-- shared-platform-OAuth-app, per-org-refresh-token pattern as the calendar tables, kept
-- separate from them because sending mail needs a different scope and an org may use a
-- different account for each.
-- ---------------------------------------------------------------------------
create table if not exists org_email_oauth (
  org_id uuid primary key references auth.users(id) on delete cascade,
  provider text not null check (provider in ('gmail', 'outlook')),
  refresh_token text not null,
  connected_email text,
  updated_at timestamptz not null default now()
);
alter table org_email_oauth enable row level security;

create or replace function get_email_oauth_status()
returns table(connected boolean, provider text, connected_email text)
language sql
security definer
set search_path = public
as $$
  select true, o.provider, o.connected_email
  from org_email_oauth o
  where o.org_id = current_org_id();
$$;
grant execute on function get_email_oauth_status() to authenticated;

-- ---------------------------------------------------------------------------
-- An org's own sending domain on the platform's Resend account. Until it's verified, mail
-- sent through the platform account goes from RESEND_FROM_ADDRESS; once verified, from
-- from_address. Nobody can send as a domain they haven't verified — see lib/emailSender.ts.
-- ---------------------------------------------------------------------------
create table if not exists org_email_domain (
  org_id uuid primary key references auth.users(id) on delete cascade,
  domain text not null,
  resend_domain_id text not null,
  status text not null default 'not_started',  -- Resend's: not_started | pending | verified | failed | temporary_failure
  records jsonb not null default '[]'::jsonb,   -- DNS records the org has to add
  from_address text not null,
  updated_at timestamptz not null default now()
);
create unique index if not exists idx_org_email_domain_domain on org_email_domain(lower(domain));
alter table org_email_domain enable row level security;
drop policy if exists "org can read own email domain" on org_email_domain;
create policy "org can read own email domain" on org_email_domain
  for select using ((select current_org_id()) = org_id);

-- ---------------------------------------------------------------------------
-- One-time moves into the tables above (safe to re-run).
-- ---------------------------------------------------------------------------
-- Assistants auto-provisioned on the platform's Vapi account used to live in the browser-
-- editable settings blob; orgs on their own Vapi key keep theirs there.
insert into org_voice (org_id, assistant_id)
select s.org_id, s.settings->>'vapiAssistantId'
from org_channel_settings s
where coalesce(s.settings->>'vapiAssistantId', '') <> ''
  and coalesce(s.settings->>'vapiApiKey', '') = ''
  and not exists (select 1 from org_channel_secrets x where x.org_id = s.org_id and x.secrets ? 'vapiApiKey')
on conflict (org_id) do nothing;

-- Re-saving every row runs it through trg_divert_org_channel_secrets, moving existing secrets out.
update org_channel_settings set settings = settings;

-- ---------------------------------------------------------------------------
-- Follow-up on unanswered AI calls (lib/voiceFollowUp.ts): which try a call was, and what
-- happens next — another call at next_retry_at, or a WhatsApp/email message after the last.
-- followup_status: retry_scheduled | retrying | retried | following_up | fallback_whatsapp |
-- fallback_email | gave_up | stopped (null = nothing to follow up, e.g. answered or inbound).
-- ---------------------------------------------------------------------------
alter table voice_calls add column if not exists attempt int not null default 1;
alter table voice_calls add column if not exists next_retry_at timestamptz;
alter table voice_calls add column if not exists followup_status text;
alter table voice_calls add column if not exists followup_detail text;
create index if not exists idx_voice_calls_due_retries
  on voice_calls(next_retry_at) where followup_status = 'retry_scheduled';

-- Each lead's AI-call status (Pending | Sent | Failed), alongside whatsapp_status/email_status —
-- without it a refresh reloaded leads as never called.
alter table clients add column if not exists voice_call_status text;

-- ---------------------------------------------------------------------------
-- Server-side call queue (lib/callQueue.ts). Starting a voice campaign queues its leads
-- here instead of dialling them from the browser, so a campaign keeps running with the tab
-- closed, never runs more calls at once than the org chose (and the platform's Vapi plan
-- allows), goes in batches with a pause between, waits for each lead's business hours, and
-- never calls the same number twice at once. Missed-call retries (lib/voiceFollowUp.ts) go
-- through the same queue. Written only by the server; orgs can read their own rows.
-- ---------------------------------------------------------------------------
create table if not exists call_campaigns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references auth.users(id) on delete cascade,
  batch_size int not null default 50,
  concurrency int not null default 2,         -- calls at the same time
  batch_gap_minutes int not null default 30,  -- pause after a batch finishes
  status text not null default 'running',     -- running | paused | cancelled | done
  total int not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_call_campaigns_org on call_campaigns(org_id, created_at desc);
alter table call_campaigns enable row level security;
drop policy if exists "org can read own call campaigns" on call_campaigns;
create policy "org can read own call campaigns" on call_campaigns
  for select using ((select current_org_id()) = org_id);

create table if not exists call_queue (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references auth.users(id) on delete cascade,
  campaign_id uuid references call_campaigns(id) on delete cascade,  -- null for missed-call retries
  client_id text references clients(id) on delete set null,
  phone text not null,
  phone_digits text not null,
  lead_name text,
  lead_country text,
  batch_no int not null default 1,
  attempt int not null default 1,
  source text not null default 'campaign',   -- campaign | retry
  retry_of_call_id uuid references voice_calls(id) on delete set null,
  status text not null default 'queued',     -- queued | calling | done | failed | skipped | cancelled
  not_before timestamptz not null default now(),
  vapi_call_id text,
  detail text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_call_queue_pending on call_queue(org_id, status, batch_no, not_before);
create index if not exists idx_call_queue_campaign on call_queue(campaign_id, status);
create index if not exists idx_call_queue_vapi_call on call_queue(vapi_call_id) where vapi_call_id is not null;
-- One live entry per number per org: no double-dialling from duplicates or two campaigns.
create unique index if not exists uq_call_queue_live_phone
  on call_queue(org_id, phone_digits) where status in ('queued', 'calling');
alter table call_queue enable row level security;
drop policy if exists "org can read own call queue" on call_queue;
create policy "org can read own call queue" on call_queue
  for select using ((select current_org_id()) = org_id);

-- ---------------------------------------------------------------------------
-- Server-run WhatsApp/email campaigns (lib/messageQueue.ts). Starting a campaign queues one
-- campaign_recipients row per lead (status Queued, scheduled_for = when it may go out); the
-- server sends them at the campaign's pace, so it keeps going with the browser closed.
-- The campaign keeps what's needed to write each message at send time: the template, and
-- whether the AI personalises it (then the copy is written just before sending).
-- campaign_recipients statuses also use Skipped (opted out, no number…) and Cancelled.
-- ---------------------------------------------------------------------------
alter table campaigns add column if not exists template jsonb;
alter table campaigns add column if not exists use_ai boolean not null default false;
alter table campaigns add column if not exists send_gap_seconds int not null default 2;
alter table campaigns add column if not exists created_by uuid references auth.users(id) on delete set null;
create index if not exists idx_campaign_recipients_queued
  on campaign_recipients(org_id, scheduled_for)
  where whatsapp_status = 'Queued' or email_status = 'Queued';

-- ---------------------------------------------------------------------------
-- Do-not-contact list (lib/suppression.ts). Every opt-out — WhatsApp/email STOP, an
-- unsubscribe click, "don't call me" on a call — lands here by phone number or email
-- address, not just on the lead, so re-importing the same person never contacts them again.
-- Orgs can also add numbers/addresses themselves. Checked before every campaign message,
-- call, retry and follow-up.
-- ---------------------------------------------------------------------------
create table if not exists suppression_list (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('phone', 'email')),
  value text not null,            -- phone: digits only; email: lowercased
  reason text,                    -- e.g. replied STOP, unsubscribe link, asked on a call, added manually
  created_at timestamptz not null default now()
);
create unique index if not exists uq_suppression_list on suppression_list(org_id, kind, value);
alter table suppression_list enable row level security;
drop policy if exists "org can read own suppression list" on suppression_list;
create policy "org can read own suppression list" on suppression_list
  for select using ((select current_org_id()) = org_id);

-- Follow-up messages (lib/messageQueue.ts): a campaign can send one more message to leads who
-- haven't replied after N days. Step 2 rows are added once step 1 goes out.
alter table campaigns add column if not exists followup_days int;           -- null = no follow-up
alter table campaigns add column if not exists followup_template jsonb;
alter table campaign_recipients add column if not exists step int not null default 1;
alter table campaign_recipients add column if not exists first_sent_at timestamptz;

-- The lead agreed to be called (prior express written consent) — US law (TCPA) requires it
-- before AI-voice marketing calls to US numbers; lib/callQueue.ts skips US numbers without it.
alter table clients add column if not exists call_consent boolean not null default false;

-- ---------------------------------------------------------------------------
-- CRM integrations (lib/crm/*): HubSpot, Zoho CRM or Salesforce, one per org, connected with
-- OAuth from Channel Setup. OmniReach pushes leads it contacts, call summaries, booked
-- meetings and opt-outs into the CRM through an outbox (crm_events) the scheduled dispatcher
-- drains, and can import contacts/leads from the CRM. Server-only, except the status function.
-- ---------------------------------------------------------------------------
create table if not exists org_crm (
  org_id uuid primary key references auth.users(id) on delete cascade,
  provider text not null check (provider in ('hubspot', 'zoho', 'salesforce')),
  refresh_token text not null,
  access_token text,
  access_expires_at timestamptz,
  api_base text,                 -- Zoho: api_domain (per data centre); Salesforce: instance_url
  accounts_base text,            -- Zoho: the accounts server that issued the token (per data centre)
  connected_account text,        -- shown in the UI: portal / org / user
  last_sync_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);
alter table org_crm enable row level security;

create or replace function get_crm_status()
returns table(connected boolean, provider text, connected_account text, last_sync_at timestamptz, last_error text)
language sql
security definer
set search_path = public
as $$
  select true, o.provider, o.connected_account, o.last_sync_at, o.last_error
  from org_crm o
  where o.org_id = current_org_id();
$$;
grant execute on function get_crm_status() to authenticated;

-- Which CRM record each lead is, so updates go to the same record.
create table if not exists crm_links (
  org_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  provider text not null,
  crm_id text not null,
  primary key (org_id, client_id, provider)
);
alter table crm_links enable row level security;

create table if not exists crm_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references auth.users(id) on delete cascade,
  client_id text references clients(id) on delete cascade,
  kind text not null,              -- contact | note | meeting
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',   -- pending | done | failed
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_crm_events_pending on crm_events(created_at) where status = 'pending';
alter table crm_events enable row level security;

-- Per-campaign analytics groups campaigns by the template they used.
alter table campaigns add column if not exists template_name text;

-- ---------------------------------------------------------------------------
-- Usage and monthly limits per org (lib/usage.ts). Every outbound call, call minute,
-- WhatsApp message, email and AI generation is counted per calendar month (UTC). The
-- platform admin sets limits per org from the Admin page; null = no limit. Reaching a limit
-- holds new campaign sends and calls until the next month or a higher limit — replies to
-- leads already in a conversation, and incoming calls, still go out (and are counted).
-- ---------------------------------------------------------------------------
create table if not exists org_usage (
  org_id uuid not null references auth.users(id) on delete cascade,
  period text not null,            -- 'YYYY-MM' (UTC)
  metric text not null,            -- calls | call_minutes | whatsapp | emails | ai
  amount numeric not null default 0,
  updated_at timestamptz not null default now(),
  primary key (org_id, period, metric)
);
alter table org_usage enable row level security;
drop policy if exists "org can read own usage" on org_usage;
create policy "org can read own usage" on org_usage
  for select using ((select current_org_id()) = org_id);

create or replace function increment_org_usage(p_org_id uuid, p_period text, p_metric text, p_amount numeric)
returns numeric
language sql
security definer
set search_path = public
as $$
  insert into org_usage (org_id, period, metric, amount)
  values (p_org_id, p_period, p_metric, p_amount)
  on conflict (org_id, period, metric)
  do update set amount = org_usage.amount + excluded.amount, updated_at = now()
  returning amount;
$$;
-- Server only (service role): orgs must not be able to change their own counters.
revoke execute on function increment_org_usage(uuid, text, text, numeric) from public, anon, authenticated;

create table if not exists org_limits (
  org_id uuid primary key references auth.users(id) on delete cascade,
  calls int,
  call_minutes int,
  whatsapp int,
  emails int,
  ai int,
  -- Which alerts went out this month, so each is sent once: {"YYYY-MM": ["calls:80", ...]}
  alerts_sent jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table org_limits enable row level security;
drop policy if exists "org can read own limits" on org_limits;
create policy "org can read own limits" on org_limits
  for select using ((select current_org_id()) = org_id);

-- ---------------------------------------------------------------------------
-- Meeting reminders (lib/meetingReminders.ts): one row per reminder sent, so each goes out
-- once even when dispatcher runs overlap. meeting_at is part of the key, so a meeting that
-- moves gets fresh reminders for its new time.
-- ---------------------------------------------------------------------------
create table if not exists meeting_reminders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references auth.users(id) on delete cascade,
  source text not null,            -- whatsapp | email | voice (which conversation booked it)
  source_id uuid not null,         -- that conversation / call row
  kind text not null,              -- 24h | 1h
  meeting_at timestamptz not null,
  channel text,                    -- whatsapp | email | none (what the reminder went out on)
  detail text,
  created_at timestamptz not null default now()
);
create unique index if not exists uq_meeting_reminders on meeting_reminders(source, source_id, kind, meeting_at);
alter table meeting_reminders enable row level security;
drop policy if exists "org can read own meeting reminders" on meeting_reminders;
create policy "org can read own meeting reminders" on meeting_reminders
  for select using ((select current_org_id()) = org_id);
create index if not exists idx_whatsapp_conversations_meeting on whatsapp_conversations(meeting_datetime_iso) where status = 'confirmed';
create index if not exists idx_email_conversations_meeting on email_conversations(meeting_datetime_iso) where status = 'confirmed';
create index if not exists idx_voice_calls_meeting on voice_calls(meeting_datetime_iso) where status = 'confirmed';

-- Email bounces and auto-replies (lib/emailAutoDetect.ts): an undeliverable address is put on
-- the do-not-contact list and its lead marked email_status 'Bounced'; out-of-office and other
-- automatic replies are logged here instead of counting as a reply or getting an AI answer.
alter table email_conversations add column if not exists last_auto_reply_at timestamptz;
alter table email_conversations add column if not exists last_auto_reply text;
