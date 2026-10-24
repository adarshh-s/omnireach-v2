import { getSupabaseAdmin } from './supabaseAdmin.js';
import { getOrgChannelSettings } from './orgSettings.js';
import { sendSlackNotification } from './slackNotifier.js';

/**
 * Usage per org per calendar month (UTC), and the monthly limits the platform admin sets per
 * org on the Admin page (supabase/schema.sql: org_usage, org_limits).
 *
 * Counted: outbound + inbound calls and their minutes, WhatsApp messages, emails and AI
 * generations — whoever's account they go through, so the numbers also show what an org
 * costs on platform resources.
 *
 * Enforced (usageRoom): new campaign messages (lib/messageQueue.ts), campaign and single
 * calls (lib/callQueue.ts, lib/voiceCalls.ts) and AI-written campaign copy. A reached limit
 * holds those until next month or a higher limit. Replies to leads already in a conversation,
 * meeting reminders and incoming calls are never blocked — cutting someone off mid-booking
 * costs more than it saves — but they are counted.
 */

export const USAGE_METRICS = ['calls', 'call_minutes', 'whatsapp', 'emails', 'ai'] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];
export type UsageLimits = Record<UsageMetric, number | null>;

export const USAGE_LABELS: Record<UsageMetric, string> = {
  calls: 'Outbound AI calls',
  call_minutes: 'Call minutes',
  whatsapp: 'WhatsApp messages',
  emails: 'Emails',
  ai: 'AI generations',
};

const PHRASES: Record<UsageMetric, string> = {
  calls: 'outbound AI calls',
  call_minutes: 'call minutes',
  whatsapp: 'WhatsApp messages',
  emails: 'emails',
  ai: 'AI generations',
};

export interface OrgUsage {
  period: string;
  used: Record<UsageMetric, number>;
  limits: UsageLimits;
}

const NO_LIMITS: UsageLimits = { calls: null, call_minutes: null, whatsapp: null, emails: null, ai: null };
const ALERT_AT = [80, 100];

export function currentPeriod(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

function cleanLimit(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export async function getOrgLimits(orgId: string): Promise<UsageLimits> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { ...NO_LIMITS };
  const { data } = await supabase.from('org_limits').select('*').eq('org_id', orgId).maybeSingle();
  const limits = { ...NO_LIMITS };
  for (const m of USAGE_METRICS) limits[m] = cleanLimit(data?.[m]);
  return limits;
}

export async function setOrgLimits(orgId: string, input: Partial<Record<UsageMetric, unknown>>): Promise<UsageLimits> {
  const supabase = getSupabaseAdmin();
  const limits = { ...NO_LIMITS };
  for (const m of USAGE_METRICS) limits[m] = cleanLimit(input[m]);
  if (supabase) await supabase.from('org_limits').upsert({ org_id: orgId, ...limits, updated_at: new Date().toISOString() }, { onConflict: 'org_id' });
  return limits;
}

export async function getOrgUsage(orgId: string, period = currentPeriod()): Promise<OrgUsage> {
  const supabase = getSupabaseAdmin();
  const used = Object.fromEntries(USAGE_METRICS.map((m) => [m, 0])) as Record<UsageMetric, number>;
  if (!supabase) return { period, used, limits: { ...NO_LIMITS } };
  const [{ data: rows }, limits] = await Promise.all([
    supabase.from('org_usage').select('metric, amount').eq('org_id', orgId).eq('period', period),
    getOrgLimits(orgId),
  ]);
  for (const r of rows || []) if ((USAGE_METRICS as readonly string[]).includes(r.metric)) used[r.metric as UsageMetric] = Number(r.amount) || 0;
  return { period, used, limits };
}

/** Every org's usage this month, for the Admin page. */
export async function adminUsageByOrg(period = currentPeriod()): Promise<Record<string, OrgUsage>> {
  const supabase = getSupabaseAdmin();
  const out: Record<string, OrgUsage> = {};
  if (!supabase) return out;
  const [{ data: rows }, { data: limitRows }] = await Promise.all([
    supabase.from('org_usage').select('org_id, metric, amount').eq('period', period),
    supabase.from('org_limits').select('*'),
  ]);
  const entry = (orgId: string) =>
    (out[orgId] ||= { period, used: Object.fromEntries(USAGE_METRICS.map((m) => [m, 0])) as Record<UsageMetric, number>, limits: { ...NO_LIMITS } });
  for (const r of rows || []) if ((USAGE_METRICS as readonly string[]).includes(r.metric)) entry(r.org_id).used[r.metric as UsageMetric] = Number(r.amount) || 0;
  for (const l of limitRows || []) for (const m of USAGE_METRICS) entry(l.org_id).limits[m] = cleanLimit(l[m]);
  return out;
}

/** How many more of this the org may use this month (Infinity when there's no limit). */
export async function usageRoom(orgId: string, metric: UsageMetric): Promise<number> {
  const { used, limits } = await getOrgUsage(orgId);
  const limit = limits[metric];
  return limit === null ? Infinity : Math.max(0, limit - used[metric]);
}

export function limitReachedMessage(metric: UsageMetric): string {
  return `This workspace has reached its monthly limit for ${PHRASES[metric]}. It resets on the 1st, or ask the platform admin to raise it.`;
}

/** Counts usage. Never throws — counting must not break a send that already happened. */
export async function recordUsage(orgId: string | null | undefined, metric: UsageMetric, amount = 1): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase || !orgId || !(amount > 0)) return;
  try {
    const period = currentPeriod();
    const { data, error } = await supabase.rpc('increment_org_usage', { p_org_id: orgId, p_period: period, p_metric: metric, p_amount: amount });
    if (error) return;
    const total = Number(Array.isArray(data) ? data[0] : data) || 0;
    await maybeAlert(orgId, metric, period, total - amount, total);
  } catch {
    // counting is best-effort
  }
}

/** One Slack message per threshold per month when usage crosses 80% / 100% of a limit. */
async function maybeAlert(orgId: string, metric: UsageMetric, period: string, before: number, after: number): Promise<void> {
  const supabase = getSupabaseAdmin()!;
  const { data: row } = await supabase.from('org_limits').select(`${metric}, alerts_sent`).eq('org_id', orgId).maybeSingle();
  const limit = cleanLimit((row as any)?.[metric]);
  if (!limit) return;
  const crossed = ALERT_AT.filter((p) => before < (limit * p) / 100 && after >= (limit * p) / 100);
  if (!crossed.length) return;
  const sent: Record<string, string[]> = (row as any)?.alerts_sent || {};
  const already = new Set(sent[period] || []);
  const fresh = crossed.filter((p) => !already.has(`${metric}:${p}`));
  if (!fresh.length) return;
  fresh.forEach((p) => already.add(`${metric}:${p}`));
  // Only this month's entry is kept.
  await supabase.from('org_limits').update({ alerts_sent: { [period]: [...already] } }).eq('org_id', orgId);

  const top = Math.max(...fresh);
  const settings = await getOrgChannelSettings(orgId);
  const label = USAGE_LABELS[metric];
  await sendSlackNotification(
    settings?.slackWebhookUrl,
    top >= 100
      ? `⛔ *Monthly limit reached* — ${label}: ${Math.round(after)} of ${limit}. New campaign sends and calls are on hold until the 1st or until the limit is raised.`
      : `⚠️ *${top}% of the monthly limit used* — ${label}: ${Math.round(after)} of ${limit}.`
  );
}
