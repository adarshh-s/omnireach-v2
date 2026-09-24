import { Lead } from '../types';
import { ScatterPoint, ScatterOutcome } from '../components/charts/ActivityScatter';

function toScatter(leads: Lead[], outcomeOf: (l: Lead) => ScatterOutcome | null, max = 28): ScatterPoint[] {
  const points: ScatterPoint[] = [];
  for (const l of leads) {
    const outcome = outcomeOf(l);
    if (outcome) points.push({ id: l.id, outcome });
  }
  return points.slice(-max);
}

export interface ChannelDeliveryStats {
  sent: number;
  replied: number;
  failed: number;
  scatter: ScatterPoint[];
}

export function getWhatsAppStats(leads: Lead[]): ChannelDeliveryStats {
  const sent = leads.filter((l) => l.whatsAppStatus !== 'Pending').length;
  const replied = leads.filter((l) => l.whatsAppStatus === 'Replied').length;
  const failed = leads.filter((l) => l.whatsAppStatus === 'Failed').length;
  const scatter = toScatter(leads, (l) => {
    if (l.whatsAppStatus === 'Pending') return null;
    if (l.whatsAppStatus === 'Failed') return 'bad';
    if (l.whatsAppStatus === 'Replied' || l.whatsAppStatus === 'Read' || l.whatsAppStatus === 'Clicked') return 'good';
    return 'warn';
  });
  return { sent, replied, failed, scatter };
}

export function getEmailStats(leads: Lead[]): ChannelDeliveryStats {
  const sent = leads.filter((l) => l.emailStatus !== 'Pending').length;
  const replied = leads.filter((l) => l.emailStatus === 'Replied').length;
  const failed = leads.filter((l) => l.emailStatus === 'Failed').length;
  const scatter = toScatter(leads, (l) => {
    if (l.emailStatus === 'Pending') return null;
    if (l.emailStatus === 'Failed') return 'bad';
    if (l.emailStatus === 'Replied' || l.emailStatus === 'Opened' || l.emailStatus === 'Clicked') return 'good';
    return 'warn';
  });
  return { sent, replied, failed, scatter };
}

export interface CalendarStats {
  booked: number;
  inProgress: number;
  declined: number;
  scatter: ScatterPoint[];
}

export function getCalendarStats(leads: Lead[]): CalendarStats {
  const booked = leads.filter((l) => l.status === 'Meeting Scheduled').length;
  const inProgress = leads.filter((l) => l.status === 'Interested' || l.status === 'Replied').length;
  const declined = leads.filter((l) => l.status === 'Not Interested' || l.status === 'Do Not Contact').length;
  const scatter = toScatter(leads, (l) => {
    if (l.status === 'Meeting Scheduled') return 'good';
    if (l.status === 'Not Interested' || l.status === 'Do Not Contact' || l.status === 'Failed') return 'bad';
    if (l.status === 'Pending') return null;
    return 'warn';
  });
  return { booked, inProgress, declined, scatter };
}
