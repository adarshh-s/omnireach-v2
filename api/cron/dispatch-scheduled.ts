import { getSupabaseAdmin } from '../../lib/supabaseAdmin.js';
import { safeEqual } from '../../lib/security.js';
import { getOrgChannelSettings } from '../../lib/orgSettings.js';
import { sendCampaignWhatsAppMessage } from '../../lib/whatsappCampaignSender.js';
import { sendEmailViaOrgProvider } from '../../lib/emailSender.js';
import { seedConversationFromLead } from '../../lib/whatsappWebhookHandler.js';
import { seedEmailConversationFromLead, buildEmailReplyToAddress } from '../../lib/emailWebhookHandler.js';
import { reviewAllOrgs } from '../../lib/aiLearning.js';
import { processCallQueue } from '../../lib/callQueue.js';
import { processMessageQueue } from '../../lib/messageQueue.js';
import { processCrmEvents } from '../../lib/crm/index.js';
import { getOrgProfile } from '../../lib/orgSettings.js';
import { withComplianceFooter, unsubscribeHeaders } from '../../lib/emailCompliance.js';
import { placeOrgVoiceCall, getPublicBaseUrl } from '../../lib/voiceCalls.js';
import { recordUsage, usageRoom } from '../../lib/usage.js';
import { processMeetingReminders } from '../../lib/meetingReminders.js';
import type { ChannelApiSettings } from '../../src/types.js';

interface ApiRequest {
  method?: string;
  query?: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
}

interface ApiResponse {
  status: (code: number) => ApiResponse;
  json: (data: unknown) => void;
}

const BATCH_SIZE = 25;
const RETRY_BACKOFF_MS = 10 * 60 * 1000; // wait 10 min after a failure before retrying
const MAX_RETRIES = 2;

/**
 * Accepts either Vercel's own automatic `Authorization: Bearer $CRON_SECRET` header
 * (added to every cron invocation when an env var literally named CRON_SECRET is set)
 * or a `?token=` query param — so a free external pinger (e.g. cron-job.org) can also
 * trigger this for real intra-day scheduling precision beyond Vercel Hobby's 1x/day cap.
 */
function verifyDispatchToken(req: ApiRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const authHeader = (req.headers?.authorization as string | undefined) || '';
  return safeEqual(authHeader, `Bearer ${expected}`) || safeEqual(req.query?.token, expected);
}

interface DuePayload {
  whatsappMessage?: string;
  templateParams?: string[];
  emailSubject?: string;
  emailBody?: string;
  senderName?: string;
  senderEmail?: string;
}

/**
 * Headless dispatcher for country-peak-time-scheduled campaign sends — picks up
 * campaign_recipients rows whose scheduled_for has arrived, using the pre-generated
 * message content (payload) written at campaign-launch time, since there's no browser/AI
 * context available here. Triggered by vercel.json's daily cron entry and/or an external
 * pinger hitting this URL every few minutes.
 */
export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (!verifyDispatchToken(req)) {
    return res.status(403).json({ error: 'Invalid dispatch token' });
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return res.status(200).json({ processed: 0, note: 'Supabase not configured' });
  }

  // ?only=voice runs just the AI call queue (campaign calls and missed-call retries) — for
  // testing it without also sending whatever campaign messages happen to be due.
  if (req.query?.only === 'voice') {
    const voiceCalls = await processCallQueue(getPublicBaseUrl(req.headers), placeOrgVoiceCall);
    return res.status(200).json({ only: 'voice', voiceCalls });
  }

  const backoffCutoffIso = new Date(Date.now() - RETRY_BACKOFF_MS).toISOString();

  // Due campaign messages: sent at each campaign's pace until the time budget runs out
  // (lib/messageQueue.ts) — scheduled sends and server-run campaigns alike.
  const messages = await processMessageQueue({ budgetMs: 25000 });

  // Failed sends, past their backoff window and under the retry cap — see the
  // Retry/backoff schema comment in supabase/schema.sql.
  const { data: retryable, error: retryError } = await supabase
    .from('campaign_recipients')
    .select('id, org_id, campaign_id, client_id, whatsapp_status, email_status, payload, retry_count, campaigns(status), clients(*)')
    .or('whatsapp_status.eq.Failed,email_status.eq.Failed')
    .lt('updated_at', backoffCutoffIso)
    .lt('retry_count', MAX_RETRIES)
    .limit(BATCH_SIZE);

  if (retryError) {
    return res.status(500).json({ error: retryError.message });
  }

  let sent = messages.sent;
  let failed = messages.failed;
  let skipped = messages.skipped;
  let retried = 0;
  const settingsCache = new Map<string, ChannelApiSettings | null>();

  for (const row of retryable || []) {
    const campaign: any = Array.isArray((row as any).campaigns) ? (row as any).campaigns[0] : (row as any).campaigns;
    const client: any = Array.isArray((row as any).clients) ? (row as any).clients[0] : (row as any).clients;
    // Never re-send to someone who opted out or already booked since the first attempt.
    if (!campaign || campaign.status !== 'running' || !client || client.opted_out || client.status === 'Meeting Scheduled') {
      skipped++;
      continue;
    }

    if (!settingsCache.has(row.org_id)) {
      settingsCache.set(row.org_id, await getOrgChannelSettings(row.org_id));
    }
    const channelSettings = settingsCache.get(row.org_id);
    const payload: DuePayload = row.payload || {};
    // Rows that failed before payload started being saved on every failure (not just
    // scheduled sends) have nothing to resend — skip rather than blast an empty message.
    const hasContent = Boolean(payload.whatsappMessage || payload.emailBody);
    if (!hasContent) {
      skipped++;
      continue;
    }

    // Over this month's limit (lib/usage.ts): leave it failed — it's retried once there's room.
    if (row.whatsapp_status === 'Failed' && (await usageRoom(row.org_id, 'whatsapp')) > 0) {
      const { data: claimed } = await supabase
        .from('campaign_recipients')
        .update({ whatsapp_status: 'Sending', retry_count: (row.retry_count || 0) + 1 })
        .eq('id', row.id)
        .eq('whatsapp_status', 'Failed')
        .select('id');

      if (claimed && claimed.length > 0) {
        const result = await sendCampaignWhatsAppMessage(channelSettings, {
          toPhone: client.phone || '',
          messageText: payload.whatsappMessage || '',
          templateParams: payload.templateParams,
        });
        await supabase
          .from('campaign_recipients')
          .update({
            whatsapp_status: result.delivered ? 'Sent' : 'Failed',
            error_detail: result.errorDetail || null,
            ...(result.delivered && (result.providerResponse as any)?.messageId
              ? { whatsapp_message_id: (result.providerResponse as any).messageId }
              : {}),
            updated_at: new Date().toISOString(),
          })
          .eq('id', row.id);

        retried++;
        if (result.delivered) {
          sent++;
          await recordUsage(row.org_id, 'whatsapp');
          if (result.provider === 'cloud_api') {
            seedConversationFromLead(row.org_id, client, row.id).catch(() => {});
          }
        } else {
          failed++;
        }
      }
    }

    if (row.email_status === 'Failed' && (await usageRoom(row.org_id, 'emails')) > 0) {
      const { data: claimed } = await supabase
        .from('campaign_recipients')
        .update({ email_status: 'Sending', retry_count: (row.retry_count || 0) + 1 })
        .eq('id', row.id)
        .eq('email_status', 'Failed')
        .select('id');

      if (claimed && claimed.length > 0) {
        const replyTo = buildEmailReplyToAddress(row.id) || undefined;
        const compliant = withComplianceFooter(row.org_id, client.email || '', payload.emailBody || '', await getOrgProfile(row.org_id));
        const result = await sendEmailViaOrgProvider(channelSettings, {
          to: client.email || '',
          toName: client.name,
          subject: payload.emailSubject || 'Meeting Request',
          body: compliant.body,
          headers: unsubscribeHeaders(compliant.unsubscribeUrl),
          fromName: payload.senderName || 'OmniReach AI',
          fromAddress: payload.senderEmail,
          replyTo,
          orgId: row.org_id,
        });
        await supabase
          .from('campaign_recipients')
          .update({
            email_status: result.ok ? 'Sent' : 'Failed',
            error_detail: result.error || null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', row.id);

        retried++;
        if (result.ok) {
          sent++;
          await recordUsage(row.org_id, 'emails');
          if (replyTo) {
            seedEmailConversationFromLead(row.org_id, client, row.id, payload.emailSubject).catch(() => {});
          }
        } else {
          failed++;
        }
      }
    }
  }

  // Reminders 24 hours and 1 hour before booked meetings (lib/meetingReminders.ts).
  const reminders = await processMeetingReminders({ budgetMs: 6000 });

  // Activity waiting to go to connected CRMs (lib/crm/index.ts).
  const crm = await processCrmEvents({ budgetMs: 8000 });

  // Queued AI calls — campaign batches and missed-call retries that are due (lib/callQueue.ts).
  const voiceCalls = await processCallQueue(getPublicBaseUrl(req.headers), placeOrgVoiceCall);

  // Once a day (Vercel's own cron fires at 06:00 UTC; an external pinger also lands in this
  // hour), sweep every org for finished conversations to learn from — mainly text threads
  // that went quiet, which no webhook ever signals. A no-op for orgs with nothing pending.
  const learning = new Date().getUTCHours() === 6 ? await reviewAllOrgs(25000) : undefined;

  return res.status(200).json({ processed: sent + failed + skipped + retried, sent, failed, skipped, retried, reminders, voiceCalls, crm, learning });
}
