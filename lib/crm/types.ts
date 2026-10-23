export type CrmProvider = 'hubspot' | 'zoho' | 'salesforce';

/** A live, authorised connection to one org's CRM (lib/crm/index.ts refreshes the token). */
export interface CrmConnection {
  provider: CrmProvider;
  accessToken: string;
  /** Zoho: api_domain for the org's data centre. Salesforce: instance_url. */
  apiBase: string | null;
}

export interface CrmLead {
  name: string;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  country?: string | null;
  /** OmniReach's view of where the lead is — mapped to each CRM's own status field. */
  stage?: 'contacted' | 'replied' | 'meeting' | 'opted_out';
}

export interface ImportedContact {
  crmId: string;
  name: string;
  company: string;
  email: string;
  phone: string;
  country: string;
}

export interface CrmAdapter {
  /** Find the lead/contact by email (or phone), create it if missing; returns its CRM id. */
  upsertContact(conn: CrmConnection, lead: CrmLead, knownId?: string | null): Promise<string>;
  addNote(conn: CrmConnection, crmId: string, title: string, text: string): Promise<void>;
  addMeeting(conn: CrmConnection, crmId: string, meeting: { title: string; startIso: string; durationMinutes: number; link?: string | null; notes?: string }): Promise<void>;
  /** Most recent contacts/leads, for "Import from CRM". */
  listContacts(conn: CrmConnection, limit: number): Promise<ImportedContact[]>;
}

export function splitName(name: string): { first: string; last: string } {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', last: 'Unknown' };
  if (parts.length === 1) return { first: '', last: parts[0] };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

/** Throws with the CRM's own error message, so it lands in org_crm.last_error readably. */
export async function crmFetch(url: string, init: RequestInit & { label: string }): Promise<any> {
  const res = await fetch(url, init);
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const detail =
      (Array.isArray(data) && (data[0]?.message || data[0]?.errorCode)) ||
      data?.message ||
      data?.data?.[0]?.message ||
      data?.error_description ||
      data?.error ||
      (typeof data === 'string' ? data.slice(0, 200) : '') ||
      `HTTP ${res.status}`;
    const err = new Error(`${init.label}: ${detail}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data;
}
