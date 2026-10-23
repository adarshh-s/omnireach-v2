import { CrmAdapter, CrmConnection, crmFetch, splitName } from './types.js';

/**
 * Zoho CRM (REST v6). Leads go to the Leads module, matched by email via Zoho's upsert.
 * Every org's Zoho account lives in one data centre (.com, .eu, .in, .com.au, .jp, .ca, .sa…);
 * the API base for it comes back with the token (api_domain) and is stored per org.
 * Docs: https://www.zoho.com/crm/developer/docs/api/v6/
 */

function base(conn: CrmConnection) {
  return `${conn.apiBase || 'https://www.zohoapis.com'}/crm/v6`;
}

function headers(conn: CrmConnection) {
  return { Authorization: `Zoho-oauthtoken ${conn.accessToken}`, 'Content-Type': 'application/json' };
}

/** Zoho reports per-record failures inside a 200/202 response. */
function firstRecord(data: any, label: string) {
  const rec = data?.data?.[0];
  if (!rec || rec.status === 'error') throw new Error(`${label}: ${rec?.message || rec?.code || 'no record returned'}`);
  return rec;
}

export const zoho: CrmAdapter = {
  async upsertContact(conn, lead, knownId) {
    const { first, last } = splitName(lead.name);
    // Company and Last_Name are required on Zoho Leads. Status/source are org-specific
    // picklists, so they're left alone — the notes carry OmniReach's history instead.
    const record = {
      Last_Name: last,
      ...(first ? { First_Name: first } : {}),
      Company: lead.company || lead.name || 'Unknown',
      ...(lead.email ? { Email: lead.email } : {}),
      ...(lead.phone ? { Phone: lead.phone } : {}),
      ...(lead.country ? { Country: lead.country } : {}),
    };
    if (knownId) {
      const data = await crmFetch(`${base(conn)}/Leads/${knownId}`, {
        label: 'Zoho lead update',
        method: 'PUT',
        headers: headers(conn),
        body: JSON.stringify({ data: [record] }),
      });
      firstRecord(data, 'Zoho lead update');
      return knownId;
    }
    const data = await crmFetch(`${base(conn)}/Leads/upsert`, {
      label: 'Zoho lead upsert',
      method: 'POST',
      headers: headers(conn),
      body: JSON.stringify({ data: [record], duplicate_check_fields: lead.email ? ['Email'] : ['Phone'] }),
    });
    return firstRecord(data, 'Zoho lead upsert').details.id;
  },

  async addNote(conn, crmId, title, text) {
    const data = await crmFetch(`${base(conn)}/Leads/${crmId}/Notes`, {
      label: 'Zoho note',
      method: 'POST',
      headers: headers(conn),
      body: JSON.stringify({ data: [{ Note_Title: title, Note_Content: text }] }),
    });
    firstRecord(data, 'Zoho note');
  },

  async addMeeting(conn, crmId, meeting) {
    const start = new Date(meeting.startIso);
    const end = new Date(start.getTime() + meeting.durationMinutes * 60_000);
    // Zoho wants yyyy-MM-ddTHH:mm:ss±HH:mm — UTC with an explicit +00:00 offset.
    const fmt = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
    const data = await crmFetch(`${base(conn)}/Events`, {
      label: 'Zoho meeting',
      method: 'POST',
      headers: headers(conn),
      body: JSON.stringify({
        data: [
          {
            Event_Title: meeting.title,
            Start_DateTime: fmt(start),
            End_DateTime: fmt(end),
            Description: [meeting.notes || 'Booked by OmniReach AI.', meeting.link ? `Join: ${meeting.link}` : ''].filter(Boolean).join('\n'),
            $se_module: 'Leads',
            What_Id: { id: crmId },
          },
        ],
      }),
    });
    firstRecord(data, 'Zoho meeting');
  },

  async listContacts(conn, limit) {
    const out: any[] = [];
    let page = 1;
    while (out.length < limit) {
      const params = new URLSearchParams({
        fields: 'First_Name,Last_Name,Email,Phone,Mobile,Company,Country',
        per_page: String(Math.min(200, limit - out.length)),
        page: String(page),
        sort_by: 'Created_Time',
        sort_order: 'desc',
      });
      const data = await crmFetch(`${base(conn)}/Leads?${params}`, { label: 'Zoho leads', headers: headers(conn) });
      out.push(...(data?.data || []));
      if (!data?.info?.more_records) break;
      page++;
    }
    return out.map((l) => ({
      crmId: l.id,
      name: [l.First_Name, l.Last_Name].filter(Boolean).join(' ') || l.Email || 'Lead',
      company: l.Company || '',
      email: l.Email || '',
      phone: l.Mobile || l.Phone || '',
      country: l.Country || '',
    }));
  },
};
