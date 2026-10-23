import { useRef } from 'react';
import { supabase, isSupabaseBrowserConfigured } from '../lib/supabaseClient';
import { Lead } from '../types';

function leadToRow(lead: Lead, orgId: string) {
  return {
    id: lead.id,
    org_id: orgId,
    name: lead.name,
    company: lead.company || null,
    phone: lead.phone || null,
    email: lead.email || null,
    country: lead.country || null,
    status: lead.status,
    whatsapp_status: lead.whatsAppStatus,
    email_status: lead.emailStatus,
    voice_call_status: lead.voiceCallStatus || null,
    whatsapp_message: lead.whatsAppMessage || null,
    email_subject: lead.emailSubject || null,
    email_body: lead.emailBody || null,
    meeting_date: lead.meetingDate || null,
    meeting_time: lead.meetingTime || null,
    notes: lead.notes || null,
    tags: lead.tags || [],
    follow_up_date: lead.followUpDate || null,
    last_contacted: lead.lastContacted || null,
    channel_used: lead.channelUsed || null,
    is_valid_phone: lead.isValidPhone,
    is_valid_email: lead.isValidEmail,
    custom_fields: lead.customFields || {},
    opted_out: lead.optedOut || false,
    call_consent: lead.callConsent || false,
    updated_at: new Date().toISOString(),
  };
}

function rowToLead(row: any): Lead {
  return {
    id: row.id,
    name: row.name,
    company: row.company || '',
    phone: row.phone || '',
    email: row.email || '',
    country: row.country || undefined,
    status: row.status,
    whatsAppStatus: row.whatsapp_status,
    emailStatus: row.email_status,
    voiceCallStatus: row.voice_call_status || undefined,
    whatsAppMessage: row.whatsapp_message || undefined,
    emailSubject: row.email_subject || undefined,
    emailBody: row.email_body || undefined,
    meetingDate: row.meeting_date || undefined,
    meetingTime: row.meeting_time || undefined,
    notes: row.notes || undefined,
    tags: row.tags && row.tags.length > 0 ? row.tags : undefined,
    followUpDate: row.follow_up_date || undefined,
    lastContacted: row.last_contacted || undefined,
    channelUsed: row.channel_used || undefined,
    isValidPhone: row.is_valid_phone,
    isValidEmail: row.is_valid_email,
    customFields: row.custom_fields || {},
    optedOut: row.opted_out || false,
    callConsent: row.call_consent || false,
  };
}

/**
 * Syncs the Clients (Lead[]) list with Supabase, scoped to the signed-in org, using the
 * same graceful-degradation approach as useCloudSettings: when Supabase isn't configured
 * or nobody's signed in, callers keep using their existing localStorage-backed state
 * untouched. When signed in, this becomes the source of truth for that org.
 */
export function useCloudClients(userId: string | null | undefined) {
  const lastSyncedIds = useRef<Set<string>>(new Set());
  // Each lead's row as last loaded or saved — only leads that changed since are saved again.
  // Saving every lead on every change would overwrite statuses the server updated meanwhile
  // (server-run campaigns, the call queue) with this browser's stale copy.
  const lastSyncedRows = useRef<Map<string, string>>(new Map());
  const rowKey = (row: Record<string, unknown>) => {
    const { updated_at: _ignored, ...rest } = row;
    return JSON.stringify(rest);
  };

  async function loadClients(): Promise<Lead[] | null> {
    if (!isSupabaseBrowserConfigured || !supabase || !userId) return null;
    const { data, error } = await supabase
      .from('clients')
      .select('*')
      .eq('org_id', userId)
      .order('created_at', { ascending: false });
    if (error || !data) return null;
    lastSyncedIds.current = new Set(data.map((r: any) => r.id));
    const leads = data.map(rowToLead);
    lastSyncedRows.current = new Map(leads.map((l) => [l.id, rowKey(leadToRow(l, userId))]));
    return leads;
  }

  async function syncClients(leads: Lead[]): Promise<void> {
    if (!isSupabaseBrowserConfigured || !supabase || !userId) return;

    const currentIds = new Set(leads.map((l) => l.id));
    const toDelete = [...lastSyncedIds.current].filter((id) => !currentIds.has(id));
    lastSyncedIds.current = currentIds;

    const changed = leads.map((l) => leadToRow(l, userId)).filter((row) => lastSyncedRows.current.get(row.id) !== rowKey(row));
    for (const id of toDelete) lastSyncedRows.current.delete(id);

    if (changed.length > 0) {
      let { error } = await supabase.from('clients').upsert(changed, { onConflict: 'id' });
      // Until supabase/schema.sql adds the newer columns, save everything else rather than
      // failing the whole sync over them.
      if (error && /voice_call_status|call_consent/.test(error.message)) {
        ({ error } = await supabase.from('clients').upsert(
          changed.map(({ voice_call_status: _skip, call_consent: _skip2, ...rest }) => rest),
          { onConflict: 'id' }
        ));
      }
      // Only remembered as saved once it actually saved, so a failed save is retried next time.
      if (!error) for (const row of changed) lastSyncedRows.current.set(row.id, rowKey(row));
    }
    if (toDelete.length > 0) {
      await supabase.from('clients').delete().in('id', toDelete);
    }
  }

  return { loadClients, syncClients, isCloudBacked: isSupabaseBrowserConfigured };
}
