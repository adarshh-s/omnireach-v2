import { Lead } from '../types';

export interface AnalyticsSummary {
  totalClients: number;
  activeCampaigns: number | null;
  activeConversations: number | null;
  meetingsBooked: number;
  contactedCount: number;
  conversionRate: number;
  failedCount: number;
  whatsAppSent: number;
  whatsAppReplied: number;
  whatsAppFailed: number;
  emailSent: number;
  emailReplied: number;
  emailFailed: number;
  calendarBooked: number;
  calendarInProgress: number;
  calendarDeclined: number;
}

/** Escapes a value for CSV — wraps in quotes and doubles any embedded quotes whenever the
 * value contains a comma, quote, or newline that would otherwise break column alignment. */
function csvCell(value: string | number | null | undefined): string {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(',') + '\r\n';
}

/** Builds a single CSV report — a summary block up top, then one row per lead — and triggers
 * a browser download. No server round-trip: everything here is already in the Dashboard's
 * local state, so this just formats what's already on screen. */
export function downloadAnalyticsCsv(leads: Lead[], summary: AnalyticsSummary): void {
  let csv = '';

  csv += csvRow(['OmniReach Analytics Export']);
  csv += csvRow(['Generated', new Date().toLocaleString()]);
  csv += '\r\n';

  csv += csvRow(['Summary']);
  csv += csvRow(['Total Clients', summary.totalClients]);
  csv += csvRow(['Active Campaigns', summary.activeCampaigns ?? 'n/a']);
  csv += csvRow(['Active Conversations', summary.activeConversations ?? 'n/a']);
  csv += csvRow(['Meetings Booked', summary.meetingsBooked]);
  csv += csvRow(['Contacted', `${summary.contactedCount} / ${summary.totalClients}`]);
  csv += csvRow(['Conversion Rate', `${summary.conversionRate}%`]);
  csv += csvRow(['Failed Dispatches', summary.failedCount]);
  csv += '\r\n';

  csv += csvRow(['Channel', 'Sent', 'Replied', 'Failed']);
  csv += csvRow(['WhatsApp', summary.whatsAppSent, summary.whatsAppReplied, summary.whatsAppFailed]);
  csv += csvRow(['Email', summary.emailSent, summary.emailReplied, summary.emailFailed]);
  csv += '\r\n';

  csv += csvRow(['Google Calendar', 'Booked', 'In Progress', 'Declined']);
  csv += csvRow(['', summary.calendarBooked, summary.calendarInProgress, summary.calendarDeclined]);
  csv += '\r\n';

  csv += csvRow(['Leads']);
  csv += csvRow([
    'Name',
    'Company',
    'Phone',
    'Email',
    'Country',
    'Status',
    'WhatsApp Status',
    'Email Status',
    'Channel Used',
    'Last Contacted',
    'Meeting Date',
    'Meeting Time',
  ]);
  for (const lead of leads) {
    csv += csvRow([
      lead.name,
      lead.company,
      lead.phone,
      lead.email,
      lead.country,
      lead.status,
      lead.whatsAppStatus,
      lead.emailStatus,
      lead.channelUsed,
      lead.lastContacted,
      lead.meetingDate,
      lead.meetingTime,
    ]);
  }

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dateStr = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `omnireach-analytics-${dateStr}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
