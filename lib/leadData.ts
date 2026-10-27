import { getSupabaseAdmin } from './supabaseAdmin.js';
import { addToSuppression, emailKey, phoneKey } from './suppression.js';
import { logAudit, AuditActor } from './auditLog.js';

/**
 * A person's data-protection requests (GDPR in the EU/UK, DPDP in India, CCPA in California):
 *   - export: everything OmniReach holds on one lead, as JSON (right of access / portability),
 *   - erase: delete it all (right to erasure).
 * Erasing keeps one thing unless told otherwise: the number and address on the
 * do-not-contact list, so the person is never contacted again after re-import — which the
 * same laws allow, and which most people asking for erasure want. Copies held by other
 * services (the voice provider's call recordings, a connected CRM, sent emails in a mailbox)
 * are outside OmniReach and are listed in the response so the org can handle them.
 */

function digits(v: string | null | undefined) {
  return phoneKey(v);
}

async function gather(orgId: string, clientId: string) {
  const supabase = getSupabaseAdmin()!;
  const { data: client } = await supabase.from('clients').select('*').eq('id', clientId).eq('org_id', orgId).maybeSingle();
  if (!client) return null;
  const phone = digits(client.phone);
  const email = emailKey(client.email);
  const phones = phone ? [phone, `+${phone}`] : [];

  const [wa, waByPhone, em, emByEmail, calls, recipients, queue, crm, dnc] = await Promise.all([
    supabase.from('whatsapp_conversations').select('*').eq('org_id', orgId).eq('client_id', clientId),
    phones.length ? supabase.from('whatsapp_conversations').select('*').eq('org_id', orgId).in('phone', phones) : Promise.resolve({ data: [] }),
    supabase.from('email_conversations').select('*').eq('org_id', orgId).eq('client_id', clientId),
    email ? supabase.from('email_conversations').select('*').eq('org_id', orgId).eq('client_email', email) : Promise.resolve({ data: [] }),
    supabase.from('voice_calls').select('*').eq('org_id', orgId).eq('client_id', clientId),
    supabase.from('campaign_recipients').select('*').eq('org_id', orgId).eq('client_id', clientId),
    supabase.from('call_queue').select('*').eq('org_id', orgId).eq('client_id', clientId),
    supabase.from('crm_links').select('*').eq('org_id', orgId).eq('client_id', clientId),
    supabase.from('suppression_list').select('kind, value, reason, created_at').eq('org_id', orgId).in('value', [phone, email].filter(Boolean)),
  ]);
  const unique = (rows: any[]) => [...new Map(rows.map((r) => [r.id, r])).values()];
  return {
    client,
    whatsapp: unique([...(wa.data || []), ...((waByPhone as any).data || [])]),
    email: unique([...(em.data || []), ...((emByEmail as any).data || [])]),
    calls: calls.data || [],
    campaignMessages: recipients.data || [],
    callQueue: queue.data || [],
    crmLinks: crm.data || [],
    doNotContact: dnc.data || [],
  };
}

const ELSEWHERE = [
  'Call recordings and transcripts kept by the voice provider (Vapi) — delete them in its dashboard if recording is on.',
  'The lead record and notes in your connected CRM, if any.',
  'Emails and messages already delivered to inboxes and phones, and copies in your own mailbox.',
];

export async function exportLeadData(orgId: string, actor: AuditActor, clientId: string) {
  if (!getSupabaseAdmin()) return { ok: false, error: 'Server database is not configured.' };
  const data = await gather(orgId, clientId);
  if (!data) return { ok: false, error: 'Lead not found.' };
  await logAudit(orgId, actor, 'lead.exported', data.client.name || clientId);
  return { ok: true, exportedAt: new Date().toISOString(), data, heldElsewhere: ELSEWHERE };
}

export async function eraseLeadData(orgId: string, actor: AuditActor, clientId: string, keepOnDoNotContact = true) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { ok: false, error: 'Server database is not configured.' };
  const data = await gather(orgId, clientId);
  if (!data) return { ok: false, error: 'Lead not found.' };

  const ids = (rows: any[]) => rows.map((r) => r.id);
  const sourceIds = [...ids(data.whatsapp), ...ids(data.email), ...ids(data.calls)];
  if (sourceIds.length) await supabase.from('meeting_reminders').delete().eq('org_id', orgId).in('source_id', sourceIds);
  if (data.whatsapp.length) await supabase.from('whatsapp_conversations').delete().eq('org_id', orgId).in('id', ids(data.whatsapp));
  if (data.email.length) await supabase.from('email_conversations').delete().eq('org_id', orgId).in('id', ids(data.email));
  if (data.calls.length) await supabase.from('voice_calls').delete().eq('org_id', orgId).in('id', ids(data.calls));
  await supabase.from('call_queue').delete().eq('org_id', orgId).eq('client_id', clientId);
  await supabase.from('crm_events').delete().eq('org_id', orgId).eq('client_id', clientId);
  // campaign_recipients and crm_links go with the client (on delete cascade).
  await supabase.from('clients').delete().eq('id', clientId).eq('org_id', orgId);

  if (keepOnDoNotContact) {
    await addToSuppression(orgId, { phone: data.client.phone, email: data.client.email }, 'asked for their data to be erased');
  } else {
    const values = [digits(data.client.phone), emailKey(data.client.email)].filter(Boolean);
    if (values.length) await supabase.from('suppression_list').delete().eq('org_id', orgId).in('value', values);
  }
  // The log keeps that an erasure happened, not who it was about.
  await logAudit(orgId, actor, 'lead.erased', null, { conversations: data.whatsapp.length + data.email.length, calls: data.calls.length, keptOnDoNotContact: keepOnDoNotContact });
  return {
    ok: true,
    erased: { conversations: data.whatsapp.length + data.email.length, calls: data.calls.length, campaignMessages: data.campaignMessages.length },
    keptOnDoNotContact: keepOnDoNotContact,
    heldElsewhere: ELSEWHERE,
  };
}
