import { getSupabaseAdmin } from './supabaseAdmin.js';

/**
 * Per-campaign and per-template results for the Reports page. Nothing new is recorded for
 * this — it's all derived from what campaigns already store:
 *   - sent / delivered / read / failed: campaign_recipients statuses (first messages),
 *   - replied: the AI conversation started by that campaign message has a message from the
 *     lead (whatsapp_conversations / email_conversations .campaign_recipient_id),
 *   - booked: that conversation confirmed a meeting (or the recipient is marked booked),
 *   - opted out: the lead is opted out now,
 *   - calls: call_campaigns → call_queue → voice_calls outcomes.
 * Rates are out of leads actually reached (sent), not out of everyone queued.
 */

export interface MessageCampaignReport {
  id: string;
  name: string;
  createdAt: string;
  channels: string[];
  templateName: string | null;
  status: string;
  leads: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  replied: number;
  booked: number;
  optedOut: number;
  followupsSent: number;
  replyRate: number;
  bookingRate: number;
}

export interface CallCampaignReport {
  id: string;
  createdAt: string;
  status: string;
  leads: number;
  called: number;
  answered: number;
  booked: number;
  avgDurationSeconds: number;
  answerRate: number;
  bookingRate: number;
}

export interface TemplateReport {
  templateName: string;
  campaigns: number;
  sent: number;
  replied: number;
  booked: number;
  replyRate: number;
  bookingRate: number;
}

export interface AnalyticsReport {
  messageCampaigns: MessageCampaignReport[];
  callCampaigns: CallCampaignReport[];
  templates: TemplateReport[];
  totals: { sent: number; replied: number; booked: number; calls: number; answered: number; callBookings: number };
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
const SENT = ['Sent', 'Delivered', 'Read', 'Replied', 'Opened', 'Clicked'];

async function inChunks<T>(ids: string[], fetch: (chunk: string[]) => PromiseLike<{ data: T[] | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await fetch(ids.slice(i, i + 500));
    out.push(...(data || []));
  }
  return out;
}

export async function buildAnalytics(orgId: string, limit = 50): Promise<AnalyticsReport> {
  const supabase = getSupabaseAdmin();
  const empty: AnalyticsReport = { messageCampaigns: [], callCampaigns: [], templates: [], totals: { sent: 0, replied: 0, booked: 0, calls: 0, answered: 0, callBookings: 0 } };
  if (!supabase) return empty;

  // ---- WhatsApp / email campaigns ----
  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id, name, created_at, channels, template_name, status')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(limit);
  const campaignIds = (campaigns || []).map((c: any) => c.id);

  const recipients = await inChunks<any>(campaignIds, (chunk) =>
    supabase.from('campaign_recipients').select('id, campaign_id, client_id, whatsapp_status, email_status, meeting_booked, step').in('campaign_id', chunk)
  );
  const recipientIds = recipients.map((r) => r.id);
  const [waConvs, emailConvs] = await Promise.all([
    inChunks<any>(recipientIds, (chunk) => supabase.from('whatsapp_conversations').select('campaign_recipient_id, status, history').in('campaign_recipient_id', chunk)),
    inChunks<any>(recipientIds, (chunk) => supabase.from('email_conversations').select('campaign_recipient_id, status, history').in('campaign_recipient_id', chunk)),
  ]);
  const replied = new Set<string>();
  const booked = new Set<string>();
  for (const c of [...waConvs, ...emailConvs]) {
    if ((c.history || []).some((h: any) => h.role === 'user')) replied.add(c.campaign_recipient_id);
    if (c.status === 'confirmed') booked.add(c.campaign_recipient_id);
  }
  const clientIds = [...new Set(recipients.map((r) => r.client_id).filter(Boolean))];
  const optedOut = new Set(
    (await inChunks<any>(clientIds, (chunk) => supabase.from('clients').select('id').eq('org_id', orgId).eq('opted_out', true).in('id', chunk))).map((c) => c.id)
  );

  const messageCampaigns: MessageCampaignReport[] = (campaigns || []).map((c: any) => {
    const rows = recipients.filter((r) => r.campaign_id === c.id);
    const first = rows.filter((r) => (r.step || 1) === 1);
    const isSent = (r: any) => SENT.includes(r.whatsapp_status) || SENT.includes(r.email_status);
    const sent = first.filter(isSent);
    const leadIds = new Set(first.map((r) => r.client_id));
    // A reply or booking to the follow-up counts for the campaign too.
    const repliedLeads = new Set(rows.filter((r) => replied.has(r.id)).map((r) => r.client_id));
    const bookedLeads = new Set(rows.filter((r) => booked.has(r.id) || r.meeting_booked).map((r) => r.client_id));
    return {
      id: c.id,
      name: c.name,
      createdAt: c.created_at,
      channels: c.channels || [],
      templateName: c.template_name || null,
      status: c.status,
      leads: leadIds.size,
      sent: sent.length,
      delivered: first.filter((r) => ['Delivered', 'Read'].includes(r.whatsapp_status)).length,
      read: first.filter((r) => r.whatsapp_status === 'Read').length,
      failed: first.filter((r) => r.whatsapp_status === 'Failed' || r.email_status === 'Failed').length,
      replied: repliedLeads.size,
      booked: bookedLeads.size,
      optedOut: [...leadIds].filter((id) => optedOut.has(id)).length,
      followupsSent: rows.filter((r) => (r.step || 1) > 1 && isSent(r)).length,
      replyRate: pct(repliedLeads.size, sent.length),
      bookingRate: pct(bookedLeads.size, sent.length),
    };
  });

  // ---- Per template ----
  const byTemplate = new Map<string, TemplateReport>();
  for (const c of messageCampaigns) {
    const key = c.templateName || 'Older campaigns (template not recorded)';
    const t = byTemplate.get(key) || { templateName: key, campaigns: 0, sent: 0, replied: 0, booked: 0, replyRate: 0, bookingRate: 0 };
    t.campaigns++;
    t.sent += c.sent;
    t.replied += c.replied;
    t.booked += c.booked;
    byTemplate.set(key, t);
  }
  const templates = [...byTemplate.values()]
    .map((t) => ({ ...t, replyRate: pct(t.replied, t.sent), bookingRate: pct(t.booked, t.sent) }))
    .sort((a, b) => b.sent - a.sent);

  // ---- AI call campaigns ----
  const { data: callCampaigns } = await supabase
    .from('call_campaigns')
    .select('id, created_at, status, total')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(limit);
  const callIds = (callCampaigns || []).map((c: any) => c.id);
  const queue = await inChunks<any>(callIds, (chunk) => supabase.from('call_queue').select('campaign_id, status, vapi_call_id').in('campaign_id', chunk));
  const vapiIds = queue.map((q) => q.vapi_call_id).filter(Boolean);
  const calls = await inChunks<any>(vapiIds, (chunk) => supabase.from('voice_calls').select('vapi_call_id, outcome, status, duration_seconds').in('vapi_call_id', chunk));
  const callById = new Map(calls.map((c) => [c.vapi_call_id, c]));

  const callReports: CallCampaignReport[] = (callCampaigns || []).map((c: any) => {
    const items = queue.filter((q) => q.campaign_id === c.id);
    const placed = items.filter((q) => q.vapi_call_id).map((q) => callById.get(q.vapi_call_id)).filter(Boolean) as any[];
    const answered = placed.filter((v) => v.outcome === 'answered');
    const bookedCalls = placed.filter((v) => v.status === 'confirmed');
    const durations = answered.map((v) => v.duration_seconds || 0).filter((d) => d > 0);
    return {
      id: c.id,
      createdAt: c.created_at,
      status: c.status,
      leads: c.total,
      called: placed.length,
      answered: answered.length,
      booked: bookedCalls.length,
      avgDurationSeconds: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
      answerRate: pct(answered.length, placed.length),
      bookingRate: pct(bookedCalls.length, placed.length),
    };
  });

  return {
    messageCampaigns,
    callCampaigns: callReports,
    templates,
    totals: {
      sent: messageCampaigns.reduce((n, c) => n + c.sent, 0),
      replied: messageCampaigns.reduce((n, c) => n + c.replied, 0),
      booked: messageCampaigns.reduce((n, c) => n + c.booked, 0),
      calls: callReports.reduce((n, c) => n + c.called, 0),
      answered: callReports.reduce((n, c) => n + c.answered, 0),
      callBookings: callReports.reduce((n, c) => n + c.booked, 0),
    },
  };
}
