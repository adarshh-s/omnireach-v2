import { CrmAdapter, CrmConnection, crmFetch, splitName } from './types.js';

/**
 * Salesforce (REST API). Leads go to the Lead object, matched by email (then phone) among
 * unconverted leads. Notes become completed Tasks and meetings become Events, both linked to
 * the lead (WhoId). The instance URL comes back with the token and is stored per org.
 * Docs: https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/
 */

const VERSION = 'v60.0';

function base(conn: CrmConnection) {
  if (!conn.apiBase) throw new Error('Salesforce: missing instance URL — reconnect Salesforce.');
  return `${conn.apiBase}/services/data/${VERSION}`;
}

function headers(conn: CrmConnection) {
  return { Authorization: `Bearer ${conn.accessToken}`, 'Content-Type': 'application/json' };
}

/** SOQL string literal escaping. */
function soql(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findLead(conn: CrmConnection, field: 'Email' | 'Phone', value: string): Promise<string | null> {
  const q = `SELECT Id FROM Lead WHERE ${field} = '${soql(value)}' AND IsConverted = false ORDER BY CreatedDate DESC LIMIT 1`;
  const data = await crmFetch(`${base(conn)}/query?q=${encodeURIComponent(q)}`, { label: 'Salesforce lead search', headers: headers(conn) });
  return data?.records?.[0]?.Id || null;
}

export const salesforce: CrmAdapter = {
  async upsertContact(conn, lead, knownId) {
    const { first, last } = splitName(lead.name);
    // Company and LastName are required on Lead; Status/LeadSource are org picklists, left alone.
    const fields = {
      LastName: last,
      ...(first ? { FirstName: first } : {}),
      Company: lead.company || lead.name || 'Unknown',
      ...(lead.email ? { Email: lead.email } : {}),
      ...(lead.phone ? { Phone: lead.phone } : {}),
      ...(lead.country ? { Country: lead.country } : {}),
    };
    const id =
      knownId ||
      (lead.email ? await findLead(conn, 'Email', lead.email) : null) ||
      (lead.phone ? await findLead(conn, 'Phone', lead.phone) : null);
    if (id) {
      await crmFetch(`${base(conn)}/sobjects/Lead/${id}`, {
        label: 'Salesforce lead update',
        method: 'PATCH',
        headers: headers(conn),
        body: JSON.stringify(fields),
      });
      return id;
    }
    const created = await crmFetch(`${base(conn)}/sobjects/Lead`, {
      label: 'Salesforce lead create',
      method: 'POST',
      headers: headers(conn),
      body: JSON.stringify(fields),
    });
    return created.id;
  },

  async addNote(conn, crmId, title, text) {
    await crmFetch(`${base(conn)}/sobjects/Task`, {
      label: 'Salesforce activity',
      method: 'POST',
      headers: headers(conn),
      body: JSON.stringify({
        WhoId: crmId,
        Subject: title.slice(0, 255),
        Description: text.slice(0, 32000),
        Status: 'Completed',
        ActivityDate: new Date().toISOString().slice(0, 10),
      }),
    });
  },

  async addMeeting(conn, crmId, meeting) {
    const end = new Date(new Date(meeting.startIso).getTime() + meeting.durationMinutes * 60_000).toISOString();
    await crmFetch(`${base(conn)}/sobjects/Event`, {
      label: 'Salesforce meeting',
      method: 'POST',
      headers: headers(conn),
      body: JSON.stringify({
        WhoId: crmId,
        Subject: meeting.title.slice(0, 255),
        StartDateTime: meeting.startIso,
        EndDateTime: end,
        Description: [meeting.notes || 'Booked by OmniReach AI.', meeting.link ? `Join: ${meeting.link}` : ''].filter(Boolean).join('\n'),
        ...(meeting.link ? { Location: meeting.link.slice(0, 255) } : {}),
      }),
    });
  },

  async listContacts(conn, limit) {
    const q = `SELECT Id, FirstName, LastName, Email, Phone, MobilePhone, Company, Country FROM Lead WHERE IsConverted = false ORDER BY CreatedDate DESC LIMIT ${Math.min(2000, limit)}`;
    const out: any[] = [];
    let next = `${base(conn)}/query?q=${encodeURIComponent(q)}`;
    while (next && out.length < limit) {
      const data = await crmFetch(next, { label: 'Salesforce leads', headers: headers(conn) });
      out.push(...(data?.records || []));
      next = data?.nextRecordsUrl ? `${conn.apiBase}${data.nextRecordsUrl}` : '';
    }
    return out.map((l) => ({
      crmId: l.Id,
      name: [l.FirstName, l.LastName].filter(Boolean).join(' ') || l.Email || 'Lead',
      company: l.Company || '',
      email: l.Email || '',
      phone: l.MobilePhone || l.Phone || '',
      country: l.Country || '',
    }));
  },
};
