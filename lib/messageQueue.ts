import { getSupabaseAdmin } from './supabaseAdmin.js';
import { getOrgChannelSettings, getOrgProfile, getOrgAccessStatus } from './orgSettings.js';
import { sendCampaignWhatsAppMessage } from './whatsappCampaignSender.js';
import { sendEmailViaOrgProvider } from './emailSender.js';
import { seedConversationFromLead } from './whatsappWebhookHandler.js';
import { seedEmailConversationFromLead, buildEmailReplyToAddress } from './emailWebhookHandler.js';
import { computeNextPeakSendTime } from './countryTiming.js';
import { generateOutreachCopy } from './outreachCopy.js';
import { getOrgUsage, recordUsage, limitReachedMessage } from './usage.js';
import { HARD_BOUNCE_ERROR, markEmailBounced } from './emailBounces.js';
import { contactBlocks, campaignGapHours } from './contactRules.js';
import { interpolateTemplate } from '../src/utils/outreachEngine.js';
import { loadSuppression, isSuppressed } from './suppression.js';
import { withComplianceFooter, unsubscribeHeaders } from './emailCompliance.js';
import { emitCrmEvent } from './crm/index.js';
import type { ChannelApiSettings, CampaignSettings, Lead } from '../src/types.js';

/**
 * Server-run WhatsApp and email campaigns. Starting a campaign queues one campaign_recipients
 * row per lead (enqueueMessageCampaign) with the time it may go out — pushed to later days
 * once the org's safe daily WhatsApp limit is used, and to the lead's local peak hours if the
 * org turned that on. processMessageQueue sends what's due at the campaign's pace, writing
 * AI-personalised copy just before each send, and re-checks each lead first (opted out or
 * already booked → skipped).
 *
 * It runs on the scheduled dispatcher (api/cron/dispatch-scheduled.ts) and, while the
 * Campaigns page is open, every few seconds from the page itself (?action=campaign-pump) —
 * so it's quick while someone's watching and keeps going when nobody is.
 *
 * Manual WhatsApp (click-to-chat in the user's own WhatsApp) can't be sent from a server, so
 * that mode still runs in the browser (src/components/BatchCampaignRunner.tsx).
 */

type Channel = 'whatsapp' | 'email';

export interface MessageTemplateInput {
  whatsAppContent?: string;
  emailSubject?: string;
  emailBody?: string;
}

export interface EnqueueMessagesInput {
  clientIds: string[];
  channels: Channel[];
  template: MessageTemplateInput;
  useAi: boolean;
  peakScheduling: boolean;
  sendGapSeconds: number;
  /** Send one follow-up email this many days later to leads who haven't replied (null = off). */
  followupDays?: number | null;
  followupTemplate?: MessageTemplateInput | null;
  /** For per-template analytics (lib/analytics.ts). */
  templateName?: string | null;
}

export interface EnqueueMessagesResult {
  ok: boolean;
  error?: string;
  campaignId?: string;
  queued: number;
  skipped: { name: string; reason: string }[];
  laterDays: number;
}

interface Payload {
  whatsappMessage?: string;
  templateParams?: string[];
  emailSubject?: string;
  emailBody?: string;
  senderName?: string;
  senderEmail?: string;
}

const LIVE = ['Queued', 'Sending'];

function digits(phone: string | null | undefined) {
  return (phone || '').replace(/\D/g, '');
}

function usableSenderEmail(profile: CampaignSettings | null, settings: ChannelApiSettings | null): string | undefined {
  const candidate = settings?.smtpFromEmail || profile?.senderEmail;
  return candidate && !candidate.includes('.example') ? candidate : undefined;
}

/** Whether this org's WhatsApp can be sent from the server (not manual click-to-chat). */
export function whatsappSendsFromServer(settings: ChannelApiSettings | null): boolean {
  if (settings?.whatsAppProvider === 'cloud_api') return !!(settings.whatsappCloudApiKey && settings.whatsappCloudPhoneId);
  if (settings?.whatsAppProvider === 'twilio') return !!(settings.twilioAccountSid && settings.twilioAuthToken);
  if (settings?.whatsAppProvider === 'webhook') return !!settings.n8nWebhookUrl;
  return false;
}

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? v[0] ?? null : v ?? null;
}

/** The org's settings with its follow-up WhatsApp template swapped in, or null when it has
 * none (then follow-ups go by email only). */
export function followupWhatsAppSettings(settings: ChannelApiSettings | null): ChannelApiSettings | null {
  if (!settings || !whatsappSendsFromServer(settings)) return null;
  if (settings.whatsAppProvider === 'cloud_api' && settings.whatsappFollowupTemplateName?.trim()) {
    return {
      ...settings,
      whatsappMessageMode: 'template',
      whatsappTemplateName: settings.whatsappFollowupTemplateName.trim(),
      whatsappTemplateLanguage: settings.whatsappFollowupTemplateLanguage?.trim() || settings.whatsappTemplateLanguage,
      whatsappTemplateVariables: settings.whatsappFollowupTemplateVariables || [],
    };
  }
  if (settings.whatsAppProvider === 'twilio' && settings.twilioFollowupContentSid?.trim()) {
    return {
      ...settings,
      whatsappMessageMode: 'template',
      twilioContentSid: settings.twilioFollowupContentSid.trim(),
      twilioContentVariables: settings.twilioFollowupContentVariables || [],
    };
  }
  return null;
}

function asLead(client: any): Lead {
  return { ...client, whatsAppStatus: client.whatsapp_status, emailStatus: client.email_status } as Lead;
}

function renderTemplate(template: MessageTemplateInput, client: any, profile: CampaignSettings | null) {
  const lead = asLead(client);
  const settings = (profile || {}) as CampaignSettings;
  return {
    whatsappMessage: interpolateTemplate(template.whatsAppContent || '', lead, settings),
    emailSubject: interpolateTemplate(template.emailSubject || '', lead, settings),
    emailBody: interpolateTemplate(template.emailBody || '', lead, settings),
  };
}

async function selectInChunks(table: string, columns: string, column: string, values: string[], orgId: string) {
  const supabase = getSupabaseAdmin()!;
  const rows: any[] = [];
  for (let i = 0; i < values.length; i += 300) {
    const { data } = await supabase.from(table).select(columns).eq('org_id', orgId).in(column, values.slice(i, i + 300));
    rows.push(...(data || []));
  }
  return rows;
}

export async function enqueueMessageCampaign(orgId: string, createdBy: string | null, input: EnqueueMessagesInput): Promise<EnqueueMessagesResult> {
  const supabase = getSupabaseAdmin();
  const fail = (error: string): EnqueueMessagesResult => ({ ok: false, error, queued: 0, skipped: [], laterDays: 0 });
  if (!supabase) return fail('Server database is not configured.');

  const channels = [...new Set(input.channels)].filter((c) => c === 'whatsapp' || c === 'email');
  if (channels.length === 0) return fail('Pick WhatsApp, email, or both.');
  const [settings, profile] = await Promise.all([getOrgChannelSettings(orgId), getOrgProfile(orgId)]);
  if (channels.includes('whatsapp') && !whatsappSendsFromServer(settings)) {
    return fail('WhatsApp is set to manual (your own WhatsApp app), which can only send from this browser. Connect the WhatsApp Business API in Channel Setup to send automatically.');
  }

  const clients = await selectInChunks('clients', '*', 'id', [...new Set(input.clientIds)], orgId);
  const byId = new Map(clients.map((c) => [c.id, c]));

  // Numbers and addresses already waiting to be messaged (in any of this org's campaigns)
  // aren't queued again — by number/address, not lead, since two leads can share one.
  const { data: live } = await supabase
    .from('campaign_recipients')
    .select('whatsapp_status, email_status, clients(phone, email)')
    .eq('org_id', orgId)
    .or('whatsapp_status.in.(Queued,Sending),email_status.in.(Queued,Sending)')
    .limit(20000);
  const seenPhones = new Set<string>();
  const seenEmails = new Set<string>();
  for (const r of live || []) {
    const c: any = one((r as any).clients);
    if (LIVE.includes(r.whatsapp_status) && digits(c?.phone)) seenPhones.add(digits(c?.phone));
    if (LIVE.includes(r.email_status) && c?.email) seenEmails.add(c.email.trim().toLowerCase());
  }

  // Safe daily WhatsApp limit: count what's gone out in the last 24h plus what's already
  // waiting, and push anything beyond the limit to the following days.
  const dailyLimit = Math.max(1, settings?.safeDailyWhatsAppLimit || 250);
  let waPosition = 0;
  if (channels.includes('whatsapp')) {
    const dayAgo = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const [{ count: sentToday }, { count: waiting }] = await Promise.all([
      supabase.from('campaign_recipients').select('id', { count: 'exact', head: true }).eq('org_id', orgId).in('whatsapp_status', ['Sent', 'Delivered', 'Read']).gte('updated_at', dayAgo),
      supabase.from('campaign_recipients').select('id', { count: 'exact', head: true }).eq('org_id', orgId).in('whatsapp_status', LIVE),
    ]);
    waPosition = (sentToday || 0) + (waiting || 0);
  }

  const suppression = await loadSuppression(orgId);
  // Recently contacted elsewhere, or mid-conversation with the AI (lib/contactRules.ts).
  const blocks = await contactBlocks(orgId, clients, campaignGapHours(settings));
  const skipped: { name: string; reason: string }[] = [];
  const senderEmail = usableSenderEmail(profile, settings);
  const rows: any[] = [];
  let laterDays = 0;
  const now = Date.now();

  for (const clientId of input.clientIds) {
    const client = byId.get(clientId);
    if (!client) continue;
    const name = client.name || 'Lead';
    if (client.opted_out) {
      skipped.push({ name, reason: 'opted out' });
      continue;
    }
    if (client.status === 'Meeting Scheduled') {
      skipped.push({ name, reason: 'meeting already booked' });
      continue;
    }
    if (blocks.has(client.id)) {
      skipped.push({ name, reason: blocks.get(client.id)! });
      continue;
    }

    let wa = channels.includes('whatsapp') ? 'Queued' : 'Pending';
    let email = channels.includes('email') ? 'Queued' : 'Pending';
    const reasons: string[] = [];
    if (wa === 'Queued') {
      const d = digits(client.phone);
      if (d.length < 7 || client.is_valid_phone === false) (wa = 'Skipped'), reasons.push('no valid phone number');
      else if (suppression.phones.has(d)) (wa = 'Skipped'), reasons.push('number is on the do-not-contact list');
      else if (seenPhones.has(d)) (wa = 'Skipped'), reasons.push('WhatsApp already queued for this number');
      else seenPhones.add(d);
    }
    if (email === 'Queued') {
      const e = (client.email || '').trim().toLowerCase();
      if (!e.includes('@') || client.is_valid_email === false) (email = 'Skipped'), reasons.push('no valid email');
      else if (suppression.emails.has(e)) (email = 'Skipped'), reasons.push('address is on the do-not-contact list');
      else if (seenEmails.has(e)) (email = 'Skipped'), reasons.push('email already queued for this address');
      else seenEmails.add(e);
    }
    if (wa !== 'Queued' && email !== 'Queued') {
      skipped.push({ name, reason: reasons.join(', ') || 'nothing to send' });
      continue;
    }

    let notBefore = new Date(now);
    if (wa === 'Queued') {
      const dayOffset = Math.floor(waPosition / dailyLimit);
      waPosition++;
      if (dayOffset > 0) {
        notBefore = new Date(now + dayOffset * 24 * 3_600_000);
        laterDays = Math.max(laterDays, dayOffset);
      }
    }
    const scheduledFor = input.peakScheduling ? computeNextPeakSendTime(client.country, notBefore) : notBefore;

    const templateParamDefs = settings?.whatsAppProvider === 'twilio' ? settings?.twilioContentVariables : settings?.whatsappTemplateVariables;
    const payload: Payload = {
      senderName: profile?.senderName,
      senderEmail,
      ...(settings?.whatsappMessageMode === 'template'
        ? { templateParams: (templateParamDefs || []).map((v) => interpolateTemplate(v, asLead(client), (profile || {}) as CampaignSettings)) }
        : {}),
      // Plain templates are filled in now; AI copy is written just before sending.
      ...(input.useAi ? {} : renderTemplate(input.template, client, profile)),
    };
    rows.push({ org_id: orgId, client_id: clientId, whatsapp_status: wa, email_status: email, scheduled_for: scheduledFor.toISOString(), payload });
  }

  if (rows.length === 0) return { ok: true, queued: 0, skipped, laterDays: 0 };

  const { data: campaign, error } = await supabase
    .from('campaigns')
    .insert({
      org_id: orgId,
      name: `Campaign — ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`,
      channels,
      status: 'running',
      template: input.template,
      template_name: input.templateName || null,
      use_ai: input.useAi,
      send_gap_seconds: Math.min(60, Math.max(1, Math.round(input.sendGapSeconds || 2))),
      ai_instructions: profile?.customInstructions || null,
      created_by: createdBy,
      followup_days: input.followupDays ? Math.min(30, Math.max(1, Math.round(input.followupDays))) : null,
      followup_template: input.followupDays ? input.followupTemplate || null : null,
    })
    .select('id')
    .single();
  if (error || !campaign) return fail(error?.message || 'Could not create the campaign.');

  for (let i = 0; i < rows.length; i += 500) {
    const { error: insertError } = await supabase.from('campaign_recipients').insert(rows.slice(i, i + 500).map((r) => ({ ...r, campaign_id: campaign.id })));
    if (insertError) {
      await supabase.from('campaigns').delete().eq('id', campaign.id);
      return fail(insertError.message);
    }
  }
  return { ok: true, campaignId: campaign.id, queued: rows.length, skipped, laterDays };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends due campaign messages until the time budget runs out (serverless functions are
 * time-limited), pausing each org's campaign `send_gap_seconds` between leads.
 */
export async function processMessageQueue(options: { budgetMs: number; onlyOrgId?: string }): Promise<{ sent: number; failed: number; skipped: number }> {
  const supabase = getSupabaseAdmin();
  const counts = { sent: 0, failed: 0, skipped: 0 };
  if (!supabase) return counts;
  const deadline = Date.now() + options.budgetMs;
  // Room to finish a send (AI copy + WhatsApp + email) before the time limit.
  const margin = Math.min(5000, Math.floor(options.budgetMs / 3));

  let query = supabase
    .from('campaign_recipients')
    .select(
      'id, org_id, campaign_id, client_id, whatsapp_status, email_status, payload, step, first_sent_at, campaigns(status, use_ai, template, send_gap_seconds, followup_days, followup_template), clients(*)'
    )
    .lte('scheduled_for', new Date().toISOString())
    .or('whatsapp_status.eq.Queued,email_status.eq.Queued')
    .order('scheduled_for')
    .limit(200);
  if (options.onlyOrgId) query = query.eq('org_id', options.onlyOrgId);
  const { data: due } = await query;

  const lastSentAt = new Map<string, number>();
  const orgCache = new Map<
    string,
    { settings: ChannelApiSettings | null; profile: CampaignSettings | null; locked: boolean; room: { whatsapp: number; emails: number } }
  >();
  const touchedCampaigns = new Set<string>();

  for (const row of due || []) {
    if (Date.now() > deadline - margin) break;
    const campaign: any = one((row as any).campaigns);
    const client: any = one((row as any).clients);
    const status = campaign?.status;
    if (status !== 'running' && status !== 'cancelled') continue; // paused, draft, completed: leave as is
    if (status === 'cancelled') {
      await setQueuedChannels(row, 'Cancelled', 'Campaign was cancelled.');
      continue;
    }
    if (!client || client.opted_out || client.status === 'Meeting Scheduled') {
      await setQueuedChannels(row, 'Skipped', !client ? 'Lead was deleted.' : client.opted_out ? 'Lead opted out.' : 'Meeting already booked.');
      counts.skipped++;
      continue;
    }

    // Someone may have opted out on another channel or been added to the do-not-contact list
    // since this was queued.
    const blocked = await isSuppressed(row.org_id, { phone: client.phone, email: client.email });
    if ((blocked.phone && row.whatsapp_status === 'Queued') || (blocked.email && row.email_status === 'Queued')) {
      const update: Record<string, string> = { error_detail: 'On the do-not-contact list.', updated_at: new Date().toISOString() };
      if (blocked.phone && row.whatsapp_status === 'Queued') (update.whatsapp_status = 'Skipped'), (row.whatsapp_status = 'Skipped');
      if (blocked.email && row.email_status === 'Queued') (update.email_status = 'Skipped'), (row.email_status = 'Skipped');
      await supabase.from('campaign_recipients').update(update).eq('id', row.id);
      counts.skipped++;
      if (row.whatsapp_status !== 'Queued' && row.email_status !== 'Queued') continue;
    }

    if (!orgCache.has(row.org_id)) {
      const [settings, profile, access, usage] = await Promise.all([
        getOrgChannelSettings(row.org_id),
        getOrgProfile(row.org_id),
        getOrgAccessStatus(row.org_id),
        getOrgUsage(row.org_id),
      ]);
      // What's left of this month's limits, counted down locally as this run sends.
      const left = (m: 'whatsapp' | 'emails') => (usage.limits[m] === null ? Infinity : Math.max(0, usage.limits[m]! - usage.used[m]));
      orgCache.set(row.org_id, { settings, profile, locked: access === 'locked', room: { whatsapp: left('whatsapp'), emails: left('emails') } });
    }
    const org = orgCache.get(row.org_id)!;
    if (org.locked) continue;

    // Monthly limit reached on a channel: that channel waits (checked again in an hour) while
    // the other one still goes out.
    const heldWhatsApp = row.whatsapp_status === 'Queued' && org.room.whatsapp <= 0;
    const heldEmail = row.email_status === 'Queued' && org.room.emails <= 0;
    // Kept as the row's note while the other channel's send result is written.
    const heldNote = heldWhatsApp || heldEmail ? limitReachedMessage(heldWhatsApp ? 'whatsapp' : 'emails') : null;
    if (heldWhatsApp || heldEmail) {
      await supabase
        .from('campaign_recipients')
        .update({
          scheduled_for: new Date(Date.now() + 3_600_000).toISOString(),
          error_detail: heldNote,
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id);
      if (heldWhatsApp) row.whatsapp_status = 'Held';
      if (heldEmail) row.email_status = 'Held';
      if (row.whatsapp_status !== 'Queued' && row.email_status !== 'Queued') {
        counts.skipped++;
        continue;
      }
    }

    // Pace each org's sends.
    const gapMs = Math.max(1, campaign.send_gap_seconds || 2) * 1000;
    const wait = (lastSentAt.get(row.org_id) || 0) + gapMs - Date.now();
    if (wait > 0) {
      if (Date.now() + wait > deadline - margin) break;
      await sleep(wait);
    }

    // A follow-up only goes to leads who haven't answered the first message on any channel.
    if ((row.step || 1) > 1 && (await leadRepliedSince(row.org_id, client, row.first_sent_at))) {
      await setQueuedChannels(row, 'Skipped', 'Lead replied — no follow-up needed.');
      counts.skipped++;
      continue;
    }

    let payload: Payload = row.payload || {};
    // Follow-ups on WhatsApp are approved templates, so only their email needs copy.
    const needsCopy =
      ((row.step || 1) === 1 && row.whatsapp_status === 'Queued' && !payload.whatsappMessage) || (row.email_status === 'Queued' && !payload.emailBody);
    if (needsCopy) {
      const template = ((row.step || 1) > 1 ? campaign.followup_template : null) || campaign.template || {};
      const copy = campaign.use_ai
        ? await generateOutreachCopy(row.org_id, client, { ...(org.profile || {}), customInstructions: org.profile?.customInstructions }, template)
        : { whatsApp: '', emailSubject: '', emailBody: '' };
      const rendered = renderTemplate(template, client, org.profile);
      payload = {
        ...payload,
        whatsappMessage: copy.whatsApp || rendered.whatsappMessage,
        emailSubject: copy.emailSubject || rendered.emailSubject,
        emailBody: copy.emailBody || rendered.emailBody,
      };
      // Saved so a later retry resends exactly this copy.
      await supabase.from('campaign_recipients').update({ payload }).eq('id', row.id);
    }

    const clientUpdate: Record<string, unknown> = {};
    let sentSomething = false;

    const waSettings = (row.step || 1) > 1 ? followupWhatsAppSettings(org.settings) : org.settings;
    if (row.whatsapp_status === 'Queued' && !waSettings) {
      await supabase.from('campaign_recipients').update({ whatsapp_status: 'Skipped', error_detail: 'No WhatsApp follow-up template is set.' }).eq('id', row.id);
      row.whatsapp_status = 'Skipped';
    }
    if (row.whatsapp_status === 'Queued' && (await claim(row.id, 'whatsapp_status'))) {
      const result = await sendCampaignWhatsAppMessage(waSettings, {
        toPhone: client.phone || '',
        messageText: payload.whatsappMessage || '',
        templateParams: payload.templateParams,
      });
      const messageId = (result.providerResponse as any)?.messageId;
      await supabase
        .from('campaign_recipients')
        .update({
          whatsapp_status: result.delivered ? 'Sent' : 'Failed',
          error_detail: result.errorDetail || heldNote,
          ...(result.delivered && messageId ? { whatsapp_message_id: messageId } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id);
      clientUpdate.whatsapp_status = result.delivered ? 'Sent' : 'Failed';
      clientUpdate.whatsapp_message = payload.whatsappMessage || null;
      if (result.delivered) {
        counts.sent++;
        sentSomething = true;
        org.room.whatsapp--;
        await recordUsage(row.org_id, 'whatsapp');
        if (result.provider === 'cloud_api') await seedConversationFromLead(row.org_id, client, row.id).catch(() => {});
      } else counts.failed++;
    }

    if (row.email_status === 'Queued' && (await claim(row.id, 'email_status'))) {
      const replyTo = buildEmailReplyToAddress(row.id) || undefined;
      const compliant = withComplianceFooter(row.org_id, client.email || '', payload.emailBody || '', org.profile);
      const result = await sendEmailViaOrgProvider(org.settings, {
        to: client.email || '',
        toName: client.name,
        subject: payload.emailSubject || 'Meeting Request',
        body: compliant.body,
        fromName: payload.senderName || org.profile?.senderName || 'OmniReach AI',
        fromAddress: payload.senderEmail,
        replyTo,
        headers: unsubscribeHeaders(compliant.unsubscribeUrl),
        orgId: row.org_id,
      });
      // Rejected as an address that doesn't exist: no retries, and never emailed again.
      const bounced = !result.ok && HARD_BOUNCE_ERROR.test(result.error || '');
      const emailStatus = result.ok ? 'Sent' : bounced ? 'Bounced' : 'Failed';
      await supabase
        .from('campaign_recipients')
        .update({ email_status: emailStatus, error_detail: result.error || heldNote, updated_at: new Date().toISOString() })
        .eq('id', row.id);
      clientUpdate.email_status = emailStatus;
      if (bounced) await markEmailBounced(row.org_id, client.email || '', result.error || 'invalid address');
      clientUpdate.email_subject = payload.emailSubject || null;
      clientUpdate.email_body = payload.emailBody || null;
      if (result.ok) {
        counts.sent++;
        sentSomething = true;
        org.room.emails--;
        await recordUsage(row.org_id, 'emails');
        if (replyTo) await seedEmailConversationFromLead(row.org_id, client, row.id, payload.emailSubject).catch(() => {});
      } else counts.failed++;
    }

    // Keep the lead itself current too, so the Leads page is right even with the browser closed.
    if (Object.keys(clientUpdate).length) {
      await supabase
        .from('clients')
        .update({
          ...clientUpdate,
          ...(sentSomething ? { last_contacted: new Date().toISOString(), ...(client.status === 'Pending' ? { status: 'Contacted' } : {}) } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq('id', client.id)
        .eq('org_id', row.org_id);
    }
    // Log it in the org's CRM, if one is connected (sent from the outbox, never blocking here).
    if (sentSomething) {
      const via = [clientUpdate.whatsapp_status === 'Sent' ? 'WhatsApp' : '', clientUpdate.email_status === 'Sent' ? 'email' : ''].filter(Boolean).join(' and ');
      const isFollowup = (row.step || 1) > 1;
      await emitCrmEvent(row.org_id, client.id, {
        kind: 'note',
        title: isFollowup ? 'OmniReach: follow-up sent' : 'OmniReach: outreach sent',
        text: [
          `${isFollowup ? 'Follow-up' : 'Outreach'} sent by ${via}.`,
          clientUpdate.email_status === 'Sent' && payload.emailSubject ? `Email subject: ${payload.emailSubject}` : '',
          clientUpdate.whatsapp_status === 'Sent' && payload.whatsappMessage ? `WhatsApp: ${payload.whatsappMessage}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        stage: 'contacted',
      });
    }

    // Queue the follow-up for leads this first message reached: by email when they have one,
    // and on WhatsApp too when it reached them there and the org has a follow-up template.
    // A row with a channel held by a monthly limit queues it on the pass that sends the rest.
    const waFollowSettings = clientUpdate.whatsapp_status === 'Sent' ? followupWhatsAppSettings(org.settings) : null;
    if (sentSomething && !heldWhatsApp && !heldEmail && (row.step || 1) === 1 && campaign.followup_days && (client.email || waFollowSettings)) {
      const followAt = new Date(Date.now() + campaign.followup_days * 24 * 3_600_000);
      const followTemplate = campaign.followup_template || campaign.template || {};
      await supabase.from('campaign_recipients').insert({
        org_id: row.org_id,
        campaign_id: row.campaign_id,
        client_id: row.client_id,
        step: 2,
        first_sent_at: new Date().toISOString(),
        whatsapp_status: waFollowSettings ? 'Queued' : 'Pending',
        email_status: client.email ? 'Queued' : 'Pending',
        scheduled_for: followAt.toISOString(),
        payload: {
          senderName: payload.senderName,
          senderEmail: payload.senderEmail,
          ...(waFollowSettings
            ? {
                templateParams: ((waFollowSettings.whatsAppProvider === 'twilio' ? waFollowSettings.twilioContentVariables : waFollowSettings.whatsappTemplateVariables) || []).map((v) =>
                  interpolateTemplate(v, asLead(client), (org.profile || {}) as CampaignSettings)
                ),
              }
            : {}),
          ...(campaign.use_ai
            ? {}
            : (({ emailSubject, emailBody }) => ({ emailSubject, emailBody }))(renderTemplate(followTemplate, client, org.profile))),
        },
      });
    }

    lastSentAt.set(row.org_id, Date.now());
    if (row.campaign_id) touchedCampaigns.add(row.campaign_id);
  }

  for (const id of touchedCampaigns) await completeCampaignIfDone(id);
  return counts;
}

/** Whether the lead wrote back (WhatsApp or email) or booked since `since`. */
async function leadRepliedSince(orgId: string, client: any, since: string | null): Promise<boolean> {
  if (client.status === 'Meeting Scheduled') return true;
  const supabase = getSupabaseAdmin()!;
  const sinceMs = since ? new Date(since).getTime() : 0;
  const repliedIn = (rows: any[] | null) =>
    (rows || []).some((c) => (c.history || []).some((h: any) => h.role === 'user' && new Date(h.timestamp).getTime() > sinceMs));
  const phone = digits(client.phone);
  const email = (client.email || '').trim().toLowerCase();
  const [{ data: wa }, { data: em }] = await Promise.all([
    phone ? supabase.from('whatsapp_conversations').select('history').eq('org_id', orgId).eq('phone', phone) : Promise.resolve({ data: [] }),
    email ? supabase.from('email_conversations').select('history').eq('org_id', orgId).eq('client_email', email) : Promise.resolve({ data: [] }),
  ]);
  return repliedIn(wa as any[]) || repliedIn(em as any[]);
}

async function claim(rowId: string, column: 'whatsapp_status' | 'email_status'): Promise<boolean> {
  const supabase = getSupabaseAdmin()!;
  const { data } = await supabase.from('campaign_recipients').update({ [column]: 'Sending' }).eq('id', rowId).eq(column, 'Queued').select('id');
  return !!data?.length;
}

async function setQueuedChannels(row: any, status: 'Cancelled' | 'Skipped', detail: string) {
  const supabase = getSupabaseAdmin()!;
  await supabase
    .from('campaign_recipients')
    .update({
      ...(row.whatsapp_status === 'Queued' ? { whatsapp_status: status } : {}),
      ...(row.email_status === 'Queued' ? { email_status: status } : {}),
      error_detail: detail,
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id);
}

async function completeCampaignIfDone(campaignId: string) {
  const supabase = getSupabaseAdmin()!;
  const { count } = await supabase
    .from('campaign_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .or('whatsapp_status.in.(Queued,Sending),email_status.in.(Queued,Sending)');
  if (!count) await supabase.from('campaigns').update({ status: 'completed', updated_at: new Date().toISOString() }).eq('id', campaignId).eq('status', 'running');
}

export async function setMessageCampaignStatus(orgId: string, action: 'pause' | 'resume' | 'cancel'): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  const now = new Date().toISOString();
  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id')
    .eq('org_id', orgId)
    .not('template', 'is', null)
    .in('status', action === 'resume' ? ['paused'] : ['running', 'paused']);
  const ids = (campaigns || []).map((c: any) => c.id);
  if (!ids.length) return;
  const next = action === 'pause' ? 'paused' : action === 'resume' ? 'running' : 'cancelled';
  await supabase.from('campaigns').update({ status: next, updated_at: now }).in('id', ids);
  if (action === 'cancel') {
    for (const column of ['whatsapp_status', 'email_status']) {
      await supabase.from('campaign_recipients').update({ [column]: 'Cancelled', updated_at: now }).in('campaign_id', ids).eq(column, 'Queued');
    }
  }
}

export interface MessageCampaignStatus {
  campaign: { id: string; status: string; channels: Channel[]; createdAt: string; followupDays: number | null } | null;
  /** First messages, by status. */
  whatsapp: Record<string, number>;
  email: Record<string, number>;
  /** First messages still to go out — the campaign is "in progress" for the page while > 0. */
  initialWaiting: number;
  nextScheduledAt: string | null;
  /** Follow-up emails, by status, and when the next one is due. */
  followups: Record<string, number>;
  nextFollowupAt: string | null;
  items: { clientId: string; whatsappStatus: string; emailStatus: string }[];
}

/** The latest server-run campaign's progress, for the Campaigns page. */
export async function getMessageCampaignStatus(orgId: string): Promise<MessageCampaignStatus> {
  const supabase = getSupabaseAdmin();
  const empty: MessageCampaignStatus = {
    campaign: null,
    whatsapp: {},
    email: {},
    initialWaiting: 0,
    nextScheduledAt: null,
    followups: {},
    nextFollowupAt: null,
    items: [],
  };
  if (!supabase) return empty;
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id, status, channels, created_at, followup_days')
    .eq('org_id', orgId)
    .not('template', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!campaign) return empty;

  const { data: rows } = await supabase
    .from('campaign_recipients')
    .select('client_id, whatsapp_status, email_status, scheduled_for, step')
    .eq('campaign_id', campaign.id)
    .limit(10000);
  const first = (rows || []).filter((r: any) => (r.step || 1) === 1);
  const follow = (rows || []).filter((r: any) => (r.step || 1) > 1);
  const tally = (list: any[], key: 'whatsapp_status' | 'email_status') =>
    list.reduce<Record<string, number>>((acc, r: any) => ((acc[r[key]] = (acc[r[key]] || 0) + 1), acc), {});
  const isWaiting = (r: any) => r.whatsapp_status === 'Queued' || r.whatsapp_status === 'Sending' || r.email_status === 'Queued' || r.email_status === 'Sending';
  const nextTime = (list: any[]) => {
    const times = list.filter((r: any) => isWaiting(r) && r.scheduled_for && new Date(r.scheduled_for).getTime() > Date.now()).map((r: any) => new Date(r.scheduled_for).getTime());
    return times.length ? new Date(Math.min(...times)).toISOString() : null;
  };

  return {
    campaign: {
      id: campaign.id,
      status: campaign.status,
      channels: campaign.channels || [],
      createdAt: campaign.created_at,
      followupDays: campaign.followup_days ?? null,
    },
    whatsapp: tally(first, 'whatsapp_status'),
    email: tally(first, 'email_status'),
    initialWaiting: first.filter(isWaiting).length,
    nextScheduledAt: nextTime(first),
    // One outcome per follow-up, whichever channel(s) it went on.
    followups: follow.reduce<Record<string, number>>((acc, r: any) => {
      const both = [r.whatsapp_status, r.email_status];
      const outcome = both.some((v) => ['Sent', 'Delivered', 'Read'].includes(v))
        ? 'Sent'
        : both.some((v) => v === 'Queued' || v === 'Sending')
          ? 'Queued'
          : both.includes('Failed')
            ? 'Failed'
            : 'Skipped';
      acc[outcome] = (acc[outcome] || 0) + 1;
      return acc;
    }, {}),
    nextFollowupAt: nextTime(follow),
    items: first.map((r: any) => ({ clientId: r.client_id, whatsappStatus: r.whatsapp_status, emailStatus: r.email_status })),
  };
}
