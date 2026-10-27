import { getSupabaseAdmin } from './supabaseAdmin.js';
import { usageRoom } from './usage.js';
import { contactBlocks, campaignGapHours } from './contactRules.js';
import { getOrgChannelSettings, getOrgAccessStatus } from './orgSettings.js';
import { checkCallingHours } from './countryTiming.js';
import { loadSuppression, isSuppressed } from './suppression.js';
import { legalRegion } from './regionRules.js';

/**
 * Server-side dialler for AI voice campaigns. Starting a campaign queues its leads in
 * call_queue (enqueueCampaignCalls); processCallQueue then starts calls only while there's
 * room:
 *   - at most `concurrency` calls at once per org (the org's choice for that campaign), and
 *     at most VAPI_MAX_CONCURRENT_CALLS across the whole platform (one shared Vapi plan),
 *   - one batch at a time, with a pause of `batch_gap_minutes` after each batch finishes,
 *   - at most voiceDailyCallLimit calls per org in any 24 hours (protects the number from
 *     being flagged as spam),
 *   - only during the lead's local business hours (otherwise it waits),
 *   - never the same number twice at once (a unique index on live entries).
 *
 * It runs when a campaign starts, each time a call ends (the Vapi webhook frees a slot),
 * and on the scheduled dispatcher — so it keeps going with the browser closed, and things
 * that wait on the clock (business hours, batch gaps, retries) start once the dispatcher
 * runs again. Missed-call retries (lib/voiceFollowUp.ts) are queued here too, outside batches.
 */

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_DAILY_LIMIT = 150;
// A call with no end report after this long is treated as finished, so a lost webhook
// can't hold a slot forever.
const STALE_CALL_MINUTES = 20;

function platformMaxConcurrent(): number {
  const n = Number(process.env.VAPI_MAX_CONCURRENT_CALLS);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

export function phoneDigits(phone: string): string {
  return (phone || '').replace(/\D/g, '');
}

export interface CampaignOptions {
  batchSize: number;
  concurrency: number;
  batchGapMinutes: number;
}

export interface EnqueueLead {
  clientId: string;
  name?: string;
  phone?: string;
  country?: string;
}

export interface EnqueueResult {
  ok: boolean;
  error?: string;
  campaignId?: string;
  queued: number;
  skipped: { name: string; reason: string }[];
}

function clampOptions(o: Partial<CampaignOptions>): CampaignOptions {
  return {
    batchSize: Math.min(500, Math.max(1, Math.round(o.batchSize || 50))),
    concurrency: Math.min(10, Math.max(1, Math.round(o.concurrency || DEFAULT_CONCURRENCY))),
    batchGapMinutes: Math.min(24 * 60, Math.max(0, Math.round(o.batchGapMinutes ?? 30))),
  };
}

/** Queues a campaign's leads for calling, in batches. Skips (and reports) leads that can't
 * or shouldn't be called rather than failing them later. */
export async function enqueueCampaignCalls(
  orgId: string,
  createdBy: string | null,
  leads: EnqueueLead[],
  options: Partial<CampaignOptions>
): Promise<EnqueueResult> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { ok: false, error: 'Server database is not configured.', queued: 0, skipped: [] };
  const opts = clampOptions(options);
  const skipped: { name: string; reason: string }[] = [];

  // What the database knows now wins over the browser's copy (opt-outs, bookings, numbers).
  const ids = leads.map((l) => l.clientId).filter(Boolean);
  const { data: rows } = ids.length
    ? await supabase.from('clients').select('id, name, phone, country, opted_out, status, call_consent, last_contacted').eq('org_id', orgId).in('id', ids)
    : { data: [] as any[] };
  const byId = new Map((rows || []).map((r: any) => [r.id, r]));

  const suppression = await loadSuppression(orgId);
  const settings = await getOrgChannelSettings(orgId);
  const usConsentRequired = settings?.voiceUsConsentRequired !== false;
  // Recently contacted elsewhere, or mid-conversation with the AI (lib/contactRules.ts).
  const blocks = await contactBlocks(orgId, rows || [], campaignGapHours(settings));
  const { data: live } = await supabase.from('call_queue').select('phone_digits').eq('org_id', orgId).in('status', ['queued', 'calling']);
  const seen = new Set((live || []).map((r: any) => r.phone_digits));

  const toQueue: { client_id: string; phone: string; phone_digits: string; lead_name?: string; lead_country?: string }[] = [];
  for (const lead of leads) {
    const row: any = byId.get(lead.clientId);
    const name = row?.name || lead.name || 'Lead';
    const phone = row?.phone || lead.phone || '';
    const digits = phoneDigits(phone);
    if (row?.opted_out) skipped.push({ name, reason: 'opted out' });
    else if (row?.status === 'Meeting Scheduled') skipped.push({ name, reason: 'meeting already booked' });
    else if (digits.length < 7) skipped.push({ name, reason: 'no valid phone number' });
    else if (suppression.phones.has(digits)) skipped.push({ name, reason: 'on the do-not-contact list' });
    else if (usConsentRequired && !row?.call_consent && legalRegion(row?.country || lead.country, phone) === 'us')
      skipped.push({ name, reason: 'US number without recorded consent to calls' });
    else if (seen.has(digits)) skipped.push({ name, reason: 'already in the call queue (or a duplicate number)' });
    else if (blocks.has(lead.clientId)) skipped.push({ name, reason: blocks.get(lead.clientId)! });
    else {
      seen.add(digits);
      toQueue.push({ client_id: lead.clientId, phone, phone_digits: digits, lead_name: name, lead_country: row?.country || lead.country });
    }
  }
  if (toQueue.length === 0) return { ok: true, queued: 0, skipped };

  const { data: campaign, error: campaignError } = await supabase
    .from('call_campaigns')
    .insert({
      org_id: orgId,
      batch_size: opts.batchSize,
      concurrency: opts.concurrency,
      batch_gap_minutes: opts.batchGapMinutes,
      total: toQueue.length,
      created_by: createdBy,
    })
    .select('id')
    .single();
  if (campaignError || !campaign) return { ok: false, error: campaignError?.message || 'Could not create the campaign.', queued: 0, skipped };

  const { error } = await supabase.from('call_queue').insert(
    toQueue.map((q, i) => ({
      ...q,
      org_id: orgId,
      campaign_id: campaign.id,
      batch_no: Math.floor(i / opts.batchSize) + 1,
    }))
  );
  if (error) {
    await supabase.from('call_campaigns').delete().eq('id', campaign.id);
    return {
      ok: false,
      error: error.code === '23505' ? 'Some of these leads were queued by someone else just now — try again.' : error.message,
      queued: 0,
      skipped,
    };
  }
  return { ok: true, campaignId: campaign.id, queued: toQueue.length, skipped };
}

/** Queues one missed-call retry (lib/voiceFollowUp.ts). False if that number already has a
 * live queue entry — it's being called anyway. */
export async function enqueueRetryCall(params: {
  orgId: string;
  clientId: string | null;
  phone: string;
  name?: string | null;
  country?: string | null;
  attempt: number;
  notBefore: Date;
  retryOfCallId: string;
}): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return false;
  const { error } = await supabase.from('call_queue').insert({
    org_id: params.orgId,
    client_id: params.clientId,
    phone: params.phone,
    phone_digits: phoneDigits(params.phone),
    lead_name: params.name,
    lead_country: params.country,
    attempt: params.attempt,
    source: 'retry',
    batch_no: 0,
    retry_of_call_id: params.retryOfCallId,
    not_before: params.notBefore.toISOString(),
  });
  return !error;
}

/** Marks a call's queue entry finished — from the end-of-call webhook. Returns its org so
 * the caller can start the next call straight away. */
export async function markQueuedCallFinished(vapiCallId: string, outcome: string | null): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;
  const { data } = await supabase
    .from('call_queue')
    .update({
      status: 'done',
      detail: outcome,
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('vapi_call_id', vapiCallId)
    .eq('status', 'calling')
    .select('org_id, campaign_id');
  const row = data?.[0];
  if (row?.campaign_id) await finishCampaignIfEmpty(row.campaign_id);
  return row?.org_id || null;
}

async function finishCampaignIfEmpty(campaignId: string) {
  const supabase = getSupabaseAdmin()!;
  const { count } = await supabase
    .from('call_queue')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .in('status', ['queued', 'calling']);
  if (!count) {
    await supabase
      .from('call_campaigns')
      .update({ status: 'done', updated_at: new Date().toISOString() })
      .eq('id', campaignId)
      .eq('status', 'running');
  }
}

export type PlaceCall = (params: {
  orgId: string;
  phone: string;
  name?: string;
  clientId?: string;
  country?: string;
  baseUrl: string | null;
  attempt: number;
}) => Promise<{ httpStatus: number; body: Record<string, unknown> }>;

/** Errors that mean no call can be placed for this org right now — stop the queue rather
 * than failing every remaining lead one by one. */
const ORG_BLOCKING_ERROR = /no phone number is assigned|not set up|not configured|Add your Vapi/i;

/**
 * Starts whatever calls there's room for. `onlyOrgId` limits it to one org (after that org's
 * call ended); otherwise every org with due calls.
 */
export async function processCallQueue(
  baseUrl: string | null,
  placeCall: PlaceCall,
  onlyOrgId?: string
): Promise<{ started: number; waiting: number; failed: number }> {
  const supabase = getSupabaseAdmin();
  const counts = { started: 0, waiting: 0, failed: 0 };
  if (!supabase) return counts;
  const now = new Date();

  // Calls whose end report never came — free their slot.
  const staleCutoff = new Date(now.getTime() - STALE_CALL_MINUTES * 60_000).toISOString();
  await supabase
    .from('call_queue')
    .update({ status: 'done', detail: 'no end-of-call report', finished_at: now.toISOString(), updated_at: now.toISOString() })
    .eq('status', 'calling')
    .lt('started_at', staleCutoff);

  let dueQuery = supabase.from('call_queue').select('org_id').eq('status', 'queued').lte('not_before', now.toISOString()).limit(1000);
  if (onlyOrgId) dueQuery = dueQuery.eq('org_id', onlyOrgId);
  const { data: dueOrgs } = await dueQuery;
  const orgIds = [...new Set((dueOrgs || []).map((r: any) => r.org_id as string))];
  if (orgIds.length === 0) return counts;

  const { count: platformActive } = await supabase.from('call_queue').select('id', { count: 'exact', head: true }).eq('status', 'calling');
  let platformRoom = platformMaxConcurrent() - (platformActive || 0);

  for (const orgId of orgIds) {
    if (platformRoom <= 0) break;
    if ((await getOrgAccessStatus(orgId)) === 'locked') continue;

    const settings = await getOrgChannelSettings(orgId);
    const dailyLimit = Math.max(1, settings?.voiceDailyCallLimit || DEFAULT_DAILY_LIMIT);
    const dayAgo = new Date(now.getTime() - 24 * 3_600_000).toISOString();
    const [{ count: active }, { count: placedToday }, { data: campaigns }] = await Promise.all([
      supabase.from('call_queue').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('status', 'calling'),
      supabase
        .from('voice_calls')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .eq('direction', 'outbound')
        .gte('created_at', dayAgo),
      supabase.from('call_campaigns').select('id, concurrency, batch_gap_minutes, status').eq('org_id', orgId).in('status', ['running', 'paused']),
    ]);
    const runningCampaigns = (campaigns || []).filter((c: any) => c.status === 'running');
    const pausedIds = new Set((campaigns || []).filter((c: any) => c.status === 'paused').map((c: any) => c.id));
    // The org's limit is the most any of its running campaigns allows (the default when only
    // missed-call retries are waiting).
    const concurrency = runningCampaigns.length ? Math.max(...runningCampaigns.map((c: any) => c.concurrency)) : DEFAULT_CONCURRENCY;
    // Monthly limits (lib/usage.ts): queued calls wait until the limit is raised or the month turns.
    const [callsLeft, minutesLeft] = await Promise.all([usageRoom(orgId, 'calls'), usageRoom(orgId, 'call_minutes')]);
    let room = Math.min(concurrency - (active || 0), platformRoom, dailyLimit - (placedToday || 0), minutesLeft > 0 ? callsLeft : 0);
    if (room <= 0) continue;

    // Which batch each running campaign is on, and whether its pause between batches is over.
    const allowedBatch = new Map<string, number>();
    for (const c of runningCampaigns as any[]) {
      const { data: live } = await supabase
        .from('call_queue')
        .select('batch_no, status')
        .eq('campaign_id', c.id)
        .in('status', ['queued', 'calling'])
        .order('batch_no')
        .limit(1);
      const batch = live?.[0]?.batch_no;
      if (!batch) continue;
      const batchStarted = live![0].status === 'calling' || (await batchHasStarted(c.id, batch));
      if (batch > 1 && !batchStarted) {
        const { data: prev } = await supabase
          .from('call_queue')
          .select('finished_at')
          .eq('campaign_id', c.id)
          .eq('batch_no', batch - 1)
          .order('finished_at', { ascending: false, nullsFirst: false })
          .limit(1);
        const prevDone = prev?.[0]?.finished_at ? new Date(prev[0].finished_at).getTime() : 0;
        if (now.getTime() < prevDone + c.batch_gap_minutes * 60_000) continue;
      }
      allowedBatch.set(c.id, batch);
    }

    const { data: candidates } = await supabase
      .from('call_queue')
      .select('*')
      .eq('org_id', orgId)
      .eq('status', 'queued')
      .lte('not_before', now.toISOString())
      .order('batch_no')
      .order('created_at')
      .limit(200);

    for (const item of candidates || []) {
      if (room <= 0 || platformRoom <= 0) break;
      if (item.campaign_id) {
        if (pausedIds.has(item.campaign_id)) continue;
        if (allowedBatch.get(item.campaign_id) !== item.batch_no) continue;
      }

      // Outside the lead's business hours (or a public holiday there): look again in an hour.
      const hours = checkCallingHours(item.lead_country, now, { phone: item.phone, skipHolidays: settings?.voiceSkipHolidays !== false });
      if (!hours.allowed) {
        await supabase
          .from('call_queue')
          .update({
            not_before: new Date(now.getTime() + 3_600_000).toISOString(),
            detail: hours.holiday ? `waiting — ${hours.holiday} (public holiday)` : 'waiting for business hours',
            updated_at: now.toISOString(),
          })
          .eq('id', item.id);
        counts.waiting++;
        continue;
      }

      // Claim it, so overlapping runs never start the same call twice.
      const { data: claimed } = await supabase
        .from('call_queue')
        .update({ status: 'calling', started_at: now.toISOString(), detail: null, updated_at: now.toISOString() })
        .eq('id', item.id)
        .eq('status', 'queued')
        .select('id');
      if (!claimed?.length) continue;

      // Re-check the lead right before dialling — they may have booked or opted out meanwhile.
      if (item.client_id) {
        const { data: client } = await supabase.from('clients').select('opted_out, status').eq('id', item.client_id).maybeSingle();
        const reason = client?.opted_out ? 'opted out' : client?.status === 'Meeting Scheduled' ? 'meeting already booked' : null;
        const blocked = !reason && (await isSuppressed(orgId, { phone: item.phone })).phone;
        if (reason || blocked) {
          const why = reason || 'on the do-not-contact list';
          await supabase.from('call_queue').update({ status: 'skipped', detail: why, finished_at: now.toISOString() }).eq('id', item.id);
          if (item.retry_of_call_id) await markRetryOutcome(item.retry_of_call_id, 'stopped', why);
          continue;
        }
      } else if ((await isSuppressed(orgId, { phone: item.phone })).phone) {
        await supabase.from('call_queue').update({ status: 'skipped', detail: 'on the do-not-contact list', finished_at: now.toISOString() }).eq('id', item.id);
        if (item.retry_of_call_id) await markRetryOutcome(item.retry_of_call_id, 'stopped', 'on the do-not-contact list');
        continue;
      }

      const result = await placeCall({
        orgId,
        phone: item.phone,
        name: item.lead_name || undefined,
        clientId: item.client_id || undefined,
        country: item.lead_country || undefined,
        baseUrl,
        attempt: item.attempt,
      });
      const callId = result.body?.callId as string | undefined;
      if (result.httpStatus === 200 && callId) {
        await supabase.from('call_queue').update({ vapi_call_id: callId, updated_at: new Date().toISOString() }).eq('id', item.id);
        if (item.retry_of_call_id) await markRetryOutcome(item.retry_of_call_id, 'retried', null);
        counts.started++;
        room--;
        platformRoom--;
      } else {
        const error = String(result.body?.error || 'Could not start the call.');
        await supabase
          .from('call_queue')
          .update({ status: 'failed', detail: error, finished_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('id', item.id);
        if (item.retry_of_call_id) await markRetryOutcome(item.retry_of_call_id, 'stopped', error);
        counts.failed++;
        if (ORG_BLOCKING_ERROR.test(error)) {
          await setOrgQueueStatus(orgId, 'cancel', error);
          break;
        }
      }
      if (item.campaign_id) await finishCampaignIfEmpty(item.campaign_id);
    }
  }
  return counts;
}

async function batchHasStarted(campaignId: string, batch: number): Promise<boolean> {
  const supabase = getSupabaseAdmin()!;
  const { count } = await supabase
    .from('call_queue')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .eq('batch_no', batch)
    .not('started_at', 'is', null);
  return (count || 0) > 0;
}

async function markRetryOutcome(voiceCallRowId: string, status: 'retried' | 'stopped', detail: string | null) {
  const supabase = getSupabaseAdmin()!;
  await supabase
    .from('voice_calls')
    .update({ followup_status: status, followup_detail: detail, updated_at: new Date().toISOString() })
    .eq('id', voiceCallRowId);
}

/** Pause, resume or cancel an org's queued calls. Calls already in progress finish normally. */
export async function setOrgQueueStatus(orgId: string, action: 'pause' | 'resume' | 'cancel', detail?: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  const now = new Date().toISOString();
  if (action === 'cancel') {
    await supabase
      .from('call_queue')
      .update({ status: 'cancelled', detail: detail || 'cancelled', finished_at: now, updated_at: now })
      .eq('org_id', orgId)
      .eq('status', 'queued');
    await supabase.from('call_campaigns').update({ status: 'cancelled', updated_at: now }).eq('org_id', orgId).in('status', ['running', 'paused']);
    return;
  }
  await supabase
    .from('call_campaigns')
    .update({ status: action === 'pause' ? 'paused' : 'running', updated_at: now })
    .eq('org_id', orgId)
    .eq('status', action === 'pause' ? 'running' : 'paused');
}

export interface QueueStatus {
  campaign: { id: string; status: string; total: number; batchSize: number; concurrency: number; batchGapMinutes: number; createdAt: string } | null;
  counts: Record<string, number>;
  callingNow: number;
  currentBatch: number | null;
  totalBatches: number;
  nextStartAt: string | null;
  waitingForHours: number;
  items: { clientId: string | null; status: string; detail: string | null }[];
}

/** The latest campaign's progress, for the Campaigns page. */
export async function getQueueStatus(orgId: string): Promise<QueueStatus> {
  const supabase = getSupabaseAdmin();
  const empty: QueueStatus = { campaign: null, counts: {}, callingNow: 0, currentBatch: null, totalBatches: 0, nextStartAt: null, waitingForHours: 0, items: [] };
  if (!supabase) return empty;
  const { data: campaign } = await supabase
    .from('call_campaigns')
    .select('*')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!campaign) return empty;

  const { data: items } = await supabase
    .from('call_queue')
    .select('client_id, status, detail, batch_no, not_before, started_at, finished_at')
    .eq('campaign_id', campaign.id)
    .limit(5000);
  const counts: Record<string, number> = {};
  for (const i of items || []) counts[i.status] = (counts[i.status] || 0) + 1;
  const live = (items || []).filter((i: any) => i.status === 'queued' || i.status === 'calling');
  const currentBatch = live.length ? Math.min(...live.map((i: any) => i.batch_no)) : null;
  const totalBatches = Math.max(0, ...(items || []).map((i: any) => i.batch_no));

  // When the next call can start, if nothing is calling: the end of the batch pause, or the
  // earliest business-hours wait.
  let nextStartAt: string | null = null;
  const queued = live.filter((i: any) => i.status === 'queued');
  if (campaign.status === 'running' && queued.length && !live.some((i: any) => i.status === 'calling')) {
    const batchQueued = queued.filter((i: any) => i.batch_no === currentBatch);
    const prevFinished = (items || [])
      .filter((i: any) => i.batch_no === (currentBatch || 0) - 1 && i.finished_at)
      .map((i: any) => new Date(i.finished_at).getTime());
    const batchStarted = (items || []).some((i: any) => i.batch_no === currentBatch && i.started_at);
    const gapEnd = !batchStarted && prevFinished.length ? Math.max(...prevFinished) + campaign.batch_gap_minutes * 60_000 : 0;
    const earliest = Math.min(...batchQueued.map((i: any) => new Date(i.not_before).getTime()));
    const t = Math.max(gapEnd, earliest);
    if (t > Date.now()) nextStartAt = new Date(t).toISOString();
  }

  return {
    campaign: {
      id: campaign.id,
      status: campaign.status,
      total: campaign.total,
      batchSize: campaign.batch_size,
      concurrency: campaign.concurrency,
      batchGapMinutes: campaign.batch_gap_minutes,
      createdAt: campaign.created_at,
    },
    counts,
    callingNow: counts.calling || 0,
    currentBatch,
    totalBatches,
    nextStartAt,
    waitingForHours: queued.filter((i: any) => i.detail === 'waiting for business hours').length,
    items: (items || []).map((i: any) => ({ clientId: i.client_id, status: i.status, detail: i.detail })),
  };
}
