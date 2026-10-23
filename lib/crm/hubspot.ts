import { CrmAdapter, CrmConnection, CrmLead, crmFetch, splitName } from './types.js';

/**
 * HubSpot (CRM v3 API). Leads become Contacts, matched by email (then phone). Notes and
 * meetings are associated to the contact. Docs: https://developers.hubspot.com/docs/api/crm/contacts
 */

const API = 'https://api.hubapi.com';
// HubSpot's default association type ids: note→contact 202, meeting→contact 200.
const NOTE_TO_CONTACT = 202;
const MEETING_TO_CONTACT = 200;

// hs_lead_status default options.
const LEAD_STATUS: Record<NonNullable<CrmLead['stage']>, string> = {
  contacted: 'ATTEMPTED_TO_CONTACT',
  replied: 'CONNECTED',
  meeting: 'OPEN_DEAL',
  opted_out: 'UNQUALIFIED',
};

function headers(conn: CrmConnection) {
  return { Authorization: `Bearer ${conn.accessToken}`, 'Content-Type': 'application/json' };
}

async function findBy(conn: CrmConnection, propertyName: string, value: string): Promise<string | null> {
  const data = await crmFetch(`${API}/crm/v3/objects/contacts/search`, {
    label: 'HubSpot contact search',
    method: 'POST',
    headers: headers(conn),
    body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName, operator: 'EQ', value }] }], limit: 1 }),
  });
  return data?.results?.[0]?.id || null;
}

export const hubspot: CrmAdapter = {
  async upsertContact(conn, lead, knownId) {
    const { first, last } = splitName(lead.name);
    const properties: Record<string, string> = {
      firstname: first,
      lastname: last,
      ...(lead.email ? { email: lead.email } : {}),
      ...(lead.phone ? { phone: lead.phone } : {}),
      ...(lead.company ? { company: lead.company } : {}),
      ...(lead.country ? { country: lead.country } : {}),
      ...(lead.stage ? { hs_lead_status: LEAD_STATUS[lead.stage] } : {}),
    };
    const id =
      knownId ||
      (lead.email ? await findBy(conn, 'email', lead.email) : null) ||
      (lead.phone ? await findBy(conn, 'phone', lead.phone) : null);
    if (id) {
      await crmFetch(`${API}/crm/v3/objects/contacts/${id}`, {
        label: 'HubSpot contact update',
        method: 'PATCH',
        headers: headers(conn),
        body: JSON.stringify({ properties }),
      });
      return id;
    }
    const created = await crmFetch(`${API}/crm/v3/objects/contacts`, {
      label: 'HubSpot contact create',
      method: 'POST',
      headers: headers(conn),
      body: JSON.stringify({ properties }),
    });
    return created.id;
  },

  async addNote(conn, crmId, title, text) {
    await crmFetch(`${API}/crm/v3/objects/notes`, {
      label: 'HubSpot note',
      method: 'POST',
      headers: headers(conn),
      body: JSON.stringify({
        properties: { hs_timestamp: new Date().toISOString(), hs_note_body: `<strong>${title}</strong><br/>${text.replace(/\n/g, '<br/>')}` },
        associations: [{ to: { id: crmId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_CONTACT }] }],
      }),
    });
  },

  async addMeeting(conn, crmId, meeting) {
    const end = new Date(new Date(meeting.startIso).getTime() + meeting.durationMinutes * 60_000).toISOString();
    await crmFetch(`${API}/crm/v3/objects/meetings`, {
      label: 'HubSpot meeting',
      method: 'POST',
      headers: headers(conn),
      body: JSON.stringify({
        properties: {
          hs_timestamp: meeting.startIso,
          hs_meeting_title: meeting.title,
          hs_meeting_start_time: meeting.startIso,
          hs_meeting_end_time: end,
          hs_meeting_body: meeting.notes || 'Booked by OmniReach AI.',
          ...(meeting.link ? { hs_meeting_external_url: meeting.link } : {}),
        },
        associations: [{ to: { id: crmId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: MEETING_TO_CONTACT }] }],
      }),
    });
  },

  async listContacts(conn, limit) {
    const out: any[] = [];
    let after: string | undefined;
    while (out.length < limit) {
      const params = new URLSearchParams({ limit: String(Math.min(100, limit - out.length)), properties: 'firstname,lastname,email,phone,company,country' });
      if (after) params.set('after', after);
      const data = await crmFetch(`${API}/crm/v3/objects/contacts?${params}`, { label: 'HubSpot contacts', headers: headers(conn) });
      out.push(...(data?.results || []));
      after = data?.paging?.next?.after;
      if (!after) break;
    }
    return out.map((c) => ({
      crmId: c.id,
      name: [c.properties?.firstname, c.properties?.lastname].filter(Boolean).join(' ') || c.properties?.email || 'Contact',
      company: c.properties?.company || '',
      email: c.properties?.email || '',
      phone: c.properties?.phone || '',
      country: c.properties?.country || '',
    }));
  },
};
